import { activeData } from '../domain/records';
import type { CSSProperties } from 'react';
import { addDays, calendarDate, dayDistance, localDate } from '../domain/dates';
import type { Data, Project, Schedule, Stage, Task } from '../domain/model';

export type Tone = 'overdue' | 'today' | 'soon' | 'later' | 'done';
export function formatDate(value: string, includeYear = false, today = localDate()): string {
  const [year, month, day] = value.split('-').map(Number);
  return `${includeYear || year !== Number(today.slice(0, 4)) ? `${year}年` : ''}${month}月${day}日`;
}
export function formatDateTime(date: string, time: string | null = null): string {
  return `${formatDate(date)}${time ? ` ${time}` : ''}`;
}
export const weekday = (date: string) => `周${'日一二三四五六'[calendarDate(date).getDay()]}`;
export const dateHeading = (date: string) => `${formatDate(date)} ${weekday(date)}`;
export function parseDateInput(value: string, year = new Date().getFullYear()): string | null {
  const full = value.match(/^(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})日?$/);
  const short = value.match(/^(\d{1,2})[月\-/](\d{1,2})日?$/);
  if (!full && !short) return null;
  const y = full ? Number(full[1]) : year,
    m = Number(full ? full[2] : short![1]),
    d = Number(full ? full[3] : short![2]);
  if (y < 1900 || y > 9999) return null;
  const test = new Date(y, m - 1, d, 12);
  if (test.getFullYear() !== y || test.getMonth() !== m - 1 || test.getDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export const timeMinutes = (time: string): number => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};
export function deadline(
  task: Task,
  now = new Date(),
): { label: string; tone: Tone; days: number } {
  if (!task.due_date)
    return { label: '', tone: task.status === 'done' ? 'done' : 'later', days: Infinity };
  const days = dayDistance(task.due_date, localDate(now));
  if (task.status === 'done') return { label: '已完成', tone: 'done', days };
  const minutes =
    task.due_time && days === 0
      ? timeMinutes(task.due_time) - now.getHours() * 60 - now.getMinutes()
      : null;
  if (days < 0) return { label: `逾期 ${-days} 天`, tone: 'overdue', days };
  if (minutes !== null && minutes < 0)
    return {
      label: -minutes < 60 ? `逾期 ${-minutes} 分钟` : `逾期 ${Math.floor(-minutes / 60)} 小时`,
      tone: 'overdue',
      days,
    };
  if (days === 0)
    return {
      label:
        minutes === null
          ? '今天截止'
          : minutes < 60
            ? `还剩 ${minutes} 分钟`
            : `还剩 ${Math.floor(minutes / 60)} 小时`,
      tone: 'today',
      days,
    };
  return { label: `还剩 ${days} 天`, tone: days <= 7 ? 'soon' : 'later', days };
}
export function compareDeadlines(a: Task, b: Task): number {
  return (
    `${a.due_date ?? '9999-12-31'} ${a.due_time ?? '23:59'}`.localeCompare(
      `${b.due_date ?? '9999-12-31'} ${b.due_time ?? '23:59'}`,
    ) || a.created_at.localeCompare(b.created_at)
  );
}
export function projectStyle(projects: Project[], id: string | null): CSSProperties {
  const index = projects.findIndex((project) => project.id === id);
  return {
    '--project-color': index < 0 ? 'var(--border)' : `var(--project-${(index % 5) + 1})`,
  } as CSSProperties;
}

