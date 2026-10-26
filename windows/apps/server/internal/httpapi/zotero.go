package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Only Zotero's local read API is accessed; no credentials or database writes.
var zoteroLocalClient = &http.Client{
	Timeout:       20 * time.Second,
	Transport:     &http.Transport{Proxy: nil},
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
}

var zoteroKeyPattern = regexp.MustCompile(`^[A-Z0-9]{8}$`)
var zoteroYearPattern = regexp.MustCompile(`\b(?:19|20)\d{2}\b`)

type zoteroItem struct {
	Key  string `json:"key"`
	Data struct {
		ItemType string `json:"itemType"`
		Title    string `json:"title"`
		Creators []struct {
			CreatorType string `json:"creatorType"`
			FirstName   string `json:"firstName"`
			LastName    string `json:"lastName"`
			Name        string `json:"name"`
		} `json:"creators"`
		Date             string `json:"date"`
		DOI              string `json:"DOI"`
		PublicationTitle string `json:"publicationTitle"`
		ProceedingsTitle string `json:"proceedingsTitle"`
		University       string `json:"university"`
		Filename         string `json:"filename"`
		ContentType      string `json:"contentType"`
		LinkMode         string `json:"linkMode"`
	} `json:"data"`
	Meta struct {
		NumChildren int `json:"numChildren"`
	} `json:"meta"`
}

type zoteroAttachment struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type zoteroEntry struct {
	Key         string             `json:"key"`
	Title       string             `json:"title"`
	Authors     []string           `json:"authors"`
	Year        int                `json:"year,omitempty"`
	DOI         string             `json:"doi"`
	Venue       string             `json:"venue"`
	Attachments []zoteroAttachment `json:"attachments"`
	Error       string             `json:"error,omitempty"`
}

func zoteroRequest(ctx context.Context, path string, query url.Values) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:23119/api/users/0/"+path+"?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Zotero-API-Version", "3")
	req.Header.Set("Accept", "application/json")
	response, err := zoteroLocalClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接本机 Zotero，请打开 Zotero 7 或更新版本后重试")
	}
	if response.StatusCode >= 400 {
		response.Body.Close()
		switch response.StatusCode {
		case http.StatusForbidden:
			return nil, fmt.Errorf("请在 Zotero「设置 → 高级」中启用「允许此计算机上的其他应用程序与 Zotero 通信」")
		case http.StatusNotFound:
			return nil, fmt.Errorf("Zotero 条目或本地附件不存在；请确认附件已下载，并使用 Zotero 7 或更新版本")
		default:
			return nil, fmt.Errorf("Zotero 返回 HTTP %d，请检查 Zotero 后重试", response.StatusCode)
		}
	}
	return response, nil
}

func zoteroJSON(ctx context.Context, path string, query url.Values, target any) (http.Header, error) {
	response, err := zoteroRequest(ctx, path, query)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Zotero 返回了无法读取的响应")
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16<<20)).Decode(target); err != nil {
		return nil, fmt.Errorf("无法解析 Zotero 资料库，请确认本地 API 已启用")
	}
	return response.Header, nil
}

func zoteroPDF(item zoteroItem) bool {
	return item.Data.ItemType == "attachment" && item.Data.LinkMode != "linked_url" &&
		(item.Data.ContentType == "application/pdf" || strings.EqualFold(filepath.Ext(item.Data.Filename), ".pdf"))
}

func zoteroPDFInfo(item zoteroItem) zoteroAttachment {
	name := item.Data.Filename
	if name == "" {
		name = item.Data.Title
	}
	if !strings.EqualFold(filepath.Ext(name), ".pdf") {
		name += ".pdf"
	}
	return zoteroAttachment{Key: item.Key, Name: name}
}

func (s *Server) handleZoteroCollections(w http.ResponseWriter, r *http.Request) {
	var collections []struct {
		Key  string `json:"key"`
		Data struct {
			Name   string `json:"name"`
			Parent any    `json:"parentCollection"`
		} `json:"data"`
	}
	_, err := zoteroJSON(r.Context(), "collections", nil, &collections)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	result := make([]map[string]any, 0, len(collections))
	for _, collection := range collections {
		result = append(result, map[string]any{"key": collection.Key, "name": collection.Data.Name, "parent": collection.Data.Parent})
	}
	writeJSON(w, http.StatusOK, map[string]any{"collections": result})
}

