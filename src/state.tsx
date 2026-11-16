import type { TaskBatchAction } from './data/repository';
import { defaultLayout, type Accent, type DashboardLayout } from './domain/preferences';
import { RecordConflict } from './domain/records';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { repository } from './data/repository';
import {
  emptyData,
  type Data,
  type Table,
  type Tables,
  type Task,
  type Snapshot,
  type Schedule,
} from './domain/model';

type Store = {
  data: Data;
  loading: boolean;
  busy: boolean;
  error: string;
  toast: string;
  theme: string;
  fontScale: string;
  accent: Accent;
  dashboardLayout: DashboardLayout;
  setAccent: (value: Accent) => Promise<void>;
  setDashboardLayout: (value: DashboardLayout) => Promise<void>;
  setFontScale: (value: string) => Promise<void>;
  reload: () => Promise<void>;
  save: <K extends Table>(table: K, value: Tables[K]) => Promise<void>;
  remove: (table: Table, id: string) => Promise<void>;
  toggle: (task: Task) => Promise<void>;
  toggleSchedule: (schedule: Schedule) => Promise<void>;
  pendingSchedule: { schedule: Schedule; task: Task } | null;
  completingScheduleId: string | null;
  confirmScheduleCompletion: (completeTask: boolean) => Promise<void>;
  cancelScheduleCompletion: () => void;
  batchTasks: (ids: string[], action: TaskBatchAction) => Promise<void>;
  saveTaskSchedules: (
    taskId: string,
    plans: Schedule[],
    expected: Pick<Schedule, 'id' | 'updated_at'>[],
  ) => Promise<void>;
  archive: (table: 'tasks' | 'projects', id: string, archived: boolean) => Promise<void>;
  setTheme: (theme: string) => Promise<void>;
  restore: (snapshot: Snapshot) => Promise<string>;
  notify: (message: string) => void;
  report: (error: unknown) => void;
};
const Context = createContext<Store | null>(null);
export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'issues' in e)
    return (e as { issues: { message: string }[] }).issues
      .map((x) => x.message)
      .slice(0, 3)
      .join('；');
  return e instanceof Error ? e.message : String(e);
}
export function Provider({ children }: { children: ReactNode }) {
  const [pendingSchedule, setPendingSchedule] = useState<{ schedule: Schedule; task: Task } | null>(
    null,
  );
  const [completingScheduleId, setCompletingScheduleId] = useState<string | null>(null);
  const [data, setData] = useState<Data>(emptyData),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [theme, updateTheme] = useState('system');
  const [fontScale, updateFontScale] = useState('standard');
  const [accent, updateAccent] = useState<Accent>('blue');
  const [dashboardLayout, updateLayout] = useState<DashboardLayout>({ ...defaultLayout });
  const reload = async () => {
    setData(await repository.load());
    setError('');
  };
  const report = (e: unknown) => setError(errorMessage(e));
  useEffect(() => {
    Promise.all([
      reload(),
      repository.theme().then(updateTheme),
      repository.fontScale().then(updateFontScale),
      repository.preferences().then((value) => {
        updateAccent(value.accent);
        updateLayout(value.layout);
      }),
    ])
      .catch(report)
      .finally(() => setLoading(false));
  }, []);
  useLayoutEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      '--user-font-scale',
      String(
        ({ compact: 0.925, standard: 1, large: 1.15 } as Record<string, number>)[fontScale] ?? 1,
      ),
    );
  }, [fontScale]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(id);
  }, [toast]);
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  async function mutate<T>(work: () => Promise<T>): Promise<T> {
    setBusy(true);
    try {
      const result = await work();
      await reload();
      return result;
    } catch (e) {
      if (!(e instanceof RecordConflict)) report(e);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const save: Store['save'] = async (table, value) => {
    await mutate(() => repository.save(table, value));
    setToast('已保存到本地');
  };
  const remove: Store['remove'] = async (table, id) => {
    await mutate(() => repository.remove(table, id));
    setToast(
      table === 'projects'
        ? '项目及其阶段、任务和关联日程已删除'
        : table === 'tasks'
          ? '任务及其关联日程已删除'
          : '已删除，其他内容已保留',
    );
  };
  const toggle = async (task: Task) => {
    await mutate(() =>
      repository.save('tasks', {
        ...task,
        status: task.status === 'done' ? 'todo' : 'done',
        updated_at: new Date().toISOString(),
      }),
    );
    setToast(task.status === 'done' ? '任务已重新打开' : '又完成一件事');
  };
  async function finishSchedule(
    schedule: Schedule,
    completed: boolean,
    completeTask = false,
    task: Task | null = null,
  ) {
    if (completed) setCompletingScheduleId(schedule.id);
    try {
      await mutate(() =>
        repository.setScheduleCompletion(
          schedule,
          completed,
          completeTask,
          task?.updated_at ?? null,
        ),
      );
      setToast(
        completed
          ? completeTask
            ? '本次日程和关联任务已完成'
            : '本次日程已完成，任务状态保持不变'
          : '本次日程已重新打开，任务状态保持不变',
      );
    } finally {
      setCompletingScheduleId(null);
    }
  }
  async function toggleSchedule(schedule: Schedule) {
    if (schedule.completed_at) {
      await finishSchedule(schedule, false);
      return;
    }
    const task = data.tasks.find((t) => t.id === schedule.task_id);
    if (task && task.status !== 'done') {
      setPendingSchedule({ schedule, task });
      return;
    }
    await finishSchedule(schedule, true);
  }
  return (
    <Context.Provider
      value={{
        data,
        loading,
        busy,
        error,
        toast,
        theme,
        fontScale,
        accent,
        dashboardLayout,
        setAccent: async (value) => {
          try {
            await repository.setAccent(value);
            updateAccent(value);
          } catch (error) {
            report(error);
            throw error;
          }
        },
        setDashboardLayout: async (value) => {
          try {
            await repository.setDashboardLayout(value);
            updateLayout(value);
          } catch (error) {
            report(error);
            throw error;
          }
        },
        setFontScale: async (value) => {
          await repository.setFontScale(value);
          updateFontScale(value);
        },
        reload,
        save,
        remove,
        toggle,
        toggleSchedule,
        pendingSchedule,
        completingScheduleId,
        cancelScheduleCompletion: () => setPendingSchedule(null),
        confirmScheduleCompletion: async (completeTask) => {
          if (!pendingSchedule) return;
          await finishSchedule(pendingSchedule.schedule, true, completeTask, pendingSchedule.task);
          setPendingSchedule(null);
        },
        saveTaskSchedules: async (taskId, plans, expected) => {
          const count = await mutate(() => repository.saveTaskSchedules(taskId, plans, expected));
          setToast(`已保存 ${count} 条关联日程`);
        },
        batchTasks: async (ids, action) => {
          const count = await mutate(() => repository.batchTasks(ids, action));
          const labels = {
            complete: '完成',
            reopen: '重新打开',
            archive: '归档',
            restore: '恢复',
            delete: '删除',
          };
          setToast(
            `已${labels[action]} ${count} 项任务${action === 'delete' ? '及其关联日程' : ''}`,
          );
        },
        archive: async (table, id, archived) => {
          const value = data[table].find((record) => record.id === id);
          if (!value) throw new Error('记录不存在');
          try {
            await mutate(() =>
              repository.save(table, {
                ...value,
                archived_at: archived ? new Date().toISOString() : null,
                updated_at: new Date().toISOString(),
              }),
            );
          } catch (error) {
            report(error);
            throw error;
          }
          setToast(archived ? '已归档，可在归档列表恢复' : '已恢复，原完成状态已保留');
        },
        setTheme: async (value) => {
          await mutate(() => repository.setTheme(value));
          updateTheme(value);
        },
        restore: (snapshot) => mutate(() => repository.restore(snapshot)),
        notify: setToast,
        report,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useStore(): Store {
  const value = useContext(Context);
  if (!value) throw new Error('Missing provider');
  return value;
}