export type AgendaEntry = {
  key: string;
  title: string;
  task?: Task;
  schedule?: Schedule;
  period: Schedule['period'] | 'unplanned' | 'deadline';
  start: string | null;
  end: string | null;
};
/** Each real execution remains a separate entry. A linked task is not rendered again as a DDL task. */
export function agendaForDate(data: Data, date: string): AgendaEntry[] {
  data = activeData(data);
  const plans = data.schedules.filter((schedule) => schedule.date === date);
  const linked = new Set(plans.map((schedule) => schedule.task_id).filter(Boolean));
  const pendingLinked = new Set(
    plans
      .filter((schedule) => !schedule.completed_at)
      .map((schedule) => schedule.task_id)
      .filter(Boolean),
  );
  const arranged = new Set(data.schedules.map((schedule) => schedule.task_id).filter(Boolean));
  const tasks = new Map(data.tasks.map((task) => [task.id, task]));
  return [
    ...plans.map((schedule) => {
      const task = schedule.task_id ? tasks.get(schedule.task_id) : undefined;
      return {
        key: `schedule-${schedule.id}`,
        title: task?.title ?? schedule.title,
        task,
        schedule,
        period: schedule.period,
        start: schedule.start_time,
        end: schedule.end_time,
      };
    }),
    ...data.tasks
      .filter(
        (task) =>
          task.due_date === date &&
          (!linked.has(task.id) || (task.status !== 'done' && !pendingLinked.has(task.id))),
      )
      .map((task) => ({
        key: `task-${task.id}`,
        title: task.title,
        task,
        period: arranged.has(task.id) ? ('deadline' as const) : ('unplanned' as const),
        start: null,
        end: null,
      })),
  ];
}
export const entryDone = (entry: AgendaEntry) =>
  entry.schedule ? !!entry.schedule.completed_at : entry.task?.status === 'done';
export function horizonDays(data: Data, start: string, count: number) {
  data = activeData(data);
  return Array.from({ length: count }, (_, i) => {
    const date = addDays(start, i);
    return {
      date,
      deadlines: data.tasks.filter((task) => task.due_date === date),
      schedules: data.schedules.filter((schedule) => schedule.date === date),
      events: data.events.filter((event) => event.date === date),
    };
  });
}

export type PlacedEntry = {
  entry: AgendaEntry;
  start: number;
  end: number;
  lane: number;
  lanes: number;
};
/** Packing affects visual columns only, never the stored start/end or overlap of schedules. */
export function placeEntries(entries: AgendaEntry[], pixelsPerHour = 56): PlacedEntry[] {
  const sorted = entries
    .filter((entry) => entry.period === 'exact' && entry.start)
    .map((entry) => ({
      entry,
      start: timeMinutes(entry.start!),
      end: Math.max(
        entry.end ? timeMinutes(entry.end) : timeMinutes(entry.start!),
        timeMinutes(entry.start!) + (64 / pixelsPerHour) * 60,
      ),
      lane: 0,
      lanes: 1,
    }))
    .sort((a, b) => a.start - b.start || a.entry.key.localeCompare(b.entry.key));
  let cluster: PlacedEntry[] = [],
    clusterEnd = -1,
    laneEnds: number[] = [];
  const finish = () => {
    for (const item of cluster) item.lanes = laneEnds.length;
  };
  for (const item of sorted) {
    if (item.start >= clusterEnd) {
      finish();
      cluster = [];
      laneEnds = [];
      clusterEnd = -1;
    }
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = item.end;
    item.lane = lane;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  finish();
  return sorted;
}
export function stageState(project: Project, stages: Stage[], tasks: Task[], date: string) {
  const ordered = stages
    .filter((stage) => stage.project_id === project.id)
    .sort(
      (a, b) =>
        a.start_date.localeCompare(b.start_date) ||
        a.end_date.localeCompare(b.end_date) ||
        a.id.localeCompare(b.id),
    );
  const active = ordered.filter((stage) => stage.start_date <= date && stage.end_date >= date);
  const current =
    active.at(-1) ?? ordered.find((stage) => stage.start_date > date) ?? ordered.at(-1);
  const remaining = tasks.filter(
    (task) =>
      task.status !== 'done' &&
      (current ? task.stage_id === current.id : task.project_id === project.id),
  ).length;
  return { ordered, active, current, index: current ? ordered.indexOf(current) + 1 : 0, remaining };
}
