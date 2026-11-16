import { Confirm } from '../components/Modal';
import { errorMessage } from '../state';
import type { TaskBatchAction } from '../data/repository';
import { ViewSwitch } from '../components/PageTransition';
import { useLayoutEffect, useState, type FormEvent } from 'react';
import {
  Folder,
  MoreHorizontal,
  Plus,
  Search,
  Inbox,
  Layers3,
  Archive,
  ArchiveRestore,
  ListChecks,
  Check,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useStore } from '../state';
import { activeData } from '../domain/records';
import { progress } from '../domain/dates';
import { formatDate, projectStyle } from '../presentation/view';
import type { Task } from '../domain/model';
import { Empty, TaskRow, type TaskSelection } from '../components/Items';
import { Disclosure } from '../components/Disclosure';
import { useContentEntrance } from '../components/motion';
import { Select } from '../components/Controls';
import type { EditorSpec } from '../components/Editor';

function TaskList({
  tasks,
  edit,
  details = false,
  archived = false,
  selection,
}: {
  tasks: Task[];
  edit: (spec: EditorSpec) => void;
  details?: boolean;
  archived?: boolean;
  selection?: TaskSelection;
}) {
  return (
    <div className="task-list">
      <AnimatePresence initial={false}>
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            edit={edit}
            context={false}
            details={details}
            selection={selection}
            variant={archived ? 'archived' : 'task'}
          />
        ))}
      </AnimatePresence>
      {!tasks.length && <div className="group-empty">没有符合当前筛选的任务</div>}
    </div>
  );
}
export function Tasks({
  edit,
  initialProject = 'independent',
}: {
  edit: (spec: EditorSpec) => void;
  initialProject?: string;
}) {
  const entrance = useContentEntrance(),
    { data, save, busy, archive, batchTasks } = useStore(),
    active = activeData(data);
  const [scope, setScope] = useState(initialProject === 'independent' ? 'independent' : 'projects'),
    [filter, setFilter] = useState('open'),
    [query, setQuery] = useState(''),
    [quick, setQuick] = useState(''),
    [quickError, setQuickError] = useState('');
  const [chosenProject, setProjectFilter] = useState(
    initialProject === 'independent' ? 'all' : initialProject,
  );
  const projectFilter = active.projects.some((p) => p.id === chosenProject) ? chosenProject : 'all';
  const visible = (t: Task) =>
    (filter === 'all' || (filter === 'done' ? t.status === 'done' : t.status !== 'done')) &&
    `${t.title} ${t.notes}`.toLowerCase().includes(query.toLowerCase());
  const canQuick = scope === 'independent' || (scope === 'projects' && projectFilter !== 'all');
  const defaultProject = scope === 'projects' && projectFilter !== 'all' ? projectFilter : '';
  const newTask = () => edit({ table: 'tasks', defaults: { project_id: defaultProject } });
  async function add(event: FormEvent) {
    event.preventDefault();
    const title = quick.trim();
    if (!title || busy || !canQuick) return;
    setQuickError('');
    const stamp = new Date().toISOString();
    try {
      await save('tasks', {
        id: crypto.randomUUID(),
        title,
        notes: '',
        status: 'todo',
        priority: 'medium',
        project_id: defaultProject || null,
        stage_id: null,
        due_date: null,
        due_time: null,
        archived_at: null,
        created_at: stamp,
        updated_at: stamp,
      });
      setQuick('');
    } catch (error) {
      setQuickError(error instanceof Error ? error.message : String(error));
    }
  }
  const archivedTasks = data.tasks.filter(
    (t) =>
      t.archived_at &&
      (!t.project_id || !data.projects.find((p) => p.id === t.project_id)?.archived_at) &&
      `${t.title} ${t.notes}`.toLowerCase().includes(query.toLowerCase()),
  );
  const archivedProjects = data.projects.filter(
    (p) => p.archived_at && `${p.title} ${p.notes}`.toLowerCase().includes(query.toLowerCase()),
  );
  const [selecting, setSelecting] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [pendingBatch, setPendingBatch] = useState<{
      action: 'delete' | 'archive';
      ids: string[];
      taskCount: number;
      planCount: number;
      unfinished: number;
    } | null>(null),
    [batchError, setBatchError] = useState('');
  useLayoutEffect(() => {
    setSelecting(false);
    setSelected(new Set());
    setPendingBatch(null);
    setBatchError('');
  }, [scope, filter, projectFilter, query]);
  const results =
    scope === 'archive'
      ? archivedTasks
      : active.tasks.filter(
          (task) =>
            (scope === 'independent'
              ? !task.project_id
              : !!task.project_id &&
                (projectFilter === 'all' || task.project_id === projectFilter)) && visible(task),
        );
  const selectedTasks = results.filter((task) => selected.has(task.id)),
    selectedIds = selectedTasks.map((task) => task.id),
    allSelected = results.length > 0 && selectedTasks.length === results.length;
  const rowSelection: TaskSelection | undefined = selecting
    ? {
        selectedIds: selected,
        toggle: (id) =>
          setSelected((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          }),
      }
    : undefined;
  const planCount = data.schedules.filter(
    (schedule) => schedule.task_id && selectedIds.includes(schedule.task_id),
  ).length;
  const unfinished = selectedTasks.filter((task) => task.status !== 'done').length;
  async function applyBatch(action: TaskBatchAction, ids = selectedIds) {
    if (!ids.length || busy) return;
    setBatchError('');
    try {
      await batchTasks(ids, action);
      setSelecting(false);
      setSelected(new Set());
    } catch (error) {
      setBatchError(errorMessage(error));
      throw error;
    }
  }
  function requestBatch(action: TaskBatchAction) {
    if (action === 'delete' || (action === 'archive' && unfinished > 0))
      setPendingBatch({
        action: action as 'delete' | 'archive',
        ids: [...selectedIds],
        taskCount: selectedIds.length,
        planCount,
        unfinished,
      });
    else void applyBatch(action).catch(() => {});
  }
  return (
    <div className="tasks-page">
      <motion.div variants={entrance} className="page-heading">
        <h1>{scope === 'independent' ? '独立任务' : scope === 'projects' ? '项目' : '归档'}</h1>
        <div className="button-group">
          <button
            disabled={busy || (!results.length && !selecting)}
            className={selecting ? 'selected' : ''}
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
              setBatchError('');
            }}
          >
            {selecting ? <X size={16} /> : <ListChecks size={16} />}{' '}
            {selecting ? '取消选择' : '批量选择'}
          </button>
          {scope !== 'archive' && (
            <button onClick={() => edit({ table: 'projects' })}>
              <Folder size={16} />
              新建项目
            </button>
          )}
          {scope !== 'archive' && (
            <button className="primary" onClick={newTask}>
              <Plus size={16} />
              新建任务
            </button>
          )}
        </div>
      </motion.div>
      <div className="task-category-tabs" role="group" aria-label="任务分类">
        {[
          ['independent', '独立任务', Inbox],
          ['projects', '项目', Folder],
          ['archive', '归档', Archive],
        ].map(([key, label, Icon]) => (
          <button
            key={key as string}
            className={scope === key ? 'selected' : ''}
            aria-pressed={scope === key}
            onClick={() => {
              setScope(key as string);
              setQuickError('');
            }}
          >
            {typeof Icon !== 'string' && <Icon size={16} />} {label as string}
          </button>
        ))}
      </div>
      <motion.div variants={entrance} className="task-toolbar">
        {scope !== 'archive' && (
          <div className="segmented" role="group" aria-label="任务状态筛选">
            {[
              ['open', '未完成'],
              ['done', '已完成'],
              ['all', '全部'],
            ].map(([key, label]) => (
              <button
                key={key}
                className={filter === key ? 'selected' : ''}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <label className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索任务"
            placeholder={scope === 'archive' ? '搜索归档内容' : '搜索任务或备注'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {scope === 'projects' && (
          <Select
            label="筛选项目"
            value={projectFilter}
            onChange={setProjectFilter}
            options={[
              { value: 'all', label: '全部项目' },
              ...active.projects.map((p) => ({ value: p.id, label: p.title })),
            ]}
          />
        )}
      </motion.div>
      {selecting && (
        <div className="bulk-toolbar" role="region" aria-label="批量任务操作">
          <label className="inline-check">
            <input
              type="checkbox"
              aria-label="全选当前筛选结果"
              checked={allSelected}
              ref={(input) => {
                if (input) input.indeterminate = selectedTasks.length > 0 && !allSelected;
              }}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(results.map((task) => task.id)))
              }
            />
            全选当前结果（{results.length}）
          </label>
          <strong>已选 {selectedTasks.length} 项</strong>
          <div className="button-group">
            {scope === 'archive' ? (
              <button
                disabled={!selectedIds.length || busy}
                onClick={() => requestBatch('restore')}
              >
                <ArchiveRestore size={15} />
                恢复
              </button>
            ) : (
              <>
                <button
                  disabled={!selectedIds.length || !unfinished || busy}
                  onClick={() => requestBatch('complete')}
                >
                  <Check size={15} />
                  完成
                </button>
                <button
                  disabled={!selectedIds.length || unfinished === selectedTasks.length || busy}
                  onClick={() => requestBatch('reopen')}
                >
                  <RotateCcw size={15} />
                  重新打开
                </button>
                <button
                  disabled={!selectedIds.length || busy}
                  onClick={() => requestBatch('archive')}
                >
                  <Archive size={15} />
                  归档
                </button>
              </>
            )}
            <button disabled={!selectedIds.length || busy} onClick={() => requestBatch('delete')}>
              <Trash2 size={15} />
              删除
            </button>
          </div>
          {batchError && (
            <p role="alert" className="form-error">
              {batchError}。未应用部分改动。
            </p>
          )}
        </div>
      )}
      <ViewSwitch
        viewKey={`${scope}:${filter}:${projectFilter}`}
        order={
          ['independent', 'projects', 'archive'].indexOf(scope) * 100 +
          ['open', 'done', 'all'].indexOf(filter) * 10 +
          active.projects.findIndex((project) => project.id === projectFilter) +
          1
        }
      >
        {canQuick && !selecting && (
          <motion.form
            variants={entrance}
            className="quick-add"
            onSubmit={(event) => void add(event)}
          >
            <Plus size={19} />
            <input
              aria-label="快速添加任务"
              value={quick}
              onChange={(event) => setQuick(event.target.value)}
              maxLength={300}
              placeholder="记下一件事，按 Enter 添加…"
            />
            <button type="submit" disabled={!quick.trim() || busy}>
              添加任务 <span className="key-hint">↵</span>
            </button>
          </motion.form>
        )}
        {quickError && (
          <p className="form-error" role="alert">
            {quickError}
          </p>
        )}
        <motion.div variants={entrance} className="task-groups">
          {scope === 'independent' && (
            <section className="panel task-group independent-group">
              <div className="section-heading">
                <h2>
                  <Inbox size={18} />
                  独立任务{' '}
                  <span className="count">
                    {active.tasks.filter((t) => !t.project_id && visible(t)).length}
                  </span>
                </h2>
                <button className="icon-button" aria-label="添加独立任务" onClick={newTask}>
                  <Plus size={17} />
                </button>
              </div>
              <TaskList
                tasks={active.tasks.filter((t) => !t.project_id && visible(t))}
                details
                selection={rowSelection}
                edit={edit}
              />
            </section>
          )}
          {scope === 'projects' &&
            active.projects
              .filter((p) => projectFilter === 'all' || p.id === projectFilter)
              .map((project) => {
                const tasks = active.tasks.filter((t) => t.project_id === project.id),
                  allTasks = data.tasks.filter((t) => t.project_id === project.id),
                  stages = active.stages
                    .filter((s) => s.project_id === project.id)
                    .sort((a, b) => a.start_date.localeCompare(b.start_date));
                return (
                  <section
                    className="panel task-group"
                    key={project.id}
                    style={projectStyle(data.projects, project.id)}
                  >
                    <div className="project-group-head">
                      <span className="project-dot" />
                      <div className="item-main">
                        <h2>{project.title}</h2>
                        {project.notes && (
                          <p className="item-meta preserve-lines">{project.notes}</p>
                        )}
                        <span className="item-meta">
                          {stages.length} 个阶段 ·{' '}
                          {allTasks.filter((t) => t.status === 'done').length} / {allTasks.length}{' '}
                          已完成
                        </span>
                      </div>
                      <span className="project-percent">{progress(allTasks)}%</span>
                      <button
                        className="icon-button"
                        aria-label={`编辑项目：${project.title}`}
                        onClick={() => edit({ table: 'projects', record: project })}
                      >
                        <MoreHorizontal size={19} />
                      </button>
                    </div>
                    {stages.map((stage) => (
                      <Disclosure
                        key={stage.id}
                        title={
                          <>
                            <Layers3 size={16} />
                            <span className="item-main">
                              <span className="item-title">{stage.title}</span>
                              <span className="item-meta">
                                {formatDate(stage.start_date)} 至 {formatDate(stage.end_date)}
                              </span>
                            </span>
                            <span className="badge">
                              {
                                tasks.filter((t) => t.stage_id === stage.id && t.status !== 'done')
                                  .length
                              }{' '}
                              待完成
                            </span>
                          </>
                        }
                      >
                        <div className="stage-tools">
                          <button
                            className="text-button"
                            onClick={() => edit({ table: 'stages', record: stage })}
                          >
                            编辑阶段
                          </button>
                          <button
                            className="text-button"
                            onClick={() =>
                              edit({
                                table: 'tasks',
                                defaults: { project_id: project.id, stage_id: stage.id },
                              })
                            }
                          >
                            <Plus size={13} />
                            添加任务
                          </button>
                        </div>
                        <TaskList
                          tasks={tasks.filter((t) => t.stage_id === stage.id && visible(t))}
                          selection={rowSelection}
                          edit={edit}
                        />
                      </Disclosure>
                    ))}
                    {tasks.some((t) => !t.stage_id) && (
                      <div className="unassigned">
                        <h3>未分配阶段</h3>
                        <TaskList
                          tasks={tasks.filter((t) => !t.stage_id && visible(t))}
                          selection={rowSelection}
                          edit={edit}
                        />
                      </div>
                    )}
                    {!tasks.length && !stages.length && (
                      <Empty
                        action={() =>
                          edit({ table: 'stages', defaults: { project_id: project.id } })
                        }
                        label="添加第一个阶段"
                      >
                        先划分工作阶段，或直接为项目添加任务。
                      </Empty>
                    )}
                    <div className="panel-bottom">
                      <button
                        className="text-button"
                        onClick={() =>
                          edit({ table: 'stages', defaults: { project_id: project.id } })
                        }
                      >
                        <Plus size={14} />
                        添加阶段
                      </button>
                      <button
                        className="text-button"
                        onClick={() =>
                          edit({ table: 'tasks', defaults: { project_id: project.id } })
                        }
                      >
                        <Plus size={14} />
                        添加项目任务
                      </button>
                    </div>
                  </section>
                );
              })}
          {scope === 'projects' && !active.projects.length && (
            <Empty action={() => edit({ table: 'projects' })} label="新建项目">
              还没有工作中的项目。
            </Empty>
          )}
          {scope === 'archive' && (
            <>
              <p className="field-hint">
                归档内容保留在本机。恢复后仍保持原完成状态；项目归档会一起隐藏其任务和关联日程。
              </p>
              <section className="panel task-group">
                <h2>已归档项目</h2>
                {archivedProjects.map((project) => (
                  <div
                    className="archived-project-row"
                    key={project.id}
                    style={projectStyle(data.projects, project.id)}
                  >
                    <span className="project-dot" />
                    <button
                      className="item-main text-button"
                      onClick={() => edit({ table: 'projects', record: project })}
                    >
                      {project.title}
                    </button>
                    <span className="item-meta">
                      包含 {data.tasks.filter((t) => t.project_id === project.id).length} 项任务
                    </span>
                    <button
                      disabled={busy}
                      onClick={() => void archive('projects', project.id, false).catch(() => {})}
                    >
                      <ArchiveRestore size={15} />
                      恢复项目
                    </button>
                  </div>
                ))}
                {!archivedProjects.length && <Empty>没有归档项目。</Empty>}
              </section>
              <section className="panel task-group">
                <h2>已归档任务</h2>
                <TaskList
                  tasks={archivedTasks}
                  archived
                  details
                  edit={edit}
                  selection={rowSelection}
                />
              </section>
            </>
          )}
        </motion.div>
      </ViewSwitch>
      <AnimatePresence>
        {pendingBatch && (
          <Confirm
            title={pendingBatch.action === 'delete' ? '批量删除任务' : '批量归档任务'}
            label={
              pendingBatch.action === 'delete'
                ? `删除 ${pendingBatch.taskCount} 项任务`
                : `归档 ${pendingBatch.taskCount} 项任务`
            }
            message={
              pendingBatch.action === 'delete'
                ? `将永久删除选中的 ${pendingBatch.taskCount} 项任务及其全部 ${pendingBatch.planCount} 条关联日程。未选中的任务、项目和阶段保留。此操作无法撤销。`
                : `将归档选中的 ${pendingBatch.taskCount} 项任务，其中 ${pendingBatch.unfinished} 项尚未完成。归档不代表完成，内容和原状态保留，可在归档列表恢复。`
            }
            danger={pendingBatch.action === 'delete'}
            close={() => setPendingBatch(null)}
            action={async () => {
              await applyBatch(pendingBatch.action, pendingBatch.ids);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
