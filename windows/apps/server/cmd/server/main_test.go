package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cbctv2/server/internal/config"
)

type pipes struct {
	stdinReader  *io.PipeReader
	stdinWriter  *io.PipeWriter
	stdoutReader *bufio.Scanner
	stdoutWriter *io.PipeWriter
}

func newPipes() *pipes {
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()
	return &pipes{
		stdinReader:  stdinReader,
		stdinWriter:  stdinWriter,
		stdoutReader: bufio.NewScanner(stdoutReader),
		stdoutWriter: stdoutWriter,
	}
}

func (p *pipes) closeStdin() { _ = p.stdinWriter.Close() }

// readyLine 阻塞读取第一行 CBCT_V2_READY，超时即失败。
func (p *pipes) readyLine(t *testing.T) map[string]any {
	t.Helper()
	type result struct {
		line string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		if p.stdoutReader.Scan() {
			done <- result{line: p.stdoutReader.Text()}
			return
		}
		err := p.stdoutReader.Err()
		if err == nil {
			err = io.EOF
		}
		done <- result{err: err}
	}()
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("读取就绪行失败: %v", got.err)
		}
		if !strings.HasPrefix(got.line, config.ReadyPrefix) {
			t.Fatalf("就绪行前缀不符: %q", got.line)
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(got.line, config.ReadyPrefix)), &payload); err != nil {
			t.Fatalf("就绪信息不是 JSON: %v (%s)", err, got.line)
		}
		return payload
	case <-time.After(20 * time.Second):
		t.Fatal("等待就绪行超时")
		return nil
	}
}

