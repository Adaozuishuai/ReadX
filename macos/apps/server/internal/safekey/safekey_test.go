package safekey

import (
	"strings"
	"testing"
)

func TestAcceptsRealWorldKeys(t *testing.T) {
	for _, key := range []string{
		"2209.14540", "2401.00135", "intratomo-2021", "2022-naf",
		"10.1234-abc.def", "论文-2026", "a",
	} {
		if err := Check(key); err != nil {
			t.Fatalf("合法键 %q 被拒绝: %v", key, err)
		}
	}
}

func TestRejectsDangerousKeys(t *testing.T) {
	cases := []struct {
		name string
		key  string
	}{
		{"空串", ""},
		{"上级目录", ".."},
		{"路径穿越", "../../app/config"},
		{"反斜杠穿越", `..\..\windows`},
		{"含分隔符", "a/b"},
		{"含反斜杠", `a\b`},
		// DOI 常含 '/'：旧版 isSafePathKey 只挡开头斜杠，v2 一律拒绝——
		// 键会被拼进 library/text/<key>-v3.txt，放行斜杠等于悄悄改变文件位置。
		{"DOI 带斜杠", "10.1234/abc.def"},
		{"绝对路径 Unix", "/etc/passwd"},
		{"绝对路径 Windows", `C:\Windows`},
		{"盘符相对", `C:file`},
		{"原型污染", "__proto__"},
		{"构造器", "constructor"},
		{"原型属性", "prototype"},
		{"NUL 截断", "abc\x00def"},
		{"超长", strings.Repeat("a", maxLength+1)},
	}
	for _, c := range cases {
		if err := Check(c.key); err == nil {
			t.Fatalf("%s（%q）必须被拒绝", c.name, c.key)
		}
	}
}

func TestMaxLengthBoundary(t *testing.T) {
	if err := Check(strings.Repeat("a", maxLength)); err != nil {
		t.Fatalf("恰好 %d 字符应放行: %v", maxLength, err)
	}
}

func TestMustCheckEchoesKey(t *testing.T) {
	got, err := MustCheck("2209.14540", "论文键")
	if err != nil || got != "2209.14540" {
		t.Fatalf("合法键应原样返回，实际 %q %v", got, err)
	}
	if _, err := MustCheck("..", "论文键"); err == nil || !strings.Contains(err.Error(), "论文键") {
		t.Fatalf("错误信息应指出是什么键，实际 %v", err)
	}
}
