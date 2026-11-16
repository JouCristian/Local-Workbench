import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const out = 'artifacts/orb-response';
await mkdir(out, { recursive: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const repo = () =>
  page.evaluate(async () => {
    const { repository: r } = await import('/src/data/repository.ts');
    return r.load();
  });
const history = () =>
  page.evaluate(async () => {
    const { assistantRepository: a } = await import('/src/data/assistant.ts');
    return a.conversations();
  });
const before = await repo(),
  originalHistory = await history(),
  marker = `Orb QA ${crypto.randomUUID().slice(0, 8)}`;
const nav = (name) =>
  page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('button', { name, exact: true })
    .click();
try {
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('.strands-container').getAttribute('data-form'), 'sphere');
  assert.equal(await page.locator('.strands-container').getAttribute('data-palette'), 'theme');
  const large = await page.locator('.assistant-visual').boundingBox();
  const main = await page.locator('.assistant-main').boundingBox(),
    composer = await page.locator('.assistant-composer').boundingBox();
  assert(composer.width / main.width > 0.9);
  assert(composer.x - main.x >= 14);
  await page.screenshot({ path: `${out}/idle.png` });
  const a = await page.locator('.assistant-visual').screenshot();
  await page.waitForTimeout(800);
  const b = await page.locator('.assistant-visual').screenshot();
  assert(!a.equals(b));
  await page
    .getByRole('textbox', { name: '给 AI 助手的消息' })
    .pressSequentially('abc', { delay: 80 });
  assert.equal(await page.locator('.strands-container').getAttribute('data-last-pulse'), 'scale');
  assert(Number(await page.locator('.strands-container').getAttribute('data-pulses')) >= 3);
  // Controlled response tests visual timing through the last output chunk, without
  // sending any local records to a provider or reading/replacing the saved key.
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((s) => s.includes('/src/data/assistant.ts'));
    const { assistantRepository: a } = await import(url);
    a.configured = async () => true;
    a.chat = async (_request, delta) =>
      new Promise((resolve) => {
        window.__orbPartial = () => delta('{"answer":"这是一段尚未结束的 UI 验收输出');
        window.__orbFinish = () => resolve({ answer: 'UI 验收输出已结束。', proposals: [] });
      });
  });
  await nav('设置');
  await page.waitForTimeout(100);
  await nav('工作台助手');
  await page.waitForTimeout(850);
  await page.getByRole('textbox', { name: '给 AI 助手的消息' }).fill(marker);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.lattice-loader').waitFor();
  await page.waitForTimeout(1100);
  const small = await page.locator('.assistant-visual').boundingBox();
  assert(Math.abs(small.height / large.height - 0.42) < 0.03);
  assert(small.y < large.y);
  assert.equal(await page.locator('.strands-container').getAttribute('data-form'), 'sphere');
  assert.equal(await page.locator('.strands-container').getAttribute('data-palette'), 'spectrum');
  assert.equal(await page.locator('.strands-container').getAttribute('data-mode'), 'thinking');
  await page.screenshot({ path: `${out}/thinking.png` });
  await page.evaluate(() => window.__orbPartial());
  await page.getByText('这是一段尚未结束的 UI 验收输出', { exact: true }).waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.strands-container').getAttribute('data-mode'), 'output');
  assert.equal(await page.locator('.strands-container').getAttribute('data-wave'), 'right-to-left');
  assert.equal(await page.locator('.strands-container').getAttribute('data-palette'), 'spectrum');
  await page.evaluate(() => window.__orbFinish());
  await page.getByText('UI 验收输出已结束。', { exact: true }).waitFor();
  await page.waitForTimeout(1050);
  assert.equal(await page.locator('.strands-container').getAttribute('data-palette'), 'theme');
  assert.equal(await page.locator('.strands-container').getAttribute('data-wave'), 'idle');
  assert.equal(await page.locator('.strands-container').getAttribute('data-form'), 'sphere');
  assert(
    Math.abs((await page.locator('.assistant-visual').boundingBox()).height / large.height - 0.5) <
      0.03,
  );
  const oldWidth = (await page.locator('.assistant-composer').boundingBox()).width;
  await page.getByRole('button', { name: '收起助手侧栏', exact: true }).click();
  await page.waitForTimeout(650);
  const expanded = await page.locator('.assistant-composer').boundingBox();
  assert(expanded.width > oldWidth + 150);
  await page.screenshot({ path: `${out}/conversation-wide.png` });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 568,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(650);
  assert.equal(
    await page.locator('.assistant-composer').evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await page.screenshot({ path: `${out}/narrow.png` });
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  assert.deepEqual(await repo(), before);
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/result.json`,
    JSON.stringify(
      {
        passed: true,
        normalHeight: large.height,
        conversationHeight: small.height,
        composerWidth: composer.width,
        sidebarCollapsedWidth: expanded.width,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Independent sphere, native radius pulses, thinking/output modes, size recovery and composer width passed.',
  );
} finally {
  await page.reload();
  await page.evaluate(async (marker) => {
    const { assistantRepository: a } = await import('/src/data/assistant.ts');
    for (const c of (await a.conversations()).filter((c) => c.title === marker))
      await a.remove(c.id);
  }, marker);
  assert.deepEqual(await repo(), before);
  assert.deepEqual(await history(), originalHistory);
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(850);
  await browser.close();
}
