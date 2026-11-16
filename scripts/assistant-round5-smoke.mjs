import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const out = 'artifacts/assistant-round5';
await mkdir(out, { recursive: true });
const errors = [];
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
const business = () =>
  page.evaluate(async () => (await import('/src/data/repository.ts')).repository.load());
const marker = `Round5 ${crypto.randomUUID().slice(0, 8)}`,
  ids = [];
const chat = () => page.locator('[data-view="assistant-chat"][data-present="true"]');
const thread = () => chat().locator('.assistant-thread-switch > [data-present="true"]');
const input = () => chat().getByRole('textbox', { name: '给 AI 助手的消息' });
const orb = () => page.locator('.strands-container');
const select = async (name) => {
  if (name !== '新的工作任务') return page.getByRole('button', { name, exact: true }).click();
  const previous = new Set((await ai('conversations')).map((c) => c.id));
  await page.locator('.assistant-new').click();
  const created = (await ai('conversations')).filter((c) => !previous.has(c.id));
  ids.push(...created.map((c) => c.id));
};
const report = {};
let before, original;
try {
  await page.reload();
  await select('打开 AI 助手');
  await page.waitForTimeout(1100);
  before = await business();
  original = await ai('conversations');
  for (let i = 0; i < 2; i++) {
    const id = crypto.randomUUID(),
      stamp = new Date(Date.now() - 10000 + i * 1000).toISOString();
    ids.push(id);
    await ai('create', [{ id, title: `${marker} ${i}`, created_at: stamp, updated_at: stamp }]);
    await ai('save', [
      {
        id: crypto.randomUUID(),
        conversation_id: id,
        role: 'user',
        text: `${marker} message ${i}`,
        attachments: [],
        proposals: [],
        draft_state: 'none',
        created_at: stamp,
      },
    ]);
  }
  await page.reload();
  await select('打开 AI 助手');
  await page.waitForTimeout(1100);
  const idle = Number(await orb().getAttribute('data-activity'));
  const frameA = await page.locator('.assistant-visual').screenshot();
  await page.waitForTimeout(700);
  const frameB = await page.locator('.assistant-visual').screenshot();
  assert(!frameA.equals(frameB), 'Idle orb must actually flow.');
  await input().focus();
  await page.waitForTimeout(900);
  const focused = Number(await orb().getAttribute('data-activity'));
  assert(focused > idle + 0.1);
  await input().pressSequentially('typing', { delay: 80 });
  assert.equal(await orb().getAttribute('data-last-pulse'), 'scale');
  assert(Number(await orb().getAttribute('data-pulse')) > 0);
  assert(Math.abs(Number(await orb().getAttribute('data-activity')) - focused) < 0.003);
  report.orb = { idle, focused, nativePulseOnly: true, idleChangesFrame: true };
  await page.evaluate(() => (window.__composer = document.querySelector('.assistant-composer')));
  await select(`${marker} 1`);
  await page.waitForTimeout(850);
  await select(`${marker} 0`);
  await thread().getByText(`${marker} message 0`, { exact: true }).waitFor();
  assert.equal(await thread().getAttribute('data-axis'), 'y');
  assert(
    await page.evaluate(() => window.__composer === document.querySelector('.assistant-composer')),
  );
  assert.equal(
    await page
      .locator('.assistant-composer')
      .evaluate((el) => el.closest('[data-view]').dataset.view),
    'assistant-chat',
  );
  await page.waitForTimeout(850);
  await select('新的工作任务');
  await page.waitForTimeout(900);
  const composerBox = await page.locator('.assistant-composer').boundingBox();
  const emptyKey = await thread().getAttribute('data-view');
  await select('新的工作任务');
  await page.waitForTimeout(850);
  assert.equal(await thread().getAttribute('data-view'), emptyKey);
  assert.equal(await chat().locator('.view-switch-pane[data-present="false"]').count(), 0);
  assert.deepEqual(await page.locator('.assistant-composer').boundingBox(), composerBox);
  assert.equal(ids.length, 4);
  report.switching = { persistentComposer: true, emptyToEmptyNoTransition: true };
  const cube = page.locator('.assistant-caption-cube'),
    captionHeight = await cube.evaluate((el) => el.clientHeight);
  await chat().getByRole('checkbox', { name: '读取本地工作台数据' }).click();
  await page.waitForTimeout(70);
  assert.equal(await cube.locator('p').count(), 2);
  assert(
    await cube
      .locator('p')
      .last()
      .evaluate((el) => getComputedStyle(el).transform.startsWith('matrix3d')),
  );
  await page.waitForTimeout(650);
  assert.equal(await cube.locator('p').count(), 1);
  assert.equal(await cube.evaluate((el) => el.clientHeight), captionHeight);
  assert((await cube.textContent()).includes('不发送工作台数据'));
  const options = page.getByRole('button', { name: `对话选项 ${marker} 0`, exact: true });
  await options.click({ force: true });
  const menu = page.locator('.assistant-history-menu:popover-open');
  await menu.waitFor();
  const anchorBox = await options.boundingBox(),
    menuBox = await menu.boundingBox();
  assert(Math.abs(menuBox.x - anchorBox.x) < 2);
  await menu.getByRole('menuitem', { name: '删除对话' }).click();
  await page.getByRole('alertdialog', { name: '确认删除对话' }).waitFor();
  await menu.getByRole('button', { name: '取消', exact: true }).click();
  await page.waitForTimeout(60);
  assert.equal(await menu.count(), 1);
  await page.waitForTimeout(400);
  assert.equal(await menu.count(), 0);
  report.chrome = { captionCube: true, anchoredMoreMenu: true, animatedMenuExit: true };
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((s) => s.includes('/src/data/assistant.ts'));
    const { assistantRepository: a } = await import(url);
    a.configured = async () => true;
    a.chat = async (_request, delta) =>
      new Promise((resolve) => {
        window.__round5Partial = () => delta('{"answer":"输出中的内容');
        window.__round5Finish = () => resolve({ answer: '输出结束。', proposals: [] });
      });
  });
  const nav = page.getByRole('navigation', { name: '主要导航' });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(100);
  await nav.getByRole('button', { name: '工作台助手', exact: true }).click();
  await page.waitForTimeout(900);
  await input().fill(`${marker} send`);
  await page.waitForTimeout(100);
  const welcome = page.locator('.assistant-welcome-layer'),
    welcomeBox = await welcome.boundingBox();
  await select('发送消息');
  await page.locator('.thought-line').waitFor();
  const fadedBox = await welcome.boundingBox();
  assert.equal(fadedBox.y, welcomeBox.y);
  const welcomeOpacity = Number(await welcome.evaluate((el) => getComputedStyle(el).opacity));
  assert(welcomeOpacity > 0 && welcomeOpacity < 1);
  assert(await welcome.evaluate((el) => el.parentElement === document.body));
  assert(
    await page
      .getByRole('button', { name: `${marker} 1`, exact: true })
      .evaluate((el) => getComputedStyle(el).opacity === '1'),
  );
  await page.waitForTimeout(950);
  assert.equal(await orb().getAttribute('data-wave'), 'right-to-left');
  const thinking = await orb().getAttribute('data-appearance');
  await page.screenshot({ path: `${out}/thinking.png` });
  await page.evaluate(() => window.__round5Partial());
  await thread().getByText('输出中的内容', { exact: true }).waitFor();
  await page.waitForTimeout(850);
  assert.equal(await orb().getAttribute('data-appearance'), thinking);
  assert.equal(await page.locator('.thought-line').count(), 0);
  await page.evaluate(() => window.__round5Finish());
  await thread().getByText('输出结束。', { exact: true }).waitFor();
  await page.waitForTimeout(900);
  report.response = {
    thoughtLine: true,
    thinkingAndOutputSameWave: true,
    welcomeFadesInPlace: true,
    historyUndimmed: true,
  };
  await page.screenshot({ path: `${out}/conversation.png` });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 568,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(900);
  if (await page.getByRole('button', { name: '收起助手侧栏', exact: true }).count())
    await select('收起助手侧栏');
  await page.waitForTimeout(900);
  assert(
    await page.locator('.assistant-composer').evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.screenshot({ path: `${out}/narrow.png` });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await input().focus();
  const pulses = await orb().getAttribute('data-pulses');
  await input().pressSequentially('test');
  assert.equal(await orb().getAttribute('data-pulses'), pulses);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.deepEqual(await business(), before);
  assert.deepEqual(errors, []);
  report.passed = true;
  await writeFile(`${out}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  for (const id of ids) await ai('remove', [id]);
  if (original) assert.deepEqual(await ai('conversations'), original);
  if (before) assert.deepEqual(await business(), before);
  await page.reload();
  await select('打开 AI 助手');
  await page.waitForTimeout(1000);
  await browser.close();
}
