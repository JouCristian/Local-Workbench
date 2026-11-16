import type { Data, Task, Schedule } from './model';
export class RecordConflict extends Error {
  readonly name = 'RecordConflict';
}
export const normalizeTitle = (title: string) =>
  title.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase();
export const taskIdentity = (task: Task) =>
  JSON.stringify([normalizeTitle(task.title), task.project_id, task.stage_id]);
export function scheduleIdentity(schedule: Schedule) {
  return JSON.stringify([
    schedule.task_id ?? `title:${normalizeTitle(schedule.title)}`,
    schedule.date,
    schedule.period,
    schedule.start_time,
  ]);
}
export function uniqueSchedules(schedules: Schedule[]): Schedule[] {
  const result = new Map<string, Schedule>();
  for (const schedule of [...schedules].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  )) {
    const key = scheduleIdentity(schedule);
    if (!result.has(key)) result.set(key, schedule);
  }
  return [...result.values()];
}
export function duplicateSchedules(schedules: Schedule[], value: Schedule) {
  return schedules.filter(
    (s) => s.id !== value.id && scheduleIdentity(s) === scheduleIdentity(value),
  );
}
export function activeData(data: Data): Data {
  const projects = data.projects.filter((p) => !p.archived_at),
    pids = new Set(projects.map((p) => p.id));
  const tasks = data.tasks.filter(
      (t) => !t.archived_at && (!t.project_id || pids.has(t.project_id)),
    ),
    tids = new Set(tasks.map((t) => t.id));
  return {
    ...data,
    projects,
    stages: data.stages.filter((s) => pids.has(s.project_id)),
    tasks,
    schedules: uniqueSchedules(data.schedules.filter((s) => !s.task_id || tids.has(s.task_id))),
  };
}
export function assertNoDuplicate(data: Data, table: string, value: Task | Schedule) {
  if (table === 'tasks') {
    const task = value as Task,
      old = data.tasks.find((t) => t.id === task.id);
    if (task.archived_at) return;
    if (old && !old.archived_at && taskIdentity(old) === taskIdentity(task)) return;
    const found = activeData(data).tasks.find(
      (t) => t.id !== task.id && taskIdentity(t) === taskIdentity(task),
    );
    if (found)
      throw new RecordConflict(
        '已有同一分类、同一阶段的同名任务，请编辑现有任务；不同项目或阶段可使用相同标题。',
      );
  }
  if (table === 'schedules') {
    const schedule = value as Schedule,
      old = data.schedules.find((s) => s.id === schedule.id);
    if (old && scheduleIdentity(old) === scheduleIdentity(schedule)) return;
    if (duplicateSchedules(data.schedules, schedule).length)
      throw new RecordConflict(
        '该任务在同一天、同一时段已有安排。请编辑已有日程，或选择不同执行时间。',
      );
  }
}
