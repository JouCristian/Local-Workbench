import { uniqueSchedules } from '../domain/records';
import { localDate, compareSchedules } from '../domain/dates';
import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { CalendarPlus, Check, Flag, Moon, Archive, ArchiveRestore } from 'lucide-react';
import { useMotionPreference } from './motion';
import { useStore } from '../state';
import { deadline, formatDate, formatDateTime, projectStyle } from '../presentation/view';
import { priorityLabels, type Task, type Schedule, type CalendarEvent } from '../domain/model';
import { scheduleTime } from '../domain/dates';
import type { EditorSpec } from './Editor';

export function completionExit(active: boolean, reduced: boolean) {
  return {
    opacity: 0,
    height: 0,
    minHeight: 0,
    paddingTop: 0,
    paddingBottom: 0,
    marginTop: 0,
    marginBottom: 0,
    borderWidth: 0,
    transition: {
      duration: reduced ? 0 : 0.22,
      delay: active && !reduced ? 0.06 : 0,
      ease: [0.22, 1, 0.36, 1] as const,
    },
  };
}
export function TaskCheck({
  task,
  onIntent,
  disabled = false,
}: {
  task: Task;
  onIntent?: (value: boolean | null) => void;
  disabled?: boolean;
}) {
  const { toggle, busy } = useStore();
  const [intent, setIntent] = useState<boolean | null>(null);
  const checked = intent ?? task.status === 'done';
  useEffect(() => {
    if (intent !== null && (task.status === 'done') === intent) setIntent(null);
  }, [task.status, intent]);
  async function activate() {
    const next = !checked;
    setIntent(next);
    onIntent?.(next);
    try {
      await toggle(task);
    } catch {
      setIntent(null);
      onIntent?.(null);
    }
  }
  return (
    <button
      type="button"
      className={`check-button ${checked ? 'done' : task.status === 'doing' ? 'doing' : ''} ${intent === true ? 'check-drawing' : ''}`}
      aria-label={`${checked ? '重新打开' : '完成'}任务：${task.title}`}
      aria-pressed={checked}
      disabled={busy || disabled}
      onClick={() => void activate()}
    >
      {checked ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 8 6.4 11.3 13 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : task.status === 'doing' ? (
        <span className="doing-dot" />
      ) : null}
    </button>
  );
}
export function DeadlineBadge({
  task,
  now = new Date(),
  className = '',
}: {
  task: Task;
  now?: Date;
  className?: string;
}) {
  if (!task.due_date) return null;
  const info = deadline(task, now);
  return (
    <span
      className={`deadline-badge tone-${info.tone} ${className}`}
      title={formatDateTime(task.due_date, task.due_time)}
    >
      <i aria-hidden="true" />
      {info.label}
    </span>
  );
}
export type TaskSelection = { selectedIds: ReadonlySet<string>; toggle: (id: string) => void };
export function TaskRow({
  task,
  edit,
  context = true,
  variant = 'task',
  now = new Date(),
  details = false,
  selection,
}: {
  task: Task;
  details?: boolean;
  selection?: TaskSelection;
  edit: (spec: EditorSpec) => void;
  context?: boolean;
  variant?: 'task' | 'deadline' | 'archived';
  now?: Date;
}) {
  const { data, archive, busy } = useStore();
  const reduced = useMotionPreference();
  const [intent, setIntent] = useState<boolean | null>(null);
  const done = task.status === 'done' || intent === true;
  useEffect(() => {
    if (intent !== null && (task.status === 'done') === intent) setIntent(null);
  }, [task.status, intent]);
  const project = data.projects.find((project) => project.id === task.project_id);
  const plans = uniqueSchedules(data.schedules.filter((s) => s.task_id === task.id)).sort(
    compareSchedules,
  );
  const plan = plans.find((s) => s.date >= localDate()) ?? plans.at(-1);
  const detailText = [
    task.due_date ? `截止 ${formatDateTime(task.due_date, task.due_time)}` : '未设置截止日期',
    plan ? `安排 ${formatDate(plan.date)} ${scheduleTime(plan)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <motion.div
      initial={false}
      animate={{ opacity: selection ? 1 : done ? 0.65 : 1 }}
      transition={{ duration: reduced ? 0 : 0.18 }}
      exit={completionExit(intent === true, reduced)}
      className={`task-row ${variant === 'deadline' ? 'deadline-row' : ''} ${done ? 'is-done' : ''} ${details ? 'detailed-task-row' : ''}`}
      data-selected={selection?.selectedIds.has(task.id) || undefined}
      data-task-id={task.id}
      data-project={task.project_id ?? undefined}
      style={projectStyle(data.projects, task.project_id)}
    >
      {selection ? (
        <button
          type="button"
          role="checkbox"
          className="selection-check"
          aria-label={`选择任务：${task.title}`}
          aria-checked={selection.selectedIds.has(task.id)}
          disabled={busy}
          onClick={() => selection.toggle(task.id)}
        >
          {selection.selectedIds.has(task.id) && <Check size={14} />}
        </button>
      ) : (
        <TaskCheck task={task} onIntent={setIntent} disabled={variant === 'archived'} />
      )}
      <button
        type="button"
        className="item-main"
        disabled={!!selection && busy}
        onClick={() =>
          selection ? selection.toggle(task.id) : edit({ table: 'tasks', record: task })
        }
      >
        <span className="item-title">{task.title}</span>
        {details && <span className="item-meta task-date-detail">{detailText}</span>}
        {variant === 'deadline' && (
          <span className="item-meta">
            {project?.title ?? '独立任务'}
            <span>{task.due_date && formatDateTime(task.due_date, task.due_time)}</span>
          </span>
        )}
      </button>
      {variant === 'task' && (
        <>
          {context && project && <span className="task-project-label">{project.title}</span>}
          {!done && task.status === 'doing' && <span className="status-label">进行中</span>}
          {done && <span className="status-label completed-label">已完成</span>}
          {task.priority !== 'medium' && (
            <span className={`priority-label priority-${task.priority}`}>
              {priorityLabels[task.priority]}优先级
            </span>
          )}
        </>
      )}
      <DeadlineBadge task={task} now={now} />
      {!selection && variant === 'archived' && (
        <button
          disabled={busy}
          className="text-button"
          aria-label={`恢复任务：${task.title}`}
          onClick={() => void archive('tasks', task.id, false).catch(() => {})}
        >
          <ArchiveRestore size={15} />
          恢复
        </button>
      )}
      {!selection && variant === 'task' && done && (
        <button
          disabled={busy}
          className="icon-button"
          aria-label={`归档任务：${task.title}`}
          title={`归档任务：${task.title}`}
          onClick={() => void archive('tasks', task.id, true).catch(() => {})}
        >
          <Archive size={15} />
        </button>
      )}
      {!selection && variant === 'task' && (
        <button
          type="button"
          className="icon-button row-action"
          aria-label={`管理日程：${task.title}`}
          title="新增或编辑此任务的全部日程"
          onClick={() =>
            edit({
              table: 'schedules',
              mode: 'task-schedules',
              defaults: { task_id: task.id, title: task.title },
            })
          }
        >
          <CalendarPlus size={15} />
        </button>
      )}
    </motion.div>
  );
}
export function ScheduleRow({
  schedule,
  edit,
}: {
  schedule: Schedule;
  edit: (spec: EditorSpec) => void;
}) {
  const { data } = useStore();
  const task = data.tasks.find((task) => task.id === schedule.task_id);
  return (
    <button
      type="button"
      className={`schedule-row ${schedule.completed_at ? 'is-done' : ''}`}
      onClick={() => edit({ table: 'schedules', record: schedule })}
      style={projectStyle(data.projects, task?.project_id ?? null)}
    >
      <span className="schedule-time">{scheduleTime(schedule)}</span>
      <span className="item-title">{task?.title ?? schedule.title}</span>
      {schedule.completed_at && <Check size={15} />}
    </button>
  );
}
export function EventRow({
  event,
  edit,
  showDate = true,
}: {
  event: CalendarEvent;
  edit: (spec: EditorSpec) => void;
  showDate?: boolean;
}) {
  return (
    <button
      type="button"
      className={`event-row ${event.kind === 'rest' ? 'rest' : ''}`}
      onClick={() => edit({ table: 'events', record: event })}
    >
      {event.kind === 'rest' ? <Moon size={15} /> : <Flag size={15} />}
      <span className="item-title">{event.title}</span>
      {showDate && <span className="item-meta">{formatDate(event.date)}</span>}
      <span className="event-kind">{event.kind === 'rest' ? '休息日' : '重要事件'}</span>
    </button>
  );
}
export function Empty({
  children,
  action,
  label,
}: {
  children: ReactNode;
  action?: () => void;
  label?: string;
}) {
  return (
    <div className="empty">
      <p>{children}</p>
      {action && (
        <button type="button" className="text-button" onClick={action}>
          {label}
        </button>
      )}
    </div>
  );
}
