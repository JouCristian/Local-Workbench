import { formatDate } from '../presentation/view';
import { scheduleTime } from '../domain/dates';
import { activeData, duplicateSchedules } from '../domain/records';
import type { Schedule } from '../domain/model';
import { AnimatePresence } from 'motion/react';
import { useState, type FormEvent } from 'react';
import { Trash2, Archive, ArchiveRestore } from 'lucide-react';
import { useStore, errorMessage } from '../state';
import {
  schemas,
  periodLabels,
  statusLabels,
  priorityLabels,
  type Table,
  type Tables,
} from '../domain/model';
import { localDate } from '../domain/dates';
import { Modal, Confirm } from './Modal';
import { DatePicker, Select, TimePicker } from './Controls';
import { TaskSchedules } from './TaskSchedules';

export type EditorSpec = {
  mode?: 'task-schedules';
  table: Table;
  record?: Tables[Table];
  defaults?: Record<string, string>;
};
const names: Record<Table, string> = {
  projects: '项目',
  stages: '阶段',
  tasks: '任务',
  schedules: '日程',
  events: '事件',
};
const deleteMessages: Record<Table, string> = {
  projects:
    '永久删除此项目、全部阶段、任务及任务关联日程？不会转为独立任务。此操作无法撤销；如需保留内容，请选择归档项目。',
  stages: '删除此阶段？其中的任务会保留在原项目下。此操作无法撤销。',
  tasks: '永久删除此任务及其全部关联日程？此操作无法撤销。',
  schedules: '删除此条日程？关联任务会保留。此操作无法撤销。',
  events: '删除此事件或休息日？此操作无法撤销。',
};

export function Editor({ spec, close }: { spec: EditorSpec; close: () => void }) {
  if (spec.mode === 'task-schedules' && spec.defaults?.task_id)
    return <TaskSchedules taskId={spec.defaults.task_id} close={close} />;
  return <RecordEditor spec={spec} close={close} />;
}

