import { describe, it, expect } from 'vitest';
import { entryDone, agendaForDate } from '../src/presentation/view';
import { emptyData, parseSnapshot, schemas } from '../src/domain/model';
const now = new Date().toISOString();
const task = schemas.tasks.parse({
  id: crypto.randomUUID(),
  title: 'Task',
  notes: '',
  status: 'todo',
  priority: 'medium',
  due_date: '2026-11-18',
  due_time: null,
  project_id: null,
  stage_id: null,
  created_at: now,
  updated_at: now,
});
const plan = (date: string, completed_at: string | null = null) =>
  schemas.schedules.parse({
    id: crypto.randomUUID(),
    task_id: task.id,
    title: 'Plan',
    notes: '',
    date,
    period: 'morning',
    start_time: null,
    end_time: null,
    created_at: now,
    updated_at: now,
    completed_at,
  });
describe('schedule completion is independent from task status', () => {
  it('keeps the deadline reminder after all executions for that day are completed', () => {
    const rows = agendaForDate(
      { ...emptyData, tasks: [task], schedules: [plan('2026-11-18', now)] },
      '2026-11-18',
    );
    expect(rows.some((e) => e.period === 'deadline' && !entryDone(e))).toBe(true);
    expect(rows.filter((e) => e.schedule)).toHaveLength(1);
  });
  it('completing one execution leaves later executions and task deadline open', () => {
    const data = {
      ...emptyData,
      tasks: [task],
      schedules: [plan('2026-11-15', now), plan('2026-11-16'), plan('2026-11-17')],
    };
    expect(entryDone(agendaForDate(data, '2026-11-15')[0])).toBe(true);
    expect(entryDone(agendaForDate(data, '2026-11-16')[0])).toBe(false);
    expect(entryDone(agendaForDate(data, '2026-11-18')[0])).toBe(false);
  });
  it('a completed task does not imply every execution was performed', () => {
    const entry = agendaForDate(
      { ...emptyData, tasks: [{ ...task, status: 'done' }], schedules: [plan('2026-11-15')] },
      '2026-11-15',
    )[0];
    expect(entryDone(entry)).toBe(false);
  });
  it('round trips completion while accepting older backup files', () => {
    const snapshot = {
      ...emptyData,
      tasks: [task],
      schedules: [plan('2026-11-15', now)],
      format: 'local-workbench',
      version: 1,
      exported_at: now,
    };
    expect(parseSnapshot(JSON.stringify(snapshot)).schedules[0].completed_at).toBe(now);
    delete (snapshot.schedules[0] as { completed_at?: unknown }).completed_at;
    expect(parseSnapshot(JSON.stringify(snapshot)).schedules[0].completed_at).toBeUndefined();
  });
});
