package httpapi

import (
	"strings"
	"testing"

	"cbctv2/server/internal/latex"
)

// 模型经常把 JSON 包在代码围栏里；解析要容得下这种常见形态，
// 但不能「猜」内容——解析不出来就必须拒绝，绝不写盘。
func TestParseFixProposalAcceptsFencesAndRejectsGarbage(t *testing.T) {
	plain := `{"summary":"修好了","content":"\\documentclass{article}"}`
	proposal, err := parseFixProposal(plain)
	if err != nil || proposal.Summary != "修好了" || !strings.Contains(proposal.Content, "documentclass") {
		t.Fatalf("普通 JSON 应当解析成功: %v %+v", err, proposal)
	}
	for _, fenced := range []string{
		"```json\n" + plain + "\n```",
		"```\n" + plain + "\n```",
		"  ```json\n" + plain + "\n```  ",
	} {
		if _, err := parseFixProposal(fenced); err != nil {
			t.Fatalf("带代码围栏的返回应当能解析: %v（输入 %q）", err, fenced)
		}
	}
	for _, bad := range []string{"", "这不是 JSON", `{"summary":"只有说明"}`, `{"content":""}`} {
		if _, err := parseFixProposal(bad); err == nil {
			t.Fatalf("无法解析或没有源码时必须报错（否则会写坏文件）：%q", bad)
		}
	}
	// 超长源码必须拒绝，而不是写到磁盘上再失败。
	huge := `{"summary":"x","content":"` + strings.Repeat("a", latex.MaxFileBytes+1) + `"}`
	if _, err := parseFixProposal(huge); err == nil {
		t.Fatal("超过上限的源码必须拒绝")
	}
}

func TestTruncateTailKeepsTheEnd(t *testing.T) {
	text := strings.Repeat("a", 50) + "TAIL"
	short := truncateTail(text, 10)
	if !strings.HasSuffix(short, "TAIL") {
		t.Fatalf("截断必须保留结尾（TeX 的错误在后面）：%q", short)
	}
	if !strings.Contains(short, "截断") {
		t.Fatalf("截断要有明确标注：%q", short)
	}
	if got := truncateTail("短文本", 100); got != "短文本" {
		t.Fatalf("不需要截断时应原样返回：%q", got)
	}
}
