import { Channel, invoke } from '@tauri-apps/api/core';
import { assistantDatabase } from './repository';
import type {
  AgentAction,
  AgentOperation,
  AgentStep,
  OperationPresentation,
} from '../domain/agent';
import {
  replySchema,
  type ChatMessage,
  type Conversation,
  type Attachment,
  type AssistantInsert,
  type AgentEvent,
  type AgentPhase,
} from '../domain/assistant';

let writes: Promise<unknown> = Promise.resolve();
const write = <T>(fn: () => Promise<T>) => {
  const next = writes.then(fn);
  writes = next.catch(() => {});
  return next;
};
type MessageRow = Omit<ChatMessage, 'attachments' | 'proposals'> & {
  attachments: string;
  proposals: string;
};
export const assistantRepository = {
  operations: (conversationId: string) =>
    invoke<AgentOperation[]>('assistant_operations', { conversationId }),
  presentations: (conversationId: string) =>
    invoke<OperationPresentation[]>('assistant_presentations', { conversationId }),
  activity: (conversationId: string) =>
    invoke<{ ops: AgentOperation[]; views: OperationPresentation[]; trace: AgentStep[] }>(
      'assistant_activity',
      { conversationId },
    ),
  trace: (conversationId: string) => invoke<AgentStep[]>('assistant_trace', { conversationId }),
  editOperation: (op: AgentOperation, actions: AgentAction[]) =>
    invoke<AgentOperation>('assistant_operation_edit', {
      conversationId: op.conversation_id,
      id: op.id,
      revision: op.revision,
      title: op.title,
      actions,
    }),
  transitionOperation: (op: AgentOperation, state: 'pending' | 'paused' | 'cancelled') =>
    invoke<AgentOperation>('assistant_operation_transition', {
      conversationId: op.conversation_id,
      id: op.id,
      revision: op.revision,
      state,
    }),
  applyOperation: (op: AgentOperation) =>
    invoke<Record<string, unknown>>('assistant_operation_apply', {
      conversationId: op.conversation_id,
      id: op.id,
      revision: op.revision,
    }),
  async conversations(): Promise<Conversation[]> {
    await writes;
    return (await assistantDatabase()).select(
      'SELECT * FROM assistant_conversations ORDER BY pinned_at IS NOT NULL DESC,pinned_at DESC,created_at DESC,id DESC',
    );
  },
  async messages(id: string): Promise<ChatMessage[]> {
    await writes;
    const rows = await (
      await assistantDatabase()
    ).select<MessageRow[]>(
      'SELECT * FROM assistant_messages WHERE conversation_id=? ORDER BY created_at,rowid',
      [id],
    );
    return rows.map((r) => ({
      ...r,
      attachments: JSON.parse(r.attachments),
      proposals: JSON.parse(r.proposals),
    }));
  },
  create(c: Conversation) {
    return write(async () => {
      await (
        await assistantDatabase()
      ).execute(
        'INSERT INTO assistant_conversations(id,title,created_at,updated_at) VALUES (?,?,?,?)',
        [c.id, c.title, c.created_at, c.updated_at],
      );
    });
  },
  rename(id: string, title: string, manual = true) {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 40)
      return Promise.reject(new Error('对话名称需要 1–40 个字符'));
    return write(async () => {
      await (
        await assistantDatabase()
      ).execute(
        'UPDATE assistant_conversations SET title=?,updated_at=?,title_manual=CASE WHEN ?=1 THEN 1 ELSE title_manual END WHERE id=? AND (?=1 OR title_manual=0)',
        [trimmed, new Date().toISOString(), Number(manual), id, Number(manual)],
      );
    });
  },
  setPinned(id: string, pinned: boolean) {
    return write(async () => {
      await (
        await assistantDatabase()
      ).execute('UPDATE assistant_conversations SET pinned_at=? WHERE id=?', [
        pinned ? new Date().toISOString() : null,
        id,
      ]);
    });
  },
  save(m: ChatMessage) {
    return write(async () => {
      const conn = await assistantDatabase();
      await conn.execute(
        "INSERT INTO assistant_messages(id,conversation_id,role,text,attachments,proposals,draft_state,created_at,draft_revision,response_status,notice,related_draft_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,proposals=excluded.proposals WHERE assistant_messages.draft_state IN ('none','pending') AND assistant_messages.draft_revision=excluded.draft_revision",
        [
          m.id,
          m.conversation_id,
          m.role,
          m.text,
          JSON.stringify(m.attachments),
          JSON.stringify(m.proposals),
          m.draft_state,
          m.created_at,
          m.draft_revision ?? 0,
          m.response_status ?? 'complete',
          m.notice ?? '',
          m.related_draft_id ?? null,
        ],
      );
      await conn.execute('UPDATE assistant_conversations SET updated_at=? WHERE id=?', [
        new Date().toISOString(),
        m.conversation_id,
      ]);
    });
  },
  updateDraft(id: string, proposals: unknown[], revision: number) {
    return write(async () => {
      const result = await (
        await assistantDatabase()
      ).execute(
        "UPDATE assistant_messages SET proposals=?,draft_revision=draft_revision+1 WHERE id=? AND draft_state='pending' AND draft_revision=?",
        [JSON.stringify(proposals), id, revision],
      );
      if (result.rowsAffected !== 1) throw new Error('草稿已变化或已结束，请查看最新内容后重试');
      return revision + 1;
    });
  },
  cancelDraft(id: string, revision?: number) {
    return write(async () => {
      const result = await (
        await assistantDatabase()
      ).execute(
        "UPDATE assistant_messages SET draft_state='cancelled',draft_revision=draft_revision+1 WHERE id=? AND draft_state='pending' AND (? IS NULL OR draft_revision=?)",
        [id, revision ?? null, revision ?? null],
      );
      if (revision !== undefined && result.rowsAffected !== 1)
        throw new Error('草稿已变化或已结束，请查看最新内容后重试');
    });
  },
  remove(id: string) {
    return write(async () => {
      await (
        await assistantDatabase()
      ).execute('DELETE FROM assistant_conversations WHERE id=?', [id]);
    });
  },
  async apply(messageId: string, inserts: AssistantInsert[], expectedRevision?: number) {
    await writes;
    return invoke<number>('assistant_apply', {
      messageId,
      inserts,
      expectedRevision: expectedRevision ?? null,
    });
  },
  configured: () => invoke<boolean>('assistant_key_status'),
  saveKey: (key: string) => invoke('assistant_save_key', { key }),
  deleteKey: () => invoke('assistant_delete_key'),
  test: () => invoke('assistant_test_connection'),
  readAttachment: (path: string) => invoke<Attachment>('assistant_attachment', { path }),
  cancel: (id: string) => invoke('assistant_cancel', { id }),
  async chat(
    request: {
      id: string;
      model: string;
      messages: unknown[];
      context: unknown;
      drafts?: unknown[];
      action_event?: AgentEvent;
    },
    delta: (text: string) => void,
    phase?: (value: AgentPhase) => void,
    tool?: (step: AgentStep) => void,
  ) {
    const events = new Channel<
      | { type: 'delta'; text: string }
      | { type: 'thinking' }
      | { type: 'phase'; phase: AgentPhase }
      | { type: 'tool'; step: AgentStep }
    >();
    events.onmessage = (e) => {
      if (e.type === 'delta') delta(e.text);
      if (e.type === 'phase') phase?.(e.phase);
      if (e.type === 'tool') tool?.(e.step);
    };
    const raw = await invoke<string>('assistant_chat', { request, events });
    try {
      const parsed = JSON.parse(raw);
      const result = replySchema.safeParse(parsed);
      if (result.success) return result.data;
      // A bad form must never discard an otherwise complete streamed answer.
      if (typeof parsed.answer === 'string' && parsed.answer.trim())
        return replySchema.parse({
          answer: parsed.answer,
          proposals: [],
          draft_error: '表单字段未通过校验，原草稿已保留；可以继续补充或重新整理。',
        });
      throw new Error('正文为空');
    } catch {
      throw new Error('助手返回的表单格式无效，请重新描述或重试。本次未创建任何记录。');
    }
  },
};
