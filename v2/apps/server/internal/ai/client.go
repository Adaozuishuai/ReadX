package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// RequestTimeout 与旧版一致：出站请求必须有超时，否则网络挂起会让界面永远停在「生成中」。
const RequestTimeout = 180 * time.Second

// Message 是一条对话消息；Role 用 OpenAI 的 system/user/assistant。
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Stream      bool      `json:"stream"`
	Temperature float64   `json:"temperature"`
}

type chatChoice struct {
	FinishReason string `json:"finish_reason"`
	Delta        struct {
		Content string `json:"content"`
	} `json:"delta"`
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
}

type chatChunk struct {
	Choices []chatChoice `json:"choices"`
}

// Client 是 OpenAI 兼容接口的最小客户端。
type Client struct {
	cfg  Config
	http *http.Client
}

func NewClient(cfg Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: RequestTimeout + 15*time.Second}}
}

func (c *Client) post(ctx context.Context, payload chatRequest) (*http.Response, error) {
	endpoint, err := c.cfg.Endpoint()
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	response, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil || strings.Contains(err.Error(), "timeout") || strings.Contains(err.Error(), "canceled") {
			return nil, fmt.Errorf("请求超时（180 秒），未保存，请重试。")
		}
		return nil, fmt.Errorf("请求失败：%s", err.Error())
	}
	if response.StatusCode != http.StatusOK {
		defer response.Body.Close()
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		text := string(detail)
		if len([]rune(text)) > 200 {
			text = string([]rune(text)[:200])
		}
		message := fmt.Sprintf("接口返回 %d，请检查 API 地址、模型与访问权限。", response.StatusCode)
		if text != "" {
			message += "\n服务端返回：" + text
		}
		return nil, fmt.Errorf("%s", message)
	}
	return response, nil
}

// Generate 是非流式生成：结构化精读要整段 JSON，流式拼接无收益。
func (c *Client) Generate(ctx context.Context, system, user string, temperature float64) (string, error) {
	payload := chatRequest{
		Model: c.cfg.ModelName(),
		Messages: []Message{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature: temperature,
	}
	response, err := c.post(ctx, payload)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	var decoded struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		return "", fmt.Errorf("接口返回不是合法 JSON: %w", err)
	}
	if len(decoded.Choices) == 0 || strings.TrimSpace(decoded.Choices[0].Message.Content) == "" {
		return "", fmt.Errorf("（模型没有返回内容，检查 config.json 里的模型名是否正确）")
	}
	return decoded.Choices[0].Message.Content, nil
}

// Stream 流式对话：onDelta 收到每个增量，返回完整文本。
//
// 与旧版一致的两条硬约束：finish_reason 不是 stop 视为失败；流中断时不返回成功——
// 半个回答比没有回答更危险。
func (c *Client) Stream(ctx context.Context, messages []Message, temperature float64, onDelta func(string)) (string, error) {
	response, err := c.post(ctx, chatRequest{
		Model:       c.cfg.ModelName(),
		Messages:    messages,
		Stream:      true,
		Temperature: temperature,
	})
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	var full strings.Builder
	completed := false
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[len("data:"):])
		if payload == "[DONE]" {
			completed = true
			break
		}
		var chunk chatChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		choice := chunk.Choices[0]
		if choice.FinishReason != "" {
			if choice.FinishReason == "stop" {
				completed = true
			} else {
				return full.String(), fmt.Errorf("生成未完成（%s），未保存，请重试。", choice.FinishReason)
			}
		}
		if choice.Delta.Content != "" {
			full.WriteString(choice.Delta.Content)
			if onDelta != nil {
				onDelta(choice.Delta.Content)
			}
		}
		if completed {
			break
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return full.String(), fmt.Errorf("请求失败：%s", err.Error())
	}
	if full.Len() == 0 {
		return "", fmt.Errorf("（助教没有返回内容，检查 config.json 里的模型名是否正确）")
	}
	if !completed {
		return full.String(), fmt.Errorf("连接中断，回答未完成，未保存，请重试。")
	}
	return full.String(), nil
}

// TrimHistory 对应旧版「只带最近 8 轮」并把 ai 角色映射成 assistant。
func TrimHistory(history []Message, keep int) []Message {
	if len(history) > keep {
		history = history[len(history)-keep:]
	}
	out := make([]Message, 0, len(history))
	for _, item := range history {
		role := item.Role
		if role == "ai" {
			role = "assistant"
		} else if role != "assistant" {
			role = "user"
		}
		out = append(out, Message{Role: role, Content: item.Content})
	}
	return out
}
