package httpapi

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// 用户导入的 Legado 书源页面与封面代理。
//
// 安全边界：
//   - 仅接受公网 HTTPS 地址；
//   - 重定向仍限于公网 HTTPS，并在 DNS 解析后拦截私网目标；
//   - 响应最多 8 MiB；不携带本地凭据，不读取文件系统。

const (
	maxSourcePageBytes = 8 << 20

	sourceBrowserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
		"(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

func blockUnsafeAddress(_ string, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("无法解析目标地址")
	}
	addr, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return fmt.Errorf("无法解析目标地址")
	}
	addr = addr.Unmap()
	if addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsUnspecified() || addr.IsMulticast() {
		return fmt.Errorf("目标地址不可访问")
	}
	if addr.Is4() {
		octets := addr.As4()
		// 100.64.0.0/10 (CGNAT) 经常出现在云内网里，IsPrivate 不覆盖。
		if octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127 {
			return fmt.Errorf("目标地址不可访问")
		}
	}
	return nil
}

var webSourceHTTPClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
			Control:   blockUnsafeAddress,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
	},
	CheckRedirect: func(request *http.Request, via []*http.Request) error {
		if len(via) >= 8 {
			return fmt.Errorf("Legado 书源重定向次数过多")
		}
		if _, err := validatePublicWebURL(request.URL.String()); err != nil {
			return fmt.Errorf("Legado 书源重定向到了不允许的地址")
		}
		return nil
	},
}

// validatePublicWebURL 用于「中文连载书源」：主机由用户导入的书源决定，无法预先
// 白名单，但必须是公网 HTTPS。私网/回环地址由 Dialer.Control 在 DNS 解析后兜底拦截。
func validatePublicWebURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, fmt.Errorf("书源地址必须是 https URL")
	}
	if parsed.User != nil {
		return nil, fmt.Errorf("书源地址不能包含用户名或密码")
	}
	host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
	if host == "" || net.ParseIP(host) != nil || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return nil, fmt.Errorf("不允许访问该主机")
	}
	return parsed, nil
}

func (s *Server) handleSlackWebSourceFetch(w http.ResponseWriter, r *http.Request) {
	mode := strings.TrimSpace(r.URL.Query().Get("mode"))
	if mode != "page" && mode != "image" {
		writeError(w, http.StatusBadRequest, "mode 只能是 page / image")
		return
	}
	target, err := validatePublicWebURL(r.URL.Query().Get("url"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "书源地址无效")
		return
	}
	host := strings.ToLower(target.Hostname())
	request.Header.Set("User-Agent", sourceBrowserUA)
	request.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	request.Header.Set("Referer", "https://"+host+"/")
	if mode == "image" {
		request.Header.Set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
	} else {
		request.Header.Set("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
	}

	response, err := webSourceHTTPClient.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, "书源暂时无法连接")
		return
	}
	defer response.Body.Close()
	w.Header().Set("X-Readx-Upstream-Host", host)
	w.Header().Set("X-Readx-Upstream-Status", strconv.Itoa(response.StatusCode))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("书源返回 HTTP %d", response.StatusCode))
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxSourcePageBytes+1))
	if err != nil {
		writeError(w, http.StatusBadGateway, "读取书源页面失败")
		return
	}
	if len(body) > maxSourcePageBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "书源页面超过 8 MiB")
		return
	}
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "text/html; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if mode == "image" {
		w.Header().Set("Cache-Control", "private, max-age=3600")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
