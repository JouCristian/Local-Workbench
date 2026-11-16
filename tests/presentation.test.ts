import { describe, it, expect } from 'vitest';
import {
  agendaForDate,
  deadline,
  formatDate,
  parseDateInput,
  placeEntries,
  stageState,
} from '../src/presentation/view';
import { emptyData, type Task, type Schedule } from '../src/domain/model';
const stamp = '2026-11-12T00:00:00Z';
const task: Task = {
  id: 'task',
  title: 'Task',
  notes: '',
  status: 'todo',
  priority: 'medium',
  due_date: '2026-11-12',
  due_time: '22:00',
  project_id: null,
  stage_id: null,
  created_at: stamp,
  updated_at: stamp,
};
const plan: Schedule = {
  id: 'plan',
  title: 'Plan',
  notes: '',
  task_id: 'task',
  date: '2026-11-12',
  period: 'afternoon',
  start_time: null,
  end_time: null,
  created_at: stamp,
  updated_at: stamp,
};
describe('presentation calendar', () => {
  it('shows a deadline reminder when the task is already planned on another date', () => {
    const data = { ...emptyData, tasks: [task], schedules: [{ ...plan, date: '2026-11-11' }] };
    expect(agendaForDate(data, '2026-11-12')).toHaveLength(1);
    expect(agendaForDate(data, '2026-11-12')[0]).toMatchObject({
      period: 'deadline',
      start: null,
      end: null,
    });
    expect(agendaForDate({ ...data, schedules: [] }, '2026-11-12')[0].period).toBe('unplanned');
  });
  it('keeps same-day deadline information on its execution without adding another row', () => {
    const entries = agendaForDate({ ...emptyData, tasks: [task], schedules: [plan] }, '2026-11-12');
    expect(entries).toHaveLength(1);
    expect(entries[0].task?.due_time).toBe('22:00');
    expect(entries[0].schedule?.id).toBe(plan.id);
  });
  it('retains multiple executions without duplicating a linked DDL task', () => {
    const entries = agendaForDate(
      {
        ...emptyData,
        tasks: [task],
        schedules: [plan, { ...plan, id: 'second', period: 'morning' }],
      },
      '2026-11-12',
    );
    expect(entries).toHaveLength(2);
    expect(
      entries.every((e) => e.start === null && ['afternoon', 'morning'].includes(e.period)),
    ).toBe(true);
  });
  it('never turns a due time into an execution time', () => {
    expect(agendaForDate({ ...emptyData, tasks: [task] }, '2026-11-12')[0]).toMatchObject({
      period: 'unplanned',
      start: null,
      end: null,
    });
  });
  it('uses local dates and distinguishes exact overdue time', () => {
    const now = new Date(2026, 10, 12, 23, 0);
    expect(deadline(task, now).tone).toBe('overdue');
    expect(deadline({ ...task, due_time: null }, now).tone).toBe('today');
    expect(deadline({ ...task, due_date: '2026-11-18' }, now).label).toBe('还剩 6 天');
  });
  it('formats readable dates and validates localized input', () => {
    expect(formatDate('2026-11-18', false, '2026-11-12')).toBe('11月18日');
    expect(formatDate('2027-01-01', false, '2026-11-12')).toBe('2027年1月1日');
    expect(parseDateInput('11月18日', 2026)).toBe('2026-11-18');
    expect(parseDateInput('2026/2/29')).toBeNull();
  });
  it('packs overlaps into columns without changing explicit times', () => {
    const entries = agendaForDate(
      {
        ...emptyData,
        tasks: [task],
        schedules: [
          { ...plan, period: 'exact', start_time: '10:00', end_time: '11:00' },
          { ...plan, id: 'b', period: 'exact', start_time: '10:30', end_time: null },
        ],
      },
      '2026-11-12',
    );
    const placed = placeEntries(entries);
    expect(placed.map((e) => e.lane)).toEqual([0, 1]);
    expect(placed.every((e) => e.lanes === 2)).toBe(true);
    expect(entries.find((entry) => entry.schedule?.id === 'b')?.end).toBeNull();
  });
  it('keeps overlapping stages active', () => {
    const p = { id: 'p', title: 'Project', notes: '', created_at: stamp, updated_at: stamp };
    const s = {
      id: 'a',
      title: 'Stage',
      project_id: 'p',
      start_date: '2026-11-10',
      end_date: '2026-11-20',
      created_at: stamp,
      updated_at: stamp,
    };
    const state = stageState(p, [s, { ...s, id: 'b', start_date: '2026-11-12' }], [], '2026-11-12');
    expect(state.active).toHaveLength(2);
    expect(state.index).toBe(2);
  });
});
