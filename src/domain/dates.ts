import type { Schedule, Task } from './model';

/** Calendar dates never pass through UTC serialization. Timestamps do. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function calendarDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
export function addDays(value: string, count: number): string {
  const d = calendarDate(value);
  d.setDate(d.getDate() + count);
  return localDate(d);
}
export function formatDate(value: string, year = false): string {
  return calendarDate(value).toLocaleDateString('zh-CN', {
    ...(year ? { year: 'numeric' } : {}),
    month: 'long',
    day: 'numeric',
  });
}
export function dayDistance(value: string, today: string): number {
  const a = value.split('-').map(Number),
    b = today.split('-').map(Number);
  return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
}
export function dueLabel(task: Task, today = localDate()): string {
  if (!task.due_date) return '无截止日期';
  const days = dayDistance(task.due_date, today);
  const label =
    days < 0
      ? `逾期 ${-days} 天`
      : days === 0
        ? '今天截止'
        : days === 1
          ? '明天截止'
          : `${days} 天后截止`;
  return `${label}${task.due_time ? ` · ${task.due_time}` : ''}`;
}
export function scheduleTime(s: Schedule): string {
  if (s.period === 'exact') return `${s.start_time}${s.end_time ? ` – ${s.end_time}` : ''}`;
  return { anytime: '全天 / 未指定', morning: '上午', afternoon: '下午', evening: '晚上' }[
    s.period
  ];
}
export function progress(tasks: Task[]): number {
  return tasks.length
    ? Math.round((tasks.filter((t) => t.status === 'done').length / tasks.length) * 100)
    : 0;
}
export function todayTasks(tasks: Task[], schedules: Schedule[], today: string): Task[] {
  const ids = new Set(schedules.filter((s) => s.date === today && s.task_id).map((s) => s.task_id));
  return tasks.filter((t) => ids.has(t.id) || t.due_date === today);
}
const periodOrder = { anytime: 0, morning: 1, afternoon: 2, evening: 3, exact: 4 };
/** Exact times have their own group. No fake hour is invented for fuzzy periods. */
export function compareSchedules(a: Schedule, b: Schedule): number {
  return (
    a.date.localeCompare(b.date) ||
    periodOrder[a.period] - periodOrder[b.period] ||
    (a.start_time ?? '').localeCompare(b.start_time ?? '') ||
    a.created_at.localeCompare(b.created_at)
  );
}
