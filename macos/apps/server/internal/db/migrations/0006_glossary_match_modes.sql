ALTER TABLE glossary_terms ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'exact';
ALTER TABLE glossary_terms ADD COLUMN context TEXT NOT NULL DEFAULT '';
