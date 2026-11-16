-- A task owns its execution plans. Archiving remains an UPDATE and keeps history.
CREATE INDEX IF NOT EXISTS schedule_task ON schedules(task_id);
CREATE TRIGGER task_delete_schedules BEFORE DELETE ON tasks
BEGIN
 DELETE FROM schedules WHERE task_id=OLD.id;
END;
