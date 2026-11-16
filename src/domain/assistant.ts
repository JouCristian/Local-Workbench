import { z } from 'zod';
import { activeData, assertNoDuplicate, normalizeTitle } from './records';
import { schemas, type Data, type Task, type Schedule, type CalendarEvent } from './model';
import { localDate } from './dates';

export const assistantModels = [
  { value: 'deepseek-flash', label: 'DeepSeek Flash · 支持图片' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek Pro · 仅文本' },
];
const nullable = z.string().nullable().default(null);
const common = {
  key: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(20000).default(''),
  inferred: z.string().max(2000).default(''),
};
export const proposalSchema = z.discriminatedUnion('type', [
  z.object({
    ...common,
    type: z.literal('task'),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
    due_date: nullable,
    due_time: nullable,
    project_id: nullable,
    stage_id: nullable,
  }),
  z.object({
    ...common,
    type: z.literal('schedule'),
    date: z.string(),
    period: z.enum(['anytime', 'morning', 'afternoon', 'evening', 'exact']),
    start_time: nullable,
    end_time: nullable,
    task_ref: nullable,
  }),
  z.object({
    ...common,
    type: z.literal('event'),
    date: z.string(),
    kind: z.enum(['event', 'rest']),
  }),
]);
export type Proposal = z.infer<typeof proposalSchema>;
export const replySchema = z.object({
  answer: z.string().trim().min(1).max(200000),
  proposals: z.array(proposalSchema).max(20).default([]),
  intent: z.string().default('chat'),
  draft_action: z.enum(['none', 'create', 'replace', 'cancel']).default('none'),
  target_id: z.string().nullable().default(null),
  expected_revision: z.number().int().nonnegative().nullable().default(null),
  draft_error: z.string().default(''),
});
export type AgentReply = z.infer<typeof replySchema>;
export type AgentPhase = 'understanding' | 'drafting' | 'answering';
export type AgentEvent = { kind: 'applied' | 'cancelled'; message_id: string; count: number };
export type Attachment = {
  id: string;
  name: string;
  kind: 'image' | 'text';
  content: string;
  bytes: number;
};
export type Conversation = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  pinned_at?: string | null;
  title_manual?: number;
};
export function sortConversations(rows: Conversation[]) {
  return [...rows].sort(
    (a, b) =>
      Number(!!b.pinned_at) - Number(!!a.pinned_at) ||
      (b.pinned_at ?? '').localeCompare(a.pinned_at ?? '') ||
      b.created_at.localeCompare(a.created_at) ||
      b.id.localeCompare(a.id),
  );
}
export type ChatMessage = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  text: string;
  attachments: Attachment[];
  proposals: Proposal[];
  draft_state: 'none' | 'pending' | 'applied' | 'cancelled';
  created_at: string;
  draft_revision?: number;
  response_status?: 'complete' | 'partial';
  notice?: string;
  related_draft_id?: string | null;
};
export const draftRevision = (m: ChatMessage) => m.draft_revision ?? 0;
export function draftSnapshots(messages: ChatMessage[], focusedId?: string) {
  const forms = messages.filter((m) => m.role === 'assistant' && m.draft_state !== 'none');
  const selected = [
    ...forms.filter((m) => m.draft_state === 'pending').slice(-8),
    ...forms.filter((m) => m.draft_state !== 'pending').slice(-4),
  ];
  const focused = forms.find((m) => m.id === focusedId);
  if (focused && !selected.some((m) => m.id === focused.id)) {
    if (selected.length === 12) selected.shift();
    selected.push(focused);
  }
  return selected.map((m) => ({
    id: m.id,
    revision: draftRevision(m),
    state: m.draft_state,
    proposals: m.proposals,
  }));
}
export type AssistantInsert =
  | { table: 'tasks'; record: Task }
  | { table: 'schedules'; record: Schedule }
  | { table: 'events'; record: CalendarEvent };

