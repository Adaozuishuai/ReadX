package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"cbctv2/server/internal/db"
	"cbctv2/server/internal/legacy"
	"os"
	"path/filepath"
)

const pageSource = "=== Page 1 ===\nWe train using 50 views and report PSNR of 33.05 dB on the Walnut dataset.\n"

func newReadingsServer(t *testing.T) (*httptestServerBundle, string) {
	t.Helper()
	root := t.TempDir()
	paths := legacy.NewPaths(root)
	cfg := defaultTestConfig(root)
	handle, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatal(err)
	}
	bundle := serve(t, cfg, handle)

	if _, err := handle.Exec(`INSERT INTO documents(id, key, title) VALUES('k1','k1','Paper One')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO document_pages(document_id, page, text, hash) VALUES('k1', 1, ?, 'h')`,
		strings.TrimPrefix(pageSource, "=== Page 1 ===\n")); err != nil {
		t.Fatal(err)
	}
	_ = paths
	return bundle, root
}

func putReading(t *testing.T, bundle *httptestServerBundle, key, kind, value string) (*http.Response, map[string]any) {
	t.Helper()
	return post(t, bundle, http.MethodPut, "/v1/readings/"+key+"/"+kind, `{"value":`+mustMarshalString(value)+`}`)
}

func mustMarshalString(value string) string {
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(body)
}

func validExperimentJSON() string {
	return `{"dataset":[{"k":"数据集","v":"Walnut","page":1,"excerpt":"We train using 50 views and report PSNR of 33.05 dB on the Walnut dataset."}],` +
		`"acquisition":[],"training":[],"loss":[],"metrics":[],"results":[]}`
}

func TestReadingSaveValidPassesUnpruned(t *testing.T) {
	bundle, _ := newReadingsServer(t)
	res, payload := putReading(t, bundle, "k1", "experiment", validExperimentJSON())
	if res.StatusCode != http.StatusOK {
		t.Fatalf("合法生成物应 200，实际 %d %v", res.StatusCode, payload)
	}
	if payload["pruned"] != false || payload["saved"] != true {
		t.Fatalf("合法生成物不应被修剪: %v", payload)
	}
	demoted, _ := payload["demoted"].([]any)
	if len(demoted) != 0 {
		t.Fatalf("不应有降级条目: %v", payload["demoted"])
	}

	stored := decode(t, get(t, bundle.frontend, "/v1/readings/k1", bundle.token))
	entries := stored["entries"].(map[string]any)
	entry := entries["experiment"].(map[string]any)
	if entry["validationError"] != nil {
		t.Fatalf("合法保存不应带未核验标注: %v", entry["validationError"])
	}
	if !strings.Contains(entry["value"].(string), "Walnut") {
		t.Fatalf("存储值应保留原文: %v", entry["value"])
	}
}

func TestReadingSavePrunesInvalidField(t *testing.T) {
	bundle, _ := newReadingsServer(t)
	bad := `{"dataset":[{"k":"数据集","v":"Walnut","page":1,"excerpt":"We train using 50 views and report PSNR of 33.05 dB on the Walnut dataset."},` +
		`{"k":"视图数","v":"999 views","page":1,"excerpt":"对不上的摘录"}],` +
		`"acquisition":[],"training":[],"loss":[],"metrics":[],"results":[]}`
	res, payload := putReading(t, bundle, "k1", "experiment", bad)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("可修剪的生成物应保存成功，实际 %d %v", res.StatusCode, payload)
	}
	if payload["pruned"] != true {
		t.Fatalf("应标记为已修剪: %v", payload)
	}
	demoted := payload["demoted"].([]any)
	if len(demoted) == 0 || !strings.Contains(demoted[0].(string), "视图数") {
		t.Fatalf("降级清单应指出被降级的字段: %v", payload["demoted"])
	}

	stored := decode(t, get(t, bundle.frontend, "/v1/readings/k1", bundle.token))
	entry := stored["entries"].(map[string]any)["experiment"].(map[string]any)
	var saved map[string]any
	if err := json.Unmarshal([]byte(entry["value"].(string)), &saved); err != nil {
		t.Fatal(err)
	}
	fields := saved["dataset"].([]any)
	if len(fields) != 2 {
		t.Fatalf("修剪应保留字段并把坏字段降级，而不是删除: %v", fields)
	}
	demotedField := fields[1].(map[string]any)
	if demotedField["v"] != "论文未说明" || demotedField["page"] != nil {
		t.Fatalf("坏字段应被降级为未知: %v", demotedField)
	}
}

