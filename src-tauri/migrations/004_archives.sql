-- Archiving preserves status, relationships and historical schedules.
ALTER TABLE projects ADD COLUMN archived_at TEXT DEFAULT NULL;
ALTER TABLE tasks ADD COLUMN archived_at TEXT DEFAULT NULL;
CREATE INDEX projects_archive ON projects(archived_at);
CREATE INDEX tasks_archive ON tasks(archived_at, project_id);