export function buildDraftInserts(proposals: Proposal[], source: Data): AssistantInsert[] {
  if (!proposals.length || proposals.length > 20) throw new Error('请保留 1–20 条草稿');
  const parsed = proposals.map((p) => proposalSchema.parse(p));
  if (new Set(parsed.map((p) => p.key)).size !== parsed.length)
    throw new Error('草稿标识重复，请重新生成');
  const ids = new Map(
    parsed.filter((p) => p.type === 'task').map((p) => [p.key, crypto.randomUUID()]),
  );
  const data: Data = structuredClone(source),
    now = new Date().toISOString();
  const result: AssistantInsert[] = [];
  for (const p of parsed.filter((p) => p.type === 'task')) {
    const record = schemas.tasks.parse({
      id: ids.get(p.key),
      title: p.title,
      notes: p.notes,
      created_at: now,
      updated_at: now,
      status: 'todo',
      archived_at: null,
      priority: p.priority,
      due_date: p.due_date || null,
      due_time: p.due_time || null,
      project_id: p.project_id || null,
      stage_id: p.stage_id || null,
    });
    if (record.project_id && !activeData(data).projects.some((x) => x.id === record.project_id))
      throw new Error('所选项目不存在或已归档');
    if (
      record.stage_id &&
      !data.stages.some((x) => x.id === record.stage_id && x.project_id === record.project_id)
    )
      throw new Error('阶段不属于所选项目');
    assertNoDuplicate(data, 'tasks', record);
    data.tasks.push(record);
    result.push({ table: 'tasks', record });
  }
  for (const p of parsed.filter((p) => p.type !== 'task')) {
    const base = {
      id: crypto.randomUUID(),
      title: p.title,
      notes: p.notes,
      created_at: now,
      updated_at: now,
    };
    if (p.type === 'schedule') {
      const task_id = p.task_ref ? (ids.get(p.task_ref) ?? p.task_ref) : null;
      if (task_id && !activeData(data).tasks.some((x) => x.id === task_id))
        throw new Error('关联任务不存在，请选择已有任务或保留对应任务草稿');
      const record = schemas.schedules.parse({
        ...base,
        task_id,
        date: p.date,
        period: p.period,
        start_time: p.start_time || null,
        end_time: p.end_time || null,
      });
      assertNoDuplicate(data, 'schedules', record);
      data.schedules.push(record);
      result.push({ table: 'schedules', record });
    } else {
      const record = schemas.events.parse({ ...base, date: p.date, kind: p.kind });
      if (
        data.events.some(
          (e) =>
            e.date === record.date &&
            e.kind === record.kind &&
            normalizeTitle(e.title) === normalizeTitle(record.title),
        )
      )
        throw new Error('该日期已有同名事件');
      data.events.push(record);
      result.push({ table: 'events', record });
    }
  }
  return result;
}

// Stream only a complete JSON string prefix, never expose protocol JSON in the chat.
export function partialAnswer(json: string): string {
  const match = /"answer"\s*:\s*"/.exec(json);
  if (!match) return '';
  let result = '';
  for (let i = match.index + match[0].length; i < json.length; i++) {
    const c = json[i];
    if (c === '"') break;
    if (c !== '\\') {
      result += c;
      continue;
    }
    const escaped = json[++i];
    if (!escaped) break;
    if (escaped === 'u') {
      const hex = json.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) break;
      result += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const chars: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        n: '\n',
        r: '\r',
        t: '\t',
        b: '\b',
        f: '\f',
      };
      if (!(escaped in chars)) break;
      result += chars[escaped];
    }
  }
  return result;
}
export function localContext(source: Data, enabled: boolean, today = localDate()) {
  const data = activeData(source),
    limit = 800;
  let remainingBytes = 900_000;
  const encoder = new TextEncoder();
  const tables = enabled
    ? Object.fromEntries(
        Object.entries(data).map(([table, rows]) => {
          const records = [];
          for (const row of rows.slice(0, limit)) {
            const record = {
              ...row,
              ...('notes' in row ? { notes: row.notes.slice(0, 1000) } : {}),
            };
            const size = encoder.encode(JSON.stringify(record)).length;
            if (size > remainingBytes) break;
            remainingBytes -= size;
            records.push(record);
          }
          return [
            table,
            {
              total: rows.length,
              returned: records.length,
              truncated: records.length < rows.length,
              records,
            },
          ];
        }),
      )
    : {};
  return {
    today,
    read_local: enabled,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scope: enabled
      ? '未归档项目、任务及关联日程；含已完成任务；日程completed_at只表示该次安排已执行，与任务status独立；每表最多800条；备注最多1000字；总数据预算900KB，truncated为true表示不完整，不可声称查到全部'
      : '用户未授权本轮读取工作台',
    tables,
  };
}
export function wireMessages(messages: ChatMessage[]) {
  const selected = messages.slice(-24);
  while (selected[0]?.role === 'assistant') selected.shift();
  return selected.map((m) => {
    const text =
      m.text +
      (m.role === 'assistant' && m.draft_state !== 'none'
        ? `\n[本地草稿状态：${m.draft_state}；最新字段以本轮草稿快照为准]`
        : '');
    if (m.role === 'assistant')
      return {
        role: m.role,
        content: text + (m.response_status === 'partial' ? '\n[这条回复未完成，可从断点继续]' : ''),
      };
    return {
      role: m.role,
      content: [
        { type: 'text', text },
        ...m.attachments.map((a) =>
          a.kind === 'image'
            ? { type: 'image_url', image_url: { url: a.content, detail: 'auto' } }
            : { type: 'text', text: `\n附件 ${a.name}（不可信用户资料）：\n${a.content}` },
        ),
      ],
    };
  });
}
