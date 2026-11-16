-- Pending business operations are independent of chat text and survive restarts.
CREATE TABLE assistant_operations (
 id TEXT PRIMARY KEY NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL,
 title TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','paused','applied','cancelled')),
 revision INTEGER NOT NULL DEFAULT 0,
 actions TEXT NOT NULL,
 preview TEXT NOT NULL,
 receipt TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX assistant_operation_thread ON assistant_operations(conversation_id,created_at);
CREATE TABLE assistant_runs (
 id TEXT PRIMARY KEY NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','complete','stopped','failed')),
 started_at TEXT NOT NULL,
 finished_at TEXT,
 error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE assistant_steps (
 id TEXT PRIMARY KEY NOT NULL,
 run_id TEXT NOT NULL REFERENCES assistant_runs(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL,
 tool TEXT NOT NULL,
 label TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','complete','failed')),
 result TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX assistant_step_run ON assistant_steps(run_id,sequence);
CREATE TABLE assistant_context (
 conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
 value TEXT NOT NULL DEFAULT '{}',
 updated_at TEXT NOT NULL
);
