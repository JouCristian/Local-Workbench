import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const out = 'artifacts/round4';
await mkdir(out, { recursive: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { repository: r } = await import('/src/data/repository.ts');
      return r[method](...args);
    },
    { method, args },
  );
const ai = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { assistantRepository: r } = await import('/src/data/assistant.ts');
      return r[method](...args);
    },
    { method, args },
  );
const nav = (name) =>
  page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('button', { name, exact: true })
    .click();
const before = await repo('load'),
  ids = { tasks: [], schedules: [] },
  marker = `Round4 ${crypto.randomUUID().slice(0, 8)}`,
  stamp = new Date().toISOString();
let conversation = null;
const today = await page.evaluate(async () => {
  const { localDate } = await import('/src/domain/dates.ts');
  return localDate();
});
const task = async (name) => {
  const t = {
    id: crypto.randomUUID(),
    title: `${marker} ${name}`,
    notes: '',
    status: 'todo',
    priority: 'medium',
    due_date: today,
    due_time: null,
    project_id: null,
    stage_id: null,
    archived_at: null,
    created_at: stamp,
    updated_at: stamp,
  };
  ids.tasks.push(t.id);
  await repo('save', ['tasks', t]);
  return t;
};
const plan = async (t, title, date, period) => {
  const s = {
    id: crypto.randomUUID(),
    title: `${marker} ${title}`,
    notes: '',
    task_id: t?.id ?? null,
    date,
    period,
    start_time: null,
    end_time: null,
    created_at: stamp,
    updated_at: stamp,
    completed_at: null,
  };
  ids.schedules.push(s.id);
  await repo('save', ['schedules', s]);
  return s;
};
const check = (id) => page.locator(`[data-agenda-key="schedule-${id}"] .check-button`);
try {
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(1100);
  const bounds = await page.locator('.assistant-layout').boundingBox(),
    area = await page.locator('.workspace-scroll').boundingBox();
  for (const k of ['x', 'y', 'width', 'height']) assert(Math.abs(bounds[k] - area[k]) < 2);
  const shot1 = await page.locator('.assistant-visual').screenshot();
  await page.waitForTimeout(800);
  const shot2 = await page.locator('.assistant-visual').screenshot();
  assert(!shot1.equals(shot2), 'idle Strands must keep moving');
  const input = page.getByRole('textbox', { name: '给 AI 助手的消息' });
  await input.pressSequentially('abc', { delay: 70 });
  assert(Number(await page.locator('.strands-container').getAttribute('data-pulses')) >= 3);
  await page.getByRole('combobox', { name: '助手模型', exact: true }).click();
  await page.waitForTimeout(260);
  assert.equal(
    await page.locator('.assistant-composer').evaluate((el) => getComputedStyle(el).boxShadow),
    'none',
  );
  await page.keyboard.press('Escape');
  await input.fill('');
  await page.getByRole('button', { name: 'API 与隐私设置', exact: true }).click();
  await page.waitForTimeout(90);
  const apiPane = page.locator('[data-view="assistant-api"][data-present="true"]');
  assert.equal(await apiPane.getAttribute('data-axis'), 'x');
  assert.equal(await apiPane.getAttribute('data-direction'), '1');
  await page.waitForTimeout(800);
  const back = page.getByRole('button', { name: '回到对话', exact: true });
  assert((await back.boundingBox()).x > bounds.x + bounds.width / 2);
  await back.click();
  await page.waitForTimeout(90);
  assert.equal(
    await page
      .locator('[data-view="assistant-chat"][data-present="true"]')
      .getAttribute('data-direction'),
    '-1',
  );
  await page.waitForTimeout(850);
  assert.equal(
    await page
      .getByRole('button', { name: 'API 与隐私设置', exact: true })
      .evaluate((el) => getComputedStyle(el).borderRadius),
    '6px',
  );
  // Controlled provider fixture for thinking visuals only; never contacts a real API or saves a key.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((x) => x.name)
      .find((x) => x.includes('/src/data/assistant.ts'));
    const { assistantRepository: a } = await import(url);
    window.__aiOriginal = { configured: a.configured, chat: a.chat };
    a.configured = async () => true;
    a.chat = async () =>
      new Promise(
        (resolve) =>
          (window.__resolveThinking = () =>
            resolve({ answer: 'UI 验收结束；未创建业务记录。', proposals: [] })),
      );
  });
  await nav('设置');
  await page.waitForTimeout(100);
  await nav('工作台助手');
  await page.waitForTimeout(850);
  await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill(marker);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.lattice-loader').waitFor();
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('.strands-container').getAttribute('data-form'), 'sphere');
  assert(Number(await page.locator('.strands-container').getAttribute('data-morph')) > 0.99);
  await page.screenshot({ path: `${out}/thinking.png` });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(2200);
  await page.evaluate(() => window.__resolveThinking());
  await page.getByText('UI 验收结束；未创建业务记录。', { exact: true }).waitFor();
  conversation = (await ai('conversations')).find((c) => c.title === marker);
  assert(conversation);
  await page.waitForTimeout(950);
  assert.equal(await page.locator('.strands-container').getAttribute('data-form'), 'sphere');
  assert(Number(await page.locator('.strands-container').getAttribute('data-morph')) > 0.99);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((x) => x.name)
      .find((x) => x.includes('/src/data/assistant.ts'));
    const { assistantRepository: a } = await import(url);
    Object.assign(a, window.__aiOriginal);
  });
  const multi = await task('multi'),
    single = await task('single');
  const a = await plan(multi, 'A', today, 'morning'),
    b = await plan(multi, 'B', today, 'afternoon'),
    c = await plan(multi, 'C', today, 'evening'),
    d = await plan(single, 'single', today, 'anytime'),
    solo = await plan(null, 'solo', today, 'anytime');
  await page.reload();
  await nav('日程');
  await page.waitForTimeout(900);
  await check(a.id).click();
  let dialog = page.getByRole('dialog', { name: '完成本次日程', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(230);
  assert.equal((await repo('load')).schedules.find((s) => s.id === a.id).completed_at, null);
  await check(a.id).click();
  await dialog.getByRole('button', { name: '仅完成本次日程', exact: true }).click();
  await page.waitForTimeout(650);
  let data = await repo('load');
  assert(data.schedules.find((s) => s.id === a.id).completed_at);
  assert.equal(data.tasks.find((t) => t.id === multi.id).status, 'todo');
  assert(data.schedules.filter((s) => [b.id, c.id].includes(s.id)).every((s) => !s.completed_at));
  assert(await check(b.id).isVisible());
  await check(d.id).click();
  await dialog.getByRole('button', { name: '仅完成本次日程', exact: true }).click();
  await page.waitForTimeout(600);
  data = await repo('load');
  assert.equal(data.tasks.find((t) => t.id === single.id).status, 'todo');
  await check(b.id).click();
  await dialog.getByRole('button', { name: '同时完成任务', exact: true }).click();
  await page.waitForTimeout(650);
  data = await repo('load');
  assert.equal(data.tasks.find((t) => t.id === multi.id).status, 'done');
  assert.equal(data.schedules.find((s) => s.id === c.id).completed_at, null);
  assert(await check(c.id).isVisible());
  await check(solo.id).click();
  await page.waitForTimeout(600);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert((await repo('load')).schedules.find((s) => s.id === solo.id).completed_at);
  await page.getByLabel('显示已完成', { exact: true }).check();
  await page.waitForTimeout(250);
  await check(b.id).click();
  await page.waitForTimeout(600);
  data = await repo('load');
  assert.equal(data.schedules.find((s) => s.id === b.id).completed_at, null);
  assert.equal(data.tasks.find((t) => t.id === multi.id).status, 'done');
  const snapshot = await repo('snapshot');
  assert(snapshot.schedules.find((s) => s.id === a.id).completed_at);
  await page.reload();
  await nav('日程');
  await page.waitForTimeout(900);
  await page.getByLabel('显示已完成', { exact: true }).check();
  await page.waitForTimeout(250);
  assert.equal(await check(a.id).getAttribute('aria-pressed'), 'true');
  await page.screenshot({ path: `${out}/execution-completion.png` });
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/result.json`,
    JSON.stringify(
      {
        passed: true,
        checks: [
          'full workspace, transient composer focus, API direction both ways',
          'idle motion, typing impulses, continuous sphere morph, theme Lattice Loader (controlled provider fixture)',
          'multi/single/unlinked schedule completion, cancellation, explicit task completion, independent reopen, SQLite reload',
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log('Round 4 desktop and real SQLite acceptance passed.');
} finally {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Only the UUIDs created above are removed. Keychain and user records are untouched.
  for (const id of ids.tasks) await repo('remove', ['tasks', id]);
  for (const id of ids.schedules) await repo('remove', ['schedules', id]);
  for (const c of (await ai('conversations')).filter((c) => c.title === marker))
    await ai('remove', [c.id]);
  assert.deepEqual(await repo('load'), before);
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(850);
  await browser.close();
}
