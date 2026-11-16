-- Execution completion is independent from the associated task's overall status.
ALTER TABLE schedules ADD COLUMN completed_at TEXT;
CREATE INDEX schedule_completion ON schedules(date,completed_at);
