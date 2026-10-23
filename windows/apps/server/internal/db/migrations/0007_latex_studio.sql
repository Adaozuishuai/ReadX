CREATE TABLE latex_projects (
	id                    TEXT PRIMARY KEY,
	title                 TEXT NOT NULL,
	main_file             TEXT NOT NULL DEFAULT 'main.tex',
	engine                TEXT NOT NULL DEFAULT 'pdflatex',
	auto_compile          INTEGER NOT NULL DEFAULT 0,
	created_at            TEXT NOT NULL DEFAULT '',
	updated_at            TEXT NOT NULL DEFAULT '',
	last_build_id         TEXT NOT NULL DEFAULT '',
	last_success_build_id TEXT NOT NULL DEFAULT ''
);

-- 一次编译一条记录：状态、诊断计数与产物路径都在这里，
-- 前端轮询/流式读到的就是这个表的行（见 ReadX_LaTeX_Studio.md §6/§7）。
CREATE TABLE latex_builds (
	id            TEXT PRIMARY KEY,
	project_id    TEXT NOT NULL REFERENCES latex_projects(id) ON DELETE CASCADE,
	revision      TEXT NOT NULL DEFAULT '',
	status        TEXT NOT NULL DEFAULT 'queued',
	reason        TEXT NOT NULL DEFAULT '',
	engine        TEXT NOT NULL DEFAULT '',
	main_file     TEXT NOT NULL DEFAULT '',
	started_at    TEXT NOT NULL DEFAULT '',
	finished_at   TEXT NOT NULL DEFAULT '',
	exit_code     INTEGER NOT NULL DEFAULT 0,
	error_count   INTEGER NOT NULL DEFAULT 0,
	warning_count INTEGER NOT NULL DEFAULT 0,
	log_path      TEXT NOT NULL DEFAULT '',
	pdf_path      TEXT NOT NULL DEFAULT '',
	message       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX latex_builds_project ON latex_builds(project_id, started_at);