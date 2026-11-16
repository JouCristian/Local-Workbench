import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { appleEase, useMotionPreference } from '../motion';
import { Check, X, ClipboardList, CalendarDays, Flag } from 'lucide-react';
import { DatePicker, TimePicker, Select } from '../Controls';
import {
  buildDraftInserts,
  draftRevision,
  type AgentEvent,
  type ChatMessage,
  type Proposal,
} from '../../domain/assistant';
import { activeData } from '../../domain/records';
import { periodLabels } from '../../domain/model';
import { assistantRepository as api } from '../../data/assistant';
import { repository } from '../../data/repository';
import { errorMessage, useStore } from '../../state';

export function DraftForms({
  message,
  update,
  disabled = false,
  review,
  afterAction,
}: {
  message: ChatMessage;
  update: (value: ChatMessage) => void;
  disabled?: boolean;
  review?: () => Promise<void>;
  afterAction?: (event: AgentEvent) => Promise<void>;
}) {
  const { data, reload, notify } = useStore(),
    active = activeData(data);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const locked = useRef(false);
  const current = useRef(message);
  if (current.current.id !== message.id || draftRevision(message) >= draftRevision(current.current))
    current.current = message;
  const pending = message.draft_state === 'pending';
  const reduced = useMotionPreference();
  const persist = (proposals: Proposal[]) => {
    if (disabled || locked.current) return;
    const previous = current.current;
    const next = {
      ...previous,
      proposals,
      draft_revision: draftRevision(previous) + 1,
    };
    current.current = next;
    update(next);
    void api.updateDraft(previous.id, proposals, draftRevision(previous)).catch(async (e) => {
      setError(errorMessage(e));
      try {
        const fresh = (await api.messages(previous.conversation_id)).find(
          (m) => m.id === previous.id,
        );
        if (fresh) {
          current.current = fresh;
          update(fresh);
        }
      } catch {
        /* The original write error remains visible if the reread also fails. */
      }
    });
  };
  const change = (index: number, fields: Partial<Proposal>) =>
    persist(
      current.current.proposals.map((p, i) =>
        i === index ? ({ ...p, ...fields } as Proposal) : p,
      ),
    );
  async function apply() {
    if (locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const fresh = await repository.load();
      const latest = current.current;
      const inserts = buildDraftInserts(latest.proposals, fresh);
      const count = await api.apply(latest.id, inserts, draftRevision(latest));
      update({ ...latest, draft_state: 'applied', draft_revision: draftRevision(latest) + 1 });
      await reload();
      notify('已确认，草稿已保存到工作台');
      await afterAction?.({ kind: 'applied', message_id: latest.id, count });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function cancel() {
    if (locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    try {
      const latest = current.current;
      await api.cancelDraft(latest.id, draftRevision(latest));
      update({ ...latest, draft_state: 'cancelled', draft_revision: draftRevision(latest) + 1 });
      await afterAction?.({ kind: 'cancelled', message_id: latest.id, count: 0 });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <AnimatePresence initial={false} mode="wait">
      {!pending ? (
        <motion.div
          key="result"
          className={`assistant-draft-result ${message.draft_state === 'cancelled' ? 'assistant-draft-cancelled' : ''}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced ? 0 : 0.24, ease: appleEase }}
        >
          {message.draft_state === 'applied' ? <Check size={15} /> : <X size={15} />}
          {message.draft_state === 'applied' ? '已保存到工作台' : '已取消草稿，未创建记录'}
        </motion.div>
      ) : (
        <motion.div
          key="form"
          className="assistant-drafts"
          aria-label="待确认草稿"
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0, marginTop: 0 }}
          transition={{ duration: reduced ? 0 : 0.32, ease: appleEase }}
        >
          <div className="assistant-draft-heading">
            <strong>待你确认 · {message.proposals.length} 项</strong>
            <span>可编辑，也可继续聊天补充要求</span>
          </div>
          <fieldset disabled={busy || disabled || !pending}>
            {message.proposals.map((p, i) => (
              <section className="assistant-draft" key={p.key}>
                <header>
                  {p.type === 'task' ? (
                    <ClipboardList size={16} />
                  ) : p.type === 'schedule' ? (
                    <CalendarDays size={16} />
                  ) : (
                    <Flag size={16} />
                  )}
                  <strong>
                    {p.type === 'task'
                      ? '新建任务'
                      : p.type === 'schedule'
                        ? '新建日程'
                        : p.kind === 'rest'
                          ? '休息日'
                          : '重要事件'}
                  </strong>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`移除草稿 ${p.title}`}
                    onClick={() => persist(current.current.proposals.filter((_, n) => n !== i))}
                  >
                    <X size={14} />
                  </button>
                </header>
                <label className="field">
                  <span>标题</span>
                  <input
                    aria-label={`草稿 ${i + 1} 标题`}
                    value={p.title}
                    maxLength={300}
                    onChange={(e) => change(i, { title: e.target.value })}
                  />
                </label>
                {p.inferred && <p className="assistant-inferred">建议 / 待核实：{p.inferred}</p>}
                <div className="assistant-draft-grid">
                  {p.type === 'task' ? (
                    <>
                      <label className="field">
                        <span>截止日期 · 可留空</span>
                        <DatePicker
                          label={`草稿 ${i + 1} 截止日期`}
                          value={p.due_date ?? ''}
                          onChange={(v) =>
                            change(i, { due_date: v || null, ...(!v ? { due_time: null } : {}) })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>截止时间 · 可留空</span>
                        <TimePicker
                          label={`草稿 ${i + 1} 截止时间`}
                          value={p.due_time ?? ''}
                          onChange={(v) => change(i, { due_time: v || null })}
                        />
                      </label>
                      <label className="field">
                        <span>优先级</span>
                        <Select
                          label={`草稿 ${i + 1} 优先级`}
                          value={p.priority}
                          onChange={(v) => change(i, { priority: v as 'low' | 'medium' | 'high' })}
                          options={[
                            { value: 'low', label: '低' },
                            { value: 'medium', label: '中' },
                            { value: 'high', label: '高' },
                          ]}
                        />
                      </label>
                      <label className="field">
                        <span>项目</span>
                        <Select
                          label={`草稿 ${i + 1} 项目`}
                          value={p.project_id ?? ''}
                          onChange={(v) => change(i, { project_id: v || null, stage_id: null })}
                          options={[
                            { value: '', label: '独立任务' },
                            ...active.projects.map((x) => ({ value: x.id, label: x.title })),
                          ]}
                        />
                      </label>
                      {p.project_id && (
                        <label className="field">
                          <span>阶段</span>
                          <Select
                            label={`草稿 ${i + 1} 阶段`}
                            value={p.stage_id ?? ''}
                            onChange={(v) => change(i, { stage_id: v || null })}
                            options={[
                              { value: '', label: '不指定阶段' },
                              ...active.stages
                                .filter((x) => x.project_id === p.project_id)
                                .map((x) => ({ value: x.id, label: x.title })),
                            ]}
                          />
                        </label>
                      )}
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>{p.type === 'schedule' ? '执行日期' : '日期'}</span>
                        <DatePicker
                          label={`草稿 ${i + 1} 日期`}
                          value={p.date}
                          required
                          onChange={(v) => change(i, { date: v })}
                        />
                      </label>
                      {p.type === 'event' ? (
                        <label className="field">
                          <span>事件类型</span>
                          <Select
                            label={`草稿 ${i + 1} 类型`}
                            value={p.kind}
                            onChange={(v) => change(i, { kind: v as 'event' | 'rest' })}
                            options={[
                              { value: 'event', label: '重要事件' },
                              { value: 'rest', label: '休息日' },
                            ]}
                          />
                        </label>
                      ) : (
                        <>
                          <label className="field">
                            <span>时间安排</span>
                            <Select
                              label={`草稿 ${i + 1} 时段`}
                              value={p.period}
                              onChange={(v) =>
                                change(i, {
                                  period: v as typeof p.period,
                                  start_time: null,
                                  end_time: null,
                                })
                              }
                              options={Object.entries(periodLabels).map(([value, label]) => ({
                                value,
                                label,
                              }))}
                            />
                          </label>
                          {p.period === 'exact' && (
                            <>
                              <label className="field">
                                <span>开始时间</span>
                                <TimePicker
                                  label={`草稿 ${i + 1} 开始时间`}
                                  value={p.start_time ?? ''}
                                  onChange={(v) => change(i, { start_time: v || null })}
                                />
                              </label>
                              <label className="field">
                                <span>结束时间 · 可选</span>
                                <TimePicker
                                  label={`草稿 ${i + 1} 结束时间`}
                                  value={p.end_time ?? ''}
                                  onChange={(v) => change(i, { end_time: v || null })}
                                />
                              </label>
                            </>
                          )}
                          <label className="field assistant-span-2">
                            <span>关联任务</span>
                            <Select
                              label={`草稿 ${i + 1} 关联任务`}
                              value={p.task_ref ?? ''}
                              onChange={(v) => change(i, { task_ref: v || null })}
                              options={[
                                { value: '', label: '独立日程' },
                                ...message.proposals
                                  .filter((x) => x.type === 'task')
                                  .map((x) => ({ value: x.key, label: `新任务 · ${x.title}` })),
                                ...active.tasks.map((x) => ({ value: x.id, label: x.title })),
                              ]}
                            />
                          </label>
                        </>
                      )}
                    </>
                  )}
                </div>
                <label className="field">
                  <span>备注</span>
                  <textarea
                    aria-label={`草稿 ${i + 1} 备注`}
                    rows={2}
                    value={p.notes}
                    maxLength={20000}
                    onChange={(e) => change(i, { notes: e.target.value })}
                  />
                </label>
              </section>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="assistant-inline-status">
              {error}
            </p>
          )}
          <footer>
            {review && (
              <button
                className="text-button"
                disabled={busy || disabled}
                onClick={() => void review()}
              >
                让助手检查这组草稿
              </button>
            )}
            <button
              className="text-button"
              disabled={busy || disabled}
              onClick={() => void cancel()}
            >
              取消这组草稿
            </button>
            <button
              className="primary-button"
              disabled={busy || disabled || !message.proposals.length}
              onClick={() => void apply()}
            >
              <Check size={15} />
              {busy ? '正在保存…' : '确认并保存全部'}
            </button>
          </footer>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
