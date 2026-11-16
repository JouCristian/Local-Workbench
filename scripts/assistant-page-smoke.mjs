import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  page = browser.contexts()[0].pages()[0];
const out = 'artifacts/assistant-page';
await mkdir(out, { recursive: true });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const nav = (name) =>
  page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('button', { name, exact: true })
    .click();
const pane = () => page.locator('.page-transition[data-page="assistant"][data-present="true"]');
const business = () =>
  page.evaluate(async () => {
    const { repository } = await import('/src/data/repository.ts');
    return repository.load();
  });
const before = await business();
try {
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).waitFor();
  const order = await page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('button')
    .allTextContents();
  assert(
    order.findIndex((s) => s.trim() === '日程') < order.findIndex((s) => s.trim() === '工作台助手'),
  );
  assert(
    order.findIndex((s) => s.trim() === '工作台助手') < order.findIndex((s) => s.trim() === '设置'),
  );
  await nav('工作台助手');
  await pane().waitFor();
  await page.locator('.assistant-visual canvas').waitFor();
  await page.waitForTimeout(850);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(await page.getByLabel('推荐提问').count(), 0);
  assert.equal(await pane().getAttribute('data-direction'), '1');
  assert.equal(await pane().getAttribute('data-axis'), 'y');
  await page.evaluate(() => {
    window.__assistantCanvas = document.querySelector('.assistant-visual canvas');
  });
  const send = page.locator('.assistant-send');
  assert(await send.isDisabled());
  const style = () =>
    send.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      cursor: getComputedStyle(el).cursor,
      opacity: getComputedStyle(el).opacity,
    }));
  const baseline = await style();
  await send.hover({ force: true });
  assert.deepEqual(await style(), baseline);
  assert.equal(baseline.cursor, 'not-allowed');
  const input = page.getByRole('textbox', { name: '给 AI 助手的消息' });
  await input.fill('保留这段未发送的文字');
  assert.equal(await send.isDisabled(), false);
  const setup = page.locator('.assistant-setup-link');
  if (await setup.count()) {
    const a = await setup.boundingBox(),
      b = await page.locator('.assistant-composer').boundingBox();
    assert(a.y + a.height <= b.y);
    assert(Math.abs(a.x - b.x) < 4);
  }
  await page.getByRole('combobox', { name: '助手模型', exact: true }).click();
  const option = page.locator(
    '.assistant-model-popover [role="option"][data-value="deepseek-v4-pro"]',
  );
  await option.waitFor();
  const initial = await option.evaluate((el) => getComputedStyle(el).backgroundColor);
  await option.hover();
  const hover = await option.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(hover, initial);
  await page.mouse.move(10, 10);
  await page.waitForTimeout(200);
  assert.equal(await option.evaluate((el) => getComputedStyle(el).backgroundColor), initial);
  assert.equal(
    await option.evaluate((el) => el.querySelector('span').getBoundingClientRect().height < 20),
    true,
  );
  await page.getByRole('combobox', { name: '助手模型', exact: true }).press('ArrowDown');
  assert((await page.locator('.assistant-model-popover .highlighted').count()) > 0);
  await page.keyboard.press('Escape');
  await nav('设置');
  await page.waitForTimeout(850);
  assert.equal(
    await page.getByRole('textbox', { name: 'DeepSeek API Key', exact: true }).count(),
    0,
  );
  const sequence = await page
    .locator('.settings-layout>.settings-section')
    .evaluateAll((nodes) => nodes.map((n) => n.textContent));
  assert(sequence[0].includes('外观'));
  assert(sequence[1].includes('工作台助手 API 设置'));
  assert(sequence[2].includes('数据与备份'));
  await page.getByRole('button', { name: '工作台助手 API 设置', exact: false }).click();
  await page.getByRole('region', { name: 'DeepSeek API 设置' }).waitFor();
  assert.equal(await pane().getAttribute('data-direction'), '-1');
  await page.getByRole('button', { name: '回到对话', exact: true }).click();
  assert.equal(await input.inputValue(), '保留这段未发送的文字');
  await page.waitForTimeout(850);
  assert(
    await page.evaluate(
      () => window.__assistantCanvas === document.querySelector('.assistant-visual canvas'),
    ),
  );
  // Repeated route changes reuse the canvas and must not produce main-thread long tasks.
  await page.evaluate(() => {
    window.__longTasks = [];
    window.__longObserver = new PerformanceObserver((list) =>
      window.__longTasks.push(...list.getEntries().map((e) => e.duration)),
    );
    window.__longObserver.observe({ type: 'longtask', buffered: false });
  });
  for (let i = 0; i < 3; i++) {
    await nav('设置');
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+j');
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(900);
  assert.equal(await pane().count(), 1);
  assert.equal(await page.locator('.assistant-visual canvas').count(), 1);
  const performance = await page.evaluate(() => {
    window.__longObserver.disconnect();
    return {
      tasks: window.__longTasks,
      canvasReused: window.__assistantCanvas === document.querySelector('.assistant-visual canvas'),
    };
  });
  assert(performance.canvasReused);
  await input.fill('');
  await page.screenshot({ path: `${out}/desktop.png` });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 568,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(600);
  if (await page.locator('.assistant-layout:not(.assistant-sidebar-collapsed)').count())
    await page.getByRole('button', { name: '收起助手侧栏', exact: true }).click();
  await page.waitForTimeout(600);
  assert.equal(
    await page.locator('.assistant-composer').evaluate((el) => el.scrollWidth > el.clientWidth),
    false,
  );
  await page.getByRole('combobox', { name: '助手模型', exact: true }).click();
  await page.waitForTimeout(180);
  assert.equal(
    await option.evaluate((el) => el.querySelector('span').getBoundingClientRect().height < 20),
    true,
  );
  await page.screenshot({ path: `${out}/narrow-model.png` });
  await page.keyboard.press('Escape');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.detach();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await nav('设置');
  await page.keyboard.press('Control+j');
  await page.waitForTimeout(100);
  assert.equal(await pane().count(), 1);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.deepEqual(await business(), before);
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/result.json`,
    JSON.stringify({ passed: true, performance, pageErrors: errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, performance, pageErrors: errors }));
} finally {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(850);
  await browser.close();
}
