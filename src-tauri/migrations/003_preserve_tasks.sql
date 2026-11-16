CREATE TRIGGER project_delete_detach BEFORE DELETE ON projects
BEGIN UPDATE tasks SET stage_id=NULL, project_id=NULL WHERE project_id=OLD.id; END;
