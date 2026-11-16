-- Business operations and their positions in the conversation are separate.
ALTER TABLE assistant_operations ADD COLUMN superseded_by TEXT REFERENCES assistant_operations(id) ON DELETE SET NULL;
CREATE TABLE assistant_operation_presentations (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 operation_id TEXT NOT NULL REFERENCES assistant_operations(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('create','revise','present','state','replace')),
 created_at TEXT NOT NULL,
 UNIQUE(operation_id,message_id)
);
CREATE INDEX assistant_presentation_operation ON assistant_operation_presentations(operation_id,sequence);
INSERT INTO assistant_operation_presentations(operation_id,message_id,revision,reason,created_at)
 SELECT id,message_id,revision,'create',created_at FROM assistant_operations ORDER BY created_at,id;
