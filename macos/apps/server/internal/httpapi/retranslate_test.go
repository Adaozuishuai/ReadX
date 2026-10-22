package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cbctv2/server/internal/legacy"
)

// 用户看到的是「没有可复用的 OCR 结果，请重新导入」，但重新导入会丢掉批注、
// 精读笔记与阅读进度——而他要的只是重新翻译。所以没有可复用识别结果时必须改为重新识别，
// 并且把缺什么前提说清楚（这是同步查得到的部分，不该等任务跑起来才失败）。
func TestRetranslateWithoutReusableOCRReidentifies(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")

	res, payload := post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/retranslate", "")
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("缺少识别结果且未配置 OCR 时应当直接说明前提，实际: %d %v", res.StatusCode, payload)
	}
	message, _ := payload["error"].(string)
	if strings.Contains(message, "请重新导入") {
		t.Fatalf("不应再让用户重新导入（会丢批注与阅读进度）: %q", message)
	}
	if !strings.Contains(message, "重新识别") {
		t.Fatalf("提示必须说明会重新识别: %q", message)
	}
	if !strings.Contains(message, "PaddleOCR") && !strings.Contains(message, "AI 助手") {
		t.Fatalf("提示必须说清缺哪个前提: %q", message)
	}
}

// 有可复用识别结果时维持原路：只重跑翻译，不碰 OCR。
func TestRetranslateReusesStoredOCRWhenPresent(t *testing.T) {
	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	seedStoredOCR(t, bundle, paths, "2209.14540")

	res, payload := post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/retranslate", "")
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("有可复用识别结果时应当接受任务: %d %v", res.StatusCode, payload)
	}
	if payload["ocr"] != "reused" {
		t.Fatalf("响应应当说明复用了识别结果: %v", payload)
	}
	jobKey, _ := payload["jobKey"].(string)
	if !strings.HasPrefix(jobKey, "retranslate-") {
		t.Fatalf("任务编号异常: %v", payload)
	}
	if message := ocrStageMessage(t, bundle, jobKey); message != "复用已有 Lee OCR 与段落结构" {
		t.Fatalf("复用路径的识别阶段应当如实说明复用: %q", message)
	}
	if _, err := os.Stat(filepath.Join(paths.DataDir(), "retain", "jobs", jobKey, "ocr", "normalized", "document.v1.json")); err != nil {
		t.Fatalf("复用路径应当把识别结果放进新任务目录: %v", err)
	}
	// 测试环境没有可用模型，后台任务会立刻失败并回滚：等它收尾，既避免任务写到已关闭的库，
	// 也顺带确认失败原因是「模型配置」而不是别的。
	status, message := waitForJobTerminal(t, bundle, jobKey)
	if status != "failed" || !strings.Contains(message, "模型配置") {
		t.Fatalf("复用路径在缺少模型时应快速失败并说明原因: %s %q", status, message)
	}
}

// 版式在、但上一次识别的归一化文件已被清掉：同样是「没有可复用的识别结果」，
// 必须走重新识别，而不是报「找不到归一化文件」把人堵死。
func TestRetranslateWithLayoutButMissingOCRDocumentReidentifies(t *testing.T) {
	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	seedStoredOCR(t, bundle, paths, "2209.14540")
	if err := os.Remove(filepath.Join(paths.DataDir(), "retain", "jobs", "2209.14540", "ocr", "normalized", "document.v1.json")); err != nil {
		t.Fatal(err)
	}

	res, payload := post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/retranslate", "")
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("归一化文件缺失时应当说明需要重新识别: %d %v", res.StatusCode, payload)
	}
	message, _ := payload["error"].(string)
	if strings.Contains(message, "无法复用识别结果") || strings.Contains(message, "请重新导入") {
		t.Fatalf("不应再以「无法复用」收场: %q", message)
	}
	if !strings.Contains(message, "重新识别") {
		t.Fatalf("提示必须说明会重新识别: %q", message)
	}
}

