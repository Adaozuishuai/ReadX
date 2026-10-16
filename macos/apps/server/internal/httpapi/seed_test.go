package httpapi

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"cbctv2/server/internal/legacy"
)

// seedImportedFixtures 把 newImportServer 造出的旧版文件直接写进 SQLite。
//
// 背景：原先测试用 `POST /v1/import`（旧数据迁移端点）来装载夹具。
// 该端点在「删除导入旧数据功能」时一并移除，但**测试仍需要同样的起始数据**。
// 这里直接在测试侧落库，等价于迁移一次的结果，且不再依赖被删除的产品端点。
//
// 与迁移端点的语义保持一致的点：
//   - 只读旧文件（这里连读都不需要，直接用已知 fixture 内容）
//   - 幂等：重复调用按 key UPSERT，不产生重复行
//   - 逐页正文写 document_pages，供 /v1/documents/{key}/pages 读取
func seedImportedFixtures(t *testing.T, bundle *httptestServerBundle, paths legacy.Paths) {
	t.Helper()
	ctx := context.Background()
	stamp := time.Now().UTC().Format(time.RFC3339)

	type fixture struct {
		id, key, title, venue string
		year                  int
		status                string
		authors               []string
		pages                 []string
		readingJSON           string
		hasPDF                bool
	}
	fixtures := []fixture{
		{
			id: "2209.14540", key: "2209.14540",
			title: "NAF: Neural Attenuation Fields",
			venue: "ECCV 2022", year: 2022, status: "done",
			authors:     []string{"Ruyi Zha"},
			pages:       []string{"NAF abstract line.", "We train using 50 views."},
			readingJSON: `{"key":"2209.14540","notes":"读到这里"}`,
			hasPDF:      true,
		},
		{
			id: "intratomo-2021", key: "intratomo-2021",
			title: "IntraTomo", venue: "ICCV 2021", year: 2021, status: "reading",
			authors: []string{"Guangming Zang"},
		},
	}

	for _, f := range fixtures {
		authors, err := json.Marshal(f.authors)
		if err != nil {
			t.Fatalf("序列化 authors 失败: %v", err)
		}
		if _, err := bundle.handle.ExecContext(ctx, `
			INSERT INTO documents(id, key, title, authors, year, venue, status, pdf_path, added_at, updated_at, raw_json)
			VALUES(?,?,?,?,?,?,?,?,?,?,?)
			ON CONFLICT(id) DO UPDATE SET
				title=excluded.title, authors=excluded.authors, year=excluded.year,
				venue=excluded.venue, updated_at=excluded.updated_at
		`, f.id, f.key, f.title, string(authors), f.year, f.venue, f.status,
			func() string {
				if f.hasPDF {
					return filepath.Join(paths.LibraryDir(), f.key+".pdf")
				}
				return ""
			}(), stamp, stamp, "{}"); err != nil {
			t.Fatalf("插入文档 %s 失败: %v", f.key, err)
		}

		for index, text := range f.pages {
			if _, err := bundle.handle.ExecContext(ctx, `
				INSERT INTO document_pages(document_id, page, text, hash, updated_at)
				VALUES(?,?,?,?,?)
				ON CONFLICT(document_id, page) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at
			`, f.id, index+1, text, legacy.PageHash(text), stamp); err != nil {
				t.Fatalf("插入正文 %s p%d 失败: %v", f.key, index+1, err)
			}
		}

		// readings.value_json 存的是**旧版精读记录的裸 JSON**：
		// `/v1/documents/{key}` 的 `loadReading` 原样取出返回，不做包裹。
		if f.readingJSON != "" {
			if _, err := bundle.handle.ExecContext(ctx, `
				INSERT INTO readings(document_id, value_json, updated_at) VALUES(?,?,?)
				ON CONFLICT(document_id) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
			`, f.id, f.readingJSON, stamp); err != nil {
				t.Fatalf("插入 readings %s 失败: %v", f.key, err)
			}
		}
	}
}

// newSeededServer 在 newImportServer 的基础上把夹具直接植入 SQLite，
// 用于替代过去「先 POST /v1/import 再断言」的测试写法。
func newSeededServer(t *testing.T) (*httptestServerBundle, legacy.Paths) {
	t.Helper()
	bundle, paths := newImportServer(t)
	seedImportedFixtures(t, bundle, paths)
	return bundle, paths
}

// defaultSeededBundle 只取 bundle，弱化 paths 的调用方更简洁。
func defaultSeededBundle(t *testing.T) *httptestServerBundle {
	t.Helper()
	bundle, _ := newSeededServer(t)
	return bundle
}
