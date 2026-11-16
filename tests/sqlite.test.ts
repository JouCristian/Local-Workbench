import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let dir: string, path: string, db: DatabaseSync;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workbench-test-'));
  path = join(dir, 'test.db');
  db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON');
  for (const migration of ['001_initial', '002_integrity', '003_preserve_tasks'])
    db.exec(readFileSync(`src-tauri/migrations/${migration}.sql`, 'utf8'));
  db.exec(
    "INSERT INTO projects VALUES ('p','Project','','now','now'); INSERT INTO stages VALUES ('s','p','Stage','2026-11-12','2026-11-20','now','now'); INSERT INTO tasks VALUES ('t','Task','','todo','high','2026-11-18',NULL,'p','s','now','now');",
  );
  for (const migration of [
    '004_archives',
    '005_project_delete_contents',
    '006_task_delete_schedules',
  ])
    db.exec(readFileSync(`src-tauri/migrations/${migration}.sql`, 'utf8'));
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith('workbench-test-')) {
    throw new Error('Refusing to remove a path outside the test fixture directory');
  }
  rmSync(dir, { recursive: true, force: true });
});
describe('real SQLite migrations and relationships', () => {
  it('persists tasks after closing and reopening a disk database', () => {
    db.close();
    db = new DatabaseSync(path);
    expect(db.prepare('SELECT title FROM tasks').get()?.title).toBe('Task');
  });
  it('deletes project tasks and stages instead of detaching tasks', () => {
    db.exec("DELETE FROM projects WHERE id='p'");
    expect(db.prepare('SELECT count(*) n FROM tasks').get()?.n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM stages').get()?.n).toBe(0);
  });
  it('deletes assigned, unassigned and archived project contents without touching unrelated data', () => {
    db.exec(
      "INSERT INTO tasks(id,title,notes,status,priority,project_id,created_at,updated_at,archived_at) VALUES ('unassigned','Unassigned','','done','medium','p','now','now','archived');INSERT INTO tasks(id,title,notes,status,priority,created_at,updated_at) VALUES ('independent','Independent','','todo','medium','now','now');INSERT INTO projects(id,title,notes,created_at,updated_at) VALUES ('other','Other','','now','now');INSERT INTO tasks(id,title,notes,status,priority,project_id,created_at,updated_at) VALUES ('other-task','Other task','','todo','medium','other','now','now');",
    );
    const insert = db.prepare(
      "INSERT INTO schedules VALUES (?,?,?,'2026-11-13','afternoon',NULL,NULL,'','now','now')",
    );
    insert.run('linked', 't', 'Linked');
    insert.run('archived-linked', 'unassigned', 'Archived');
    insert.run('standalone', null, 'Standalone');
    insert.run('independent-plan', 'independent', 'Independent');
    insert.run('other-plan', 'other-task', 'Other');
    db.exec("DELETE FROM projects WHERE id='p'");
    expect(
      db
        .prepare('SELECT id FROM tasks ORDER BY id')
        .all()
        .map((row) => row.id),
    ).toEqual(['independent', 'other-task']);
    expect(
      db
        .prepare('SELECT id FROM schedules ORDER BY id')
        .all()
        .map((row) => row.id),
    ).toEqual(['independent-plan', 'other-plan', 'standalone']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('rolls the entire project deletion back if a child cannot be deleted', () => {
    db.exec(
      "INSERT INTO schedules VALUES ('linked','t','Linked','2026-11-13','afternoon',NULL,NULL,'','now','now');CREATE TRIGGER test_block_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'blocked');END;",
    );
    expect(() => db.exec("DELETE FROM projects WHERE id='p'")).toThrow(/blocked/);
    for (const table of ['projects', 'stages', 'tasks', 'schedules'])
      expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(1);
  });
  it('keeps all content when archiving a project', () => {
    db.exec("UPDATE projects SET archived_at='2026-11-13T00:00:00Z' WHERE id='p'");
    expect(db.prepare("SELECT project_id FROM tasks WHERE id='t'").get()?.project_id).toBe('p');
    expect(db.prepare('SELECT count(*) n FROM stages').get()?.n).toBe(1);
  });
  it('keeps project relationship when deleting stage', () => {
    db.exec("DELETE FROM stages WHERE id='s'");
    const t = db.prepare('SELECT * FROM tasks').get();
    expect(t?.stage_id).toBeNull();
    expect(t?.project_id).toBe('p');
  });
  it('deletes all linked schedules when a task is removed', () => {
    const stmt = db.prepare(
      "INSERT INTO schedules VALUES (?,'t',?,'2026-11-13','afternoon',NULL,NULL,'','now','now')",
    );
    stmt.run('a', 'First');
    stmt.run('b', 'Second');
    db.exec("DELETE FROM tasks WHERE id='t'");
    expect(db.prepare('SELECT count(*) n FROM schedules').get()?.n).toBe(0);
  });
  it('allows overlapping stages and rejects a task linked to another project stage', () => {
    db.exec(
      "INSERT INTO stages VALUES ('s2','p','Overlap','2026-11-14','2026-11-21','now','now'); INSERT INTO projects(id,title,notes,created_at,updated_at) VALUES ('p2','Other','','now','now');",
    );
    expect(() => db.exec("UPDATE tasks SET project_id='p2' WHERE id='t'")).toThrow(
      /stage must belong/,
    );
  });
  it('rejects time values for fuzzy periods and rolls back a failed import', () => {
    expect(() =>
      db.exec(
        "INSERT INTO schedules VALUES ('a','t','Bad','2026-11-13','morning','09:00',NULL,'','now','now')",
      ),
    ).toThrow();
    db.exec('BEGIN');
    db.exec('DELETE FROM tasks');
    try {
      db.exec(
        "INSERT INTO tasks(id,title,notes,status,priority,due_date,due_time,project_id,stage_id,created_at,updated_at) VALUES ('bad','','','todo','high',NULL,NULL,NULL,NULL,'now','now')",
      );
    } catch {
      db.exec('ROLLBACK');
    }
    expect(db.prepare('SELECT id FROM tasks').get()?.id).toBe('t');
  });
});
