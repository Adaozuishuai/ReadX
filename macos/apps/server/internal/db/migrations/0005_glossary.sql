CREATE TABLE glossary_terms (
	source     TEXT PRIMARY KEY COLLATE NOCASE,
	target     TEXT NOT NULL,
	level      TEXT NOT NULL DEFAULT 'preferred',
	note       TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT ''
);
