ALTER TABLE documents ADD COLUMN format TEXT NOT NULL DEFAULT 'pdf';
ALTER TABLE annotations ADD COLUMN locator_json TEXT NOT NULL DEFAULT '{}';
CREATE TABLE document_sections (
 document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL,
 href TEXT NOT NULL,
 title TEXT NOT NULL,
 blocks_json TEXT NOT NULL,
 text TEXT NOT NULL,
 PRIMARY KEY(document_id, ordinal)
);
CREATE TABLE reading_locations (
 document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
 location_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
