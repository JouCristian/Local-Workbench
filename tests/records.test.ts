import { describe, it, expect } from 'vitest';
import {
  activeData,
  assertNoDuplicate,
  uniqueSchedules,
  normalizeTitle,
} from '../src/domain/records';
import { emptyData, type Task, type Schedule, parseSnapshot } from '../src/domain/model';
import example from '../examples/generic.json';
const stamp = '2026-11-12T00:00:00Z';
const task: Task = {
  id: crypto.randomUUID(),
  title: 'Read Notes',
  notes: '',
  status: 'todo',
  priority: 'medium',
  due_date: null,
  due_time: null,
  project_id: null,
  stage_id: null,
  created_at: stamp,
  updated_at: stamp,
};
const plan: Schedule = {
  id: crypto.randomUUID(),
  title: 'Read',
  notes: '',
  task_id: task.id,
  date: '2026-11-13',
  period: 'afternoon',
  start_time: null,
  end_time: null,
  created_at: stamp,
  updated_at: stamp,
};
describe('record identity and archives', () => {
  it('rejects duplicate exact starts even when end times differ', () => {
    const first = { ...plan, period: 'exact' as const, start_time: '10:00', end_time: '11:00' };
    expect(() =>
      assertNoDuplicate({ ...emptyData, tasks: [task], schedules: [first] }, 'schedules', {
        ...first,
        id: 'b',
        end_time: '12:00',
      }),
    ).toThrow(/同一时段/);
  });

  it('merges legacy same-slot duplicates without changing source records', () => {
    const schedules = [plan, { ...plan, id: crypto.randomUUID() }];
    expect(uniqueSchedules(schedules)).toHaveLength(1);
    expect(schedules).toHaveLength(2);
  });
  it('permits distinct executions and overlapping different tasks', () => {
    expect(
      uniqueSchedules([
        plan,
        { ...plan, id: 'b', period: 'morning' },
        { ...plan, id: 'c', task_id: 'other' },
      ]),
    ).toHaveLength(3);
  });
  it('rejects same task, date and period on creation, permits editing the existing record', () => {
    const data = { ...emptyData, tasks: [task], schedules: [plan] };
    expect(() => assertNoDuplicate(data, 'schedules', { ...plan, id: 'b' })).toThrow(/同一时段/);
    expect(() => assertNoDuplicate(data, 'schedules', { ...plan, notes: 'edited' })).not.toThrow();
    expect(() =>
      assertNoDuplicate(data, 'schedules', { ...plan, id: 'b', date: '2026-11-14' }),
    ).not.toThrow();
  });
  it('normalizes accidental title spacing, case and full-width characters', () => {
    expect(normalizeTitle(' Ａ b\tＣ ')).toBe('abc');
    expect(() =>
      assertNoDuplicate({ ...emptyData, tasks: [task] }, 'tasks', {
        ...task,
        id: 'b',
        title: 'READ  NOTES',
      }),
    ).toThrow(/同名/);
  });
  it('allows the same title in a different project or stage', () => {
    expect(() =>
      assertNoDuplicate({ ...emptyData, tasks: [task] }, 'tasks', {
        ...task,
        id: 'b',
        project_id: 'project',
      }),
    ).not.toThrow();
  });
  it('hides archived projects with their stages/tasks/plans and keeps independent events', () => {
    const p = {
      id: 'p',
      title: 'Project',
      notes: '',
      archived_at: stamp,
      created_at: stamp,
      updated_at: stamp,
    };
    const t = { ...task, project_id: 'p' };
    const data = { ...emptyData, projects: [p], tasks: [t], schedules: [plan] };
    const active = activeData(data);
    expect(active.projects).toHaveLength(0);
    expect(active.tasks).toHaveLength(0);
    expect(active.schedules).toHaveLength(0);
    expect(data.tasks[0].status).toBe('todo');
  });
  it('restoring an archived task detects a new active duplicate', () => {
    const old = { ...task, archived_at: stamp },
      newTask = { ...task, id: 'b' };
    expect(() =>
      assertNoDuplicate({ ...emptyData, tasks: [old, newTask] }, 'tasks', {
        ...old,
        archived_at: null,
      }),
    ).toThrow(/同名/);
  });
  it('accepts old JSON and preserves new archive timestamps on round-trip', () => {
    const parsed = parseSnapshot(JSON.stringify(example));
    parsed.tasks[0].archived_at = stamp;
    const again = parseSnapshot(JSON.stringify(parsed));
    expect(again.tasks[0].archived_at).toBe(stamp);
    expect(parseSnapshot(JSON.stringify(example)).tasks.length).toBeGreaterThan(0);
  });
});
