import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
describe('archive upgrade', () => {
  it('upgrades an old populated database without altering status or links', () => {
    const db = new DatabaseSync(':memory:');
    for (const file of ['001_initial', '002_integrity', '003_preserve_tasks'])
      db.exec(readFileSync(`src-tauri/migrations/${file}.sql`, 'utf8'));
    db.exec(
      "INSERT INTO projects VALUES ('p','Project','','now','now'); INSERT INTO tasks VALUES ('t','Task','','done','medium',NULL,NULL,'p',NULL,'now','now')",
    );
    db.exec(readFileSync('src-tauri/migrations/004_archives.sql', 'utf8'));
    expect(db.prepare('SELECT status,project_id,archived_at FROM tasks').get()).toMatchObject({
      status: 'done',
      project_id: 'p',
      archived_at: null,
    });
    db.exec("UPDATE projects SET archived_at='2026-11-13T00:00:00Z'");
    expect(db.prepare('SELECT status FROM tasks').get()?.status).toBe('done');
    db.close();
  });
});
