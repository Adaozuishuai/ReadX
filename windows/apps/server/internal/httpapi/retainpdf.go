package httpapi

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
)

// RetainPDFClient adapts ReadX document processing to RetainPDF's public local API.
// Credentials stay in the two local applications and are sent only to loopback.
type RetainPDFClient struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

type retainRuntime struct {
	APIBase string `json:"api_base"`
	APIKey  string `json:"api_key"`
}

type retainEnvelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type retainJobDetail struct {
	JobID          string `json:"job_id"`
	Status         string `json:"status"`
	Error          string `json:"error"`
	CompletionNote string `json:"completion_note"`
	Failure        *struct {
		Summary string `json:"summary"`
	} `json:"failure"`
	StageSnapshot  *struct {
		DisplayStage string `json:"display_stage"`
		Stage        string `json:"stage"`
		StageDetail  string `json:"stage_detail"`
		Progress     *struct {
			Current int    `json:"current"`
			Total   int    `json:"total"`
			Unit    string `json:"unit"`
		} `json:"progress"`
	} `json:"stage_snapshot"`
	BookSummary *struct {
		PageCount *int `json:"page_count"`
	} `json:"book_summary"`
}

type retainJobSubmission struct {
	JobID string `json:"job_id"`
}

type retainUpload struct {
	UploadID string `json:"upload_id"`
}

type retainProgress struct {
	Stage   string
	Message string
	Current int
	Total   int
	Unit    string
	Pages   int
}

func newRetainPDFClient() (*RetainPDFClient, error) {
	base := strings.TrimSpace(os.Getenv("RETAINPDF_API_BASE"))
	key := strings.TrimSpace(os.Getenv("RETAINPDF_API_KEY"))
	if base == "" || key == "" {
		home := strings.TrimSpace(os.Getenv("RETAINPDF_HOME"))
		runtimePath := ""
		if home != "" {
			runtimePath = filepath.Join(home, "run", "backend.json")
		} else if home = strings.TrimSpace(os.Getenv("USERPROFILE")); home != "" {
			runtimePath = filepath.Join(home, ".retainpdf", "run", "backend.json")
		} else {
			return nil, errors.New("未找到 RetainPDF 运行配置；请先启动 RetainPDF 桌面端")
		}
		raw, err := os.ReadFile(runtimePath)
		if err != nil {
			return nil, errors.New("RetainPDF 后台未运行；请先启动 RetainPDF 桌面端")
		}
		var runtime retainRuntime
		if err := json.Unmarshal(raw, &runtime); err != nil {
			return nil, fmt.Errorf("RetainPDF 运行配置无效: %w", err)
		}
		if base == "" {
			base = runtime.APIBase
		}
		if key == "" {
			key = runtime.APIKey
		}
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("RetainPDF API 地址无效")
	}
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, errors.New("RetainPDF API 必须运行在本机回环地址")
	}
	if key == "" {
		return nil, errors.New("RetainPDF 运行配置缺少本机访问密钥")
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
	}
	return &RetainPDFClient{
		baseURL: strings.TrimRight(base, "/"),
		apiKey:  key,
		http: &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (c *RetainPDFClient) request(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-API-Key", c.apiKey)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return c.http.Do(req)
}

func (c *RetainPDFClient) jsonRequest(ctx context.Context, method, path string, payload any, target any) error {
	var body io.Reader
	contentType := ""
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
		contentType = "application/json"
	}
	response, err := c.request(ctx, method, path, body, contentType)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var envelope retainEnvelope
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&envelope); err != nil {
		return fmt.Errorf("RetainPDF 返回无效响应: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || envelope.Code != 0 {
		message := strings.TrimSpace(envelope.Message)
		if message == "" {
			message = response.Status
		}
		return fmt.Errorf("RetainPDF 请求失败: %s", message)
	}
	if target != nil && len(envelope.Data) > 0 {
		if err := json.Unmarshal(envelope.Data, target); err != nil {
			return fmt.Errorf("RetainPDF 响应格式无效: %w", err)
		}
	}
	return nil
}

