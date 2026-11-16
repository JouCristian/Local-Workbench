ALTER TABLE assistant_conversations ADD COLUMN pinned_at TEXT DEFAULT NULL;
ALTER TABLE assistant_conversations ADD COLUMN title_manual INTEGER NOT NULL DEFAULT 0 CHECK(title_manual IN (0,1));
