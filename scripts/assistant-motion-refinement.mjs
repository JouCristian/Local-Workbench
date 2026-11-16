import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// Exercise the real desktop/SQLite. Provider output is controlled locally, and
// only conversations created by this run are removed in finally.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const out = 'artifacts/assistant-motion-refinement';
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
      const { assistantRepository: a } = await import(url || '/src/data/assistant.ts');
      return a[method](...args);
    },
    { method, args },
  );
const business = () =>
  page.evaluate(async () => (await import('/src/data/repository.ts')).repository.load());
const chat = () =>
  page.locator('.assistant-view-switch > [data-present="true"][data-view^="assistant-chat:"]');
const input = () => chat().getByRole('textbox', { name: '给 AI 助手的消息' });
const orb = () => page.locator('.assistant-artwork-node .strands-container');
const marker = `Motion QA ${crypto.randomUUID().slice(0, 8)}`;
const ids = [];
let before, original;
const report = {};
const watch = async () =>
  page.evaluate(() => {
    window.__frames = [];
    const start = performance.now();
    const sample = () => {
      const workspace = document.querySelector('.workspace-scroll');
      const composer = document.querySelector(
        '.assistant-view-switch > [data-present="true"] .assistant-composer',
      );
      const row = document.querySelector('.assistant-history-item');
      const orb = document.querySelector('.assistant-orb-layer');
      window.__frames.push({
        t: performance.now() - start,
        client: workspace.clientWidth,
        overflow: getComputedStyle(workspace).overflowY,
        composer: composer?.offsetWidth,
        rowHeight: row?.getBoundingClientRect().height,
        rowOpacity: row ? Number(getComputedStyle(row).opacity) : null,
        orbOpacity: Number(getComputedStyle(orb).opacity),
        orbHeight: orb.getBoundingClientRect().height,
      });
      if (performance.now() - start < 1000) requestAnimationFrame(sample);
    };
    sample();
  });
