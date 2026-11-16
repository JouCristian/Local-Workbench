import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const out = 'artifacts/agent-ui';
await mkdir(out, { recursive: true });
const marker = `AgentUI ${crypto.randomUUID().slice(0, 8)}`,
  id = crypto.randomUUID(),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const ai = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((s) => s.includes('/src/data/assistant.ts'));
      return (await import(url || '/src/data/assistant.ts')).assistantRepository[method](...args);
    },
    { method, args },
  );
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) =>
      (await import('/src/data/repository.ts')).repository[method](...args),
    { method, args },
  );
const input = () =>
  page
    .locator('[data-view="assistant-chat"][data-present="true"]')
    .getByRole('textbox', { name: '给 AI 助手的消息' });
const settled = async () => {
  await page.waitForTimeout(150);
  await page.waitForFunction(() => !document.querySelector('button[aria-label="停止生成"]'));
};
const send = async (text) => {
  await input().fill(text);
  await input().press('Enter');
  await settled();
};
const install = async (marker) => {
  const url = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((s) => s.includes('/src/data/assistant.ts'));
  const { assistantRepository: a } = await import(url),
    { proposalSchema } = await import('/src/domain/assistant.ts');
  window.__agentRequests = [];
  a.configured = async () => true;
  a.chat = async (req, delta, phase) => {
    window.__agentRequests.push(structuredClone(req));
    phase?.('understanding');
    await new Promise((r) => setTimeout(r, 60));
    const empty = {
      answer: '正常回复。',
      proposals: [],
      draft_action: 'none',
      intent: 'chat',
      target_id: null,
      expected_revision: null,
      draft_error: '',
    };
    const latest = req.messages.at(-1)?.content,
      text =
        typeof latest === 'string'
          ? latest
          : (latest
              ?.filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('\n') ?? '');
    let result = { ...empty };
    if (req.action_event) {
      if (window.__agentEventOffline) throw new Error('测试：反馈时断网');
      const d = req.drafts.find((d) => d.id === req.action_event.message_id);
      if (d?.state !== req.action_event.kind)
        throw new Error('Event did not carry latest local state');
      result.answer = `已根据本地结果确认：${req.action_event.kind}，${req.action_event.count}项。`;
    } else if (text.includes('agent:create') || text.includes('agent:new-')) {
      phase?.('drafting');
      const suffix = text.includes('agent:create') ? '初次任务' : text.split('agent:new-')[1];
      const task = proposalSchema.parse({
        key: 't1',
        type: 'task',
        title: `${marker} ${suffix}`,
        due_date: '2026-11-22',
      });
      result = {
        ...empty,
        intent: 'prepare',
        draft_action: 'create',
        answer: '正文直接包含“引号”和 {，下面是待确认表单。',
        proposals: text.includes('agent:create')
          ? [
              task,
              proposalSchema.parse({
                key: 's1',
                type: 'schedule',
                title: `${marker} 执行安排`,
                date: '2026-11-18',
                period: 'afternoon',
                task_ref: 't1',
              }),
            ]
          : [task],
      };
    } else if (text.includes('agent:refine') || text.includes('agent:stale')) {
      phase?.('drafting');
      const d = req.drafts.find((d) => d.state === 'pending');
      const proposals = structuredClone(d.proposals).map((p) =>
        p.type === 'task'
          ? { ...p, priority: 'high' }
          : { ...p, date: '2026-11-19', period: 'morning' },
      );
      if (text.includes('agent:stale'))
        await a.updateDraft(
          d.id,
          d.proposals.map((p) =>
            p.type === 'task' ? { ...p, notes: '来自另一个窗口的最新备注' } : p,
          ),
          d.revision,
        );
      result = {
        ...empty,
        intent: 'refine',
        draft_action: 'replace',
        answer: '已准备调整原草稿。',
        proposals,
        target_id: d.id,
        expected_revision: d.revision,
      };
    } else if (text.includes('检查当前这组')) {
      const d = req.drafts.find((d) => d.state === 'pending');
      result.answer = `读取最新备注：${d.proposals[0].notes}`;
    } else if (text.includes('agent:bad')) {
      result = {
        ...empty,
        intent: 'prepare',
        draft_action: 'create',
        answer: '表单即使出错，这段正文也应保留。',
        proposals: [
          proposalSchema.parse({
            key: 'bad',
            type: 'task',
            title: `${marker} bad`,
            due_date: '2026-02-30',
          }),
        ],
      };
    } else if (text.includes('agent:cancel')) {
      const d = req.drafts.find((d) => d.state === 'pending');
      result = {
        ...empty,
        intent: 'cancel',
        draft_action: 'cancel',
        target_id: d.id,
        expected_revision: d.revision,
        answer: '将取消指定草稿。',
      };
    } else if (text.includes('agent:partial')) {
      phase?.('answering');
      delta('第一段已经收到。\n引号“”和未闭合 { 都属于正常正文。');
      throw new Error('测试：输出连接中断');
    } else if (text.includes('从上一条未完成')) result.answer = '从断点继续的正文。';
    phase?.('answering');
    delta(result.answer);
    return result;
  };
};
let before, history;
const report = {};
try {
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(1000);
  before = await repo('load');
  history = await ai('conversations');
  const stamp = new Date().toISOString();
  await ai('create', [{ id, title: marker, created_at: stamp, updated_at: stamp }]);
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator(`[data-conversation-id="${id}"] > button:first-child`).click();
  await page.waitForTimeout(850);
  await page.evaluate(install, marker);
  const nav = page.getByRole('navigation', { name: '主要导航' });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(80);
  await nav.getByRole('button', { name: '工作台助手', exact: true }).click();
  await page.waitForTimeout(900);
  await send('agent:create');
  let rows = await ai('messages', [id]);
  const group = rows.find((m) => m.draft_state === 'pending');
  assert(group);
  const form = () => page.locator(`[data-message-id="${group.id}"]`);
  assert.equal(await page.getByLabel('待确认草稿', { exact: true }).count(), 1);
  assert.equal((await repo('load')).tasks.length, before.tasks.length);
  await form()
    .getByRole('textbox', { name: '草稿 1 标题', exact: true })
    .fill(`${marker} 手动标题`);
  await form().getByRole('textbox', { name: '草稿 1 备注', exact: true }).fill('手动备注应保留');
  await send('agent:refine');
  rows = await ai('messages', [id]);
  let current = rows.find((m) => m.id === group.id);
  assert.equal(current.proposals[0].title, `${marker} 手动标题`);
  assert.equal(current.proposals[0].notes, '手动备注应保留');
  assert.equal(current.proposals[0].priority, 'high');
  assert.equal(current.proposals[1].period, 'morning');
  assert.equal(rows.filter((m) => m.draft_state === 'pending').length, 1);
  await form().getByRole('button', { name: '让助手检查这组草稿', exact: true }).click();
  await settled();
  assert((await ai('messages', [id])).at(-1).text.includes('手动备注应保留'));
  await send('agent:bad');
  rows = await ai('messages', [id]);
  assert.equal(rows.at(-1).text, '表单即使出错，这段正文也应保留。');
  assert(rows.at(-1).notice.includes('表单未更新'));
  assert.equal(rows.filter((m) => m.draft_state === 'pending').length, 1);
  await send('agent:stale');
  rows = await ai('messages', [id]);
  current = rows.find((m) => m.id === group.id);
  assert.equal(current.proposals[0].notes, '来自另一个窗口的最新备注');
  assert(rows.at(-1).notice.includes('草稿已变化'));
  report.drafts = {
    manualFieldsPreserved: true,
    latestRevisionReviewed: true,
    updatesInPlace: true,
    invalidFormKeepsProse: true,
    staleReplyRejected: true,
  };
  await form().getByRole('button', { name: '确认并保存全部', exact: true }).click();
  await settled();
  await page.waitForTimeout(250);
  const business = await repo('load');
  const task = business.tasks.find((t) => t.title === `${marker} 手动标题`);
  assert(task);
  const schedule = business.schedules.find((s) => s.task_id === task.id);
  assert(schedule);
  assert.equal(schedule.period, 'morning');
  assert.equal(schedule.start_time, null);
  rows = await ai('messages', [id]);
  assert.equal(rows.find((m) => m.id === group.id).draft_state, 'applied');
  assert(rows.at(-1).text.includes('applied，2项'));
  await send('agent:new-chatcancel');
  await send('agent:cancel');
  rows = await ai('messages', [id]);
  assert.equal(rows.filter((m) => m.draft_state === 'pending').length, 0);
  await send('agent:new-buttoncancel');
  const buttonGroup = (await ai('messages', [id])).find((m) => m.draft_state === 'pending');
  await page
    .locator(`[data-message-id="${buttonGroup.id}"]`)
    .getByRole('button', { name: '取消这组草稿', exact: true })
    .click();
  await settled();
  rows = await ai('messages', [id]);
  assert.equal(rows.find((m) => m.id === buttonGroup.id).draft_state, 'cancelled');
  assert(rows.at(-1).text.includes('cancelled，0项'));
  report.actions = {
    actualTaskAndScheduleSaved: true,
    confirmedFactsFedBack: true,
    cancelByChat: true,
    cancelByButton: true,
  };
  await send('agent:partial');
  rows = await ai('messages', [id]);
  const partial = rows.at(-1);
  assert.equal(partial.response_status, 'partial');
  assert(partial.text.includes('未闭合 {'));
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator(`[data-conversation-id="${id}"] > button:first-child`).click();
  await page.waitForTimeout(850);
  await page.evaluate(install, marker);
  assert.equal(
    (await ai('messages', [id])).find((m) => m.id === partial.id).response_status,
    'partial',
  );
  await page
    .locator(`[data-message-id="${partial.id}"]`)
    .getByRole('button', { name: '从这里继续', exact: true })
    .click();
  await settled();
  assert.equal((await ai('messages', [id])).at(-1).text, '从断点继续的正文。');
  await send('agent:new-offline');
  const offline = (await ai('messages', [id])).find((m) => m.draft_state === 'pending');
  await page.evaluate(() => (window.__agentEventOffline = true));
  await page
    .locator(`[data-message-id="${offline.id}"]`)
    .getByRole('button', { name: '确认并保存全部', exact: true })
    .click();
  await settled();
  assert.equal(
    (await ai('messages', [id])).find((m) => m.id === offline.id).draft_state,
    'applied',
  );
  assert((await repo('load')).tasks.some((t) => t.title === `${marker} offline`));
  assert((await page.locator('.assistant-error').textContent()).includes('操作已在本地完成'));
  report.recovery = {
    partialTextPersists: true,
    continueAfterReload: true,
    feedbackFailureDoesNotUndoLocalSave: true,
  };
  await page.screenshot({ path: `${out}/agent.png` });
  assert.deepEqual(errors, []);
  report.passed = true;
  await writeFile(`${out}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  const data = await repo('load');
  for (const table of ['schedules', 'events', 'tasks'])
    for (const row of data[table].filter((r) => r.title.startsWith(marker)))
      await repo('remove', [table, row.id]);
  await ai('remove', [id]);
  if (history)
    assert(
      JSON.stringify(await ai('conversations')) === JSON.stringify(history),
      'Original conversations changed',
    );
  if (before)
    assert(
      JSON.stringify(await repo('load')) === JSON.stringify(before),
      'Original business records changed',
    );
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(900);
  await browser.close();
}
