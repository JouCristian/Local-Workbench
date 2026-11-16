import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Plus, Trash2, Undo2, ChevronDown } from 'lucide-react';
import { useStore, errorMessage } from '../state';
import { compareSchedules, localDate } from '../domain/dates';
import { periodLabels, type Schedule } from '../domain/model';
import { formatDateTime } from '../presentation/view';
import { DatePicker, TimePicker, Select } from './Controls';
import { Modal, Confirm } from './Modal';
import { appleEase, useMotionPreference } from './motion';

export function TaskSchedules({ taskId, close }: { taskId: string; close: () => void }) {
  const { data, busy, saveTaskSchedules } = useStore();
  const task = data.tasks.find((task) => task.id === taskId);
  const [original] = useState(() =>
    data.schedules.filter((plan) => plan.task_id === taskId).sort(compareSchedules),
  );
  function create(date = localDate()): Schedule {
    const stamp = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      task_id: taskId,
      title: task?.title ?? '',
      date,
      period: 'anytime',
      start_time: null,
      end_time: null,
      notes: '',
      created_at: stamp,
      updated_at: stamp,
    };
  }
  const [plans, setPlans] = useState<Schedule[]>(() =>
    original.length ? original.map((plan) => ({ ...plan })) : [create()],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState(''),
    [confirming, setConfirming] = useState(false);
  const reduced = useMotionPreference();
  const removed = original.filter((plan) => !plans.some((row) => row.id === plan.id));
  const isBusy = busy;
  function update(id: string, changes: Partial<Schedule>) {
    setPlans((rows) => rows.map((plan) => (plan.id === id ? { ...plan, ...changes } : plan)));
    setError('');
  }
  async function commit() {
    try {
      const stamp = new Date().toISOString();
      await saveTaskSchedules(
        taskId,
        plans.map((plan) => ({ ...plan, updated_at: stamp })),
        original.map(({ id, updated_at }) => ({ id, updated_at })),
      );
      close();
    } catch (error) {
      setError(errorMessage(error));
      throw error;
    }
  }
  return (
    <Modal title="任务日程" close={close} busy={isBusy}>
      <form
        className="modal-form task-schedules-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (removed.length) setConfirming(true);
          else void commit().catch(() => {});
        }}
      >
        <div className="editor-body modal-scroll">
          <div className="task-plan-heading">
            <strong>{task?.title ?? '任务已不存在'}</strong>
            <p>
              {task?.due_date
                ? `截止 ${formatDateTime(task.due_date, task.due_time)}`
                : '未设置截止日期'}{' '}
              · {plans.length} 条执行安排
            </p>
            <span className="field-hint">
              在此新增或修改多条日程，最后统一保存。截止日期保持独立。
            </span>
          </div>
          <div className="task-plan-list">
            <AnimatePresence initial={false}>
              {plans.map((plan, index) => (
                <motion.section
                  className="task-plan-editor"
                  key={plan.id}
                  data-plan-id={plan.id}
                  initial={{ opacity: 0, height: reduced ? 'auto' : 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: reduced ? 'auto' : 0 }}
                  transition={{ duration: reduced ? 0 : 0.24, ease: appleEase }}
                >
                  <div className="task-plan-row-head">
                    <h3>安排 {index + 1}</h3>
                    <span className="item-meta">
                      {original.some((old) => old.id === plan.id) ? '已有日程' : '新日程'}
                    </span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除安排 ${index + 1}`}
                      disabled={isBusy}
                      onClick={() => setPlans((rows) => rows.filter((row) => row.id !== plan.id))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="form-grid">
                    <label className="field">
                      <span>执行日期</span>
                      <DatePicker
                        label={`执行日期 ${index + 1}`}
                        value={plan.date}
                        required
                        clearable={false}
                        onChange={(date) => update(plan.id, { date })}
                      />
                    </label>
                    <label className="field">
                      <span>时间安排</span>
                      <Select
                        label={`时间安排 ${index + 1}`}
                        value={plan.period}
                        onChange={(period) =>
                          update(plan.id, {
                            period: period as Schedule['period'],
                            ...(period !== 'exact' ? { start_time: null, end_time: null } : {}),
                          })
                        }
                        options={Object.entries(periodLabels).map(([value, label]) => ({
                          value,
                          label,
                        }))}
                      />
                    </label>
                  </div>
                  {plan.period === 'exact' && (
                    <div className="form-grid">
                      <label className="field">
                        <span>开始时间</span>
                        <TimePicker
                          label={`开始时间 ${index + 1}`}
                          value={plan.start_time ?? ''}
                          required
                          onChange={(start_time) =>
                            update(plan.id, { start_time: start_time || null })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>结束时间（可选）</span>
                        <TimePicker
                          label={`结束时间 ${index + 1}`}
                          value={plan.end_time ?? ''}
                          onChange={(end_time) => update(plan.id, { end_time: end_time || null })}
                        />
                      </label>
                    </div>
                  )}
                  <button
                    type="button"
                    className="text-button plan-details-toggle"
                    aria-expanded={expanded.has(plan.id)}
                    onClick={() =>
                      setExpanded((old) => {
                        const next = new Set(old);
                        if (next.has(plan.id)) next.delete(plan.id);
                        else next.add(plan.id);
                        return next;
                      })
                    }
                  >
                    标题与备注{' '}
                    <ChevronDown size={13} className={expanded.has(plan.id) ? 'rotated' : ''} />
                  </button>
                  <AnimatePresence initial={false}>
                    {expanded.has(plan.id) && (
                      <motion.div
                        initial={{ height: reduced ? 'auto' : 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: reduced ? 'auto' : 0, opacity: 0 }}
                        transition={{ duration: reduced ? 0 : 0.22, ease: appleEase }}
                        className="plan-extra"
                      >
                        <label className="field">
                          <span>日程标题</span>
                          <input
                            aria-label={`日程标题 ${index + 1}`}
                            value={plan.title}
                            maxLength={300}
                            onChange={(e) => update(plan.id, { title: e.target.value })}
                          />
                        </label>
                        <label className="field">
                          <span>备注</span>
                          <textarea
                            aria-label={`备注 ${index + 1}`}
                            value={plan.notes}
                            rows={2}
                            maxLength={20000}
                            onChange={(e) => update(plan.id, { notes: e.target.value })}
                          />
                        </label>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.section>
              ))}
            </AnimatePresence>
          </div>
          {!plans.length && <p className="field-hint">还没有执行安排，点击下方按钮添加。</p>}
          <button
            type="button"
            className="add-task-plan"
            disabled={isBusy}
            onClick={() => {
              setPlans((rows) => [...rows, create(rows.at(-1)?.date)]);
              setError('');
            }}
          >
            <Plus size={16} />
            添加一条日程
          </button>
          {removed.length > 0 && (
            <div className="removed-plans">
              <p>保存后将删除 {removed.length} 条已有日程，不影响任务。</p>
              {removed.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  className="text-button"
                  onClick={() => setPlans((rows) => [...rows, { ...plan }])}
                >
                  <Undo2 size={13} />
                  撤回移除：{formatDateTime(plan.date, plan.start_time)}
                </button>
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" disabled={isBusy} onClick={close}>
            取消
          </button>
          <button type="submit" disabled={isBusy || !task} className="primary">
            {isBusy ? '保存中…' : '保存日程'}
          </button>
        </footer>
      </form>
      <AnimatePresence>
        {confirming && (
          <Confirm
            title="保存日程变更"
            label="确认保存日程"
            danger={false}
            message={`保存 ${plans.length} 条执行安排，并永久删除移除的 ${removed.length} 条已有日程？任务及其截止日期保留。`}
            close={() => setConfirming(false)}
            action={commit}
          />
        )}
      </AnimatePresence>
    </Modal>
  );
}
