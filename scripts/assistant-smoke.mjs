// Runs on the real Tauri WebView2. Only uniquely named fixtures are changed.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const out = 'artifacts/assistant';
await mkdir(out, { recursive: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const marker = `Assistant QA ${crypto.randomUUID().slice(0, 8)}`;
const api = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { assistantRepository: r } = await import('/src/data/assistant.ts');
      return r[method](...args);
    },
    { method, args },
  );
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { repository: r } = await import('/src/data/repository.ts');
      return r[method](...args);
    },
    { method, args },
  );
const before = await repo('load');
await writeFile(`${out}/before-smoke.local.json`, JSON.stringify(before));
const conversation = {
  id: crypto.randomUUID(),
  title: marker,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
const today = await page.evaluate(async () => {
  const { localDate } = await import('/src/domain/dates.ts');
  return localDate();
});
const messages = [];
const addMessage = async (proposals, label) => {
  const m = {
    id: crypto.randomUUID(),
    conversation_id: conversation.id,
    role: 'assistant',
    text: `${label}：这是一组自动验收夹具，尚未写入业务数据。`,
    attachments: [],
    proposals,
    draft_state: 'pending',
    created_at: new Date().toISOString(),
  };
  await api('save', [m]);
  messages.push(m);
  return m;
};
const task = {
  key: 't1',
  type: 'task',
  title: `${marker} task`,
  notes: '',
  priority: 'medium',
  due_date: today,
  due_time: null,
  project_id: null,
  stage_id: null,
  inferred: '验收草稿，非真实 AI 回复',
};
const schedule = (key, period) => ({
  key,
  type: 'schedule',
  title: `${marker} plan`,
  notes: '',
  date: today,
  period,
  start_time: null,
  end_time: null,
  task_ref: 't1',
  inferred: '',
});
const rest = {
  key: 'r1',
  type: 'event',
  title: `${marker} rest`,
  notes: '',
  date: today,
  kind: 'rest',
  inferred: '建议日期，等待确认',
};
async function openAssistant() {
  if (!(await page.locator('[data-page="assistant"][data-present="true"]').count()))
    await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(650);
}
async function chooseConversation() {
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('button', { name: '总览', exact: true })
    .click();
  await page.waitForTimeout(600);
  await openAssistant();
  await page.getByRole('button', { name: marker, exact: true }).click();
  await page.getByLabel('待确认草稿').first().waitFor();
}
let keep = false;
try {
  await openAssistant();
  assert.equal(await page.locator('.assistant-visual canvas').count(), 1);
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
  await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill('帮我梳理今天的安排');
  assert.match(await page.getByRole('textbox', { name: '给 AI 助手的消息' }).inputValue(), /今天/);
  const glow = await page.locator('.assistant-composer').evaluate((el) => ({
    border: getComputedStyle(el).borderColor,
    shadow: getComputedStyle(el).boxShadow,
  }));
  assert.notEqual(glow.shadow, 'none');
  await page.getByRole('button', { name: 'API 与隐私设置', exact: true }).click();
  await page.getByRole('region', { name: 'DeepSeek API 设置' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '保存密钥', exact: true }).isDisabled(),
    true,
  );
  const configured = await api('configured');
  if (!configured) {
    await assert.rejects(() => api('test'), /设置 DeepSeek API Key/);
  }
  await page.screenshot({ path: `${out}/api-settings.png` });
  await page.getByRole('button', { name: '回到对话', exact: true }).click();
  const nativeAttachment = await api('readAttachment', [`${process.cwd()}/examples/generic.json`]);
  assert.equal(nativeAttachment.kind, 'text');
  await api('create', [conversation]);
  const cancelled = await addMessage([rest], '取消场景');
  const confirmed = await addMessage(
    [task, schedule('s1', 'morning'), schedule('s2', 'afternoon'), rest],
    '原子保存场景',
  );
  await chooseConversation();
  assert.deepEqual(await repo('load'), before, 'draft must not create data');
  const groups = page.getByLabel('待确认草稿');
  await groups.nth(0).getByRole('button', { name: '取消这组草稿', exact: true }).click();
  await page.getByText('已取消草稿，未创建记录', { exact: true }).waitFor();
  const group = page.getByLabel('待确认草稿');
  await group.getByRole('textbox', { name: '草稿 1 标题', exact: true }).fill(`${marker} edited`);
  await group.getByRole('button', { name: '确认并保存全部', exact: true }).click();
  await page.getByText('已保存到工作台', { exact: true }).waitFor();
  const after = await repo('load'),
    newTasks = after.tasks.filter((t) => t.title === `${marker} edited`);
  assert.equal(newTasks.length, 1);
  const linked = after.schedules.filter((s) => s.task_id === newTasks[0].id);
  assert.equal(linked.length, 2);
  assert(linked.every((s) => s.start_time === null));
  assert.equal(after.events.filter((e) => e.title === rest.title).length, 1);
  const persisted = await api('messages', [conversation.id]);
  assert.equal(persisted.find((m) => m.id === confirmed.id).draft_state, 'applied');
  assert.equal(persisted.find((m) => m.id === cancelled.id).draft_state, 'cancelled');
  assert.equal(
    await api('apply', [
      confirmed.id,
      [{ table: 'events', record: after.events.find((e) => e.title === rest.title) }],
    ]),
    0,
  );
  await page.screenshot({ path: `${out}/confirmed.png` });
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).waitFor();
  await openAssistant();
  await page.getByRole('button', { name: marker, exact: true }).click();
  await page.getByText('已保存到工作台', { exact: true }).waitFor();
  assert.equal(await page.getByText('已取消草稿，未创建记录', { exact: true }).count(), 1);
  // UI-only theme/accent preview: original persisted preferences are not changed.
  await page.getByRole('button', { name: '新的工作任务', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/${theme}.png` });
    const overflow = await page
      .locator('.assistant-layout')
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    assert.equal(overflow, false);
  }
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 568,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(400);
  if (await page.locator('.assistant-layout:not(.assistant-sidebar-collapsed)').count())
    await page.getByRole('button', { name: '收起助手侧栏', exact: true }).click();
  await page.waitForTimeout(600);
  assert(await page.getByRole('textbox', { name: '给 AI 助手的消息' }).isVisible());
  assert.equal(
    await page.locator('.assistant-composer').evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await page.screenshot({ path: `${out}/narrow.png` });
  await session.send('Emulation.clearDeviceMetricsOverride');
  await session.detach();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('button', { name: '设置', exact: true })
    .click();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('[data-page="assistant"][data-present="true"]').count(), 0);
  await page.keyboard.press('Control+j');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-page="assistant"][data-present="true"]').count(), 1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (let i = 0; i < 3; i++) {
    await page
      .getByRole('navigation', { name: '主要导航' })
      .getByRole('button', { name: '设置', exact: true })
      .click();
    await page.waitForTimeout(70);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(850);
  assert.equal(await page.locator('[data-page="assistant"][data-present="true"]').count(), 1);
  assert.deepEqual(errors, []);
  keep = process.env.ASSISTANT_KEEP_FIXTURE === '1';
  if (keep)
    await writeFile(
      `${out}/restart-fixture.local.json`,
      JSON.stringify({
        conversation,
        marker,
        taskId: newTasks[0].id,
        eventId: after.events.find((e) => e.title === rest.title).id,
        before,
      }),
    );
  console.log(
    JSON.stringify({
      passed: true,
      keptForRestart: keep,
      checks: [
        'native SQLite drafts, cancel, atomic confirmation, idempotence',
        'edited title, two fuzzy schedules linked to one task',
        'history reload, native attachment read, unconfigured error',
        'theme, 320px, focus, reduced motion, rapid page switching',
      ],
      pageErrors: errors,
    }),
  );
} finally {
  if (!keep) {
    const data = await repo('load');
    for (const t of data.tasks.filter((t) => t.title.startsWith(marker)))
      await repo('remove', ['tasks', t.id]);
    for (const e of data.events.filter((e) => e.title.startsWith(marker)))
      await repo('remove', ['events', e.id]);
    await api('remove', [conversation.id]);
    assert.deepEqual(await repo('load'), before);
  }
  await page.reload();
  await browser.close();
}
