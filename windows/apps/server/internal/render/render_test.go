package render

import (
	"encoding/json"
	"testing"
)

func TestBuildInputProducesRprSchema(t *testing.T) {
	encoded, payload, err := buildInput([]Page{
		{
			Index:  0,
			Width:  595,
			Height: 842,
			Blocks: []Block{
				{Text: "正文译文。", Box: [4]float64{72, 72, 523, 140}, FontSize: 10.5, Role: "body"},
				{Text: "   ", Box: [4]float64{72, 160, 300, 200}, FontSize: 10},
			},
		},
		{
			Index:  1,
			Width:  595,
			Height: 842,
			Blocks: []Block{
				{Text: "标题", Box: [4]float64{100, 40, 500, 80}, FontSize: 16, Role: "title"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["schema"] != inputSchema {
		t.Fatalf("schema = %v", decoded["schema"])
	}
	pages := decoded["pages"].([]any)
	if len(pages) != 2 {
		t.Fatalf("pages = %d", len(pages))
	}
	blocks := pages[0].(map[string]any)["blocks"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("空白块应被跳过，实际 %d", len(blocks))
	}
	first := blocks[0].(map[string]any)
	if first["id"] != "p1-b1" || first["content_box"] == nil || first["cover_fill"] == nil {
		t.Fatalf("块字段不完整: %v", first)
	}
	fit := first["fit"].(map[string]any)
	if fit["mode"] != "box_overlay" || fit["min_font_size_pt"].(float64) <= 0 {
		t.Fatalf("fit 参数异常: %v", fit)
	}
	if payload.Pages[0].Blocks[0].Align != "justify" {
		t.Fatalf("宽正文块应两端对齐，实际 %q", payload.Pages[0].Blocks[0].Align)
	}
}

func TestBuildInputRejectsInvalidGeometry(t *testing.T) {
	_, _, err := buildInput([]Page{{Width: 0, Height: 842, Blocks: []Block{{Text: "x", Box: [4]float64{0, 0, 10, 10}}}}})
	if err == nil {
		t.Fatal("无效页面尺寸应报错")
	}
	_, _, err = buildInput([]Page{{Width: 595, Height: 842, Blocks: []Block{{Text: "x", Box: [4]float64{10, 10, 10, 20}}}}})
	if err == nil {
		t.Fatal("零宽块应报错")
	}
	_, _, err = buildInput([]Page{{Width: 595, Height: 842, Blocks: []Block{{Text: "   ", Box: [4]float64{10, 10, 20, 20}}}}})
	if err == nil {
		t.Fatal("没有译文块应报错")
	}
}

func TestClampBoxKeepsBoxInsidePage(t *testing.T) {
	box := clampBox([4]float64{-5, -5, 700, 900}, 595, 842)
	if box[0] < 0 || box[1] < 0 || box[2] > 595 || box[3] > 842 {
		t.Fatalf("坐标未夹到页面内: %v", box)
	}
}
