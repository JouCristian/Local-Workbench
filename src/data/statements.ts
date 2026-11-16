import type { Table, Tables } from '../domain/model';
/** The caller must validate records through schemas before building SQL. */
export function buildUpsert<K extends Table>(table: K, record: Tables[K]) {
  const fields = Object.keys(record);
  let guard = ' WHERE true',
    guardValues: unknown[] = [];
  const normal = (column: string) =>
    `lower(replace(replace(replace(trim(${column}), ' ', ''),char(9),''),char(12288),''))`;
  if (table === 'schedules') {
    const s = record as Tables['schedules'];
    const match = `date=? AND period=? AND start_time IS ? AND (CASE WHEN ? IS NULL THEN task_id IS NULL AND ${normal('title')}=${normal('?')} ELSE task_id=? END)`;
    const args = [s.date, s.period, s.start_time, s.task_id, s.title, s.task_id];
    guard = ` WHERE NOT EXISTS(SELECT 1 FROM schedules WHERE id<>? AND ${match}) OR EXISTS(SELECT 1 FROM schedules WHERE id=? AND ${match})`;
    guardValues = [s.id, ...args, s.id, ...args];
  }
  if (table === 'tasks') {
    const t = record as Tables['tasks'];
    const match = `${normal('title')}=${normal('?')} AND project_id IS ? AND stage_id IS ?`;
    const args = [t.title, t.project_id, t.stage_id];
    guard = ` WHERE ? IS NOT NULL OR NOT EXISTS(SELECT 1 FROM tasks WHERE id<>? AND archived_at IS NULL AND ${match}) OR EXISTS(SELECT 1 FROM tasks WHERE id=? AND archived_at IS NULL AND ${match})`;
    guardValues = [t.archived_at ?? null, t.id, ...args, t.id, ...args];
  }
  return {
    sql: `INSERT INTO ${table} (${fields.join(',')}) SELECT ${fields.map(() => '?').join(',')}${guard} ON CONFLICT(id) DO UPDATE SET ${fields
      .filter((f) => f !== 'id')
      .map((f) => `${f}=excluded.${f}`)
      .join(',')}`,
    values: [...Object.values(record), ...guardValues],
  };
}
