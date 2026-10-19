package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type ReasoningOption struct {
	Effort      string `json:"reasoningEffort"`
	Description string `json:"description"`
}
type CodexModel struct {
	ID               string            `json:"id"`
	Model            string            `json:"model"`
	DisplayName      string            `json:"displayName"`
	Description      string            `json:"description"`
	DefaultEffort    string            `json:"defaultReasoningEffort"`
	SupportedEfforts []ReasoningOption `json:"supportedReasoningEfforts"`
	IsDefault        bool              `json:"isDefault"`
}

var codexCatalog struct {
	sync.Mutex
	models []CodexModel
	at     time.Time
	bin    string
}

// Metadata-only RPC. No conversation or inference turn is created.
func (c Config) CodexModels(ctx context.Context, refresh bool) ([]CodexModel, error) {
	bin, _, err := resolveCLI("codex")
	if err != nil {
		return nil, err
	}
	codexCatalog.Lock()
	defer codexCatalog.Unlock()
	if !refresh && codexCatalog.bin == bin && time.Since(codexCatalog.at) < time.Minute && len(codexCatalog.models) > 0 {
		return codexCatalog.models, nil
	}
	if c.tempRoot != "" {
		if err := os.MkdirAll(c.tempRoot, 0700); err != nil {
			return nil, err
		}
	}
	dir, err := os.MkdirTemp(c.tempRoot, "codex-catalog-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	args := []string{"app-server", "--listen", "stdio://"}
	for _, key := range []string{"sqlite_home", "log_dir"} {
		value, _ := json.Marshal(filepath.Clean(dir))
		args = append(args, "-c", key+"="+string(value))
	}
	cmd, err := cliCommand(ctx, "codex", args)
	if err != nil {
		return nil, err
	}
	cmd.Dir, cmd.Env = dir, cliEnvironment("codex", dir)
	configureCLIEnvironment(cmd)
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		return nil, fmt.Errorf("无法启动 Codex 模型目录服务")
	}
	defer func() { _ = stdin.Close(); _ = terminateCLIProcess(cmd); _ = cmd.Wait() }()
	encoder := json.NewEncoder(stdin)
	send := func(id int, method string, params any) error {
		return encoder.Encode(map[string]any{"id": id, "method": method, "params": params})
	}
	if err = send(0, "initialize", map[string]any{"clientInfo": map[string]string{"name": "cbct_reading", "title": "ReadX", "version": "0.1.0"}}); err != nil {
		return nil, err
	}
	scan := bufio.NewScanner(stdout)
	scan.Buffer(make([]byte, 64<<10), 8<<20)
	models := []CodexModel{}
	requestID := 0
	for scan.Scan() {
		var message struct {
			ID    json.RawMessage `json:"id"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
			Result struct {
				Data       []CodexModel `json:"data"`
				NextCursor *string      `json:"nextCursor"`
			} `json:"result"`
		}
		if json.Unmarshal(scan.Bytes(), &message) != nil || string(message.ID) != fmt.Sprint(requestID) {
			continue
		}
		if message.Error != nil {
			return nil, fmt.Errorf("Codex 模型目录读取失败，请确认桌面版已登录")
		}
		if requestID == 0 {
			if err = encoder.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
				return nil, err
			}
			requestID++
			if err = send(requestID, "model/list", map[string]any{"limit": 100, "includeHidden": false}); err != nil {
				return nil, err
			}
			continue
		}
		for _, model := range message.Result.Data {
			if model.Model != "" {
				models = append(models, model)
			}
		}
		if message.Result.NextCursor == nil || *message.Result.NextCursor == "" || len(models) >= 500 {
			if len(models) == 0 {
				return nil, fmt.Errorf("Codex 暂未返回模型，请刷新目录")
			}
			codexCatalog.models, codexCatalog.at, codexCatalog.bin = models, time.Now(), bin
			return models, nil
		}
		requestID++
		if err = send(requestID, "model/list", map[string]any{"limit": 100, "includeHidden": false, "cursor": *message.Result.NextCursor}); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("Codex 模型目录未响应，请确认桌面版已登录后重试")
}

func (c Config) ValidateCodexSelection(ctx context.Context) error {
	if c.ProviderName() != "codex" || (c.Model == "" && c.ReasoningEffort == "") {
		return nil
	}
	models, err := c.CodexModels(ctx, false)
	if err != nil {
		return err
	}
	for _, model := range models {
		if model.Model != c.Model && !(c.Model == "" && model.IsDefault) {
			continue
		}
		if c.ReasoningEffort == "" {
			return nil
		}
		for _, effort := range model.SupportedEfforts {
			if effort.Effort == c.ReasoningEffort {
				return nil
			}
		}
		return fmt.Errorf("该模型不支持推理等级 %s，请重新选择", c.ReasoningEffort)
	}
	return fmt.Errorf("所选模型未出现在当前 Codex 目录中，请刷新后重选")
}

func cliEnvironment(provider, dir string) []string {
	env := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if provider == "codex" && codexHostEnvironment(key) {
			continue
		}
		switch strings.ToUpper(key) {
		case "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "TEMP", "TMP", "TMPDIR":
			continue
		}
		env = append(env, entry)
	}
	return append(env, "TEMP="+dir, "TMP="+dir, "TMPDIR="+dir)
}