// 重新识别会得到新的文本与版式，写回时必须是覆盖语义：
// 沿用导入路径的 INSERT OR IGNORE 会让旧文本留着，阅读器依旧是旧内容，
// 下一次「重新翻译」还会说没有可复用的 OCR。
func TestPersistReimportedOCROverwritesTextAndLayout(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	ctx := context.Background()
	server := New(bundle.cfg, bundle.handle)
	if _, err := bundle.handle.ExecContext(ctx,
		`INSERT INTO document_pages(document_id,page,text,hash,updated_at) VALUES(?,?,?,?,?)
		 ON CONFLICT(document_id,page) DO UPDATE SET text=excluded.text, hash=excluded.hash, updated_at=excluded.updated_at`,
		"2209.14540", 1, "旧的识别文本", "", nowStamp()); err != nil {
		t.Fatal(err)
	}

	metadata := recognizedPaperMetadata{
		Pages: []publicationPageHint{
			{Page: 1, Text: "重新识别后的第一页"},
			{Page: 2, Text: "重新识别后的第二页"},
		},
		LayoutPages: []layoutPage{
			{Page: 1, Width: 595, Height: 842, Blocks: []layoutBlock{{Kind: "text", Text: "重新识别后的第一页", Box: [4]float64{20, 20, 100, 60}}}},
			{Page: 2, Width: 595, Height: 842, Blocks: []layoutBlock{{Kind: "text", Text: "重新识别后的第二页", Box: [4]float64{20, 20, 100, 60}}}},
		},
	}
	if err := server.persistReimportedOCR(ctx, "2209.14540", metadata); err != nil {
		t.Fatalf("写回重新识别结果失败: %v", err)
	}
	var text string
	if err := bundle.handle.QueryRowContext(ctx, `SELECT text FROM document_pages WHERE document_id=? AND page=1`, "2209.14540").Scan(&text); err != nil {
		t.Fatal(err)
	}
	if text != "重新识别后的第一页" {
		t.Fatalf("页文本应当被覆盖为重新识别的结果，实际: %q", text)
	}
	layout, available, err := server.loadLayout(ctx, "2209.14540")
	if err != nil || !available {
		t.Fatalf("重新识别后阅读器应当能读到版式: %v available=%v", err, available)
	}
	if len(layout.Pages) != 2 || layout.Pages[0].Blocks[0].Text != "重新识别后的第一页" {
		t.Fatalf("版式没有被覆盖为重新识别的结果: %+v", layout.Pages)
	}
}

