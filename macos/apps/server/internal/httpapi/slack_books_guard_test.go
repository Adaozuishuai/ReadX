package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// TestBookSourceClientBlocksLoopbackTarget：slack_books 的出网客户端此前对
// 回环/私网目标不做任何拦截（只有重定向主机白名单）；接入共享防护后必须拒绝。
// 注入 nil proxy 做确定性验证：环境里配置了系统代理时，包级变量会把回环请求
// 经由用户代理转发（booksources 既有的「信任显式代理」规则），无法直接断言。
func TestBookSourceClientBlocksLoopbackTarget(t *testing.T) {
	client := newBookSourceClient(nil)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer srv.Close()
	req, err := http.NewRequest(http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Do(req)
	if err == nil {
		t.Fatal("出网客户端必须拒绝回环目标")
	}
	if !strings.Contains(err.Error(), "内网") && !strings.Contains(err.Error(), "公网") {
		t.Fatalf("应是网段防护拦截而非连接错误: %v", err)
	}
}

// TestPublicRedirectNoDowngrade：https 起始的导入重定向链不得降级到 http
// （publications 旧行为允许降级）；http 起始与 https→https 不受影响。
func TestPublicRedirectNoDowngrade(t *testing.T) {
	httpsStart := []*http.Request{{URL: &url.URL{Scheme: "https", Host: "example.com"}}}
	httpStart := []*http.Request{{URL: &url.URL{Scheme: "http", Host: "example.com"}}}
	httpHop := &http.Request{URL: &url.URL{Scheme: "http", Host: "example.com"}}
	httpsHop := &http.Request{URL: &url.URL{Scheme: "https", Host: "example.com"}}

	if err := publicRedirectCheck(httpsStart, httpHop); err == nil {
		t.Fatal("https → http 降级应被拒绝")
	}
	if err := publicRedirectCheck(httpsStart, httpsHop); err != nil {
		t.Fatalf("https → https 应放行: %v", err)
	}
	if err := publicRedirectCheck(httpStart, httpsHop); err != nil {
		t.Fatalf("http → https 升级应放行: %v", err)
	}
	if err := publicRedirectCheck(httpStart, httpHop); err != nil {
		t.Fatalf("http 起始的既有行为应保持: %v", err)
	}

	via := make([]*http.Request, 6)
	for i := range via {
		via[i] = httpsHop
	}
	if err := publicRedirectCheck(via, httpsHop); err == nil {
		t.Fatal("超过 5 次重定向应被拒绝")
	}
	badScheme := &http.Request{URL: &url.URL{Scheme: "file", Host: ""}}
	if err := publicRedirectCheck(httpStart, badScheme); err == nil {
		t.Fatal("非 http(s) 协议应被 validateRemoteURL 拒绝")
	}
}