function RecordEditor({ spec, close }: { spec: EditorSpec; close: () => void }) {
  const { data, save, remove, busy, archive } = useStore();
  const { table, record } = spec;
  const available = activeData(data);
  const ownedTasks = new Set(
    table === 'projects' && record
      ? data.tasks.filter((task) => task.project_id === record.id).map((task) => task.id)
      : [],
  );
  const deleteMessage =
    table === 'projects' && record
      ? `永久删除项目「${record.title}」、${data.stages.filter((stage) => stage.project_id === record.id).length} 个阶段、${ownedTasks.size} 项任务及 ${data.schedules.filter((schedule) => schedule.task_id && ownedTasks.has(schedule.task_id)).length} 条关联日程？不会转为独立任务。此操作无法撤销；如需保留内容，请归档项目。`
      : table === 'tasks' && record
        ? `永久删除任务「${record.title}」及其 ${data.schedules.filter((schedule) => schedule.task_id === record.id).length} 条关联日程？此操作无法撤销。`
        : deleteMessages[table];
  const isArchived = !!(record && 'archived_at' in record && record.archived_at);
  const [archiving, setArchiving] = useState(false),
    [duplicateToDelete, setDuplicateToDelete] = useState<Schedule | null>(null);
  const duplicates =
    table === 'schedules' && record ? duplicateSchedules(data.schedules, record as Schedule) : [];
  const [v, set] = useState<Record<string, string>>(() => ({
    title: '',
    notes: '',
    status: 'todo',
    priority: 'medium',
    project_id: '',
    stage_id: '',
    task_id: '',
    due_date: '',
    due_time: '',
    date: localDate(),
    start_date: localDate(),
    end_date: localDate(),
    period: 'anytime',
    start_time: '',
    end_time: '',
    kind: 'event',
    ...spec.defaults,
    ...Object.fromEntries(Object.entries(record ?? {}).map(([k, value]) => [k, value ?? ''])),
  }));
  const [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false);
  function change(name: string, value: string) {
    set((old) => {
      const next = { ...old, [name]: value };
      if (name === 'project_id') next.stage_id = '';
      if (name === 'due_date' && !value) next.due_time = '';
      if (name === 'period' && value !== 'exact') {
        next.start_time = '';
        next.end_time = '';
      }
      if (name === 'task_id' && value && !old.title)
        next.title = data.tasks.find((t) => t.id === value)?.title ?? '';
      return next;
    });
  }
  const input = (name: string, label: string, type = 'text', required = false) => (
    <label className="field" key={name}>
      <span>
        {label}
        {required && (
          <span aria-hidden="true" className="required">
            {' '}
            *
          </span>
        )}
      </span>
      {type === 'date' ? (
        <DatePicker
          name={name}
          label={label}
          value={v[name]}
          onChange={(value) => change(name, value)}
          required={required}
        />
      ) : type === 'time' ? (
        <TimePicker
          name={name}
          label={label}
          value={v[name]}
          onChange={(value) => change(name, value)}
          required={required}
        />
      ) : (
        <input
          name={name}
          aria-label={label}
          type={type}
          value={v[name]}
          onChange={(e) => change(name, e.target.value)}
          required={required}
          maxLength={type === 'text' ? 300 : undefined}
          min={type === 'date' ? '1900-01-01' : undefined}
          max={type === 'date' ? '9999-12-31' : undefined}
        />
      )}
    </label>
  );
  const select = (name: string, label: string, options: [string, string][], required = false) => (
    <label className="field" key={name}>
      <span>{label}</span>
      <Select
        name={name}
        label={label}
        value={v[name]}
        onChange={(value) => change(name, value)}
        required={required}
        options={options.map(([value, label]) => ({ value, label }))}
      />
    </label>
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const stamp = new Date().toISOString();
    const base = {
      id: record?.id ?? crypto.randomUUID(),
      title: v.title.trim(),
      created_at: record?.created_at ?? stamp,
      updated_at: stamp,
      ...(table === 'projects' || table === 'tasks'
        ? { archived_at: record && 'archived_at' in record ? (record.archived_at ?? null) : null }
        : {}),
    };
    const nullable = (key: string) => v[key] || null;
    let value: unknown;
    if (table === 'projects') value = { ...base, notes: v.notes };
    if (table === 'stages')
      value = { ...base, project_id: v.project_id, start_date: v.start_date, end_date: v.end_date };
    if (table === 'tasks')
      value = {
        ...base,
        notes: v.notes,
        status: v.status,
        priority: v.priority,
        due_date: nullable('due_date'),
        due_time: nullable('due_time'),
        project_id: nullable('project_id'),
        stage_id: nullable('stage_id'),
      };
    if (table === 'schedules')
      value = {
        ...base,
        notes: v.notes,
        task_id: nullable('task_id'),
        date: v.date,
        period: v.period,
        start_time: nullable('start_time'),
        end_time: nullable('end_time'),
      };
    if (table === 'events') value = { ...base, notes: v.notes, date: v.date, kind: v.kind };
    try {
      await save(table, schemas[table].parse(value));
      close();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <Modal title={`${record ? '编辑' : '新建'}${names[table]}`} close={close} busy={busy}>
      <form className="modal-form" noValidate onSubmit={(e) => void submit(e)}>
        <div className="editor-body modal-scroll">
          {table === 'schedules' &&
            select('task_id', '关联任务', [
              ['', '独立日程'],
              ...data.tasks
                .filter(
                  (t) => available.tasks.some((active) => active.id === t.id) || t.id === v.task_id,
                )
                .map(
                  (t) => [t.id, `${t.status === 'done' ? '✓ ' : ''}${t.title}`] as [string, string],
                ),
            ])}
          {duplicates.length > 0 && (
            <section className="duplicate-notice">
              <h3>发现 {duplicates.length} 条同时间的旧重复安排</h3>
              <p>时间线已合并显示。下面仅移除重复记录，当前日程会保留。</p>
              {duplicates.map((duplicate) => (
                <div key={duplicate.id}>
                  <span>
                    {duplicate.title}
                    <small>
                      {formatDate(duplicate.date)} {scheduleTime(duplicate)}
                    </small>
                    {duplicate.notes && <small>{duplicate.notes}</small>}
                  </span>
                  <button type="button" onClick={() => setDuplicateToDelete(duplicate)}>
                    移除重复项
                  </button>
                </div>
              ))}
            </section>
          )}
          {input('title', `${names[table]}标题`, 'text', true)}
          {table === 'tasks' && (
            <>
              <div className="form-grid">
                {select('status', '状态', Object.entries(statusLabels))}
                {select('priority', '优先级', Object.entries(priorityLabels))}
              </div>
              <div className="form-grid">
                {input('due_date', '截止日期', 'date')}
                {input('due_time', '截止时间（可选）', 'time')}
              </div>
              <p className="field-hint">截止日期与执行日程独立；不填时间即为仅日期。</p>
              {select('project_id', '所属项目', [
                ['', '独立任务'],
                ...data.projects
                  .filter((p) => !p.archived_at || p.id === v.project_id)
                  .map((p) => [p.id, p.title] as [string, string]),
              ])}
              {v.project_id &&
                select('stage_id', '所属阶段', [
                  ['', '暂不分配阶段'],
                  ...data.stages
                    .filter((s) => s.project_id === v.project_id)
                    .map((s) => [s.id, s.title] as [string, string]),
                ])}
            </>
          )}
          {table === 'stages' && (
            <>
              {select(
                'project_id',
                '所属项目',
                [
                  ['', '请选择项目'],
                  ...data.projects
                    .filter((p) => !p.archived_at || p.id === v.project_id)
                    .map((p) => [p.id, p.title] as [string, string]),
                ],
                true,
              )}
              <div className="form-grid">
                {input('start_date', '开始日期', 'date', true)}
                {input('end_date', '结束日期', 'date', true)}
              </div>
              <p className="field-hint">阶段可以重叠。已有任务的阶段不能直接移动到其他项目。</p>
            </>
          )}
          {table === 'schedules' && (
            <>
              <div className="form-grid">
                {input('date', '执行日期', 'date', true)}
                {select('period', '时间安排', Object.entries(periodLabels))}
              </div>
              {v.period === 'exact' && (
                <div className="form-grid">
                  {input('start_time', '开始时间', 'time', true)}
                  {input('end_time', '结束时间（可选）', 'time')}
                </div>
              )}
              <p className="field-hint">
                同一天可添加多条安排。上午、下午、晚上不会自动转换为小时。
              </p>
            </>
          )}
          {table === 'events' && (
            <div className="form-grid">
              {input('date', '事件日期', 'date', true)}
              {select('kind', '事件类型', [
                ['event', '重要事件'],
                ['rest', '休息日'],
              ])}
            </div>
          )}
          {table !== 'stages' && (
            <label className="field">
              <span>备注</span>
              <textarea
                aria-label="备注"
                name="notes"
                value={v.notes}
                maxLength={20000}
                onChange={(e) => change('notes', e.target.value)}
                rows={3}
              />
            </label>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          {record && (
            <button
              type="button"
              className="text-danger delete-control"
              onClick={() => setDeleting(true)}
              disabled={busy}
            >
              <Trash2 size={15} />
              删除{names[table]}
            </button>
          )}
          {record && (table === 'tasks' || table === 'projects') && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                isArchived
                  ? void archive(table, record.id, false)
                      .then(close)
                      .catch(() => {})
                  : setArchiving(true)
              }
            >
              {isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}{' '}
              {isArchived ? '恢复' : '归档'}
              {names[table]}
            </button>
          )}
          <button type="button" onClick={close} disabled={busy}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '保存中…' : `保存${names[table]}`}
          </button>
        </footer>
      </form>

      <AnimatePresence>
        {archiving && record && (table === 'tasks' || table === 'projects') && (
          <Confirm
            key="archive"
            title={`归档${names[table]}`}
            message={
              table === 'projects'
                ? '归档项目后，其任务和关联日程将一起从日常视图移出，内容和完成状态保留，可在归档中恢复。'
                : '归档后从日常列表移出，保留任务内容、日程及完成状态，可在归档中恢复。'
            }
            label={`归档${names[table]}`}
            danger={false}
            close={() => setArchiving(false)}
            action={async () => {
              await archive(table, record.id, true);
              close();
            }}
          />
        )}
        {duplicateToDelete && (
          <Confirm
            key="duplicate"
            title="移除重复日程"
            message={`仅删除重复的「${duplicateToDelete.title}」。当前编辑的日程和任务均保留，此操作无法撤销。`}
            label="移除重复项"
            close={() => setDuplicateToDelete(null)}
            action={async () => {
              await remove('schedules', duplicateToDelete.id);
            }}
          />
        )}
        {deleting && record && (
          <Confirm
            title={`删除${names[table]}`}
            message={deleteMessage}
            label={`删除${names[table]}`}
            close={() => setDeleting(false)}
            action={async () => {
              await remove(table, record.id);
              close();
            }}
          />
        )}
      </AnimatePresence>
    </Modal>
  );
}