// 识别页数变少时，多出来的旧页必须删掉，否则阅读器里会留下已经不存在的那一页。
func TestPersistReimportedOCRTrimsExtraPages(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	ctx := context.Background()
	server := New(bundle.cfg, bundle.handle)
	if _, err := bundle.handle.ExecContext(ctx,
		`INSERT INTO document_pages(document_id,page,text,hash,updated_at) VALUES(?,?,?,?,?)
		 ON CONFLICT(document_id,page) DO UPDATE SET text=excluded.text, hash=excluded.hash, updated_at=excluded.updated_at`,
		"2209.14540", 5, "旧的第 5 页", "", nowStamp()); err != nil {
		t.Fatal(err)
	}
	metadata := recognizedPaperMetadata{
		Pages:       []publicationPageHint{{Page: 1, Text: "只剩一页了"}},
		LayoutPages: []layoutPage{{Page: 1, Width: 595, Height: 842}},
	}
	if err := server.persistReimportedOCR(ctx, "2209.14540", metadata); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := bundle.handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM document_pages WHERE document_id=? AND page>1`, "2209.14540").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("识别页数变少后仍有 %d 页旧文本残留", count)
	}
}

// 失败要标在真正失败的那一步：识别已完成、倒在写回时，不能把成功的识别标成失败。
func TestAbortReidentifyKeepsCompletedOCRStage(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	server := New(bundle.cfg, bundle.handle)
	ctx := context.Background()
	jobRoot := t.TempDir()

	server.beginImportJob("retranslate-test", "测试任务", 0, func() {})
	server.jobStage("retranslate-test", "ocr", "done", "重新识别完成，共 2 页", 2, 2)
	server.jobStage("retranslate-test", "translate", "pending", "等待后台重新翻译", 0, -1)
	server.abortReidentify(ctx, "retranslate-test", "2209.14540", jobRoot, errSentinel)

	job, ok := server.loadImportJob(ctx, "retranslate-test")
	if !ok {
		t.Fatal("任务应当仍然存在（只是失败了）")
	}
	if job.Status != "failed" || job.Error != errSentinel.Error() {
		t.Fatalf("任务应当以失败收尾并带上原因: %s %q", job.Status, job.Error)
	}
	if stage := job.stage("ocr"); stage == nil || stage.Status != "done" {
		t.Fatalf("识别已经完成，不该被改写成失败: %+v", stage)
	}
	if stage := job.stage("translate"); stage == nil || stage.Status != "failed" {
		t.Fatalf("失败应当标在识别之后的步骤上: %+v", stage)
	}
}

// 识别本身失败时，失败标在识别阶段。
func TestAbortReidentifyMarksOCRStageWhenRecognitionFails(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	server := New(bundle.cfg, bundle.handle)
	ctx := context.Background()

	server.beginImportJob("retranslate-test", "测试任务", 0, func() {})
	server.jobStage("retranslate-test", "ocr", "running", "没有可复用的 OCR 结果，正在重新识别", 0, -1)
	server.abortReidentify(ctx, "retranslate-test", "2209.14540", t.TempDir(), errSentinel)

	job, _ := server.loadImportJob(ctx, "retranslate-test")
	if stage := job.stage("ocr"); stage == nil || stage.Status != "failed" {
		t.Fatalf("识别阶段的失败应当留在识别阶段: %+v", stage)
	}
}

var errSentinel = errors.New("写回识别结果失败")

// seedStoredOCR 造出「上一次识别留下了可复用产物」的状态：版式（库内）与归一化文件（磁盘）。
func seedStoredOCR(t *testing.T, bundle *httptestServerBundle, paths legacy.Paths, key string) {
	t.Helper()
	ctx := context.Background()
	tx, err := bundle.handle.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := saveLayoutTx(ctx, tx, key, []layoutPage{{Page: 1, Width: 595, Height: 842, Blocks: []layoutBlock{
		{Kind: "text", Text: "source", Box: [4]float64{20, 20, 100, 60}},
	}}}); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(paths.DataDir(), "retain", "jobs", key, "ocr", "normalized")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(map[string]any{"pages": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "document.v1.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}

func ocrStageMessage(t *testing.T, bundle *httptestServerBundle, jobKey string) string {
	t.Helper()
	job, ok := New(bundle.cfg, bundle.handle).loadImportJob(context.Background(), jobKey)
	if !ok {
		t.Fatalf("任务不存在: %q", jobKey)
	}
	if stage := job.stage("ocr"); stage != nil {
		return stage.Message
	}
	return ""
}

// waitForJobTerminal 等后台任务收尾（测试库没有可用模型，任务必然快速失败）。
func waitForJobTerminal(t *testing.T, bundle *httptestServerBundle, jobKey string) (string, string) {
	t.Helper()
	server := New(bundle.cfg, bundle.handle)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if job, ok := server.loadImportJob(context.Background(), jobKey); ok {
			// 读盘时「running」会被改写成「interrupted」，那不是终态，继续等。
			if job.Status != "running" && job.Status != "interrupted" {
				return job.Status, job.Error
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("等待任务收尾超时: %q", jobKey)
		}
		time.Sleep(50 * time.Millisecond)
	}
}