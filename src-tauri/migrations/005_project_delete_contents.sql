-- Deleting a project owns its contents; archiving is the non-destructive alternative.
-- These statements are part of the same DELETE and roll back together on any failure.
DROP TRIGGER IF EXISTS project_delete_detach;
CREATE TRIGGER project_delete_contents BEFORE DELETE ON projects
BEGIN
 DELETE FROM schedules WHERE task_id IN (SELECT id FROM tasks WHERE project_id=OLD.id);
 DELETE FROM tasks WHERE project_id=OLD.id;
 DELETE FROM stages WHERE project_id=OLD.id;
END;
