CREATE TRIGGER task_stage_insert BEFORE INSERT ON tasks
WHEN NEW.stage_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stages WHERE id=NEW.stage_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'Task stage must belong to its project'); END;
CREATE TRIGGER task_stage_update BEFORE UPDATE OF stage_id,project_id ON tasks
WHEN NEW.stage_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM stages WHERE id=NEW.stage_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'Task stage must belong to its project'); END;
CREATE TRIGGER stage_project_update BEFORE UPDATE OF project_id ON stages
WHEN EXISTS (SELECT 1 FROM tasks WHERE stage_id=OLD.id AND project_id<>NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'Cannot move a stage with tasks'); END;
