package ai

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestAnthropicStreamingCompletionAndTruncation(t *testing.T) {
	for _, stop := range []string{"end_turn", "max_tokens", ""} {
		t.Run(stop, func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "secret" || r.Header.Get("anthropic-version") == "" {
					t.Error("protocol headers/path missing")
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["system"] != "system" || body["stream"] != true {
					t.Error(body)
				}
				fmt.Fprintln(w, `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}`)
				if stop != "" {
					fmt.Fprintf(w, "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":%q}}\ndata: {\"type\":\"message_stop\"}\n", stop)
				}
			}))
			defer up.Close()
			var delta string
			answer, err := NewClient(Config{Provider: "anthropic", BaseURL: up.URL + "/v1", APIKey: "secret", Model: "fixture"}).Stream(context.Background(), []Message{{Role: "system", Content: "system"}, {Role: "user", Content: "question"}}, 0, func(s string) { delta += s })
			if answer != "hello" || delta != "hello" {
				t.Fatalf("lost deltas: %s %s", answer, delta)
			}
			if (stop == "end_turn") != (err == nil) {
				t.Fatalf("stop %q error %v", stop, err)
			}
		})
	}
}
func TestCLIHelperProcess(t *testing.T) {
	if os.Getenv("CBCT_TEST_HELPER_PROCESS") != "1" {
		return
	}
	fmt.Print(os.Getenv("CBCT_TEST_CLI_EVENTS"))
	os.Exit(0)
}

