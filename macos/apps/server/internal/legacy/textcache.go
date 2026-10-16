package legacy

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// pageMarker 与旧版 core/evidence.ts 的 PAGE_MARKER 完全一致：逐页缓存靠它分段，
// 摘录校验也按页取文本，所以两版必须用同一套分隔格式，否则 v2 读到的页码会错位。
var pageMarker = regexp.MustCompile(`=== Page ([0-9]+) ===`)

// OCRMarker 出现时说明全文来自识别而非文本层，摘录校验可能失效，必须提示人工核对。
const OCRMarker = "【OCR 转写 · 扫描版 PDF：文本来自机器识别，摘录校验可能失效，请人工核对】"

type Page struct {
	Number int
	Text   string
}

// SplitPages 按标记切页。标记之前的前言（通常为空）丢弃；页码重复时以第一次出现为准。
func SplitPages(text string) []Page {
	matches := pageMarker.FindAllStringSubmatchIndex(text, -1)
	pages := make([]Page, 0, len(matches))
	seen := map[int]bool{}
	for index, match := range matches {
		number, err := strconv.Atoi(text[match[2]:match[3]])
		if err != nil || seen[number] {
			continue
		}
		seen[number] = true
		start := match[1]
		end := len(text)
		if index+1 < len(matches) {
			end = matches[index+1][0]
		}
		pages = append(pages, Page{Number: number, Text: text[start:end]})
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Number < pages[j].Number })
	return pages
}

// ReadTextCache 读旧版逐页缓存；文件不存在返回 (nil, nil)，让调用方把「没有缓存」与
// 「缓存坏了」区分开——后者必须报错，不能当作没缓存而让界面显示空白正文。
func ReadTextCache(path string) ([]Page, bool, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("读取全文缓存失败: %w", err)
	}
	text := string(body)
	if len(text) == 0 {
		return nil, false, nil
	}
	pages := SplitPages(text)
	if len(pages) == 0 {
		// 没有页标记的旧文件（早期版本整篇存）：按单页处理，页号从 1 起。
		pages = []Page{{Number: 1, Text: text}}
	}
	return pages, true, nil
}

// PageHash 用于判断缓存是否变化（变化才需要重新导入，避免每次启动重写全表）。
func PageHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

func IsOCRText(pages []Page) bool {
	for _, page := range pages {
		if strings.Contains(page.Text, OCRMarker) {
			return true
		}
	}
	return false
}