func (c *RetainPDFClient) upload(ctx context.Context, filename string, pdf []byte) (string, error) {
	reader, pipe := io.Pipe()
	writer := multipart.NewWriter(pipe)
	writeDone := make(chan error, 1)
	go func() {
		part, err := writer.CreateFormFile("file", filepath.Base(filename))
		if err == nil {
			_, err = part.Write(pdf)
		}
		if closeErr := writer.Close(); err == nil {
			err = closeErr
		}
		_ = pipe.CloseWithError(err)
		writeDone <- err
	}()
	response, err := c.request(ctx, http.MethodPost, "/api/v1/uploads", reader, writer.FormDataContentType())
	if err != nil {
		_ = reader.CloseWithError(err)
		<-writeDone
		return "", fmt.Errorf("连接 RetainPDF 上传接口失败: %w", err)
	}
	defer response.Body.Close()
	if writeErr := <-writeDone; writeErr != nil {
		return "", fmt.Errorf("上传 PDF 到 RetainPDF 失败: %w", writeErr)
	}
	var envelope retainEnvelope
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&envelope); err != nil {
		return "", fmt.Errorf("RetainPDF 上传响应无效: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || envelope.Code != 0 {
		return "", fmt.Errorf("RetainPDF 上传失败: %s", strings.TrimSpace(envelope.Message))
	}
	var upload retainUpload
	if err := json.Unmarshal(envelope.Data, &upload); err != nil || upload.UploadID == "" {
		return "", errors.New("RetainPDF 上传响应缺少 upload_id")
	}
	return upload.UploadID, nil
}

func (c *RetainPDFClient) translationConfig(dataRoot string) (map[string]any, error) {
	config, err := ai.LoadConfig(filepath.Join(dataRoot, "app", "config.json"))
	if err != nil {
		return nil, err
	}
	if config.IsCLI() {
		return nil, errors.New("RetainPDF 的整本翻译需要 HTTP API 模型配置；当前 AI 助教是本机 CLI 模式，请在 ReadX AI 设置中选择已配置 API 的模型渠道")
	}
	if !config.Ready() {
		return nil, errors.New("请先在 ReadX AI 助手设置中配置可用的翻译模型 API")
	}
	protocol := "openai"
	if config.ProviderName() == "anthropic" {
		protocol = "anthropic"
	}
	baseURL := strings.TrimRight(config.PublicBaseURL(), "/")
	if protocol == "anthropic" {
		baseURL = strings.TrimSuffix(baseURL, "/messages")
	} else {
		baseURL = strings.TrimSuffix(baseURL, "/chat/completions")
	}
	thinking := strings.ToLower(strings.TrimSpace(config.ReasoningEffort))
	switch thinking {
	case "", "auto", "off", "low", "medium", "high", "max":
		if thinking == "" {
			thinking = "auto"
		}
	case "xhigh", "ultra":
		thinking = "max"
	default:
		thinking = "auto"
	}
	return map[string]any{
		"base_url":     baseURL,
		"api_key":      config.APIKey,
		"model":        config.ModelName(),
		"api_protocol": protocol,
		"thinking":     thinking,
		"mode":         "sci",
		"math_mode":    "direct_typst",
		"workers":      0,
		"batch_size":   1,
	}, nil
}

