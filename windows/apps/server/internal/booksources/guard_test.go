package booksources

import (
	"context"
	"net"
	"testing"
	"time"
)

// TestPublicIPSharedReservedTable 锁定四处出网客户端共享的网段判定表。
// publications 的旧实现缺 CGNAT/TEST-NET/240.0.0.0/4 等网段——接入共享表后
// 任何一处网段改动，所有出网点同时生效，并在这里被看见。
func TestPublicIPSharedReservedTable(t *testing.T) {
	blocked := []string{
		"10.0.0.1", "172.16.0.1", "192.168.1.1", // RFC1918
		"127.0.0.1",                                // 回环
		"169.254.169.254",                          // 链路本地（云元数据）
		"100.64.0.1",                               // CGNAT —— publications 旧实现放行的网段
		"192.0.2.1", "198.51.100.1", "203.0.113.1", // TEST-NET
		"198.18.0.1",                // benchmarking
		"240.0.0.1",                 // reserved
		"::1", "fe80::1", "fc00::1", // IPv6 回环/链路本地/ULA
		"2001:db8::1",          // 文档网段
		"64:ff9b::c000:201",    // NAT64
		"224.0.0.1", "ff0e::1", // 组播
	}
	for _, s := range blocked {
		if PublicIP(net.ParseIP(s)) {
			t.Errorf("PublicIP(%s) = true, want false", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"} {
		if !PublicIP(net.ParseIP(s)) {
			t.Errorf("PublicIP(%s) = false, want true", s)
		}
	}
}

// TestDialPublicGuardBlocksNonPublicTargets：非公网目标在拨号前即被拒——
// slack_books 的旧实现完全没有这层检查。
func TestDialPublicGuardBlocksNonPublicTargets(t *testing.T) {
	dial := DialPublicGuard(2*time.Second, nil)
	for _, addr := range []string{
		"10.0.0.1:80",    // 私网字面量
		"100.64.0.1:443", // CGNAT 字面量（不可路由——若未被表拦截会等到拨号超时）
		"127.0.0.1:8080", // 回环字面量
		"[::1]:80",       // IPv6 回环
		"localhost:80",   // 域名解析到回环 → 拒绝
	} {
		start := time.Now()
		conn, err := dial(context.Background(), "tcp", addr)
		if conn != nil {
			conn.Close()
		}
		if err == nil {
			t.Fatalf("DialPublicGuard(%s) 意外放行", addr)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("DialPublicGuard(%s) 应在拨号前被拒（耗时 %s）: %v", addr, elapsed, err)
		}
	}
}
