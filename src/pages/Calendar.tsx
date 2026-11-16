import { useMemo, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, ArrowLeft, CalendarDays, Flag } from 'lucide-react';
import { useStore } from '../state';
import { validDate } from '../domain/model';
import { calendarDate } from '../domain/dates';
import { calendarIndex, monthDays, moveMonth, type DayOverview } from '../presentation/calendar';
import { deadline, formatDate, projectStyle } from '../presentation/view';
import { elementOrigin, zoomIntent, type MotionIntent } from '../presentation/navigation';
import { ViewSwitch } from '../components/PageTransition';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const empty: DayOverview = { tasks: [], plans: [], events: [] };
function Marks({ day, now }: { day: DayOverview; now: Date }) {
  return (
    <span className="calendar-day-marks" aria-hidden="true">
      {day.tasks.slice(0, 3).map((task) => (
        <i key={task.id} className={`deadline-dot tone-${deadline(task, now).tone}`} />
      ))}
      {day.plans.length > 0 && <i className="calendar-plan-mark" />}
      {day.events.some((event) => event.kind === 'event') && <Flag size={9} />}
    </span>
  );
}
export function CalendarPage({
  today,
  initialDate,
  onDateSelect,
  onBack,
}: {
  today: string;
  initialDate: string;
  onDateSelect: (date: string, origin: string) => void;
  onBack: () => void;
}) {
  const { data } = useStore();
  const index = useMemo(() => calendarIndex(data), [data]);
  const [month, setMonth] = useState(initialDate.slice(0, 7)),
    [level, setLevel] = useState<'month' | 'year'>('month');
  const [intent, setIntent] = useState<MotionIntent>({ axis: 'z', direction: -1 });
  const year = Number(month.slice(0, 4)),
    number = Number(month.slice(5, 7)),
    now = new Date();
  function step(delta: number) {
    setIntent({ axis: 'x', direction: delta > 0 ? 1 : -1 });
    if (level === 'month') setMonth(moveMonth(month, delta));
    else setMonth(`${year + delta}-${month.slice(5, 7)}`);
  }
  function toMonth(target: string, origin: string) {
    setIntent(zoomIntent(1, origin));
    setMonth(target);
    setLevel('month');
  }
  const min = level === 'year' ? year <= 1900 : month === '1900-01',
    max = level === 'year' ? year >= 9999 : month === '9999-12';
  return (
    <div className="calendar-page">
      <div className="page-heading calendar-heading">
        <div>
          <button className="text-button" onClick={onBack}>
            <ArrowLeft size={14} />
            返回总览
          </button>
          <h1>{level === 'month' ? `${year}年${number}月` : `${year}年`}</h1>
        </div>
        <div className="button-group">
          {level === 'month' && (
            <button
              aria-label="查看年份"
              onClick={() => {
                setIntent(zoomIntent(-1));
                setLevel('year');
              }}
            >
              全年
              <CalendarDays size={15} />
            </button>
          )}
          <button
            onClick={() => {
              setIntent({ axis: 'x', direction: month <= today.slice(0, 7) ? 1 : -1 });
              setMonth(today.slice(0, 7));
            }}
          >
            本{level === 'month' ? '月' : '年'}
          </button>
          <button
            className="icon-button"
            aria-label={level === 'month' ? '上个月' : '上一年'}
            disabled={min}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="icon-button"
            aria-label={level === 'month' ? '下个月' : '下一年'}
            disabled={max}
            onClick={() => step(1)}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <p className="calendar-caption">
        {level === 'month'
          ? '查看整月的日程、截止与特殊日期，选择某天进入日程。'
          : '选择月份展开查看。圆点标记截止与安排，休息日以“休”标注。'}
      </p>
      <ViewSwitch
        viewKey={`${level}:${level === 'year' ? year : month}`}
        axis={intent.axis}
        direction={intent.direction}
        origin={intent.origin}
        order={year * 12 + number}
      >
        {level === 'month' ? (
          <div className="month-calendar" aria-label={`${year}年${number}月月历`}>
            <div className="month-weekdays">
              {weekdays.map((day) => (
                <span key={day}>周{day}</span>
              ))}
            </div>
            <div className="month-days">
              {monthDays(month).map((date) => {
                const day = index.get(date) ?? empty,
                  rest = day.events.some((event) => event.kind === 'rest');
                return (
                  <button
                    type="button"
                    key={date}
                    disabled={!validDate(date)}
                    data-date={date}
                    aria-label={`${formatDate(date)}，${day.plans.length}项安排，${day.tasks.length}项截止${rest ? '，休息日' : ''}`}
                    className={`month-day ${date.slice(0, 7) !== month ? 'outside-month' : ''} ${date === today ? 'is-today' : ''}`}
                    onClick={(event) => onDateSelect(date, elementOrigin(event.currentTarget))}
                  >
                    <span className="month-day-heading">
                      <b>{calendarDate(date).getDate()}</b>
                      {rest && <small>休</small>}
                      <Marks day={day} now={now} />
                    </span>
                    <span className="month-day-items">
                      {day.events.slice(0, 1).map((event) => (
                        <span className="calendar-event-label" key={event.id}>
                          {event.title}
                        </span>
                      ))}
                      {day.tasks
                        .filter((task) => task.status !== 'done')
                        .slice(0, 1)
                        .map((task) => (
                          <span
                            key={task.id}
                            className={`calendar-deadline-label tone-${deadline(task, now).tone}`}
                          >
                            截止 · {task.title}
                          </span>
                        ))}
                      {day.plans.slice(0, 1).map((plan) => {
                        const task = data.tasks.find((task) => task.id === plan.task_id);
                        return (
                          <span
                            key={plan.id}
                            className="calendar-execution-label"
                            style={
                              {
                                ...projectStyle(data.projects, task?.project_id ?? null),
                                '--calendar-event-color': task?.project_id
                                  ? 'var(--project-color)'
                                  : 'var(--primary)',
                              } as CSSProperties
                            }
                          >
                            {plan.start_time ? `${plan.start_time} ` : ''}
                            {task?.title ?? plan.title}
                          </span>
                        );
                      })}
                      {day.plans.length > 1 && <small>共 {day.plans.length} 项安排</small>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="year-calendar" aria-label={`${year}年年历`}>
            {Array.from({ length: 12 }, (_, i) => {
              const target = `${year}-${String(i + 1).padStart(2, '0')}`,
                days = monthDays(target),
                first = days.findIndex((date) => date === `${target}-01`);
              return (
                <button
                  type="button"
                  className={`year-month ${target === today.slice(0, 7) ? 'current-month' : ''}`}
                  key={target}
                  aria-label={`展开${year}年${i + 1}月`}
                  onClick={(event) => toMonth(target, elementOrigin(event.currentTarget))}
                >
                  <strong>{i + 1}月</strong>
                  <span className="mini-month-grid">
                    {weekdays.map((day) => (
                      <small key={day}>{day}</small>
                    ))}
                    {days.slice(0, first + new Date(year, i + 1, 0, 12).getDate()).map((date) => {
                      if (date.slice(0, 7) !== target) return <span key={date} />;
                      const day = index.get(date) ?? empty;
                      return (
                        <span key={date} className={date === today ? 'mini-today' : ''}>
                          <b>{Number(date.slice(-2))}</b>
                          <Marks day={day} now={now} />
                          {day.events.some((event) => event.kind === 'rest') && <em>休</em>}
                        </span>
                      );
                    })}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </ViewSwitch>
      <div className="calendar-legend">
        <span>
          <i className="calendar-plan-mark" />
          执行安排
        </span>
        <span>
          <i className="deadline-dot tone-today" />
          截止事项
        </span>
        <span>
          <Flag size={12} />
          重要事件
        </span>
        <span>休 · 休息日</span>
      </div>
    </div>
  );
}
