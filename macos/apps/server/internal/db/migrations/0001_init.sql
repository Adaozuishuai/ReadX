-- v2 初始 schema。权威存储在 SQLite，旧版 JSON 只作为导入源（S1）。
-- 说明：列表/计数类字段统一用 JSON 文本列，避免为过渡期字段建大量表；
-- 结构化校验相关的判定逻辑在 Go 侧（S2 移植），DB 只负责持久化。

CREATE TABLE documents (
	id          TEXT PRIMARY KEY,
	key         TEXT NOT NULL DEFAULT '',
	title       TEXT NOT NULL DEFAULT '',
	authors     TEXT NOT NULL DEFAULT '[]',
	year        INTEGER,
	venue       TEXT NOT NULL DEFAULT '',
	doi         TEXT NOT NULL DEFAULT '',
	url         TEXT NOT NULL DEFAULT '',
	status      TEXT NOT NULL DEFAULT 'queue',
	pdf_path    TEXT NOT NULL DEFAULT '',
	added_at    TEXT NOT NULL DEFAULT '',
	updated_at  TEXT NOT NULL DEFAULT '',
	raw_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX documents_key_unique ON documents(key) WHERE key <> '';
CREATE INDEX documents_status ON documents(status);

-- 逐页正文缓存。与旧版 library/text/<key>-v3.txt 同语义：由渲染进程 pdf.js 抽取后上传，
-- 服务端不再自行解析 PDF。
CREATE TABLE document_pages (
	document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	page        INTEGER NOT NULL,
	text        TEXT NOT NULL,
	hash        TEXT NOT NULL DEFAULT '',
	updated_at  TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (document_id, page)
);

-- 精读产物：四步流的解析结果整体存 JSON（校验在写入前由 Go 校验链完成）。
CREATE TABLE readings (
	document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
	value_json  TEXT NOT NULL DEFAULT '{}',
	updated_at  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE annotations (
	id          TEXT PRIMARY KEY,
	document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	page        INTEGER,
	quote       TEXT NOT NULL DEFAULT '',
	note        TEXT NOT NULL DEFAULT '',
	color       TEXT NOT NULL DEFAULT 'amber',
	tags        TEXT NOT NULL DEFAULT '[]',
	created_at  TEXT NOT NULL DEFAULT '',
	updated_at  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX annotations_document ON annotations(document_id);

-- 段落级译文缓存：命中即零成本复用，且与原文证据体系隔离（不参与摘录校验）。
CREATE TABLE translations (
	document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
	para_hash   TEXT NOT NULL,
	source      TEXT NOT NULL,
	target      TEXT NOT NULL,
	updated_at  TEXT NOT NULL DEFAULT '',
	PRIMARY KEY (document_id, para_hash)
);

-- 应用级状态（库分类、想法、趋势缓存等），键值 JSON。
CREATE TABLE app_state (
	key        TEXT PRIMARY KEY,
	value_json TEXT NOT NULL DEFAULT 'null',
	updated_at TEXT NOT NULL DEFAULT ''
);
