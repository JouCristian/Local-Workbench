CREATE TABLE projects (
 id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL CHECK(length(trim(title)) > 0),
 notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE stages (
 id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL CHECK(length(trim(title)) > 0), start_date TEXT NOT NULL, end_date TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(start_date <= end_date)
);
CREATE TABLE tasks (
 id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL CHECK(length(trim(title)) > 0), notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('todo','doing','done')), priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
 due_date TEXT, due_time TEXT, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
 stage_id TEXT REFERENCES stages(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(due_time IS NULL OR due_date IS NOT NULL), CHECK(stage_id IS NULL OR project_id IS NOT NULL)
);
CREATE TABLE schedules (
 id TEXT PRIMARY KEY NOT NULL, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
 title TEXT NOT NULL CHECK(length(trim(title)) > 0), date TEXT NOT NULL,
 period TEXT NOT NULL CHECK(period IN ('anytime','morning','afternoon','evening','exact')),
 start_time TEXT, end_time TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((period = 'exact' AND start_time IS NOT NULL) OR (period <> 'exact' AND start_time IS NULL AND end_time IS NULL)),
 CHECK(end_time IS NULL OR end_time > start_time)
);
CREATE TABLE events (
 id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL CHECK(length(trim(title)) > 0), date TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('event','rest')), notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
CREATE INDEX task_due ON tasks(due_date, status);
CREATE INDEX task_stage ON tasks(stage_id);
CREATE INDEX schedule_date ON schedules(date);
CREATE INDEX event_date ON events(date);
