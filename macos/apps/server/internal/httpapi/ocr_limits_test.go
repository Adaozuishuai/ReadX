package httpapi

import (
	"context"
	"strings"
	"testing"

	"cbctv2/server/internal/ocr"
)

func TestImportPublicationRejectsPDFAbovePaddleLimit(t *testing.T) {
	bundle, _ := newImportServer(t)
	server := New(bundle.cfg, bundle.handle)
	pdf := make([]byte, ocr.MaxPDFBytes+1)
	copy(pdf, "%PDF-1.7\n")
	_, err := server.importPublication(context.Background(), "large.pdf", "", pdf)
	if err == nil || !strings.Contains(err.Error(), "50 MB") {
		t.Fatalf("超限 PDF 应在保存或 OCR 前被拒绝，实际错误：%v", err)
	}
}

func TestPrepareImportTranslationsRejectsBeyondPaddlePageLimit(t *testing.T) {
	bundle, _ := newImportServer(t)
	server := New(bundle.cfg, bundle.handle)
	pages := make([]publicationPageHint, ocr.MaxPDFPages+1)
	err := server.prepareImportTranslations(context.Background(), []byte("%PDF"), pages, &recognizedPaperMetadata{})
	if err == nil || !strings.Contains(err.Error(), "1000 页") {
		t.Fatalf("超过 OCR 页数上限应在发起请求前拒绝，实际错误：%v", err)
	}
}

func TestCancelledImportCannotBeOverwrittenByFailure(t *testing.T) {
	bundle, _ := newImportServer(t)
	server := New(bundle.cfg, bundle.handle)
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	server.beginImportJob("cancelled-test", "paper.pdf", 1, cancel)
	if !server.cancelImportJob("cancelled-test") {
		t.Fatal("应取消运行中的导入任务")
	}
	server.finishImportJob("cancelled-test", "failed", "context canceled")
	server.jobsMu.Lock()
	status := server.importJobs["cancelled-test"].job.Status
	server.jobsMu.Unlock()
	if status != "cancelled" {
		t.Fatalf("取消状态不应被失败结果覆盖，实际状态：%s", status)
	}
}
