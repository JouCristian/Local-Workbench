import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, CalendarCheck2 } from 'lucide-react';
import { Modal } from './Modal';
import { useStore, errorMessage } from '../state';
import type { Schedule, Task } from '../domain/model';

export function ScheduleCheck({
  schedule,
  onIntent,
}: {
  schedule: Schedule;
  onIntent?: (value: boolean | null) => void;
}) {
  const { toggleSchedule, busy, completingScheduleId } = useStore();
  const completing = completingScheduleId === schedule.id;
  useEffect(() => {
    if (completing) onIntent?.(true);
  }, [completing]);
  return (
    <button
      type="button"
      className={`check-button ${schedule.completed_at || completing ? 'done' : ''} ${completing ? 'check-drawing' : ''}`}
      aria-label={`${schedule.completed_at ? '重新打开日程' : '完成本次日程'}：${schedule.title}`}
      aria-pressed={!!schedule.completed_at || completing}
      disabled={busy}
      onClick={() => void toggleSchedule(schedule).catch(() => onIntent?.(null))}
    >
      {(schedule.completed_at || completing) && (
        <motion.span initial={false} animate={{ opacity: 1, scale: 1 }}>
          <Check size={12} />
        </motion.span>
      )}
    </button>
  );
}
function CompletionDialog({ pending }: { pending: { schedule: Schedule; task: Task } }) {
  const { data, busy, cancelScheduleCompletion, confirmScheduleCompletion } = useStore();
  const [error, setError] = useState('');
  const lock = useRef(false);
  const { schedule, task } = pending;
  const remaining = data.schedules.filter(
    (s) => s.task_id === task.id && s.id !== schedule.id && !s.completed_at,
  ).length;
  async function confirm(both: boolean) {
    if (lock.current) return;
    lock.current = true;
    setError('');
    try {
      await confirmScheduleCompletion(both);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
    }
  }
  return (
    <Modal title="完成本次日程" close={cancelScheduleCompletion} busy={busy}>
      <div className="confirm-content modal-scroll">
        <CalendarCheck2 size={26} />
        <p>完成「{schedule.title}」这一次安排？</p>
        <p className="field-hint">
          {remaining
            ? `该任务还有 ${remaining} 条未完成日程。`
            : '这是该任务目前最后一条未完成日程。'}{' '}
          日程完成不等于整个任务完成。
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
      <footer className="modal-footer schedule-completion-actions">
        <button disabled={busy} onClick={cancelScheduleCompletion}>
          取消
        </button>
        <button disabled={busy} onClick={() => void confirm(true)}>
          同时完成任务
        </button>
        <button className="primary" disabled={busy} onClick={() => void confirm(false)}>
          仅完成本次日程
        </button>
      </footer>
    </Modal>
  );
}
export function ScheduleCompletion() {
  const { pendingSchedule } = useStore();
  return (
    <AnimatePresence>
      {pendingSchedule && (
        <CompletionDialog pending={pendingSchedule} key={pendingSchedule.schedule.id} />
      )}
    </AnimatePresence>
  );
}
