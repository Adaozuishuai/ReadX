package ocr

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

const (
	MinerUBaseURL      = "https://mineru.net"
	MinerUDefaultModel = "vlm"
	MinerUMaxPDFBytes  = 200 << 20
	MinerUMaxPDFPages  = 200
)

func NewMinerU(baseURL, token, model string) *Client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = MinerUBaseURL
	}
	if strings.TrimSpace(model) == "" {
		model = MinerUDefaultModel
	}
	client := New(baseURL, token, model)
	client.Provider = "mineru"
	return client
}

// MapLayouts retains each provider's native geometry and translation policy.
func (c *Client) MapLayouts(ctx context.Context, raw []json.RawMessage, sizes []Size) ([]Page, error) {
	if c.Provider != "mineru" {
		return MapLayoutsContext(ctx, raw, sizes)
	}
	if len(sizes) > 0 && len(raw) != len(sizes) {
		return nil, fmt.Errorf("MinerU 返回 %d 页，原 PDF 有 %d 页，无法可靠对齐页面", len(raw), len(sizes))
	}
	document, err := normalizeWithLeeProvider(ctx, raw, sizes, "mineru", c.Model)
	if err != nil {
		return nil, err
	}
	return projectLeeDocument(document)
}

type mineruResponse struct {
	Code json.RawMessage `json:"code"`
	Msg  string          `json:"msg"`
	Data struct {
		BatchID       string   `json:"batch_id"`
		FileURLs      []string `json:"file_urls"`
		ExtractResult []struct {
			FileName string `json:"file_name"`
			State    string `json:"state"`
			ZipURL   string `json:"full_zip_url"`
			Error    string `json:"err_msg"`
		} `json:"extract_result"`
	} `json:"data"`
}

func (c *Client) mineruJSON(ctx context.Context, method, endpoint string, payload any) (mineruResponse, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return mineruResponse{}, err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.BaseURL+endpoint, body)
	if err != nil {
		return mineruResponse{}, err
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.HTTP.Do(request)
	if err != nil {
		return mineruResponse{}, fmt.Errorf("请求 MinerU 失败: %w", err)
	}
	defer response.Body.Close()
	var result mineruResponse
	err = json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&result)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return mineruResponse{}, fmt.Errorf("MinerU 服务返回 HTTP %d：%s", response.StatusCode, result.Msg)
	}
	if err != nil {
		return mineruResponse{}, fmt.Errorf("MinerU 返回的不是合法 JSON: %w", err)
	}
	if string(result.Code) != "0" {
		return mineruResponse{}, fmt.Errorf("MinerU 任务失败（%s）：%s", result.Code, result.Msg)
	}
	return result, nil
}

func (c *Client) mineruLayouts(ctx context.Context, pdf []byte, filename string) ([]json.RawMessage, error) {
	if len(pdf) == 0 {
		return nil, errors.New("PDF 为空")
	}
	if len(pdf) > MinerUMaxPDFBytes {
		return nil, errors.New("PDF 超过 MinerU 上传上限 200 MB")
	}
	if c.Token == "" {
		return nil, errors.New("尚未配置 MinerU 令牌")
	}
	if filename == "" {
		filename = "document.pdf"
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	result, err := c.mineruJSON(ctx, http.MethodPost, "/api/v4/file-urls/batch", map[string]any{
		"files":         []map[string]any{{"name": filename, "is_ocr": true}},
		"model_version": c.Model, "language": "ch", "enable_formula": true, "enable_table": true,
	})
	if err != nil {
		return nil, err
	}
	if result.Data.BatchID == "" || len(result.Data.FileURLs) != 1 {
		return nil, errors.New("MinerU 没有返回任务编号或文件上传地址")
	}
	// Presigned object-store URLs must never receive the MinerU API token.
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, result.Data.FileURLs[0], bytes.NewReader(pdf))
	if err != nil {
		return nil, err
	}
	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, fmt.Errorf("上传 MinerU 文件失败: %w", err)
	}
	response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("上传 MinerU 文件失败：HTTP %d", response.StatusCode)
	}
	c.notifyState("submitted")
	batchID := result.Data.BatchID
	interval := c.PollInterval
	if interval <= 0 {
		interval = pollEvery
	}
	for {
		result, err := c.mineruJSON(ctx, http.MethodGet, "/api/v4/extract-results/batch/"+url.PathEscape(batchID), nil)
		if err != nil {
			return nil, err
		}
		for _, item := range result.Data.ExtractResult {
			if item.FileName != filename {
				continue
			}
			c.notifyState(item.State)
			switch item.State {
			case "done":
				if item.ZipURL == "" {
					return nil, errors.New("MinerU 任务完成但没有结果地址")
				}
				return c.downloadMinerU(ctx, item.ZipURL)
			case "failed", "cancelled", "canceled":
				return nil, fmt.Errorf("MinerU 识别失败：%s", item.Error)
			}
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (c *Client) downloadMinerU(ctx context.Context, zipURL string) ([]json.RawMessage, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, zipURL, nil)
	if err != nil {
		return nil, err
	}
	response, err := c.HTTP.Do(request)
	if err != nil {
		return nil, fmt.Errorf("下载 MinerU 结果失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载 MinerU 结果失败：HTTP %d", response.StatusCode)
	}
	const maxBundle = 512 << 20
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBundle+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxBundle {
		return nil, errors.New("MinerU 结果包超过 512 MB")
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("MinerU 结果不是有效 ZIP: %w", err)
	}
	for _, file := range archive.File {
		name := strings.ToLower(path.Base(file.Name))
		if name != "layout.json" && name != "middle.json" && !strings.HasSuffix(name, "_middle.json") {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return nil, err
		}
		var layout struct {
			Pages []json.RawMessage `json:"pdf_info"`
		}
		err = json.NewDecoder(io.LimitReader(reader, 64<<20)).Decode(&layout)
		reader.Close()
		if err != nil {
			return nil, fmt.Errorf("解析 MinerU 版式失败: %w", err)
		}
		if len(layout.Pages) > 0 {
			return layout.Pages, nil
		}
	}
	return nil, errors.New("MinerU 结果包没有包含页面的 layout.json 或 middle.json")
}
