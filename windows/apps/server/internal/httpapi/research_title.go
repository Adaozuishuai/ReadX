package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The destination is fixed. Use the configured proxy (including Windows system
// proxy) without changing the direct-only policy for arbitrary document URLs.
func newResearchTitleClient(proxy func(*http.Request) (*url.URL, error)) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = proxy
	transport.Protocols = new(http.Protocols)
	transport.Protocols.SetHTTP1(true)
	transport.TLSHandshakeTimeout = 5 * time.Second
	transport.ResponseHeaderTimeout = 10 * time.Second
	return &http.Client{
		Transport: transport,
		Timeout:   12 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 3 || request.URL.Scheme != "https" || request.URL.Host != "translate.googleapis.com" || request.URL.User != nil {
				return fmt.Errorf("翻译服务返回了不支持的跳转")
			}
			return nil
		},
	}
}

func (s *Server) handleResearchTitleTranslation(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string `json:"title"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Title) == "" || len([]rune(body.Title)) > 600 {
		writeError(w, http.StatusBadRequest, "标题为空或长度超过限制")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	client := newResearchTitleClient(sourceProxyFromEnvironment)
	defer client.CloseIdleConnections()
	translation, err := translateResearchTitle(ctx, strings.TrimSpace(body.Title), client)
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		var networkError *url.Error
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			writeError(w, http.StatusGatewayTimeout, "标题翻译超时，请检查网络或系统代理后重试")
		case errors.As(err, &networkError):
			writeError(w, http.StatusBadGateway, "暂时无法连接 Google 翻译，请检查网络或系统代理后重试")
		default:
			writeError(w, http.StatusBadGateway, "标题翻译失败："+err.Error())
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"translation": translation})
}

func translateResearchTitle(ctx context.Context, title string, client *http.Client) (string, error) {
	endpoint := "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=" + url.QueryEscape(title)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", sourceBrowserUA)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Google 翻译返回 HTTP %d，请稍后重试", response.StatusCode)
	}
	const limit = 128 << 10
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return "", err
	}
	if len(raw) > limit {
		return "", fmt.Errorf("翻译结果超过大小限制")
	}
	var result []json.RawMessage
	if json.Unmarshal(raw, &result) != nil || len(result) == 0 {
		return "", fmt.Errorf("标题翻译结果无法解析")
	}
	var segments [][]json.RawMessage
	if json.Unmarshal(result[0], &segments) != nil {
		return "", fmt.Errorf("标题翻译结果无法解析")
	}
	var translation strings.Builder
	for _, segment := range segments {
		if len(segment) == 0 {
			continue
		}
		var text string
		if json.Unmarshal(segment[0], &text) == nil {
			translation.WriteString(text)
		}
	}
	translated := strings.TrimSpace(translation.String())
	if translated == "" {
		return "", fmt.Errorf("标题翻译结果为空")
	}
	return translated, nil
}
