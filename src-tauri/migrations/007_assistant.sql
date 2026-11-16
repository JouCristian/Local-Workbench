CREATE TABLE assistant_conversations (
 id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE assistant_messages (
 id TEXT PRIMARY KEY NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')),
 text TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', proposals TEXT NOT NULL DEFAULT '[]',
 draft_state TEXT NOT NULL DEFAULT 'none' CHECK(draft_state IN ('none','pending','applied','cancelled')),
 created_at TEXT NOT NULL
);
CREATE INDEX assistant_message_order ON assistant_messages(conversation_id,created_at,id);