func writeQueueFile(t *testing.T, root string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "queue.json"), []byte(`{"papers":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRestartReusesTokenFromEnvironment(t *testing.T) {
	token := strings.Repeat("restart-token-", 5)
	t.Setenv("CBCT_SERVER_TOKEN", token)
	root := t.TempDir()
	p := newPipes()
	done := make(chan error, 1)
	go func() {
		done <- run([]string{"--data-root", root, "--exit-on-stdin-eof"}, p.stdinReader, p.stdoutWriter)
	}()
	ready := p.readyLine(t)
	p.closeStdin()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restart service did not stop")
	}
	if ready["token"] != token {
		t.Fatal("restart changed the token used by the open reader")
	}
}

func TestRunEmitsReadyServesAndStopsOnStdinEOF(t *testing.T) {
	root := t.TempDir()
	writeQueueFile(t, root)
	devInfo := filepath.Join(root, "app", "data", "v2", "dev-info.json")

	p := newPipes()
	done := make(chan error, 1)
	go func() {
		done <- run([]string{
			"--data-root", root,
			"--dev-info", devInfo,
			"--exit-on-stdin-eof",
		}, p.stdinReader, p.stdoutWriter)
	}()

	payload := p.readyLine(t)
	port, ok := payload["port"].(float64)
	if !ok || port <= 0 {
		t.Fatalf("port 应为已分配端口，实际 %v", payload["port"])
	}
	token, _ := payload["token"].(string)
	if len(token) != config.TokenBytes*2 {
		t.Fatalf("token 长度异常: %d", len(token))
	}
	if payload["dataRoot"] != root {
		t.Fatalf("dataRoot 应为 %v，实际 %v", root, payload["dataRoot"])
	}
	base := fmt.Sprintf("http://127.0.0.1:%d", int(port))

	health, err := http.Get(base + "/healthz")
	if err != nil {
		t.Fatalf("healthz 请求失败: %v", err)
	}
	health.Body.Close()
	if health.StatusCode != http.StatusOK {
		t.Fatalf("healthz 应 200，实际 %d", health.StatusCode)
	}

	anonymous, err := http.Get(base + "/v1/meta")
	if err != nil {
		t.Fatal(err)
	}
	anonymous.Body.Close()
	if anonymous.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无 token 应 401，实际 %d", anonymous.StatusCode)
	}

	request, err := http.NewRequest(http.MethodGet, base+"/v1/meta", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	authed, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(authed.Body)
	authed.Body.Close()
	if authed.StatusCode != http.StatusOK || !strings.Contains(string(body), "cbct-reading-v2") {
		t.Fatalf("带 token 应拿到 meta，实际 %d %s", authed.StatusCode, string(body))
	}

	// dev-info 文件与就绪行一致，Vite proxy 靠它注入 token。
	raw, err := os.ReadFile(devInfo)
	if err != nil {
		t.Fatalf("dev-info 应已写出: %v", err)
	}
	var fromFile map[string]any
	if err := json.Unmarshal(raw, &fromFile); err != nil {
		t.Fatalf("dev-info 不是合法 JSON: %v", err)
	}
	if fromFile["token"] != token || fromFile["port"] != port {
		t.Fatalf("dev-info 与就绪行不一致: %v", fromFile)
	}

	// 父进程关闭 stdin → 服务端应快速优雅退出，端口随后不可用。
	// 计时是硬要求：keep-alive 连接若没被 Shutdown 主动关掉，退出会拖到 IdleTimeout，
	// 表现为「关掉窗口后 server 还占着 SQLite 和端口」。
	p.closeStdin()
	start := time.Now()
	select {
	case err := <-done:
		elapsed := time.Since(start)
		if err != nil {
			t.Fatalf("stdin EOF 后应正常退出，得到错误: %v", err)
		}
		if elapsed > 3*time.Second {
			t.Fatalf("退出应在 3s 内完成，实际耗时 %s", elapsed)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("stdin 关闭后未在超时内退出（会留下孤儿进程）")
	}

	if extra, err := http.Get(base + "/healthz"); err == nil {
		extra.Body.Close()
		t.Fatalf("退出后端口不应再接受请求，实际状态 %d", extra.StatusCode)
	}
}

func TestRunRejectsBadFlags(t *testing.T) {
	root := t.TempDir()
	writeQueueFile(t, root)
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"非回环地址", []string{"--host", "0.0.0.0", "--data-root", root}, "回环"},
		{"过短 token", []string{"--token", "abc", "--data-root", root}, "太短"},
		{"缺失数据根", []string{"--data-root", filepath.Join(root, "nope")}, "数据根"},
		{"静态目录不存在", []string{"--data-root", root, "--static", filepath.Join(root, "dist")}, "静态目录"},
		{"多余位置参数", []string{"--data-root", root, "extra"}, "位置参数"},
		{"未知 flag", []string{"--nope"}, "flag"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := run(c.args, emptyReader(), io.Discard)
			if err == nil {
				t.Fatalf("应启动失败并含 %q", c.want)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("错误信息应含 %q，实际 %q", c.want, err.Error())
			}
		})
	}
}

func TestEmitReadyIsSingleLine(t *testing.T) {
	reader, writer := io.Pipe()
	scanner := bufio.NewScanner(reader)
	var err error
	done := make(chan struct{})
	go func() {
		defer close(done)
		err = emitReady(writer, map[string]any{"port": 1, "token": "abc"})
		// 写完即关闭：否则第二次 Scan 会一直等下去（管道不会自己 EOF）。
		_ = writer.Close()
	}()
	if !scanner.Scan() {
		t.Fatal("应有一行输出")
	}
	line := scanner.Text()
	<-done
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(line, config.ReadyPrefix) {
		t.Fatalf("前缀不符: %q", line)
	}
	if scanner.Scan() {
		t.Fatalf("就绪协议只允许一行，多余内容 %q", scanner.Text())
	}
	if scanErr := scanner.Err(); scanErr != nil && !errors.Is(scanErr, io.EOF) {
		t.Fatalf("读取就绪行报错: %v", scanErr)
	}
}

func TestWriteDevInfoIsAtomicAndReadable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "dev-info.json")
	if err := writeDevInfo(path, map[string]any{"port": float64(4321), "token": "t"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("dev-info 必须立即可解析: %v", err)
	}
	if payload["port"] != float64(4321) {
		t.Fatalf("内容不符: %v", payload)
	}
	if _, err := os.Stat(path + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("临时文件应已被重命名清理")
	}
}

func emptyReader() io.Reader {
	reader, writer := io.Pipe()
	go writer.Close()
	return reader
}