func (s *Server) handleZoteroItems(w http.ResponseWriter, r *http.Request) {
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	if start < 0 {
		start = 0
	}
	path := "items/top"
	if collection := r.URL.Query().Get("collection"); collection != "" {
		if !zoteroKeyPattern.MatchString(collection) {
			writeError(w, 400, "Zotero 分类标识无效")
			return
		}
		path = "collections/" + collection + "/items/top"
	}
	query := url.Values{"limit": {"40"}, "start": {strconv.Itoa(start)}, "sort": {"dateModified"}, "direction": {"desc"}, "itemType": {"-note"}}
	if search := strings.TrimSpace(r.URL.Query().Get("q")); search != "" {
		query.Set("q", search)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	var items []zoteroItem
	headers, err := zoteroJSON(ctx, path, query, &items)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	entries := make([]zoteroEntry, len(items))
	var wait sync.WaitGroup
	slots := make(chan struct{}, 6)
	for index, item := range items {
		entry := zoteroEntry{Key: item.Key, Title: item.Data.Title, DOI: item.Data.DOI, Venue: item.Data.PublicationTitle, Authors: []string{}, Attachments: []zoteroAttachment{}}
		if entry.Venue == "" {
			entry.Venue = item.Data.ProceedingsTitle
		}
		if entry.Venue == "" {
			entry.Venue = item.Data.University
		}
		entry.Year, _ = strconv.Atoi(zoteroYearPattern.FindString(item.Data.Date))
		for _, creator := range item.Data.Creators {
			if creator.CreatorType != "author" && creator.CreatorType != "bookAuthor" {
				continue
			}
			name := strings.TrimSpace(creator.Name)
			if name == "" {
				name = strings.TrimSpace(creator.FirstName + " " + creator.LastName)
			}
			if name != "" {
				entry.Authors = append(entry.Authors, name)
			}
		}
		entries[index] = entry
		if zoteroPDF(item) {
			entries[index].Attachments = append(entries[index].Attachments, zoteroPDFInfo(item))
			continue
		}
		if item.Data.ItemType == "attachment" || item.Meta.NumChildren == 0 {
			continue
		}
		wait.Add(1)
		go func(index int, key string) {
			defer wait.Done()
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				entries[index].Error = "读取附件超时，请重试"
				return
			}
			defer func() { <-slots }()
			var children []zoteroItem
			_, err := zoteroJSON(ctx, "items/"+key+"/children", nil, &children)
			if err != nil {
				entries[index].Error = err.Error()
				return
			}
			for _, child := range children {
				if zoteroPDF(child) {
					entries[index].Attachments = append(entries[index].Attachments, zoteroPDFInfo(child))
				}
			}
		}(index, item.Key)
	}
	wait.Wait()
	total, err := strconv.Atoi(headers.Get("Total-Results"))
	if err != nil {
		total = start + len(items)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": entries, "total": total, "start": start, "hasMore": start+len(items) < total || (err != nil && len(items) == 40)})
}

func (s *Server) handleZoteroFile(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	if !zoteroKeyPattern.MatchString(key) {
		writeError(w, 400, "Zotero 附件标识无效")
		return
	}
	var item zoteroItem
	if _, err := zoteroJSON(r.Context(), "items/"+key, nil, &item); err != nil {
		writeError(w, 502, err.Error())
		return
	}
	if !zoteroPDF(item) {
		writeError(w, 400, "请选择 Zotero 中的 PDF 附件")
		return
	}
	// Zotero resolves stored and linked attachment paths, including custom storage.
	response, err := zoteroRequest(r.Context(), "items/"+key+"/file", nil)
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	response.Body.Close()
	location, err := url.Parse(response.Header.Get("Location"))
	if err != nil || location.Scheme != "file" || (location.Host != "" && location.Host != "localhost") {
		writeError(w, 422, "此 PDF 尚未保存在本机，请先在 Zotero 中下载附件")
		return
	}
	path := location.Path
	if runtime.GOOS == "windows" && len(path) > 2 && path[0] == '/' && path[2] == ':' {
		path = path[1:]
	}
	path = filepath.FromSlash(path)
	if !filepath.IsAbs(path) {
		writeError(w, 422, "Zotero 返回的附件路径无效")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, 404, "无法读取 PDF，请先在 Zotero 中确认附件已下载且可打开")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeError(w, 422, "Zotero 附件不是有效文件")
		return
	}
	if info.Size() > maxPublicationBytes {
		writeError(w, 413, "PDF 超过 512 MB 导入上限")
		return
	}
	var magic [5]byte
	if _, err = io.ReadFull(file, magic[:]); err != nil || string(magic[:]) != "%PDF-" {
		writeError(w, 422, "Zotero 附件不是有效的 PDF")
		return
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		writeError(w, 500, "无法读取 PDF")
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": zoteroPDFInfo(item).Name}))
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
