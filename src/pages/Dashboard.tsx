import { DashboardLayout } from '../components/DashboardLayout';
import { defaultLayout } from '../domain/preferences';
import { activeData } from '../domain/records';
import { useContentEntrance } from '../components/motion';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, useRef } from 'react';
import { Plus, ArrowUpRight, CalendarDays, RotateCcw } from 'lucide-react';
import { useStore } from '../state';
import { addDays } from '../domain/dates';
import {
  agendaForDate,
  compareDeadlines,
  dateHeading,
  deadline,
  entryDone,
  formatDate,
  projectStyle,
  stageState,
} from '../presentation/view';
import { DateStrip } from '../components/DateStrip';
import { HourTimeline, FlexibleAgenda, useClock } from '../components/Timeline';
import { Empty, EventRow, TaskRow } from '../components/Items';
import type { EditorSpec } from '../components/Editor';

export function Dashboard({
  today,
  edit,
  onDateSelect,
  onProjectSelect,
  onCalendar,
}: {
  today: string;
  edit: (spec: EditorSpec) => void;
  onDateSelect: (date: string) => void;
  onProjectSelect: (id: string) => void;
  onCalendar: () => void;
}) {
  const entrance = useContentEntrance();
  const { data: allData, dashboardLayout, setDashboardLayout } = useStore(),
    data = activeData(allData),
    now = useClock();
  const [showDone, setShowDone] = useState(false);
  const agenda = agendaForDate(data, today),
    active = agenda.filter((entry) => !entryDone(entry));
  const deadlines = data.tasks
    .filter((task) => task.status !== 'done' && task.due_date)
    .sort(compareDeadlines);
  const overdue = deadlines.filter((task) => deadline(task, now).tone === 'overdue');
  const upcoming = deadlines.filter(
    (task) => deadline(task, now).tone !== 'overdue' && task.due_date! <= addDays(today, 7),
  );
  const summary = [
    active.some((entry) => entry.period !== 'deadline')
      ? `今天 ${active.filter((entry) => entry.period !== 'deadline').length} 项安排`
      : '',
    upcoming.length ? `7 天内有 ${upcoming.length} 个截止` : '',
    overdue.length ? `${overdue.length} 项逾期` : '',
  ].filter(Boolean);
  const [emptyReady, setEmptyReady] = useState(active.length === 0);
  useEffect(() => {
    if (active.length) {
      setEmptyReady(false);
      return;
    }
    const timer = setTimeout(() => setEmptyReady(true), 260);
    return () => clearTimeout(timer);
  }, [active.length]);
  const events = data.events.filter((event) => event.date === today);
  const agendaScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = agendaScroll.current;
    if (!el) return;
    // Start near the present hour; all 24 hours remain reachable in the same scroll area.
    const axis = el.querySelector<HTMLElement>('.hour-timeline');
    if (axis) el.scrollTop = Math.max(0, axis.offsetTop - el.offsetTop + (now.getHours() - 1) * 56);
  }, [today]);
  return (
    <div className="dashboard-page">
      <motion.div variants={entrance} className="dashboard-status">
        <h1>{dateHeading(today)}</h1>
        <div className="button-group">
          <button
            className="icon-button"
            aria-label="查看月历"
            title="查看月历"
            onClick={onCalendar}
          >
            <CalendarDays size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="恢复默认布局"
            title="恢复默认布局"
            disabled={
              Math.abs(dashboardLayout.columns - defaultLayout.columns) < 0.001 &&
              Math.abs(dashboardLayout.rows - defaultLayout.rows) < 0.001
            }
            onClick={() => void setDashboardLayout({ ...defaultLayout }).catch(() => {})}
          >
            <RotateCcw size={17} />
          </button>
          <button className="primary" onClick={() => edit({ table: 'tasks' })}>
            <Plus size={16} />
            新建任务
          </button>
        </div>
      </motion.div>
      {summary.length > 0 && (
        <p className="dashboard-summary">
          {summary.map((text, index) => (
            <span key={text} className={text.includes('逾期') ? 'overdue-text' : ''}>
              {index > 0 && <b aria-hidden="true">·</b>}
              {text}
            </span>
          ))}
        </p>
      )}
      <motion.section
        variants={entrance}
        className="horizon-section"
        aria-labelledby="horizon-title"
      >
        <div className="view-section-heading">
          <h2 id="horizon-title">时间地平线</h2>
          <span>
            {formatDate(today)} 至 {formatDate(addDays(today, 13))}
          </span>
        </div>
        <DateStrip start={today} count={14} selected={today} onSelect={onDateSelect} now={now} />
        <div className="horizon-legend">
          <span>
            <i className="deadline-dot tone-today" />
            今天截止
          </span>
          <span>
            <i className="deadline-dot tone-soon" />7 天内截止
          </span>
          <span>
            <i className="legend-load" />
            安排量
          </span>
        </div>
      </motion.section>
      <DashboardLayout
        today={
          <motion.section
            variants={entrance}
            className="today-agenda"
            aria-labelledby="today-title"
          >
            <div className="view-section-heading">
              <h2 id="today-title">今天</h2>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={showDone}
                  onChange={(event) => setShowDone(event.target.checked)}
                />
                显示已完成
              </label>
            </div>
            <div
              ref={agendaScroll}
              className="dashboard-agenda-scroll stable-scroll"
              tabIndex={0}
              aria-label="今日24小时安排"
            >
              {events.length > 0 && (
                <div className="day-events">
                  {events.map((event) => (
                    <EventRow key={event.id} event={event} edit={edit} showDate={false} />
                  ))}
                </div>
              )}
              <FlexibleAgenda entries={agenda} showDone={showDone} edit={edit} />
              <HourTimeline
                date={today}
                entries={agenda}
                showDone={showDone}
                now={now}
                edit={edit}
                fullDay
              />
              {emptyReady && !active.length && !showDone && (
                <Empty
                  action={() => edit({ table: 'schedules', defaults: { date: today } })}
                  label="安排今天"
                >
                  {agenda.length ? '今天的安排已完成。' : '今天还没有任务或日程。'}
                </Empty>
              )}
            </div>
          </motion.section>
        }
        deadlines={
          <motion.section
            variants={entrance}
            className="deadline-section"
            aria-labelledby="deadline-title"
          >
            <div className="view-section-heading">
              <h2 id="deadline-title">截止倒计时</h2>
              <span>{deadlines.length} 项未完成</span>
            </div>
            <div className="deadline-list stable-scroll" tabIndex={0} aria-label="截止倒计时列表">
              <AnimatePresence initial={false}>
                {deadlines.map((task) => (
                  <TaskRow key={task.id} task={task} edit={edit} variant="deadline" now={now} />
                ))}
              </AnimatePresence>
              {!deadlines.length && <Empty>没有待完成的截止事项。</Empty>}
            </div>
          </motion.section>
        }
        projects={
          <motion.section
            variants={entrance}
            className="project-section"
            aria-labelledby="project-title"
          >
            <div className="view-section-heading">
              <h2 id="project-title">项目进展</h2>
              <button className="text-button" onClick={() => edit({ table: 'projects' })}>
                <Plus size={14} />
                新建项目
              </button>
            </div>
            <div
              className="project-progress-scroll stable-scroll"
              tabIndex={0}
              aria-label="项目进展列表"
            >
              {data.projects.map((project) => {
                const state = stageState(project, data.stages, data.tasks, today);
                return (
                  <div
                    className="project-overview-row"
                    key={project.id}
                    style={projectStyle(allData.projects, project.id)}
                  >
                    <button
                      type="button"
                      className="project-overview-title"
                      onClick={() => onProjectSelect(project.id)}
                    >
                      <i />
                      {project.title}
                      <ArrowUpRight size={14} />
                    </button>
                    <div className="stage-segments">
                      {state.ordered.length ? (
                        state.ordered.map((stage) => {
                          const tasks = allData.tasks.filter((task) => task.stage_id === stage.id),
                            done = tasks.filter((task) => task.status === 'done').length;
                          const progress = tasks.length
                              ? Math.round((done / tasks.length) * 100)
                              : 0,
                            current = state.active.some((active) => active.id === stage.id);
                          return (
                            <button
                              type="button"
                              key={stage.id}
                              className={`stage-segment ${current ? 'current' : ''}`}
                              aria-label={`${stage.title}，${formatDate(stage.start_date)}至${formatDate(stage.end_date)}，${done}/${tasks.length} 项完成`}
                              onClick={() => edit({ table: 'stages', record: stage })}
                            >
                              <span
                                role="progressbar"
                                aria-label={stage.title}
                                aria-valuenow={progress}
                                aria-valuemin={0}
                                aria-valuemax={100}
                              >
                                <i style={{ width: `${progress}%` }} />
                              </span>
                            </button>
                          );
                        })
                      ) : (
                        <span className="no-stage">暂无阶段</span>
                      )}
                    </div>
                    <span className="project-phase-label">
                      {state.ordered.length
                        ? `阶段${['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][state.index] ?? state.index}/共${state.ordered.length}段`
                        : '暂无阶段'}
                      <b>·</b>
                      {state.remaining} 项待完成
                    </span>
                  </div>
                );
              })}
              {!data.projects.length && (
                <Empty action={() => edit({ table: 'projects' })} label="创建项目">
                  还没有项目。
                </Empty>
              )}
            </div>
          </motion.section>
        }
      />
    </div>
  );
}
