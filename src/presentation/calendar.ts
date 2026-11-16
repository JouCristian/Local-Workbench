import { addDays, localDate, calendarDate } from '../domain/dates';
import { activeData } from '../domain/records';
import type { Data, Task, Schedule, CalendarEvent } from '../domain/model';

export type DayOverview = { tasks: Task[]; plans: Schedule[]; events: CalendarEvent[] };
export function calendarIndex(data: Data): Map<string, DayOverview> {
  const active = activeData(data),
    map = new Map<string, DayOverview>();
  const day = (date: string) => {
    if (!map.has(date)) map.set(date, { tasks: [], plans: [], events: [] });
    return map.get(date)!;
  };
  active.tasks.forEach((task) => {
    if (task.due_date) day(task.due_date).tasks.push(task);
  });
  active.schedules.forEach((plan) => day(plan.date).plans.push(plan));
  active.events.forEach((event) => day(event.date).events.push(event));
  return map;
}
export function monthDays(month: string): string[] {
  const first = `${month}-01`,
    weekday = (calendarDate(first).getDay() + 6) % 7;
  const start = addDays(first, -weekday);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}
export function moveMonth(month: string, delta: number): string {
  const [year, number] = month.split('-').map(Number),
    next = new Date(year, number - 1 + delta, 1, 12);
  return localDate(next).slice(0, 7);
}
