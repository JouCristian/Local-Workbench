ALTER TABLE assistant_messages ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assistant_messages ADD COLUMN response_status TEXT NOT NULL DEFAULT 'complete' CHECK(response_status IN ('complete','partial'));
ALTER TABLE assistant_messages ADD COLUMN notice TEXT NOT NULL DEFAULT '';
ALTER TABLE assistant_messages ADD COLUMN related_draft_id TEXT DEFAULT NULL;
