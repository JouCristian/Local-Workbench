import { describe, it, expect } from 'vitest';
import {
  addDays,
  calendarDate,
  compareSchedules,
  dayDistance,
  localDate,
  progress,
  scheduleTime,
  todayTasks,
} from '../src/domain/dates';
import {
  parseSnapshot,
  scheduleSchema,
  snapshotSchema,
  taskSchema,
  validDate,
  type Schedule,
  type Task,
} from '../src/domain/model';
import example from '../examples/generic.json';

const task = (extra: Partial<Task> = {}): Task => ({
  id: crypto.randomUUID(),
  title: 'A task',
  notes: '',
  status: 'todo',
  priority: 'medium',
  due_date: null,
  due_time: null,
  project_id: null,
  stage_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...extra,
});
const schedule = (extra: Partial<Schedule> = {}): Schedule => ({
  id: crypto.randomUUID(),
  title: 'A schedule',
  date: '2026-11-13',
  period: 'afternoon',
  task_id: null,
  start_time: null,
  end_time: null,
  notes: '',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...extra,
});

describe('local calendar semantics', () => {
  it('keeps local date without UTC conversion', () => {
    const d = new Date(2026, 10, 13, 0, 15);
    expect(localDate(d)).toBe('2026-11-13');
    expect(localDate(calendarDate('2026-11-13'))).toBe('2026-11-13');
  });
  it('validates real calendar days, leap days and bounds', () => {
    expect(validDate('2026-02-29')).toBe(false);
    expect(validDate('2028-02-29')).toBe(true);
    expect(validDate('2026-13-01')).toBe(false);
    expect(validDate('0099-01-01')).toBe(false);
  });
  it('handles month/year rollovers and DST with calendar distances', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(dayDistance('2026-03-09', '2026-03-07')).toBe(2);
  });
  it('never assigns hours to fuzzy periods', () => {
    expect(scheduleTime(schedule())).toBe('下午');
    expect(scheduleSchema.safeParse(schedule({ start_time: '14:00' })).success).toBe(false);
    expect(scheduleTime(schedule({ period: 'exact', start_time: '22:00' }))).toBe('22:00');
  });
  it('validates optional exact end time', () => {
    expect(
      scheduleSchema.safeParse(
        schedule({ period: 'exact', start_time: '22:00', end_time: '21:00' }),
      ).success,
    ).toBe(false);
    expect(
      scheduleSchema.safeParse(schedule({ period: 'exact', start_time: '22:00' })).success,
    ).toBe(true);
  });
  it('orders fuzzy periods in their own groups, retaining simultaneous plans', () => {
    const a = schedule(),
      b = schedule({ title: 'Other' });
    const items = [a, b, schedule({ period: 'morning' })].sort(compareSchedules);
    expect(items).toHaveLength(3);
    expect(items[0].period).toBe('morning');
  });
});
describe('task and snapshot integrity', () => {
  it('separates deadlines from execution and deduplicates today tasks', () => {
    const a = task({ due_date: '2026-11-18' }),
      b = task({ due_date: '2026-11-13' });
    const plans = [
      schedule({ task_id: a.id }),
      schedule({ task_id: a.id }),
      schedule({ task_id: b.id }),
    ];
    expect(todayTasks([a, b], plans, '2026-11-13')).toHaveLength(2);
    expect(a.due_date).toBe('2026-11-18');
  });
  it('updates progress from task status with defined empty behavior', () => {
    expect(progress([])).toBe(0);
    expect(progress([task(), task({ status: 'done' }), task({ status: 'doing' })])).toBe(33);
  });
  it('rejects time without date and empty titles', () => {
    expect(taskSchema.safeParse(task({ due_time: '12:00' })).success).toBe(false);
    expect(taskSchema.safeParse(task({ title: '  ' })).success).toBe(false);
  });
  it('round trips a valid export including BOM', () => {
    const data = parseSnapshot('\uFEFF' + JSON.stringify(example));
    expect(snapshotSchema.parse(data)).toEqual(data);
  });
  it('rejects missing references, duplicate UUID and unknown versions', () => {
    const bad = structuredClone(example);
    bad.tasks[0].project_id = crypto.randomUUID();
    expect(() => parseSnapshot(JSON.stringify(bad))).toThrow();
    const duplicate = structuredClone(example);
    duplicate.tasks.push(duplicate.tasks[0]);
    expect(() => parseSnapshot(JSON.stringify(duplicate))).toThrow();
    expect(() => parseSnapshot(JSON.stringify({ ...example, version: 99 }))).toThrow();
  });
});
