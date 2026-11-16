import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
// Actual provider, entirely generic conversation/draft data. No local records
// are included and no messages or business records are inserted.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  page = browser.contexts()[0].pages()[0];
try {
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).waitFor();
  const results = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((s) => s.includes('/src/data/assistant.ts'));
    const { assistantRepository: a } = await import(url || '/src/data/assistant.ts');
    const { wireMessages, localContext, draftSnapshots, replySchema } = await import(
      '/src/domain/assistant.ts'
    );
    const empty = { projects: [], stages: [], tasks: [], schedules: [], events: [] },
      context = localContext(empty, false);
    const messages = [],
      results = [],
      marker = `验收${crypto.randomUUID().slice(0, 6)}`;
    window.__agentProviderResults = results;
    async function turn(label, text, event) {
      const stamp = new Date().toISOString();
      if (text)
        messages.push({
          id: crypto.randomUUID(),
          conversation_id: 'provider-only',
          role: 'user',
          text,
          attachments: [],
          proposals: [],
          draft_state: 'none',
          created_at: stamp,
        });
      const phases = [],
        start = performance.now();
      let chars = 0,
        first = null;
      const r = replySchema.parse(
        await a.chat(
          {
            id: crypto.randomUUID(),
            model: 'deepseek-flash',
            messages: wireMessages(messages),
            context,
            drafts: draftSnapshots(messages, event?.message_id),
            action_event: event,
          },
          (chunk) => {
            chars += chunk.length;
            first ??= performance.now() - start;
          },
          (p) => phases.push(p),
        ),
      );
      const row = {
        id: crypto.randomUUID(),
        conversation_id: 'provider-only',
        role: 'assistant',
        text: r.answer,
        attachments: [],
        proposals: r.draft_action === 'create' ? r.proposals : [],
        draft_state: r.draft_action === 'create' && r.proposals.length ? 'pending' : 'none',
        draft_revision: 0,
        created_at: new Date().toISOString(),
      };
      messages.push(row);
      if (r.draft_action === 'replace') {
        const target = messages.find((m) => m.id === r.target_id);
        if (!target) throw new Error('Unknown replacement target');
        target.proposals = r.proposals;
        target.draft_revision++;
      } else if (r.draft_action === 'cancel') {
        const target = messages.find((m) => m.id === r.target_id);
        if (!target) throw new Error('Unknown cancellation target');
        target.draft_state = 'cancelled';
        target.draft_revision++;
      }
      results.push({
        label,
        intent: r.intent,
        action: r.draft_action,
        length: r.answer.length,
        streamedChars: chars,
        phases,
        firstTextMs: Math.round(first ?? 0),
        totalMs: Math.round(performance.now() - start),
        draftError: r.draft_error,
        proposals: r.proposals,
        sample: r.answer.slice(0, 100),
      });
      return { r, row };
    }
    await turn('long prose', '写一篇约3000字的中文悬疑小说，主角叫林舟，直接给正文，不创建任务。');
    await turn('followup', '用80字解释刚才故事的悬念，并保留主角名字。');
    const { row: group } = await turn(
      'prepare',
      `创建任务：${marker}报告，2026-11-22截止；安排2026-11-18下午整理报告，先给待确认表单。`,
    );
    if (group.draft_state !== 'pending') throw new Error('No initial draft');
    const task = group.proposals.find((p) => p.type === 'task');
    if (!task) throw new Error('No task');
    task.title = `${marker}手动改名`;
    task.notes = '这是手动填写的备注，调整其它字段时必须保留';
    group.draft_revision++;
    const { r: refined } = await turn(
      'refine manual',
      `把${marker}手动改名这组草稿的执行安排改到2026-11-19上午，截止日期和手动备注保持不变。`,
    );
    const edited = refined.proposals.find((p) => p.type === 'task');
    if (!edited?.notes.includes('手动填写')) throw new Error('Manual note lost');
    const schedule = refined.proposals.find((p) => p.type === 'schedule');
    if (schedule?.date !== '2026-11-19' || schedule.period !== 'morning')
      throw new Error('Schedule was not refined');
    await turn('chat while waiting', '先讲一个简短笑话，不改动任何草稿。');
    await turn(
      'review current',
      '刚才手动改名任务的截止日期、执行时间和备注现在分别是什么？先不要修改。',
    );
    const { row: eventGroup } = await turn(
      'mixed',
      `写一份100字会议通知，同时另外准备2026-11-23的重要事件“${marker}会议”，不要修改之前的报告草稿。`,
    );
    if (eventGroup.draft_state !== 'pending' || !eventGroup.proposals.length)
      throw new Error('Mixed request did not produce an event form');
    await turn('cancel via chat', `取消${marker}手动改名那组报告草稿，会议草稿保持不变。`);
    eventGroup.draft_state = 'applied';
    eventGroup.draft_revision++;
    await turn('verified action', null, { kind: 'applied', message_id: eventGroup.id, count: 1 });
    return results;
  });
  assert(results[0].length > 2000 && results[0].action === 'none');
  assert.equal(results[2].action, 'create');
  assert.equal(results[3].action, 'replace');
  assert.equal(results[4].action, 'none');
  assert.equal(results[5].action, 'none');
  assert.equal(results[6].action, 'create');
  assert.equal(results[7].action, 'cancel');
  assert.deepEqual(results[8].phases, ['answering']);
  assert(results.every((r) => !r.draftError));
  await mkdir('artifacts/agent-provider', { recursive: true });
  await writeFile('artifacts/agent-provider/result.json', JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify(
      results.map(({ proposals, ...r }) => r),
      null,
      2,
    ),
  );
} catch (error) {
  const progress = await page.evaluate(() => window.__agentProviderResults ?? []).catch(() => []);
  await mkdir('artifacts/agent-provider', { recursive: true });
  await writeFile('artifacts/agent-provider/failure.json', JSON.stringify(progress, null, 2));
  console.log(
    JSON.stringify(
      progress.map(({ proposals, ...r }) => r),
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
