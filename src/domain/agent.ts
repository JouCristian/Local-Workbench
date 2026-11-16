import type { Table } from './model';

export type AgentAction = {
  key: string;
  table: Table;
  action: 'create' | 'update' | 'delete' | 'archive' | 'restore';
  id?: string;
  ref?: string;
  fields?: Record<string, string | null>;
  shift_due_days?: number;
};
export type OperationItem = {
  key: string;
  table: Table;
  action: AgentAction['action'];
  id: string;
  before: Record<string, string | null> | null;
  after: Record<string, string | null> | null;
  affected: { table: Table; record: Record<string, string | null> }[];
};
export type AgentOperation = {
  id: string;
  conversation_id: string;
  message_id: string;
  title: string;
  state: 'pending' | 'paused' | 'applied' | 'cancelled';
  revision: number;
  actions: AgentAction[];
  preview: OperationItem[];
  receipt: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  superseded_by?: string | null;
};
export type OperationPresentation = {
  sequence: number;
  operation_id: string;
  message_id: string;
  revision: number;
  reason: 'create' | 'revise' | 'present' | 'state' | 'replace';
};
export function operationPresentations(
  operation: AgentOperation,
  presentations: OperationPresentation[],
) {
  const found = presentations
    .filter((p) => p.operation_id === operation.id)
    .sort((a, b) => a.sequence - b.sequence);
  return found.length
    ? found
    : [
        {
          sequence: -1,
          operation_id: operation.id,
          message_id: operation.message_id,
          revision: operation.revision,
          reason: 'create' as const,
        },
      ];
}
export function latestPresentation(
  operation: AgentOperation,
  presentations: OperationPresentation[],
) {
  return operationPresentations(operation, presentations).at(-1)!;
}
export function replacementTarget(operation: AgentOperation, operations: AgentOperation[]) {
  const seen = new Set<string>();
  let current = operation;
  while (current.superseded_by && !seen.has(current.id)) {
    seen.add(current.id);
    const next = operations.find((op) => op.id === current.superseded_by);
    if (!next) return current.superseded_by;
    current = next;
  }
  return current.id;
}
export type QueryRecord = Record<string, unknown> & {
  id: string;
  title: string;
  due_date?: string | null;
  due_time?: string | null;
  date?: string;
  status?: string;
  period?: string;
  start_time?: string | null;
  end_time?: string | null;
  execution_state?: string;
  kind?: string;
  facts?: {
    overdue: boolean;
    days_until_due: number | null;
    schedule_total: number;
    schedule_pending: number;
    schedule_completed: number;
    task_complete: boolean;
  };
};
export type AgentStep = {
  id: string;
  run_id: string;
  message_id: string;
  tool: string;
  label: string;
  state: 'running' | 'complete' | 'failed' | 'interrupted';
  result: {
    ok?: boolean;
    error?: string;
    data?: {
      table?: Table;
      records?: QueryRecord[];
      total?: number;
      returned?: number;
      has_more?: boolean;
      as_of?: string;
    };
  };
};
export const tableNames: Record<Table, string> = {
  projects: '项目',
  stages: '阶段',
  tasks: '任务',
  schedules: '日程',
  events: '事件',
};
export const actionNames: Record<AgentAction['action'], string> = {
  create: '新建',
  update: '修改',
  delete: '删除',
  archive: '归档',
  restore: '恢复',
};
export const fieldNames: Record<string, string> = {
  title: '标题',
  notes: '备注',
  status: '状态',
  priority: '优先级',
  due_date: '截止日期',
  due_time: '截止时间',
  project_id: '所属项目',
  stage_id: '所属阶段',
  task_id: '关联任务',
  start_date: '开始日期',
  end_date: '结束日期',
  date: '执行日期',
  period: '时间安排',
  start_time: '开始时间',
  end_time: '结束时间',
  kind: '事件类型',
  completed_at: '执行状态',
  archived_at: '归档状态',
};
/** Compare business fields only; system timestamps/identifiers never clutter previews. */
export function changedFields(item: OperationItem) {
  const keys = Object.keys(item.after ?? item.before ?? {}).filter((k) => fieldNames[k]);
  return keys.filter((k) =>
    item.action === 'create'
      ? item.after?.[k] != null && item.after[k] !== ''
      : item.action === 'delete' || item.before?.[k] !== item.after?.[k],
  );
}
