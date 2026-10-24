package httpapi

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"cbctv2/server/internal/booksources"
)

const gutendexBooksURL = "https://gutendex.com/books/"

var bookSourceHTTPClient = newBookSourceClient(sourceProxyFromEnvironment)

// newBookSourceClient 构造 slack 书源出网客户端。proxy 参数化便于测试注入 nil
// 做确定性验证（环境里有系统代理时，回环请求会经代理转发，无法在包级变量上断言）。
func newBookSourceClient(proxy func(*http.Request) (*url.URL, error)) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = proxy
	// 出网防护共享 booksources 的同一份实现：解析后逐 IP 校验（含保留网段表）
	// 并按 IP 拨号。此前这里完全没有 IP/私网检查，只有重定向主机白名单——
	// DNS rebinding 或源站解析到内网地址时可直接触达本机/内网服务。
	// 用户显式配置的代理沿用 booksources 的既有信任规则（代理地址直接放行）。
	transport.DialContext = booksources.DialPublicGuard(10*time.Second, proxy)
	return &http.Client{
		Timeout:   2 * time.Minute,
		Transport: transport,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many book-source redirects")
			}
			host := strings.ToLower(request.URL.Hostname())
			if host != "gutendex.com" && host != "www.gutenberg.org" && host != "gutenberg.org" {
				return fmt.Errorf("book-source redirect host is not allowed")
			}
			return nil
		},
	}
}

func (s *Server) handleSlackBookSearch(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	pageURL := strings.TrimSpace(r.URL.Query().Get("page"))
	var target *url.URL
	if pageURL != "" {
		parsed, err := url.Parse(pageURL)
		if err != nil || parsed.Scheme != "https" || parsed.Host != "gutendex.com" || parsed.Path != "/books/" || parsed.User != nil {
			writeError(w, http.StatusBadRequest, "书目分页地址无效")
			return
		}
		pageQuery := parsed.Query()
		searchText := pageQuery.Get("search")
		if searchText == "" || len([]rune(searchText)) > 120 || (pageQuery.Get("languages") != "en" && pageQuery.Get("languages") != "") {
			writeError(w, http.StatusBadRequest, "书目搜索条件无效")
			return
		}
		if page := pageQuery.Get("page"); page != "" {
			for _, digit := range page {
				if digit < '0' || digit > '9' {
					writeError(w, http.StatusBadRequest, "书目分页地址无效")
					return
				}
			}
		}
		target = parsed
	} else {
		if query == "" || len([]rune(query)) > 120 {
			writeError(w, http.StatusBadRequest, "请输入 1 到 120 个字符的书名或作者")
			return
		}
		target, _ = url.Parse(gutendexBooksURL)
		params := target.Query()
		params.Set("search", query)
		params.Set("languages", "en")
		target.RawQuery = params.Encode()
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "无法创建书目查询")
		return
	}
	request.Header.Set("Accept", "application/json")
	response, err := bookSourceHTTPClient.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, "公版书目录暂时无法连接")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("公版书目录返回 HTTP %d", response.StatusCode))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=60")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 4<<20))
}

func (s *Server) handleSlackBookDownload(w http.ResponseWriter, r *http.Request) {
	value := strings.TrimSpace(r.URL.Query().Get("url"))
	target, err := url.Parse(value)
	if err != nil || target.Scheme != "https" || target.User != nil || target.RawQuery != "" || target.Fragment != "" ||
		(target.Host != "www.gutenberg.org" && target.Host != "gutenberg.org") || !isSupportedGutenbergPath(target.Path) {
		writeError(w, http.StatusBadRequest, "只允许下载 Project Gutenberg 的 EPUB/TXT 文件")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "下载地址无效")
		return
	}
	request.Header.Set("Accept", "application/epub+zip, text/plain;q=0.9, */*;q=0.1")
	response, err := bookSourceHTTPClient.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, "书籍文件暂时无法下载")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("下载源返回 HTTP %d", response.StatusCode))
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (64<<20)+1))
	if err != nil {
		writeError(w, http.StatusBadGateway, "读取书籍文件失败")
		return
	}
	if len(body) > 64<<20 {
		writeError(w, http.StatusRequestEntityTooLarge, "书籍文件超过 64 MiB")
		return
	}
	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func isSupportedGutenbergPath(path string) bool {
	if !strings.HasPrefix(path, "/ebooks/") {
		return false
	}
	return strings.HasSuffix(path, ".epub3.images") || strings.HasSuffix(path, ".txt.utf-8")
}
