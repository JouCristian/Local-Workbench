import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { CalendarDays } from 'lucide-react';
import { useStore } from '../state';
import { localDate } from '../domain/dates';
import {
  entryDone,
  formatDateTime,
  placeEntries,
  projectStyle,
  timeMinutes,
  type AgendaEntry,
} from '../presentation/view';
import { TaskCheck, completionExit } from './Items';
import { ScheduleCheck } from './ScheduleCompletion';
import { useMotionPreference } from './motion';
import type { EditorSpec } from './Editor';

export function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = setInterval(update, 30000);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, []);
  return now;
}
export const clockText = (now: Date) =>
  `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
function AgendaItem({
  entry,
  edit,
  block = false,
}: {
  entry: AgendaEntry;
  edit: (spec: EditorSpec) => void;
  block?: boolean;
}) {
  const { data } = useStore();
  const [intent, setIntent] = useState<boolean | null>(null);
  const reduced = useMotionPreference();
  const done = entryDone(entry) || intent === true;
  useEffect(() => {
    if (intent !== null && entryDone(entry) === intent) setIntent(null);
  }, [entry.task?.status, entry.schedule?.completed_at, intent]);
  const project = data.projects.find((project) => project.id === entry.task?.project_id);
  const open = () =>
    entry.schedule
      ? edit({ table: 'schedules', record: entry.schedule })
      : entry.task && edit({ table: 'tasks', record: entry.task });
  return (
    <motion.div
      initial={false}
      animate={{ opacity: done ? 0.6 : 1 }}
      transition={{ duration: reduced ? 0 : 0.18 }}
      exit={completionExit(intent === true, reduced)}
      className={`agenda-item ${block ? 'time-block' : ''} ${done ? 'is-done' : ''} ${entry.period === 'deadline' ? 'deadline-reminder' : ''}`}
      style={
        {
          ...projectStyle(data.projects, entry.task?.project_id ?? null),
          '--event-color': project ? 'var(--project-color)' : 'var(--primary)',
        } as React.CSSProperties
      }
      data-agenda-key={entry.key}
    >
      {entry.schedule ? (
        <ScheduleCheck schedule={entry.schedule} onIntent={setIntent} />
      ) : entry.task ? (
        <TaskCheck task={entry.task} onIntent={setIntent} />
      ) : (
        <span className="agenda-entry-dot" aria-hidden="true" />
      )}
      <button
        type="button"
        className="agenda-item-content"
        onClick={open}
        aria-label={`编辑${entry.schedule ? '日程' : '任务'}：${entry.title}`}
      >
        <span className="item-title">{entry.title}</span>
        <span className="item-meta">
          {(block || (entry.start && timeMinutes(entry.start) < 8 * 60)) && (
            <span>
              {entry.start}
              {entry.end ? `–${entry.end}` : ''}
            </span>
          )}
          {project && <span>{project.title}</span>}
          {entry.schedule?.title !== entry.title && <span>{entry.schedule?.title}</span>}
          {entry.task?.due_date &&
            (!entry.schedule || entry.schedule.date === entry.task.due_date) && (
              <span>截止 {formatDateTime(entry.task.due_date, entry.task.due_time)}</span>
            )}
          {!entry.task && <span>独立安排</span>}
          {entry.schedule?.completed_at && <span>本次日程已完成</span>}
          {entry.schedule && !entry.schedule.completed_at && entry.task?.status === 'done' && (
            <span>任务已完成 · 本次日程未完成</span>
          )}
        </span>
      </button>
    </motion.div>
  );
}
function AgendaGroup({
  title,
  entries,
  showDone,
  edit,
}: {
  title: string;
  entries: AgendaEntry[];
  showDone: boolean;
  edit: (spec: EditorSpec) => void;
}) {
  const reduced = useMotionPreference(),
    present = useIsPresent();
  return (
    <motion.section
      className="agenda-group"
      initial={false}
      inert={!present}
      exit={completionExit(false, reduced)}
    >
      <h3>{title}</h3>
      <AnimatePresence initial={false}>
        {entries.map((entry) => (
          <AgendaItem key={entry.key} entry={entry} edit={edit} />
        ))}
      </AnimatePresence>
    </motion.section>
  );
}
export function FlexibleAgenda({
  entries,
  showDone,
  edit,
}: {
  entries: AgendaEntry[];
  showDone: boolean;
  edit: (spec: EditorSpec) => void;
}) {
  return (
    <div className="flexible-agenda">
      <AnimatePresence initial={false}>
        {(
          [
            ['anytime', '未指定时段'],
            ['morning', '上午'],
            ['afternoon', '下午'],
            ['evening', '晚上'],
            ['unplanned', '待安排'],
            ['deadline', '截止提醒'],
          ] as const
        ).map(([period, title]) => {
          const visible = entries.filter(
            (entry) => entry.period === period && (showDone || !entryDone(entry)),
          );
          return visible.length ? (
            <AgendaGroup
              key={period}
              title={title}
              entries={visible}
              showDone={showDone}
              edit={edit}
            />
          ) : null;
        })}
      </AnimatePresence>
    </div>
  );
}

function CompactTimeNode({
  time,
  current,
  entries,
  showDone,
  edit,
}: {
  time: string;
  current: string;
  entries: AgendaEntry[];
  showDone: boolean;
  edit: (spec: EditorSpec) => void;
}) {
  const reduced = useMotionPreference(),
    present = useIsPresent();
  return (
    <motion.div
      className="compact-time-node"
      initial={false}
      inert={!present}
      exit={completionExit(false, reduced)}
    >
      <time>{time}</time>
      <div className="compact-time-content">
        {time === current && (
          <div className="compact-now">
            <span>现在</span>
            <i />
          </div>
        )}
        <AnimatePresence initial={false}>
          {entries.map((entry) => (
            <AgendaItem key={entry.key} entry={entry} edit={edit} />
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
export function CompactTimeline({
  entries,
  showDone,
  now,
  edit,
}: {
  entries: AgendaEntry[];
  showDone: boolean;
  now: Date;
  edit: (spec: EditorSpec) => void;
}) {
  const exact = entries.filter((entry) => entry.period === 'exact');
  const current = clockText(now);
  const times = [...new Set([...exact.map((entry) => entry.start!), current])].sort();
  return (
    <div className="compact-timeline" aria-label="今日精确时间线">
      <AnimatePresence initial={false}>
        {times
          .filter(
            (time) =>
              time === current ||
              exact.some((entry) => entry.start === time && (showDone || !entryDone(entry))),
          )
          .map((time) => (
            <CompactTimeNode
              key={time}
              time={time}
              current={current}
              entries={exact.filter(
                (entry) => entry.start === time && (showDone || !entryDone(entry)),
              )}
              showDone={showDone}
              edit={edit}
            />
          ))}
      </AnimatePresence>
    </div>
  );
}
export function HourTimeline({
  date,
  entries,
  showDone,
  now,
  edit,
  fullDay = false,
}: {
  date: string;
  entries: AgendaEntry[];
  showDone: boolean;
  now: Date;
  edit: (spec: EditorSpec) => void;
  fullDay?: boolean;
}) {
  const unit = 56,
    start = fullDay ? 0 : 8 * 60,
    finish = 24 * 60;
  const exact = entries.filter((entry) => entry.period === 'exact');
  const inside = exact.filter((entry) => timeMinutes(entry.start!) >= start);
  const outside = exact.filter((entry) => timeMinutes(entry.start!) < start);
  const placed = placeEntries(inside, unit);
  const minHeight = Math.max(
    (24 - start / 60) * unit,
    ...placed.map((item) => ((item.end - start) / 60) * unit + 8),
  );
  const minutes = now.getHours() * 60 + now.getMinutes(),
    isToday = date === localDate(now);
  return (
    <>
      <AnimatePresence initial={false}>
        {outside.some((entry) => showDone || !entryDone(entry)) && (
          <AgendaGroup
            key="early"
            title="08:00 之前"
            entries={outside.filter((entry) => showDone || !entryDone(entry))}
            showDone={showDone}
            edit={edit}
          />
        )}
      </AnimatePresence>
      {isToday && minutes < start && <div className="before-axis-now">现在 {clockText(now)}</div>}
      <div
        className="hour-timeline"
        style={{ height: minHeight }}
        aria-label={fullDay ? '0点至23点小时刻度' : '8点至23点小时刻度'}
      >
        {Array.from({ length: 24 - start / 60 }, (_, i) => i + start / 60).map((hour) => (
          <div key={hour} className="hour-tick" style={{ top: (hour - start / 60) * unit }}>
            <time>{String(hour).padStart(2, '0')}:00</time>
            <i />
          </div>
        ))}
        <div className="hour-events">
          <AnimatePresence initial={false}>
            {placed
              .filter((item) => showDone || !entryDone(item.entry))
              .map((item) => (
                <div
                  className="hour-event-position"
                  key={item.entry.key}
                  style={{
                    top: ((item.start - start) / 60) * unit,
                    left: `${(item.lane / item.lanes) * 100}%`,
                    width: `${100 / item.lanes}%`,
                    height: ((item.end - item.start) / 60) * unit,
                  }}
                >
                  <AgendaItem entry={item.entry} block edit={edit} />
                </div>
              ))}
          </AnimatePresence>
        </div>
        {isToday && minutes >= start && minutes < finish && (
          <div className="now-line" style={{ top: ((minutes - start) / 60) * unit }}>
            <span>现在 {clockText(now)}</span>
            <i />
          </div>
        )}
      </div>
      {!exact.length && (
        <p className="axis-empty">
          <CalendarDays size={14} />
          点击「新建日程」添加精确时间安排
        </p>
      )}
    </>
  );
}
