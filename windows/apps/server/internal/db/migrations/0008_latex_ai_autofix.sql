-- AI 直接写盘模式与文件快照（2026-10-23）
--
-- ai_auto_fix 默认 0：AI 直接改写项目源码这件事必须由用户显式开启，
-- 默认关闭才不会让「我只是问了个问题」变成「我的论文被改了」。
ALTER TABLE latex_projects ADD COLUMN ai_auto_fix INTEGER NOT NULL DEFAULT 0;

-- 每次 AI 写入前的源码快照。文件内容存在项目目录下的 snapshots/<id>/src，
-- 这里只存元数据：回滚要能在重启之后依然可用，所以不能只放在内存里。
CREATE TABLE latex_snapshots (
	id         TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES latex_projects(id) ON DELETE CASCADE,
	note       TEXT NOT NULL DEFAULT '',
	manifest   TEXT NOT NULL DEFAULT '',
	file_count INTEGER NOT NULL DEFAULT 0,
	byte_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX latex_snapshots_project ON latex_snapshots(project_id, created_at);