import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Pause, Play, Pencil, X, ArrowRight, CircleAlert } from 'lucide-react';
import { assistantRepository as api } from '../../data/assistant';
import {
  type AgentAction,
  type AgentOperation,
  type OperationItem,
  actionNames,
  changedFields,
  fieldNames,
  tableNames,
} from '../../domain/agent';
import { formatDate } from '../../domain/dates';
import { DatePicker, Select, TimePicker } from '../Controls';
import { appleEase, useMotionPreference } from '../motion';
import { errorMessage, useStore } from '../../state';
import { activeData } from '../../domain/records';
import type { Data } from '../../domain/model';
import { OperationBodyTransition } from './OperationBodyTransition';

const values: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  low: '低',
  medium: '中',
  high: '高',
  anytime: '全天 / 未指定',
  morning: '上午',
  afternoon: '下午',
  evening: '晚上',
  exact: '精确时间',
  event: '重要事件',
  rest: '休息日',
};
function display(field: string, value: string | null | undefined, op: AgentOperation, data: Data) {
  if (!value) return '未设置';
  if (field.endsWith('_id')) {
    const item = op.preview.find((p) => p.id === value);
    const table = field === 'project_id' ? 'projects' : field === 'stage_id' ? 'stages' : 'tasks';
    return (
      item?.after?.title ??
      item?.before?.title ??
      data[table].find((r) => r.id === value)?.title ??
      '已关联对象'
    );
  }
  if (field === 'completed_at') return '已执行';
  if (field === 'archived_at') return '已归档';
  if (field.endsWith('date') || field === 'date') return formatDate(value);
  return values[value] ?? value;
}
type Props = {
  operation: AgentOperation;
  disabled: boolean;
  update: (op: AgentOperation) => void;
  feedback: (id: string) => Promise<void>;
  register: (id: string, flush: (() => Promise<void>) | null, owner?: () => Promise<void>) => void;
};
export function OperationCard({ operation, disabled, update, feedback, register }: Props) {
  const { reload, notify, data } = useStore();
  const reduced = useMotionPreference();
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [actions, setActions] = useState(operation.actions);
  const latest = useRef(operation),
    currentActions = useRef(actions),
    pending = useRef(false),
    locked = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    latest.current = operation;
    if (!pending.current) {
      currentActions.current = operation.actions;
      setActions(operation.actions);
    }
  }, [operation]);
  async function flush() {
    const next = chain.current.then(async () => {
      if (!pending.current) return;
      const draft = structuredClone(currentActions.current);
      const op = await api.editOperation(latest.current, draft);
      latest.current = op;
      update(op);
      if (JSON.stringify(currentActions.current) === JSON.stringify(draft)) pending.current = false;
      setError('');
    });
    chain.current = next.catch(() => {});
    try {
      await next;
    } catch (e) {
      setError(`预览尚未保存：${errorMessage(e)}`);
      throw e;
    }
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    if (!pending.current || busy || disabled) return;
    const timer = window.setTimeout(() => {
      void flushRef.current().catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [actions, busy, disabled]);
  useEffect(() => {
    const writer = () => flushRef.current();
    register(operation.id, writer);
    return () => register(operation.id, null, writer);
  }, [operation.id, register]);
  function change(key: string, field: string, value: string | null) {
    const next = currentActions.current.map((a) =>
      a.key === key ? { ...a, fields: { ...a.fields, [field]: value } } : a,
    );
    currentActions.current = next;
    pending.current = true;
    setActions(next);
  }
  async function perform(action: 'save' | 'apply' | 'pending' | 'paused' | 'cancelled') {
    if (locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      if (action !== 'cancelled') await flush();
      if (action === 'save') {
        setEditing(false);
        return;
      }
      if (action === 'apply') {
        const receipt = await api.applyOperation(latest.current);
        // Local receipt is authoritative even if refreshing or network feedback fails.
        pending.current = false;
        const refreshed: AgentOperation = {
          ...latest.current,
          state: 'applied',
          revision: latest.current.revision + 1,
          receipt,
        };
        latest.current = refreshed;
        update(refreshed);
        setEditing(false);
        notify('已确认，操作已保存到工作台');
        try {
          await reload();
        } catch {
          setError('操作已保存，工作台刷新失败，请切换页面重试');
        }
      } else {
        const next = await api.transitionOperation(latest.current, action);
        pending.current = false;
        latest.current = next;
        update(next);
        setEditing(false);
      }
      await feedback(operation.id);
    } catch (e) {
      setError(errorMessage(e));
      try {
        const fresh = (await api.operations(operation.conversation_id)).find(
          (o) => o.id === operation.id,
        );
        if (fresh && fresh.revision !== latest.current.revision) {
          pending.current = false;
          latest.current = fresh;
          update(fresh);
          currentActions.current = fresh.actions;
          setActions(fresh.actions);
        }
      } catch {
        /* Retain the editable preview if offline/local reload failed. */
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const closed = operation.state === 'applied' || operation.state === 'cancelled';
  return (
    <motion.section
      className={`agent-operation ${closed ? 'agent-operation-closed' : ''}`}
      data-operation-id={operation.id}
      tabIndex={-1}
      aria-label={`操作预览：${operation.title}`}
      initial={{ opacity: 0, y: reduced ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.32, ease: appleEase }}
    >
      <header>
        <strong>{operation.title}</strong>
        <AnimatePresence initial={false} mode="wait">
          <motion.span
            className="agent-operation-state"
            key={operation.state}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.16, ease: appleEase }}
          >
            {operation.state === 'pending'
              ? '待你确认'
              : operation.state === 'paused'
                ? '已暂停'
                : operation.state === 'applied'
                  ? '已保存'
                  : '已取消'}
          </motion.span>
        </AnimatePresence>
      </header>
      <OperationBodyTransition
        state={closed ? (operation.state as 'applied' | 'cancelled') : 'preview'}
        reduced={reduced}
      >
        {closed ? (
          <p className="agent-operation-result">
            {operation.state === 'applied' ? <Check size={15} /> : <X size={15} />}
            {operation.state === 'applied'
              ? `已执行 ${operation.preview.length} 项操作`
              : '未执行这组操作'}
          </p>
        ) : (
          <>
            <p className="agent-operation-hint">
              {operation.state === 'paused'
                ? '保留当前预览，继续后才能确认。'
                : '核对下方内容后确认，也可继续对话调整。'}
              {pending.current ? ' 表单修改正在等待保存。' : ''}
            </p>
            <fieldset disabled={busy || disabled}>
              {operation.preview.map((item) => (
                <section className="agent-operation-item" key={item.key}>
                  <div className="agent-operation-item-title">
                    <span>
                      {actionNames[item.action]}
                      {tableNames[item.table]}
                    </span>
                    <strong>{item.after?.title ?? item.before?.title}</strong>
                  </div>
                  <dl className="agent-diff">
                    {changedFields(item).map((field) => (
                      <div key={field}>
                        <dt>{fieldNames[field]}</dt>
                        <dd>
                          {item.action !== 'create' && (
                            <>
                              <span className="agent-diff-before">
                                {display(field, item.before?.[field], operation, data)}
                              </span>
                              <ArrowRight size={12} />
                            </>
                          )}
                          <span>
                            {item.action === 'delete'
                              ? '将删除'
                              : display(field, item.after?.[field], operation, data)}
                          </span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {item.action === 'delete' && item.affected.length > 1 && (
                    <div className="agent-impact">
                      <CircleAlert size={14} />
                      <span>
                        {item.table === 'stages'
                          ? '将解除以下任务的阶段关联，任务与日程保留：'
                          : '同时删除以下关联内容：'}
                        {item.affected
                          .slice(1)
                          .map((a) => `${tableNames[a.table]}“${a.record.title}”`)
                          .join('、')}
                      </span>
                    </div>
                  )}
                  <AnimatePresence initial={false}>
                    {editing && item.action !== 'delete' && (
                      <motion.div
                        className="agent-operation-fields"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: reduced ? 0 : 0.32, ease: appleEase }}
                      >
                        <ItemEditor
                          item={item}
                          action={actions.find((a) => a.key === item.key)!}
                          operation={operation}
                          change={(field, value) => change(item.key, field, value)}
                          save={() => {
                            void flush().catch(() => {});
                          }}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              ))}
            </fieldset>
            <footer>
              <button
                type="button"
                className="secondary-button"
                disabled={busy || disabled}
                onClick={() => (editing ? void perform('save') : setEditing(true))}
              >
                <Pencil size={13} />
                {editing ? '保存预览' : '编辑预览'}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy || disabled}
                onClick={() => void perform(operation.state === 'paused' ? 'pending' : 'paused')}
              >
                {operation.state === 'paused' ? <Play size={13} /> : <Pause size={13} />}
                {operation.state === 'paused' ? '继续准备' : '暂停'}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy || disabled}
                onClick={() => void perform('cancelled')}
              >
                取消操作
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy || disabled || operation.state !== 'pending'}
                onClick={() => void perform('apply')}
              >
                <Check size={14} />
                {busy
                  ? '正在处理…'
                  : `${operation.preview.some((i) => i.action === 'delete') ? '确认删除' : '确认并保存'} ${operation.preview.length} 项`}
              </button>
            </footer>
          </>
        )}
      </OperationBodyTransition>
      {error && (
        <p className="agent-operation-error" role="alert">
          {error}
        </p>
      )}
    </motion.section>
  );
}
function ItemEditor({
  item,
  action,
  change,
  save,
  operation,
}: {
  item: OperationItem;
  action: AgentAction;
  change: (field: string, value: string | null) => void;
  save: () => void;
  operation: AgentOperation;
}) {
  const { data } = useStore();
  const record = { ...item.after, ...action.fields };
  const fields = Object.keys(fieldNames).filter(
    (f) =>
      f in (item.after ?? {}) &&
      f !== 'archived_at' &&
      (f !== 'completed_at' || item.action !== 'create'),
  );
  const available = activeData(data);
  const resolve = (value: string | null | undefined) =>
    operation.actions.find((a) => a.ref === value)?.id ?? value ?? '';
  return (
    <>
      {fields
        .filter((f) => f !== 'archived_at')
        .map((field) => {
          const value = record[field] ?? '',
            label = `预览 ${item.key} ${fieldNames[field]}`;
          if (field.endsWith('_id')) {
            const table =
              field === 'project_id' ? 'projects' : field === 'stage_id' ? 'stages' : 'tasks';
            const options = new Map(
              available[table].map((r) => [
                r.id,
                { id: r.id, title: r.title, project_id: 'project_id' in r ? r.project_id : null },
              ]),
            );
            for (const p of operation.preview.filter((p) => p.table === table && p.after))
              options.set(p.id, {
                id: p.id,
                title: p.after!.title!,
                project_id: p.after!.project_id ?? null,
              });
            const rows = [...options.values()].filter(
              (r) => table !== 'stages' || r.project_id === resolve(record.project_id),
            );
            return (
              <label className="field" key={field}>
                <span>{fieldNames[field]}</span>
                <Select
                  label={label}
                  value={resolve(value)}
                  onChange={(v) => {
                    change(field, v || null);
                    if (field === 'project_id' && item.table === 'tasks') change('stage_id', null);
                  }}
                  options={[
                    ...(item.table !== 'stages'
                      ? [{ value: '', label: field === 'project_id' ? '独立任务' : '不关联' }]
                      : []),
                    ...rows.map((r) => ({ value: r.id, label: r.title })),
                  ]}
                />
              </label>
            );
          }
          if (field.endsWith('date') || field === 'date')
            return (
              <label className="field" key={field}>
                <span>{fieldNames[field]}</span>
                <DatePicker
                  label={label}
                  value={value}
                  onChange={(v) => {
                    change(field, v || null);
                    if (field === 'due_date' && !v) change('due_time', null);
                  }}
                />
              </label>
            );
          if (field.endsWith('time'))
            return (
              <label className="field" key={field}>
                <span>{fieldNames[field]}</span>
                <TimePicker
                  label={label}
                  value={value}
                  onChange={(v) => change(field, v || null)}
                />
              </label>
            );
          const options: Record<string, string[]> = {
            status: ['todo', 'doing', 'done'],
            priority: ['low', 'medium', 'high'],
            period: ['anytime', 'morning', 'afternoon', 'evening', 'exact'],
            kind: ['event', 'rest'],
          };
          if (options[field])
            return (
              <label className="field" key={field}>
                <span>{fieldNames[field]}</span>
                <Select
                  label={label}
                  value={value}
                  onChange={(v) => {
                    change(field, v);
                    if (field === 'period' && v !== 'exact') {
                      change('start_time', null);
                      change('end_time', null);
                    }
                  }}
                  options={options[field].map((v) => ({ value: v, label: values[v] }))}
                />
              </label>
            );
          if (field === 'completed_at')
            return (
              <label className="field" key={field}>
                <span>执行状态</span>
                <Select
                  label={label}
                  value={value ? 'completed' : 'pending'}
                  onChange={(v) =>
                    change(field, v === 'completed' ? new Date().toISOString() : null)
                  }
                  options={[
                    { value: 'pending', label: '待执行' },
                    { value: 'completed', label: '已执行' },
                  ]}
                />
              </label>
            );
          return (
            <label className={`field ${field === 'notes' ? 'agent-field-wide' : ''}`} key={field}>
              <span>{fieldNames[field]}</span>
              {field === 'notes' ? (
                <textarea
                  aria-label={label}
                  value={value}
                  onChange={(e) => change(field, e.target.value)}
                  onBlur={save}
                  maxLength={20000}
                />
              ) : (
                <input
                  aria-label={label}
                  value={value}
                  onChange={(e) => change(field, e.target.value)}
                  onBlur={save}
                  maxLength={300}
                />
              )}
            </label>
          );
        })}
    </>
  );
}
