package ai

import (
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
		{"codex", "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"text\":\"private log\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}\n{\"type\":\"turn.completed\"}\n", "hello", true},
		{"codex", "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"partial\"}}\n", "partial", false},
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
				if name == "codex" && (!strings.Contains(joined, "read-only") || !strings.Contains(joined, "shell_tool=false")) {
					t.Error("codex isolation flags missing")
				}
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
