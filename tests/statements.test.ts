import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildUpsert } from '../src/data/statements';
import type { Task, Schedule } from '../src/domain/model';
const stamp = '2026-11-13T00:00:00Z';
const task: Task = {
  id: 'task',
  title: 'Task',
  notes: '',
  status: 'todo',
  priority: 'medium',
  due_date: null,
  due_time: null,
  project_id: null,
  stage_id: null,
  archived_at: null,
  created_at: stamp,
  updated_at: stamp,
};
function database() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['001_initial', '002_integrity', '003_preserve_tasks', '004_archives'])
    db.exec(readFileSync(`src-tauri/migrations/${file}.sql`, 'utf8'));
  return db;
}
const run = (db: DatabaseSync, table: 'tasks' | 'schedules', value: Task | Schedule) => {
  const s = buildUpsert(table, value);
  return db.prepare(s.sql).run(...(s.values as (string | null)[])).changes;
};
describe('atomic SQLite upserts', () => {
  it('prevents duplicate insertion while allowing status changes and archives', () => {
    const db = database();
    expect(run(db, 'tasks', task)).toBe(1);
    expect(run(db, 'tasks', { ...task, id: 'second', title: ' TASK ' })).toBe(0);
    expect(run(db, 'tasks', { ...task, status: 'done' })).toBe(1);
    expect(run(db, 'tasks', { ...task, status: 'done', archived_at: stamp })).toBe(1);
    expect(run(db, 'tasks', { ...task, id: 'second' })).toBe(1);
    expect(run(db, 'tasks', task)).toBe(0);
    db.close();
  });
  it('guards execution start identity and supports ordinary schedule edits', () => {
    const db = database();
    run(db, 'tasks', task);
    const plan: Schedule = {
      id: 'plan',
      title: 'Plan',
      notes: '',
      task_id: task.id,
      date: '2026-11-13',
      period: 'exact',
      start_time: '10:00',
      end_time: '11:00',
      created_at: stamp,
      updated_at: stamp,
    };
    expect(run(db, 'schedules', plan)).toBe(1);
    expect(run(db, 'schedules', { ...plan, id: 'copy', end_time: '12:00' })).toBe(0);
    expect(run(db, 'schedules', { ...plan, end_time: '12:00', notes: 'edited' })).toBe(1);
    expect(run(db, 'schedules', { ...plan, id: 'later', start_time: '10:30' })).toBe(1);
    db.close();
  });
  it('does not lose legacy duplicate records when editing one record', () => {
    const db = database();
    run(db, 'tasks', task);
    db.exec(
      "INSERT INTO schedules VALUES ('a','task','Plan','2026-11-13','afternoon',NULL,NULL,'','now','now');INSERT INTO schedules VALUES ('b','task','Plan','2026-11-13','afternoon',NULL,NULL,'','now','now')",
    );
    expect(
      run(db, 'schedules', {
        id: 'a',
        task_id: 'task',
        title: 'Plan',
        date: '2026-11-13',
        period: 'afternoon',
        start_time: null,
        end_time: null,
        notes: 'preserved',
        created_at: stamp,
        updated_at: stamp,
      }),
    ).toBe(1);
    expect(db.prepare('SELECT count(*) AS count FROM schedules').get()?.count).toBe(2);
    db.close();
  });
});
