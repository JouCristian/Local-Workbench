import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const out = 'artifacts/assistant-round6';
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
const nav = (name) =>
  page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('button', { name, exact: true })
    .click();
const input = () =>
  page
    .locator(
      '[data-page="assistant"][data-present="true"] [data-view="assistant-chat"][data-present="true"]',
    )
    .getByRole('textbox', { name: '给 AI 助手的消息' });
const thread = () => page.locator('.assistant-thread-switch > [data-present="true"]');
const marker = `Round6 ${crypto.randomUUID().slice(0, 8)}`,
  ids = [];
let before, history;
const report = {};
const createEmpty = async () => {
  const old = new Set((await ai('conversations')).map((c) => c.id));
  await page.locator('.assistant-new').click();
  const added = (await ai('conversations')).filter((c) => !old.has(c.id));
  ids.push(...added.map((c) => c.id));
  assert.equal(added.length, 1);
  return added[0];
};
const menu = () => page.locator('.assistant-history-menu:popover-open');
const options = (title) => page.getByRole('button', { name: `对话选项 ${title}`, exact: true });
const watch = () =>
  page.evaluate(() => {
    window.__round6Frames = [];
    const start = performance.now();
    const sample = () => {
      const host = document.querySelector('.route-host');
      const panes = [...document.querySelectorAll('.route-switch > .page-transition')];
      const old = document.querySelector(
        '.assistant-thread-switch > [data-present="false"] .assistant-chat-scroll',
      );
      window.__round6Frames.push({
        t: performance.now() - start,
        hostWidth: host.clientWidth,
        panes: panes.map((p) => ({
          page: p.dataset.page,
          present: p.dataset.present,
          width: p.clientWidth,
          contentWidth: p.querySelector('.route-content').clientWidth,
          contentLeft: p.querySelector('.route-content').offsetLeft,
        })),
        old: old
          ? {
              margin: getComputedStyle(old).marginTop,
              scroll: old.scrollTop,
              height: old.clientHeight,
            }
          : null,
      });
      if (performance.now() - start < 1000) requestAnimationFrame(sample);
    };
    sample();
  });
