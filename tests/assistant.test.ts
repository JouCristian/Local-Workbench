import { describe, it, expect } from 'vitest';
import { emptyData } from '../src/domain/model';
import {
  buildDraftInserts,
  partialAnswer,
  localContext,
  proposalSchema,
  wireMessages,
  sortConversations,
  draftSnapshots,
  type ChatMessage,
  type Proposal,
} from '../src/domain/assistant';

const task = () => proposalSchema.parse({ type: 'task', key: 't1', title: '测试任务' });
const plan = (more = {}) =>
  proposalSchema.parse({
    type: 'schedule',
    key: 's1',
    title: '执行任务',
    date: '2026-11-16',
    period: 'morning',
    task_ref: 't1',
    ...more,
  });
describe('assistant drafts retain calendar meaning and create only validated inserts', () => {
  it('links multiple schedules to one task without fabricating a deadline or hour', () => {
    const rows = buildDraftInserts(
      [task(), plan(), plan({ key: 's2', date: '2026-11-17', period: 'evening' })],
      emptyData,
    );
    const t = rows.find((x) => x.table === 'tasks')!;
    expect(t.record).toMatchObject({ due_date: null, due_time: null });
    expect(rows.filter((x) => x.table === 'schedules').map((x) => x.record)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: t.record.id,
          start_time: null,
          end_time: null,
          period: 'morning',
        }),
        expect.objectContaining({ task_id: t.record.id, period: 'evening' }),
      ]),
    );
    expect(emptyData.tasks).toHaveLength(0);
  });
  it('rejects duplicate tasks and schedules within one confirmation', () => {
    expect(() =>
      buildDraftInserts([task(), { ...task(), key: 't2', title: '测 试 任 务' }], emptyData),
    ).toThrow('同名任务');
    expect(() => buildDraftInserts([task(), plan(), plan({ key: 's2' })], emptyData)).toThrow(
      '已有安排',
    );
  });
  it('rejects invalid and missing dates, fuzzy hours, backwards times, and broken references', () => {
    for (const p of [
      plan({ date: '2026-02-30' }),
      plan({ date: '' }),
      plan({ start_time: '09:00' }),
      plan({ period: 'exact', start_time: '10:00', end_time: '09:00' }),
      plan({ task_ref: 'missing' }),
    ])
      expect(() => buildDraftInserts([task(), p], emptyData)).toThrow();
    expect(() =>
      buildDraftInserts([{ ...task(), due_time: '09:00' } as Proposal], emptyData),
    ).toThrow();
  });
  it('does not accept invented project or stage links', () => {
    expect(() =>
      buildDraftInserts([{ ...task(), project_id: crypto.randomUUID() } as Proposal], emptyData),
    ).toThrow('项目不存在');
    expect(() => buildDraftInserts([plan()], emptyData)).toThrow('关联任务不存在');
  });
  it('creates date-only rest events and prevents duplicate events', () => {
    const rest = proposalSchema.parse({
      type: 'event',
      key: 'r1',
      title: '休息一天',
      date: '2026-11-18',
      kind: 'rest',
    });
    const rows = buildDraftInserts([rest], emptyData);
    expect(rows[0].record).toMatchObject({ date: '2026-11-18', kind: 'rest' });
    expect(() => buildDraftInserts([rest, { ...rest, key: 'r2' }], emptyData)).toThrow('同名事件');
  });
});
describe('assistant protocol and privacy', () => {
  it('keeps pinned conversations first without reordering when replies update', () => {
    const rows = [
      { id: 'new', title: 'new', created_at: '2026-11-16', updated_at: '2026-11-16' },
      { id: 'old', title: 'old', created_at: '2026-11-10', updated_at: '2026-11-20' },
      {
        id: 'pin',
        title: 'pin',
        created_at: '2026-10-01',
        updated_at: '2026-10-01',
        pinned_at: '2026-11-15',
      },
    ];
    expect(sortConversations(rows).map((c) => c.id)).toEqual(['pin', 'new', 'old']);
    expect(
      sortConversations(rows.map((c) => ({ ...c, pinned_at: null }))).map((c) => c.id),
    ).toEqual(['new', 'old', 'pin']);
    expect(rows[0].id).toBe('new');
  });
  it('streams Chinese, escaped newlines and quotes without displaying JSON or broken escapes', () => {
    const json = JSON.stringify({ answer: '明天\n完成“报告” "好" 😀', proposals: [] });
    expect(partialAnswer(json)).toBe('明天\n完成“报告” "好" 😀');
    expect(partialAnswer('{"answer":"你好\\u4f')).toBe('你好');
    expect(partialAnswer('{"answer":"你好\\')).toBe('你好');
    expect(partialAnswer('{"ans')).toBe('');
  });
  it('does not expose workbench records when context is disabled', () => {
    const record = buildDraftInserts([task()], emptyData)[0];
    const context = localContext(
      { ...emptyData, tasks: record.table === 'tasks' ? [record.record] : [] },
      false,
      '2026-11-15',
    );
    expect(context.today).toBe('2026-11-15');
    expect(JSON.stringify(context)).not.toContain('测试任务');
    expect(context.tables).toEqual({});
  });
  it('retains local draft status, bounds history, and carries image parts only on user messages', () => {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      role: 'user',
      text: '图片任务',
      attachments: [
        {
          id: 'a',
          name: 'test.png',
          kind: 'image',
          content: 'data:image/png;base64,eA==',
          bytes: 1,
        },
      ],
      proposals: [],
      draft_state: 'none',
      created_at: new Date().toISOString(),
    };
    const rows = wireMessages(Array.from({ length: 30 }, () => message));
    expect(rows).toHaveLength(24);
    expect(rows[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]),
    );
    expect(
      wireMessages([
        message,
        {
          ...message,
          role: 'assistant',
          attachments: [],
          proposals: [task()],
          draft_state: 'cancelled',
        },
      ])[1].content,
    ).toContain('cancelled');
  });
  it('keeps prose as prose over multiple turns and trims a leading orphan assistant', () => {
    const base = {
      id: 'a',
      conversation_id: 'c',
      attachments: [],
      proposals: [],
      draft_state: 'none' as const,
      created_at: 'now',
    };
    const messages: ChatMessage[] = [
      { ...base, role: 'user', text: '写一段小说' },
      { ...base, id: 'b', role: 'assistant', text: '门外传来三下敲门声。' },
      { ...base, id: 'd', role: 'user', text: '继续' },
    ];
    const rows = wireMessages(messages);
    expect(rows[1].content).toBe('门外传来三下敲门声。');
    expect(rows[2].role).toBe('user');
    expect(wireMessages(messages.slice(1))[0].role).toBe('user');
  });
  it('supplies the latest manual draft revision and keeps an explicitly focused old form', () => {
    const base = {
      conversation_id: 'c',
      role: 'assistant' as const,
      text: '草稿',
      attachments: [],
      proposals: [task()],
      draft_state: 'applied' as const,
      created_at: 'now',
    };
    const messages = Array.from({ length: 18 }, (_, i) => ({
      ...base,
      id: `m${i}`,
      draft_revision: i,
    }));
    const rows = draftSnapshots(messages, 'm0');
    expect(rows.length).toBeLessThanOrEqual(12);
    expect(rows.find((m) => m.id === 'm0')?.revision).toBe(0);
    const manual = {
      ...base,
      id: 'pending',
      draft_state: 'pending' as const,
      draft_revision: 9,
      proposals: [{ ...task(), title: '手动修改后的标题' }],
    };
    expect(draftSnapshots([...messages, manual]).find((m) => m.id === 'pending')).toMatchObject({
      revision: 9,
      proposals: [{ title: '手动修改后的标题' }],
    });
  });
});
