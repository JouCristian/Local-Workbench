import { orderDirection } from '../presentation/navigation';
import { useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useMotionPreference } from './motion';
import { Flag } from 'lucide-react';
import { useStore } from '../state';
import { deadline, formatDate, horizonDays, weekday } from '../presentation/view';

export function DateStrip({
  start,
  count,
  selected,
  onSelect,
  now,
}: {
  start: string;
  count: 7 | 14;
  selected: string;
  onSelect: (date: string) => void;
  now: Date;
}) {
  const { data } = useStore();
  const reduced = useMotionPreference();
  const strip = useRef<HTMLDivElement>(null),
    history = useRef({ start, selected, direction: 1 as 1 | -1, from: null as number | null });
  const [highlight, setHighlight] = useState<{
    key: string;
    x: number;
    y: number;
    width: number;
    height: number;
    from: number | null;
    direction: 1 | -1;
  } | null>(null);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = () => {
      const cell = el.querySelector<HTMLButtonElement>(`[data-date="${selected}"]`);
      if (!cell) {
        setHighlight(null);
        return;
      }
      const previous = history.current,
        changed = previous.selected !== selected,
        direction = changed ? orderDirection(previous.selected, selected) : previous.direction;
      const from =
        previous.start !== start
          ? direction > 0
            ? -cell.offsetWidth
            : el.clientWidth
          : previous.from;
      history.current = { start, selected, direction, from };
      const next = {
        key: `${start}:${count}`,
        x: cell.offsetLeft,
        y: cell.offsetTop,
        width: cell.offsetWidth,
        height: cell.offsetHeight,
        from,
        direction,
      };
      setHighlight((old) => (old && JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [start, selected, count]);
  const days = horizonDays(data, start, count);
  const max = Math.max(1, ...days.map((day) => day.schedules.length));
  return (
    <div
      ref={strip}
      className="date-strip"
      data-count={count}
      aria-label={count === 14 ? '未来14天时间地平线' : '本周日期'}
    >
      {highlight && (
        <motion.i
          key={highlight.key}
          className="date-selection"
          aria-hidden="true"
          data-direction={highlight.direction}
          initial={
            reduced || highlight.from === null
              ? false
              : {
                  x: highlight.from,
                  y: highlight.y,
                  width: highlight.width,
                  height: highlight.height,
                }
          }
          animate={{
            x: highlight.x,
            y: highlight.y,
            width: highlight.width,
            height: highlight.height,
          }}
          transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 38 }}
        />
      )}
      {days.map((day) => {
        const rest = day.events.some((event) => event.kind === 'rest'),
          important = day.events.filter((event) => event.kind === 'event');
        const label = `${formatDate(day.date)} ${weekday(day.date)}，${day.schedules.length} 项安排，${day.deadlines.length} 项截止${rest ? '，休息日' : ''}${important.length ? `，${important.map((event) => event.title).join('、')}` : ''}`;
        return (
          <button
            key={day.date}
            type="button"
            className={`date-cell ${day.date === selected ? 'selected' : ''} ${rest ? 'rest-day' : ''}`}
            aria-label={label}
            title={label}
            aria-pressed={day.date === selected}
            data-date={day.date}
            onClick={() => onSelect(day.date)}
          >
            <span className="date-weekday">
              {weekday(day.date)}
              <span className="date-flags">
                {rest && <span className="rest-mark">休</span>}
                {important.length > 0 && <Flag size={12} />}
              </span>
            </span>
            <strong>{Number(day.date.slice(-2))}</strong>
            <span className="deadline-dots" aria-hidden="true">
              {day.deadlines.slice(0, 3).map((task) => (
                <i key={task.id} className={`deadline-dot tone-${deadline(task, now).tone}`} />
              ))}
              {day.deadlines.length > 3 && <small>+{day.deadlines.length - 3}</small>}
            </span>
            <span className="date-load-label">
              {day.schedules.length ? `${day.schedules.length} 项` : ' '}
            </span>
            <span className="date-load" aria-hidden="true">
              <i style={{ width: `${(day.schedules.length / max) * 100}%` }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