func (c *RetainPDFClient) runBook(ctx context.Context, filename string, pdf []byte, dataRoot string, progress func(retainProgress)) ([]byte, error) {
	translation, err := c.translationConfig(dataRoot)
	if err != nil {
		return nil, err
	}
	ocrConfig, err := loadOCRConfigForRoot(dataRoot)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(ocrConfig.Token) == "" {
		return nil, errors.New("请先在 ReadX AI 助手设置中配置 OCR 令牌")
	}
	provider := strings.ToLower(strings.TrimSpace(ocrConfig.Provider))
	if provider == "" {
		provider = "paddle"
	}
	ocrPayload := map[string]any{"provider": provider, "language": "ch", "disable_formula": false, "disable_table": false}
	switch provider {
	case "paddle":
		ocrPayload["paddle_token"] = ocrConfig.Token
		ocrPayload["paddle_api_url"] = ocrConfig.BaseURL
		ocrPayload["paddle_model"] = ocrConfig.Model
	case "mineru":
		ocrPayload["mineru_token"] = ocrConfig.Token
	default:
		return nil, fmt.Errorf("RetainPDF 不支持 ReadX 当前 OCR 服务商 %q", provider)
	}
	uploadID, err := c.upload(ctx, filename, pdf)
	if err != nil {
		return nil, err
	}
	jobPayload := map[string]any{
		"workflow": "book",
		"source":   map[string]any{"upload_id": uploadID},
		"ocr":         ocrPayload,
		"translation": translation,
		"render":      map[string]any{"render_mode": "auto"},
	}
	var submission retainJobSubmission
	if err := c.jsonRequest(ctx, http.MethodPost, "/api/v1/jobs", jobPayload, &submission); err != nil {
		return nil, err
	}
	if submission.JobID == "" {
		return nil, errors.New("RetainPDF 未返回任务 ID")
	}
	jobID := submission.JobID
	defer func() {
		if ctx.Err() != nil {
			cancelCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			response, err := c.request(cancelCtx, http.MethodPost, "/api/v1/jobs/"+url.PathEscape(jobID)+"/actions/cancel", bytes.NewReader([]byte("{}")), "application/json")
			if err == nil {
				response.Body.Close()
			}
		}
	}()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		var detail retainJobDetail
		if err := c.jsonRequest(ctx, http.MethodGet, "/api/v1/jobs/"+url.PathEscape(jobID), nil, &detail); err != nil {
			return nil, err
		}
		if progress != nil {
			stage, message, current, total := "translation", "RetainPDF 正在处理论文", 0, 0
			unit := ""
			pages := 0
			if detail.StageSnapshot != nil {
				stage = detail.StageSnapshot.Stage
				if stage == "" {
					stage = detail.StageSnapshot.DisplayStage
				}
				message = strings.TrimSpace(detail.StageSnapshot.StageDetail)
				if detail.StageSnapshot.Progress != nil {
					current, total = detail.StageSnapshot.Progress.Current, detail.StageSnapshot.Progress.Total
					unit = detail.StageSnapshot.Progress.Unit
				}
			}
			if detail.BookSummary != nil && detail.BookSummary.PageCount != nil {
				pages = *detail.BookSummary.PageCount
			}
			progress(retainProgress{Stage: stage, Message: message, Current: current, Total: total, Unit: unit, Pages: pages})
		}
		switch strings.ToLower(detail.Status) {
		case "succeeded":
			return c.downloadPDF(ctx, jobID)
		case "failed", "canceled", "cancelled", "stopped":
			message := strings.TrimSpace(detail.Error)
			if message == "" {
				message = strings.TrimSpace(detail.CompletionNote)
			}
			if message == "" && detail.Failure != nil {
				message = strings.TrimSpace(detail.Failure.Summary)
			}
			if message == "" {
				message = "任务已" + detail.Status
			}
			return nil, fmt.Errorf("RetainPDF 处理失败: %s", message)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (c *RetainPDFClient) downloadPDF(ctx context.Context, jobID string) ([]byte, error) {
	response, err := c.request(ctx, http.MethodGet, "/api/v1/jobs/"+url.PathEscape(jobID)+"/pdf", nil, "")
	if err != nil {
		return nil, fmt.Errorf("读取 RetainPDF 译文 PDF 失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("RetainPDF 没有可用的译文 PDF: %s", strings.TrimSpace(string(body)))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxPublicationBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxPublicationBytes {
		return nil, fmt.Errorf("RetainPDF 译文 PDF 超过 ReadX %d MB 文件上限", maxPublicationBytes>>20)
	}
	if !isPDFData(data) {
		return nil, errors.New("RetainPDF 返回内容不是有效 PDF")
	}
	return data, nil
}

func saveRetainPDFOutput(libraryDir, key string, data []byte) error {
	if !isPDFData(data) {
		return errors.New("RetainPDF 返回内容不是有效 PDF")
	}
	if err := os.MkdirAll(libraryDir, 0o755); err != nil {
		return fmt.Errorf("创建书库目录失败: %w", err)
	}
	target := filepath.Join(libraryDir, key+"-translated.pdf")
	file, err := os.CreateTemp(libraryDir, ".retainpdf-output-*")
	if err != nil {
		return fmt.Errorf("创建译文 PDF 临时文件失败: %w", err)
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if _, err := file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("写入译文 PDF 失败: %w", err)
	}
	if err := os.Rename(temporary, target); err != nil {
		return fmt.Errorf("保存译文 PDF 失败: %w", err)
	}
	return nil
}