try {
  await page.reload();
  await nav('工作台助手');
  await page.waitForTimeout(1100);
  before = await business();
  history = await ai('conversations');
  const id = crypto.randomUUID(),
    stamp = new Date().toISOString();
  ids.push(id);
  await ai('create', [{ id, title: `${marker} long`, created_at: stamp, updated_at: stamp }]);
  await ai('save', [
    {
      id: crypto.randomUUID(),
      conversation_id: id,
      role: 'assistant',
      text: Array.from(
        { length: 90 },
        (_, i) => `长对话第 ${i + 1} 段：用于检查退出期间滚动位置和顶部留白是否发生变化。`,
      ).join('\n\n'),
      attachments: [],
      proposals: [],
      draft_state: 'none',
      created_at: stamp,
    },
  ]);
  await page.reload();
  await nav('工作台助手');
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: `${marker} long`, exact: true }).click();
  await page.waitForTimeout(1000);
  const previous = await thread()
    .locator('.assistant-chat-scroll')
    .evaluate((el) => ({
      margin: getComputedStyle(el).marginTop,
      scroll: el.scrollTop,
      height: el.clientHeight,
    }));
  assert(previous.scroll > 500);
  await watch();
  const empty = await createEmpty();
  await page.waitForTimeout(1100);
  const frames = await page.evaluate(() => window.__round6Frames),
    outgoing = frames.filter((f) => f.old).map((f) => f.old);
  assert(outgoing.length > 5);
  assert(
    outgoing.every(
      (f) =>
        f.margin === previous.margin &&
        f.height === previous.height &&
        Math.abs(f.scroll - previous.scroll) < 2,
    ),
    JSON.stringify(outgoing.slice(0, 4)),
  );
  report.thread = { frames: outgoing.length, outgoingGeometryAndScrollPreserved: true };
  await page
    .locator(`[data-conversation-id="${empty.id}"] .assistant-history-more`)
    .click({ force: true });
  await menu().getByRole('menuitem', { name: '重命名', exact: true }).click();
  const title = `${marker} renamed`;
  await menu().getByRole('textbox', { name: '对话名称' }).fill(title);
  await menu().getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).waitFor();
  await page.waitForTimeout(400);
  await options(title).click({ force: true });
  await menu().getByRole('menuitem', { name: '置顶对话', exact: true }).click();
  await page.waitForTimeout(900);
  assert.equal((await ai('conversations'))[0].id, empty.id);
  assert((await ai('conversations')).find((c) => c.id === empty.id).pinned_at);
  await options(title).click({ force: true });
  await menu().getByRole('menuitem', { name: '取消置顶', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.reload();
  await nav('工作台助手');
  await page.waitForTimeout(1000);
  const saved = (await ai('conversations')).find((c) => c.id === empty.id);
  assert.equal(saved.title, title);
  assert.equal(saved.title_manual, 1);
  assert(saved.pinned_at);
  assert.equal((await ai('conversations'))[0].id, empty.id);
  await page.locator(`[data-conversation-id="${empty.id}"] > button:first-child`).click();
  await page.waitForTimeout(900);
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((s) => s.includes('/src/data/assistant.ts'));
    const { assistantRepository: a } = await import(url);
    a.configured = async () => true;
    a.chat = async () =>
      new Promise(
        (resolve) =>
          (window.__round6Finish = () => resolve({ answer: '回复结束。', proposals: [] })),
      );
  });
  await nav('设置');
  await page.waitForTimeout(100);
  await nav('工作台助手');
  await page.waitForTimeout(900);
  await input().fill(`${marker} focus`);
  await input().press('Enter');
  await page.locator('.thought-line').waitFor();
  assert(
    await input().evaluate((el) => document.activeElement === el && el.readOnly && !el.disabled),
  );
  await page.evaluate(() => window.__round6Finish());
  await page.getByText('回复结束。', { exact: true }).waitFor();
  await page.waitForTimeout(900);
  assert(await input().evaluate((el) => document.activeElement === el && !el.readOnly));
  assert.equal(
    (await ai('conversations')).find((c) => c.id === empty.id).title,
    title,
    'Auto title must not overwrite manual name.',
  );
  await input().fill(`${marker} button`);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.thought-line').waitFor();
  assert(await input().evaluate((el) => document.activeElement === el));
  await page.locator('.assistant-topbar > span').click();
  assert(!(await input().evaluate((el) => document.activeElement === el)));
  await page.evaluate(() => window.__round6Finish());
  await page.waitForTimeout(1000);
  assert(!(await input().evaluate((el) => document.activeElement === el)));
  report.focus = {
    enterRetainsFocus: true,
    sendButtonRetainsFocus: true,
    outsideClickRespected: true,
  };
  await options(title).click({ force: true });
  await menu().getByRole('menuitem', { name: '取消置顶', exact: true }).click();
  await page.waitForTimeout(900);
  assert.equal((await ai('conversations')).find((c) => c.id === empty.id).pinned_at, null);
  report.history = { renameAndPinPersist: true, unpin: true, manualTitlePreserved: true };
  await page.evaluate(
    () => (window.__round6Canvas = document.querySelector('.assistant-visual canvas')),
  );
  for (const destination of ['设置', '总览', '日程', '任务与项目']) {
    await watch();
    await nav(destination);
    await page.waitForTimeout(1150);
    const samples = await page.evaluate(() => window.__round6Frames);
    assert.equal(new Set(samples.map((f) => f.hostWidth)).size, 1);
    const assistantSamples = samples.flatMap((f) => f.panes).filter((p) => p.page === 'assistant');
    assert(assistantSamples.length > 2);
    assert.equal(new Set(assistantSamples.map((p) => p.width)).size, 1);
    assert.equal(new Set(assistantSamples.map((p) => p.contentWidth)).size, 1);
    assert.equal(new Set(assistantSamples.map((p) => p.contentLeft)).size, 1);
    assert.equal(
      await page
        .locator(
          `.route-switch > [data-page="${{ 设置: 'settings', 总览: 'dashboard', 日程: 'schedule', 任务与项目: 'tasks' }[destination]}"][data-present="true"]`,
        )
        .count(),
      1,
    );
    await watch();
    await nav('工作台助手');
    await page.waitForTimeout(1100);
    const entering = await page.evaluate(() => window.__round6Frames);
    assert.equal(new Set(entering.map((f) => f.hostWidth)).size, 1);
    assert(
      await page
        .locator('.assistant-visual')
        .evaluate((el) => el.closest('.page-transition')?.dataset.page === 'assistant'),
    );
    assert(
      await page.evaluate(
        () => window.__round6Canvas === document.querySelector('.assistant-visual canvas'),
      ),
    );
  }
  report.routes = { allFourRoundTripsStable: true, artworkInsideRoute: true, sameCanvas: true };
  await page.screenshot({ path: `${out}/assistant.png` });
  await nav('设置');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${out}/settings.png` });
  await nav('工作台助手');
  await page.waitForTimeout(900);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 568,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(850);
  if (await page.getByRole('button', { name: '收起助手侧栏', exact: true }).count())
    await page.getByRole('button', { name: '收起助手侧栏', exact: true }).click();
  await page.waitForTimeout(900);
  assert(
    await page.locator('.assistant-composer').evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.screenshot({ path: `${out}/narrow.png` });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  assert.deepEqual(await business(), before);
  assert.deepEqual(errors, []);
  report.passed = true;
  await writeFile(`${out}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  for (const id of ids) await ai('remove', [id]);
  if (history)
    assert(
      JSON.stringify(await ai('conversations')) === JSON.stringify(history),
      'Original conversation metadata must be unchanged',
    );
  if (before)
    assert(
      JSON.stringify(await business()) === JSON.stringify(before),
      'Original business data must be unchanged',
    );
  await page.reload();
  await nav('工作台助手');
  await page.waitForTimeout(1000);
  await browser.close();
}
