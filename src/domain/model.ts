import { z } from 'zod';

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1900 || y > 9999) return false;
  const dt = new Date(y, m - 1, d, 12);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
const date = z.string().refine(validDate, '请输入有效日期（1900 至 9999 年）');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '请输入有效时间');
const title = z.string().trim().min(1, '标题不能为空').max(300, '标题最多 300 字');
const base = { id: z.uuid(), title, created_at: z.iso.datetime(), updated_at: z.iso.datetime() };
export const projectSchema = z.object({
  ...base,
  notes: z.string().max(20000),
  archived_at: z.iso.datetime().nullable().optional(),
});
export const stageSchema = z
  .object({ ...base, project_id: z.uuid(), start_date: date, end_date: date })
  .refine((v) => v.start_date <= v.end_date, '阶段结束日期不能早于开始日期');
export const taskSchema = z
  .object({
    ...base,
    notes: z.string().max(20000),
    status: z.enum(['todo', 'doing', 'done']),
    archived_at: z.iso.datetime().nullable().optional(),
    priority: z.enum(['low', 'medium', 'high']),
    due_date: date.nullable(),
    due_time: time.nullable(),
    project_id: z.uuid().nullable(),
    stage_id: z.uuid().nullable(),
  })
  .refine((v) => !v.due_time || !!v.due_date, '设置截止时间前请选择截止日期')
  .refine((v) => !v.stage_id || !!v.project_id, '阶段必须关联项目');
export const scheduleSchema = z
  .object({
    ...base,
    task_id: z.uuid().nullable(),
    completed_at: z.iso.datetime().nullable().optional(),
    date,
    period: z.enum(['anytime', 'morning', 'afternoon', 'evening', 'exact']),
    start_time: time.nullable(),
    end_time: time.nullable(),
    notes: z.string().max(20000),
  })
  .superRefine((v, ctx) => {
    if (v.period === 'exact' ? !v.start_time : !!(v.start_time || v.end_time))
      ctx.addIssue({ code: 'custom', message: '精确安排需要开始时间；模糊时段不得包含小时' });
    if (v.end_time && v.start_time && v.end_time <= v.start_time)
      ctx.addIssue({ code: 'custom', message: '结束时间必须晚于开始时间（跨日请拆分安排）' });
  });
export const eventSchema = z.object({
  ...base,
  date,
  kind: z.enum(['event', 'rest']),
  notes: z.string().max(20000),
});
export type Project = z.infer<typeof projectSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type CalendarEvent = z.infer<typeof eventSchema>;
export type Tables = {
  projects: Project;
  stages: Stage;
  tasks: Task;
  schedules: Schedule;
  events: CalendarEvent;
};
export type Table = keyof Tables;
export type Data = { [K in Table]: Tables[K][] };
export type Snapshot = Data & { format: 'local-workbench'; version: 1; exported_at: string };
export const emptyData: Data = { projects: [], stages: [], tasks: [], schedules: [], events: [] };
export const schemas = {
  projects: projectSchema,
  stages: stageSchema,
  tasks: taskSchema,
  schedules: scheduleSchema,
  events: eventSchema,
};
export const snapshotSchema = z
  .object({
    format: z.literal('local-workbench'),
    version: z.literal(1),
    exported_at: z.iso.datetime(),
    projects: z.array(projectSchema).max(100000),
    stages: z.array(stageSchema).max(100000),
    tasks: z.array(taskSchema).max(100000),
    schedules: z.array(scheduleSchema).max(100000),
    events: z.array(eventSchema).max(100000),
  })
  .superRefine((data, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const name of Object.keys(emptyData) as Table[]) {
      if (new Set(data[name].map((v) => v.id)).size !== data[name].length)
        issue(`${name} 包含重复 UUID`);
    }
    const projects = new Set(data.projects.map((p) => p.id));
    const stages = new Map(data.stages.map((s) => [s.id, s]));
    const tasks = new Set(data.tasks.map((t) => t.id));
    data.stages.forEach((s) => {
      if (!projects.has(s.project_id)) issue('阶段关联的项目不存在');
    });
    data.tasks.forEach((t) => {
      if (t.project_id && !projects.has(t.project_id)) issue('任务关联的项目不存在');
      if (t.stage_id && stages.get(t.stage_id)?.project_id !== t.project_id)
        issue('任务阶段不属于所选项目');
    });
    data.schedules.forEach((s) => {
      if (s.task_id && !tasks.has(s.task_id)) issue('日程关联的任务不存在');
    });
  });
export function parseSnapshot(text: string): Snapshot {
  if (text.length > 30 * 1024 * 1024) throw new Error('文件超过 30 MB，请拆分后重试');
  return snapshotSchema.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
}
export const periodLabels: Record<Schedule['period'], string> = {
  anytime: '全天 / 未指定',
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
  exact: '精确时间',
};
export const statusLabels: Record<Task['status'], string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
};
export const priorityLabels: Record<Task['priority'], string> = {
  low: '低',
  medium: '中',
  high: '高',
};
