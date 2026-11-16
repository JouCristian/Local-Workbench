import { ViewSwitch } from '../components/PageTransition';
import { activeData } from '../domain/records';
import { useContentEntrance } from '../components/motion';
import { motion } from 'motion/react';
import { useRef, useState } from 'react';
import { Plus, ChevronLeft, ChevronRight, CircleHelp, Flag, CalendarDays } from 'lucide-react';
import { useStore } from '../state';
import { addDays, calendarDate } from '../domain/dates';
import { validDate } from '../domain/model';
import { agendaForDate, dateHeading } from '../presentation/view';
import { DateStrip } from '../components/DateStrip';
import { DatePicker, Popover } from '../components/Controls';
import { FlexibleAgenda, HourTimeline, useClock } from '../components/Timeline';
import { EventRow } from '../components/Items';
import type { EditorSpec } from '../components/Editor';

// Keep each transition pane's anchor independent: unmounting an outgoing pane must
// never clear the incoming pane's ref and strand a top-layer popup at (0, 0).
function ScheduleHelp() {
  const [help, setHelp] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="icon-button help-trigger"
        aria-label="日程说明"
        aria-expanded={help}
        onClick={() => setHelp(!help)}
      >
        <CircleHelp size={16} />
      </button>
      <Popover
        label="日程说明"
        open={help}
        close={() => setHelp(false)}
        anchor={anchor}
        className="help-popover"
      >
        <p>可关联已有任务，也可创建独立日程。同一时刻允许多条安排。</p>
        <p>上午、下午、晚上单独列出；只有明确填写的小时才会进入时间刻度。</p>
        <p>已安排任务在截止当天显示截止提醒；尚无日程的任务显示为待安排。</p>
        <p>勾选只完成本次安排。关联任务尚未完成时，可选择是否同时完成任务；其他日程保持独立。</p>
      </Popover>
    </>
  );
}

export function SchedulePage({
  today,
  date,
  setDate,
  edit,
  onCalendar,
}: {
  today: string;
  date: string;
  setDate: (date: string) => void;
  edit: (spec: EditorSpec) => void;
  onCalendar?: () => void;
}) {
  const entrance = useContentEntrance();
  const { data: allData } = useStore(),
    data = activeData(allData),
    now = useClock();
  const [showDone, setShowDone] = useState(false);
  const start = addDays(date, -((calendarDate(date).getDay() + 6) % 7));
  const agenda = agendaForDate(data, date),
    events = data.events.filter((event) => event.date === date);
  return (
    <div className="schedule-page">
      <motion.div variants={entrance} className="page-heading">
        <h1>日程</h1>
        <div className="button-group">
          {onCalendar && (
            <button
              className="icon-button"
              aria-label="查看月历"
              title="查看月历"
              onClick={onCalendar}
            >
              <CalendarDays size={17} />
            </button>
          )}
          <button onClick={() => edit({ table: 'events', defaults: { date } })}>
            <Flag size={15} />
            标记事件
          </button>
          <button
            className="primary"
            onClick={() => edit({ table: 'schedules', defaults: { date } })}
          >
            <Plus size={16} />
            新建日程
          </button>
        </div>
      </motion.div>
      <motion.div variants={entrance} className="schedule-date-navigation">
        <h2>{dateHeading(date)}</h2>
        <div className="button-group">
          <button
            type="button"
            className="icon-button"
            aria-label="上一周"
            onClick={() => setDate(addDays(date, -7))}
          >
            <ChevronLeft size={17} />
          </button>
          <button type="button" onClick={() => setDate(today)}>
            今天
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="下一周"
            onClick={() => setDate(addDays(date, 7))}
          >
            <ChevronRight size={17} />
          </button>
          <DatePicker
            label="选择日程日期"
            value={date}
            clearable={false}
            onChange={(value) => {
              if (validDate(value)) setDate(value);
            }}
          />
        </div>
      </motion.div>
      <motion.div variants={entrance}>
        <DateStrip start={start} count={7} selected={date} onSelect={setDate} now={now} />
      </motion.div>
      <ViewSwitch viewKey={date} order={Number(date.replaceAll('-', ''))}>
        <motion.section variants={entrance} className="daily-agenda">
          <div className="view-section-heading">
            <h2>当天安排</h2>
            <div className="agenda-toolbar">
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={showDone}
                  onChange={(event) => setShowDone(event.target.checked)}
                />
                显示已完成
              </label>
              <ScheduleHelp />
            </div>
          </div>
          {events.length > 0 && (
            <div className="day-events">
              {events.map((event) => (
                <EventRow key={event.id} event={event} edit={edit} showDate={false} />
              ))}
            </div>
          )}
          <FlexibleAgenda entries={agenda} showDone={showDone} edit={edit} />
          <HourTimeline date={date} entries={agenda} showDone={showDone} now={now} edit={edit} />
        </motion.section>
      </ViewSwitch>
    </div>
  );
}
