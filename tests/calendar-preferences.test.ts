import { describe, it, expect } from 'vitest';
import { monthDays, moveMonth, calendarIndex } from '../src/presentation/calendar';
import { defaultLayout, readLayout, clampSplit, accentSchema } from '../src/domain/preferences';
import { emptyData } from '../src/domain/model';
import { zoomIntent } from '../src/presentation/navigation';
describe('calendar navigation', () => {
  it('uses six complete local-calendar weeks and retains leap day', () => {
    const days = monthDays('2028-02');
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2028-01-31');
    expect(days).toContain('2028-02-29');
    expect(moveMonth('2026-12', 1)).toBe('2027-01');
    expect(moveMonth('2027-01', -1)).toBe('2026-12');
  });
  it('indexes the same live data and excludes archived project contents', () => {
    const stamp = '2026-11-13T00:00:00Z';
    const project = {
      id: 'p',
      title: 'Project',
      notes: '',
      created_at: stamp,
      updated_at: stamp,
      archived_at: stamp,
    };
    const task = {
      id: 't',
      title: 'Task',
      notes: '',
      created_at: stamp,
      updated_at: stamp,
      status: 'todo' as const,
      priority: 'medium' as const,
      project_id: 'p',
      stage_id: null,
      due_date: '2026-11-18',
      due_time: null,
    };
    expect(calendarIndex({ ...emptyData, projects: [project], tasks: [task] }).size).toBe(0);
    expect(
      calendarIndex({ ...emptyData, tasks: [{ ...task, project_id: null }] }).get('2026-11-18')
        ?.tasks,
    ).toHaveLength(1);
  });
  it('expresses hierarchy as depth instead of a horizontal slide', () => {
    expect(zoomIntent(-1)).toMatchObject({ axis: 'z', direction: -1 });
    expect(zoomIntent(1, '20% 40%')).toEqual({ axis: 'z', direction: 1, origin: '20% 40%' });
  });
});
describe('personal preferences', () => {
  it('validates persisted layout and falls back from corrupted data', () => {
    expect(readLayout('{broken')).toEqual(defaultLayout);
    expect(readLayout('{"columns":2,"rows":0.7}')).toEqual(defaultLayout);
    expect(readLayout('{"columns":0.5,"rows":0.6}')).toEqual({ columns: 0.5, rows: 0.6 });
    expect(clampSplit(0, 'columns')).toBe(0.32);
    expect(clampSplit(1, 'rows')).toBe(0.82);
  });
  it('accepts the seven named accents only', () => {
    expect(accentSchema.options).toHaveLength(7);
    expect(accentSchema.safeParse('violet').success).toBe(true);
    expect(accentSchema.safeParse('#abcdef').success).toBe(false);
  });
});