func TestReadingSaveUnprunableIsStoredUnverified(t *testing.T) {
	bundle, _ := newReadingsServer(t)
	res, payload := putReading(t, bundle, "k1", "experiment", `{not json at all`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("未核验通道也应保存（带标注），实际 %d %v", res.StatusCode, payload)
	}
	if payload["pruned"] != false {
		t.Fatalf("不可修剪时不应谎报已修剪: %v", payload)
	}
	validationError, _ := payload["validationError"].(string)
	if validationError == "" {
		t.Fatalf("必须带回未核验原因: %v", payload)
	}
	stored := decode(t, get(t, bundle.frontend, "/v1/readings/k1", bundle.token))
	entry := stored["entries"].(map[string]any)["experiment"].(map[string]any)
	if entry["validationError"] == nil {
		t.Fatalf("存储里必须留下未核验标注: %v", entry)
	}
}

func TestReadingSaveGuards(t *testing.T) {
	bundle, _ := newReadingsServer(t)
	if res, _ := putReading(t, bundle, "k1", "notes", "{}"); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("未知 kind 应 400，实际 %d", res.StatusCode)
	}
	if res, _ := putReading(t, bundle, "nope", "experiment", validExperimentJSON()); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知文档应 404，实际 %d", res.StatusCode)
	}

	// 没有正文缓存时不能「核验通过」——那等于放行无证据内容。
	if _, err := bundle.handle.Exec(`INSERT INTO documents(id, key, title) VALUES('k2','k2','No Text')`); err != nil {
		t.Fatal(err)
	}
	if res, payload := putReading(t, bundle, "k2", "experiment", validExperimentJSON()); res.StatusCode != http.StatusConflict {
		t.Fatalf("无正文缓存应 409，实际 %d %v", res.StatusCode, payload)
	}
}

func TestReadingSaveKeepsLegacyKeys(t *testing.T) {
	bundle, _ := newReadingsServer(t)
	legacyBlob := `{"method":"legacy","key":"k1","experimentJSON":"{}","resultsJSON":"{}"}`
	if _, err := bundle.handle.Exec(`INSERT INTO readings(document_id, value_json, updated_at) VALUES('k1', ?, 'old')`, legacyBlob); err != nil {
		t.Fatal(err)
	}
	if _, payload := putReading(t, bundle, "k1", "experiment", validExperimentJSON()); payload["saved"] != true {
		t.Fatalf("保存失败: %v", payload)
	}
	stored := decode(t, get(t, bundle.frontend, "/v1/readings/k1", bundle.token))
	entries := stored["entries"].(map[string]any)
	if entries["method"] != "legacy" || entries["experimentJSON"] != "{}" {
		t.Fatalf("旧版遗留键必须保留: %v", entries)
	}
	if _, ok := entries["experiment"]; !ok {
		t.Fatal("新写入的 kind 应并存")
	}
}

func TestReadingGetMissingIsEmptyObject(t *testing.T) {
	bundle, _ := newReadingsServer(t)
	stored := decode(t, get(t, bundle.frontend, "/v1/readings/k1", bundle.token))
	entries, ok := stored["entries"].(map[string]any)
	if !ok || len(entries) != 0 {
		t.Fatalf("没有记录时应返回空对象而不是 null: %v", stored["entries"])
	}
}

var _ = os.Getenv
var _ = filepath.Join

// 精读历史只写不读：写入时必须裁掉旧快照，否则 app_state 会随每次重跑无限增长。
func TestPaperHistoryRetentionKeepsNewest(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	server := New(bundle.cfg, bundle.handle)
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		kind := fmt.Sprintf("paperHistory:method:%019d", i)
		entry := ReadingEntry{Value: fmt.Sprintf("v%d", i), Demoted: []string{}, UpdatedAt: "2026-01-01T00:00:00Z"}
		if err := server.saveReadingEntry(ctx, "2209.14540", kind, entry); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.prunePaperHistory(ctx, "2209.14540", "method"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := bundle.handle.QueryRow(
		`SELECT COUNT(*) FROM app_state WHERE instr(key, 'paperHistory:method:') > 0`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != paperHistoryRetention {
		t.Fatalf("应保留 %d 条历史，实际 %d", paperHistoryRetention, count)
	}
	var newest string
	if err := bundle.handle.QueryRow(
		`SELECT key FROM app_state WHERE instr(key, 'paperHistory:method:') > 0 ORDER BY key DESC LIMIT 1`).Scan(&newest); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(newest, ":0000000000000000005") {
		t.Fatalf("保留的应是最新快照，实际 %s", newest)
	}
}
