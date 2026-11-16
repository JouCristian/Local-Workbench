import { buildUpsert } from './statements';
import {
  accentSchema,
  readLayout,
  layoutSchema,
  type Accent,
  type DashboardLayout,
} from '../domain/preferences';
import { assertNoDuplicate, RecordConflict } from '../domain/records';
import Database from '@tauri-apps/plugin-sql';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  emptyData,
  schemas,
  snapshotSchema,
  type Data,
  type Table,
  type Tables,
  type Snapshot,
  type Schedule,
} from '../domain/model';

export type TaskBatchAction = 'complete' | 'reopen' | 'archive' | 'restore' | 'delete';
let database: Promise<Database> | undefined;
async function db(): Promise<Database> {
  if (!isTauri())
    throw new Error('请通过 npm run tauri dev 启动桌面应用。浏览器预览无法访问本地 SQLite。');
  if (!database)
    database = Database.load('sqlite:workbench.db').catch((e) => {
      database = undefined;
      throw e;
    });
  return database;
}
// Assistant records live in separate tables, using the same migrated SQLite file.
export const assistantDatabase = db;
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const next = queue.then(action);
  queue = next.catch(() => {});
  return next;
}
export const repository = {
  setScheduleCompletion(
    schedule: Schedule,
    completed: boolean,
    completeTask = false,
    taskUpdatedAt: string | null = null,
  ): Promise<void> {
    return serialized(async () => {
      await db();
      return invoke('set_schedule_completion', {
        id: schedule.id,
        completed,
        expectedUpdatedAt: schedule.updated_at,
        expectedTaskId: schedule.task_id,
        completeTask,
        expectedTaskUpdatedAt: taskUpdatedAt,
      });
    });
  },
  async preferences(): Promise<{ accent: Accent; layout: DashboardLayout }> {
    const rows = await (
      await db()
    ).select<{ key: string; value: string }[]>(
      "SELECT key,value FROM settings WHERE key IN ('accent','dashboard-layout')",
    );
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const accent = accentSchema.safeParse(values.accent);
    return {
      accent: accent.success ? accent.data : 'blue',
      layout: readLayout(values['dashboard-layout']),
    };
  },
  setAccent(value: Accent): Promise<void> {
    const parsed = accentSchema.parse(value);
    return serialized(async () => {
      await (
        await db()
      ).execute(
        "INSERT INTO settings(key,value) VALUES ('accent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [parsed],
      );
    });
  },
  setDashboardLayout(value: DashboardLayout): Promise<void> {
    const parsed = layoutSchema.parse(value);
    return serialized(async () => {
      await (
        await db()
      ).execute(
        "INSERT INTO settings(key,value) VALUES ('dashboard-layout',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [JSON.stringify(parsed)],
      );
    });
  },
  saveTaskSchedules(
    taskId: string,
    plans: Schedule[],
    expected: Pick<Schedule, 'id' | 'updated_at'>[],
  ): Promise<number> {
    return serialized(async () => {
      await db();
      const parsed = plans.map((plan) => schemas.schedules.parse(plan));
      const data = await this.load();
      data.schedules = data.schedules.filter((plan) => plan.task_id !== taskId);
      for (const plan of parsed) {
        if (plan.task_id !== taskId) throw new Error('日程不属于当前任务');
        assertNoDuplicate(data, 'schedules', plan);
        data.schedules.push(plan);
      }
      return invoke<number>('save_task_schedules', { taskId, plans: parsed, expected });
    });
  },
  async load(): Promise<Data> {
    const conn = await db();
    const names = Object.keys(emptyData) as Table[];
    const rows = await Promise.all(
      names.map((name) => conn.select(`SELECT * FROM ${name} ORDER BY created_at, id`)),
    );
    return Object.fromEntries(names.map((name, i) => [name, rows[i]])) as Data;
  },
  save<K extends Table>(table: K, record: Tables[K]): Promise<void> {
    return serialized(async () => {
      const parsed = schemas[table].parse(record);
      if (table === 'tasks' || table === 'schedules')
        assertNoDuplicate(
          await this.load(),
          table,
          parsed as Tables['tasks'] | Tables['schedules'],
        );
      const statement = buildUpsert(table, parsed as Tables[K]);
      const result = await (await db()).execute(statement.sql, statement.values);
      if (result.rowsAffected === 0)
        throw new RecordConflict('已有相同任务或同时间安排，请编辑已有记录。');
    });
  },
  remove(table: Table, id: string): Promise<void> {
    return serialized(async () => {
      await (await db()).execute(`DELETE FROM ${table} WHERE id=?`, [id]);
    });
  },
  batchTasks(ids: string[], action: TaskBatchAction): Promise<number> {
    return serialized(async () => {
      await db();
      if (action === 'restore') {
        const data = await this.load();
        for (const id of ids) {
          const task = data.tasks.find((t) => t.id === id);
          if (!task) throw new Error('选中任务已不存在，请刷新');
          const restored = { ...task, archived_at: null };
          assertNoDuplicate(data, 'tasks', restored);
          data.tasks = data.tasks.map((t) => (t.id === id ? restored : t));
        }
      }
      return invoke<number>('batch_tasks', { ids, action });
    });
  },
  async theme(): Promise<string> {
    const rows = await (
      await db()
    ).select<{ value: string }[]>("SELECT value FROM settings WHERE key='theme'");
    return rows[0]?.value ?? 'system';
  },
  async fontScale(): Promise<string> {
    const rows = await (
      await db()
    ).select<{ value: string }[]>("SELECT value FROM settings WHERE key='font-scale'");
    return ['compact', 'standard', 'large'].includes(rows[0]?.value) ? rows[0].value : 'standard';
  },
  setFontScale(value: string): Promise<void> {
    if (!['compact', 'standard', 'large'].includes(value))
      return Promise.reject(new Error('无效的字体大小'));
    return serialized(async () => {
      await (
        await db()
      ).execute(
        "INSERT INTO settings(key,value) VALUES ('font-scale',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [value],
      );
    });
  },
  setTheme(value: string): Promise<void> {
    return serialized(async () => {
      await (
        await db()
      ).execute(
        "INSERT INTO settings(key,value) VALUES ('theme',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [value],
      );
    });
  },
  async snapshot(): Promise<Snapshot> {
    await queue;
    return snapshotSchema.parse({
      format: 'local-workbench',
      version: 1,
      exported_at: new Date().toISOString(),
      ...(await this.load()),
    });
  },
  restore(snapshot: Snapshot): Promise<string> {
    return serialized(async () => {
      await db();
      return invoke<string>('restore_snapshot', { snapshot: snapshotSchema.parse(snapshot) });
    });
  },
  directory(): Promise<string> {
    return invoke<string>('data_directory');
  },
};
