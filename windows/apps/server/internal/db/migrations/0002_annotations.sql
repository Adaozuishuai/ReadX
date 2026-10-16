-- 批注（S4）：给 annotations 表补上「类型 + 页内偏移」。
--
-- 偏移是尽力而为的定位提示：文本层会被重新抽取，逐字偏移可能漂移，
-- 所以渲染时仍以「摘录在段落里能否原样找到」为准，偏移只作为二次消歧的辅助信息。
ALTER TABLE annotations ADD COLUMN kind TEXT NOT NULL DEFAULT 'highlight';
ALTER TABLE annotations ADD COLUMN start_offset INTEGER;
ALTER TABLE annotations ADD COLUMN end_offset INTEGER;

-- 同一篇里按页 + 创建时间取用最多，建个复合索引。
CREATE INDEX annotations_page ON annotations(document_id, page, created_at);