func TestCodexAppServerHelperProcess(t *testing.T) {
	if os.Getenv("CBCT_TEST_CODEX_APPSERVER") != "1" {
		return
	}
	encoder := json.NewEncoder(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Model          string         `json:"model"`
				Effort         string         `json:"effort"`
				Sandbox        string         `json:"sandbox"`
				ApprovalPolicy string         `json:"approvalPolicy"`
				Config         map[string]any `json:"config"`
			} `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			os.Exit(2)
		}
		switch request.Method {
		case "initialize":
			_ = encoder.Encode(map[string]any{"id": request.ID, "result": map[string]any{}})
		case "thread/start":
			config := request.Params.Config
			if request.Params.Sandbox != "read-only" || request.Params.ApprovalPolicy != "never" || config["features.shell_tool"] != false {
				os.Exit(3)
			}
			_ = encoder.Encode(map[string]any{"id": request.ID, "result": map[string]any{"thread": map[string]string{"id": "test-thread"}}})
		case "turn/start":
			if request.Params.Model != "gpt-6.1-sol" || request.Params.Effort != "high" {
				os.Exit(4)
			}
			_ = encoder.Encode(map[string]any{"id": request.ID, "result": map[string]any{}})
			_ = encoder.Encode(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{"delta": "hello"}})
			_ = encoder.Encode(map[string]any{"method": "item/completed", "params": map[string]any{"item": map[string]string{"type": "agentMessage", "text": "hello"}}})
			_ = encoder.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{"turn": map[string]any{"status": "completed", "items": []any{map[string]string{"type": "agentMessage", "text": "hello"}}}}})
		}
	}
	os.Exit(0)
}
func TestEndpointCredentialsAreNotExposed(t *testing.T) {
	cfg := Config{BaseURL: "https://user:password@api.test/v1?api_key=secret#secret", APIKey: "real-key"}
	if _, err := cfg.Endpoint(); err == nil {
		t.Fatal("credential-bearing endpoint accepted")
	}
	raw, _ := json.Marshal(map[string]any{"status": cfg.Redact(), "baseURL": cfg.PublicBaseURL()})
	for _, secret := range []string{"password", "api_key", "real-key", "secret"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("credential exposed: %s", raw)
		}
	}
}
func TestCLIAdaptersOnlyReturnAssistantOutputAndRequireCompletion(t *testing.T) {
	cases := []struct {
		name, events, want string
		success            bool
	}{
		{"claude", "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}}\n{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"hello\"}\n", "hello", true},
		{"kimi", "{\"role\":\"tool\",\"content\":\"private log\"}\n{\"role\":\"assistant\",\"content\":\"hello\"}\n", "hello", true},
	}
	for index, tc := range cases {
		t.Run(fmt.Sprintf("%s-%d", tc.name, index), func(t *testing.T) {
			t.Setenv("CBCT_TEST_HELPER_PROCESS", "1")
			t.Setenv("CBCT_TEST_CLI_EVENTS", tc.events)
			client := NewClient(Config{Provider: tc.name})
			client.command = func(ctx context.Context, name string, args []string) (*exec.Cmd, error) {
				joined := strings.Join(args, " ")
				if name == "claude" && !strings.Contains(joined, "--strict-mcp-config") {
					t.Error("claude MCP isolation missing")
				}
				exe, err := os.Executable()
				return exec.CommandContext(ctx, exe, "-test.run=^TestCLIHelperProcess$"), err
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var delta string
			answer, err := client.Stream(ctx, []Message{{Role: "user", Content: "fixture"}}, 0, func(s string) { delta += s })
			if (err == nil) != tc.success || answer != tc.want || delta != tc.want {
				t.Fatalf("answer=%q delta=%q err=%v", answer, delta, err)
			}
		})
	}
}

func TestCodexAppServerUsesSelectedModelAndEffort(t *testing.T) {
	t.Setenv("CBCT_TEST_CODEX_APPSERVER", "1")
	client := NewClient(Config{Provider: "codex", Model: "gpt-6.1-sol", ReasoningEffort: "high"})
	client.command = func(ctx context.Context, name string, args []string) (*exec.Cmd, error) {
		if name != "codex" || len(args) < 2 || args[0] != "app-server" || args[1] != "--listen" {
			t.Fatalf("unexpected Codex command: %s %v", name, args)
		}
		exe, err := os.Executable()
		if err != nil {
			return nil, err
		}
		cmd := exec.CommandContext(ctx, exe, "-test.run=^TestCodexAppServerHelperProcess$")
		configureCLIProcess(cmd)
		return cmd, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var delta string
	answer, err := client.Stream(ctx, []Message{{Role: "user", Content: "fixture"}}, 0, func(s string) { delta += s })
	if err != nil || answer != "hello" || delta != "hello" {
		t.Fatalf("answer=%q delta=%q err=%v", answer, delta, err)
	}
}

func TestCodexEffortSupportUsesCatalogUnionOnlyForDefaultModel(t *testing.T) {
	models := []CodexModel{
		{ID: "default", Model: "gpt-6.1-sol", IsDefault: true, SupportedEfforts: []ReasoningOption{{Effort: "low"}, {Effort: "high"}}},
		{ID: "other", Model: "gpt-6-luna", SupportedEfforts: []ReasoningOption{{Effort: "low"}, {Effort: "medium"}, {Effort: "xhigh"}}},
	}
	if !codexEffortSupported(models, "", "xhigh") {
		t.Fatal("default model selection should accept an effort available in the Codex catalog")
	}
	if codexEffortSupported(models, "gpt-6.1-sol", "xhigh") {
		t.Fatal("explicit model selection must reject an effort absent from that model")
	}
	if !codexEffortSupported(models, "other", "xhigh") {
		t.Fatal("model id should resolve to its catalog entry")
	}
}

func TestCodexModelCatalogDoesNotExposeUltraAsPerModelEffort(t *testing.T) {
	model := normalizeCodexModelEfforts(CodexModel{
		Model:            "gpt-6.1-sol",
		SupportedEfforts: []ReasoningOption{{Effort: "low"}, {Effort: "high"}, {Effort: "max"}, {Effort: "ultra"}},
	})
	want := []string{"low", "high", "max"}
	if len(model.SupportedEfforts) != len(want) {
		t.Fatalf("got efforts %v, want %v", model.SupportedEfforts, want)
	}
	for i, effort := range want {
		if model.SupportedEfforts[i].Effort != effort {
			t.Fatalf("got efforts %v, want %v", model.SupportedEfforts, want)
		}
	}
}
