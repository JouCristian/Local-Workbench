import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  changedFields,
  latestPresentation,
  operationPresentations,
  replacementTarget,
  type AgentOperation,
  type OperationItem,
  type OperationPresentation,
} from '../src/domain/agent';
import { MarkdownMessage } from '../src/components/assistant/MarkdownMessage';

describe('agent operation previews', () => {
  it('moves only the display entry, falls back for old data, and follows replacement chains', () => {
    const op = { id: 'a', message_id: 'original', revision: 2 } as AgentOperation;
    const views: OperationPresentation[] = [
      { operation_id: 'a', message_id: 'latest', sequence: 9, revision: 2, reason: 'present' },
      { operation_id: 'b', message_id: 'unrelated', sequence: 12, revision: 0, reason: 'create' },
      { operation_id: 'a', message_id: 'original', sequence: 1, revision: 0, reason: 'create' },
    ];
    expect(latestPresentation(op, []).message_id).toBe('original');
    expect(latestPresentation(op, views).message_id).toBe('latest');
    expect(operationPresentations(op, views).map((p) => p.message_id)).toEqual([
      'original',
      'latest',
    ]);
    expect(views[0].sequence).toBe(9);
    expect(
      replacementTarget({ ...op, superseded_by: 'b' }, [
        { ...op, superseded_by: 'b' },
        { ...op, id: 'b', superseded_by: 'c' },
        { ...op, id: 'c' },
      ]),
    ).toBe('c');
  });
  it('shows only intended business changes and preserves the deadline time', () => {
    const item = {
      action: 'update',
      before: { title: '报告', due_date: '2026-11-15', due_time: '23:59', updated_at: 'old' },
      after: { title: '报告', due_date: '2026-11-17', due_time: '23:59', updated_at: 'new' },
    } as unknown as OperationItem;
    expect(changedFields(item)).toEqual(['due_date']);
  });
});
describe('assistant Markdown', () => {
  it('renders GFM headings, bold, lists, tables and fenced code', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        text={
          '## 结果\n\n**报告**\n\n- 第一项\n- 第二项\n\n|任务|日期|\n|---|---|\n|报告|明天|\n\n```ts\nconst x = 1;\n```'
        }
      />,
    );
    for (const tag of ['<h2>', '<strong>', '<ul>', '<table>', '<pre>', '<code'])
      expect(html).toContain(tag);
    expect(html).toContain('复制代码');
  });
  it('does not execute raw HTML, scripts, javascript links or load remote images', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        text={
          '<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n![外部图片](https://example.com/tracker.png)'
        }
      />,
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
  });
});