try {
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(1000);
  before = await business();
  original = await ai('conversations');
  for (let i = 0; i < 2; i++) {
    const id = crypto.randomUUID();
    ids.push(id);
    const stamp = new Date(Date.now() - 10000 + i * 1000).toISOString();
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
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: `${marker} 1`, exact: true }).click();
  await page.waitForTimeout(850);
  const oldOrb = await page.locator('.assistant-orb-layer').boundingBox();
  await watch();
  await page.getByRole('button', { name: `${marker} 0`, exact: true }).click();
  await chat().getByText(`${marker} message 0`, { exact: true }).waitFor();
  assert.equal(await chat().getAttribute('data-axis'), 'y');
  assert.equal(await chat().getAttribute('data-direction'), '1');
  await page.waitForTimeout(850);
  const historyFrames = await page.evaluate(() => window.__frames);
  assert(historyFrames.every((f) => f.orbOpacity === 1));
  assert(historyFrames.every((f) => Math.abs(f.orbHeight - oldOrb.height) < 1));
  assert(
    await page
      .locator('.assistant-orb-layer')
      .evaluate((el) => el.parentElement === document.body && !el.closest('.view-switch')),
  );
  await page.getByRole('button', { name: `${marker} 1`, exact: true }).click();
  await chat().getByText(`${marker} message 1`, { exact: true }).waitFor();
  assert.equal(await chat().getAttribute('data-direction'), '-1');
  await page.waitForTimeout(850);
  await page.getByRole('button', { name: 'API 与隐私设置', exact: true }).click();
  assert.equal(
    await page
      .locator('[data-view="assistant-api"][data-present="true"]')
      .getAttribute('data-direction'),
    '1',
  );
  await page.waitForTimeout(850);
  await page.getByRole('button', { name: '回到对话', exact: true }).click();
  assert.equal(await chat().getAttribute('data-axis'), 'x');
  assert.equal(await chat().getAttribute('data-direction'), '-1');
  await page.waitForTimeout(850);
  const oldRow = page.getByRole('button', { name: `${marker} 1`, exact: true });
  const oldY = (await oldRow.boundingBox()).y;
  await watch();
  await page.getByRole('button', { name: '新的工作任务', exact: true }).click();
  await page.waitForTimeout(1100);
  const created = (await ai('conversations')).filter(
    (c) => !original.some((o) => o.id === c.id) && !ids.includes(c.id),
  );
  assert.equal(created.length, 1);
  ids.push(created[0].id);
  const frames = await page.evaluate(() => window.__frames);
  assert(frames.some((f) => f.rowOpacity > 0 && f.rowOpacity < 0.99));
  assert(frames.every((f) => f.overflow === 'hidden'));
  assert.equal(new Set(frames.map((f) => f.client)).size, 1);
  assert.equal(new Set(frames.filter((f) => f.composer).map((f) => f.composer)).size, 1);
  assert(frames.every((f) => f.orbOpacity === 1));
  assert((await oldRow.boundingBox()).y > oldY + 25);
  report.newConversation = { frames: frames.length, stableWorkspace: true, stableComposer: true };
  await input().pressSequentially('keyboard', { delay: 60 });
  const activity = Number(await orb().getAttribute('data-activity'));
  const pulse = Number(await orb().getAttribute('data-pulse'));
  assert(Math.abs(activity - 0.12) < 0.002, `typing changes internal energy: ${activity}`);
  assert(pulse > 0);
  assert.equal(await orb().getAttribute('data-last-pulse'), 'scale');
  report.keyboard = { activity, pulse, nativeRadiusSpringOnly: true };
  await page.waitForTimeout(1100);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((s) => s.includes('/src/data/assistant.ts'));
    const { assistantRepository: a } = await import(url);
    a.configured = async () => true;
    a.chat = async (_request, delta) =>
      new Promise((resolve) => {
        window.__qaPartial = () => delta('{"answer":"动画验收输出中');
        window.__qaFinish = () => resolve({ answer: '动画验收输出完毕。', proposals: [] });
      });
  });
  const nav = page.getByRole('navigation', { name: '主要导航' });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForTimeout(100);
  await nav.getByRole('button', { name: '工作台助手', exact: true }).click();
  await page.waitForTimeout(900);
  const largeOrb = await page.locator('.assistant-orb-layer').boundingBox();
  const anchor = await chat().locator('.assistant-orb-anchor').boundingBox();
  assert(Math.abs(largeOrb.x + largeOrb.width / 2 - anchor.x - anchor.width / 2) < 1);
  assert(Math.abs(largeOrb.y + largeOrb.height / 2 - anchor.y - anchor.height / 2) < 1);
  await page.screenshot({ path: `${out}/idle.png` });
  await input().fill(`${marker} sending`);
  await page.evaluate(
    () =>
      (window.__chatPane = document.querySelector(
        '.assistant-view-switch > [data-present="true"]',
      )),
  );
  await chat().getByRole('button', { name: '发送消息', exact: true }).click();
  await chat().getByLabel('我的消息', { exact: true }).waitFor();
  assert(
    await page.evaluate(
      () =>
        window.__chatPane ===
        document.querySelector('.assistant-view-switch > [data-present="true"]'),
    ),
  );
  const user = chat().getByLabel('我的消息', { exact: true });
  const opacity = Number(await user.evaluate((el) => getComputedStyle(el).opacity));
  assert(opacity < 1, `message should animate: ${opacity}`);
  await page.locator('.lattice-loader').waitFor();
  assert.equal(await page.locator('.assistant-orb-layer').getAttribute('data-phase'), 'thinking');
  const appearance = await orb().getAttribute('data-appearance');
  assert(Number(appearance.split(',')[3]) < 1.5);
  assert(Number(await orb().getAttribute('data-palette-progress')) < 1);
  await page.waitForTimeout(900);
  const busyOrb = await page.locator('.assistant-orb-layer').boundingBox();
  assert(Math.abs(busyOrb.height / largeOrb.height - 0.42) < 0.01);
  assert.equal(await orb().getAttribute('data-mode'), 'thinking');
  const thinkingAppearance = (await orb().getAttribute('data-appearance')).split(',').map(Number);
  assert.equal(thinkingAppearance[5], 1);
  assert(thinkingAppearance[7] > 1);
  await page.screenshot({ path: `${out}/thinking.png` });
  assert.equal(await orb().getAttribute('data-palette-progress'), '1.000');
  await page.evaluate(() => window.__qaPartial());
  await chat().getByText('动画验收输出中', { exact: true }).waitFor();
  await page.waitForTimeout(850);
  assert.equal(await orb().getAttribute('data-mode'), 'output');
  assert.equal(await orb().getAttribute('data-wave'), 'right-to-left');
  assert.equal(Number((await orb().getAttribute('data-appearance')).split(',')[5]), 0);
  assert.equal(await orb().getAttribute('data-palette'), 'spectrum');
  await page.screenshot({ path: `${out}/output.png` });
  await page.evaluate(
    () => (window.__replyNode = document.querySelector('.assistant-message-assistant')),
  );
  await page.evaluate(() => window.__qaFinish());
  await chat().getByText('动画验收输出完毕。', { exact: true }).waitFor();
  assert(
    await page.evaluate(
      () => window.__replyNode === document.querySelector('.assistant-message-assistant'),
    ),
  );
  await page.waitForTimeout(100);
  const back = await orb().getAttribute('data-appearance');
  assert(Number(back.split(',')[3]) > 1.1 && Number(back.split(',')[3]) < 1.5);
  await page.waitForTimeout(850);
  assert.equal(await orb().getAttribute('data-palette'), 'theme');
  const restOrb = await page.locator('.assistant-orb-layer').boundingBox();
  assert(Math.abs(restOrb.height / largeOrb.height - 0.5) < 0.01);
  assert.equal(await orb().getAttribute('data-mode'), 'idle');
  // The next turn contracts again and recovers after its complete response.
  await input().fill(`${marker} second turn`);
  await chat().getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.lattice-loader').waitFor();
  await page.waitForTimeout(850);
  assert(
    Math.abs((await page.locator('.assistant-orb-layer').boundingBox()).height - busyOrb.height) <
      1,
  );
  await page.evaluate(() => window.__qaFinish());
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await page.waitForTimeout(900);
  assert(
    Math.abs((await page.locator('.assistant-orb-layer').boundingBox()).height - restOrb.height) <
      1,
  );
  report.orb = {
    independentLayer: true,
    large: largeOrb.height,
    busy: busyOrb.height,
    rest: restOrb.height,
    thinkingAppearance,
  };
  report.messages = {
    samePaneOnSend: true,
    entryOpacity: opacity,
    appearanceDuringEnter: appearance,
    appearanceDuringReturn: back,
    sameStreamedReplyNode: true,
  };
  // The biggest single-sidebar collapse sets the maximum even after both close.
  if (await page.getByRole('button', { name: '展开侧边栏', exact: true }).count())
    await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  await page.waitForTimeout(650);
  await page.getByRole('button', { name: '收起助手侧栏', exact: true }).click();
  await page.waitForTimeout(650);
  const single = (await page.locator('.assistant-composer').boundingBox()).width;
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  await page.waitForTimeout(650);
  const double = (await page.locator('.assistant-composer').boundingBox()).width;
  assert(Math.abs(single - double) < 2, `${single} vs ${double}`);
  report.width = { singleSidebarCollapsed: single, bothCollapsed: double };
  await page.screenshot({ path: `${out}/conversation.png` });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 568,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(850);
  assert(
    await page.locator('.assistant-composer').evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.screenshot({ path: `${out}/narrow.png` });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pulses = await orb().getAttribute('data-pulses');
  await input().pressSequentially('静态');
  await page.waitForTimeout(150);
  assert.equal(await orb().getAttribute('data-pulses'), pulses);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.deepEqual(await business(), before);
  assert.deepEqual(errors, []);
  report.passed = true;
  report.errors = errors;
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
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(900);
  await browser.close();
}
