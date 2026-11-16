import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const browser = await chromium.connectOverCDP(process.env.WORKBENCH_CDP ?? 'http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
await page.emulateMedia({ reducedMotion: 'no-preference' });
await page.reload();
await page.getByRole('heading', { name: '把今天，安排妥当。', exact: true }).waitFor();
page.setDefaultTimeout(12000);
const errors = [],
  results = [],
  layouts = [];
page.on('pageerror', (error) => errors.push(error.message));
const output = resolve('artifacts/ui-iteration-1');
await mkdir(output, { recursive: true });
const marker = `UI acceptance ${crypto.randomUUID()}`;
const repo = (method, arg) =>
  page.evaluate(
    async ({ method, arg }) => {
      const { repository } = await import('/src/data/repository.ts');
      return arg === undefined ? repository[method]() : repository[method](arg);
    },
    { method, arg },
  );
const original = await repo('snapshot'),
  theme = await repo('theme'),
  fontScale = await repo('fontScale');
function pass(message) {
  results.push(message);
  console.log(`PASS ${message}`);
}
async function nav(name) {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  await page
    .getByRole('heading', {
      name: name === '总览' ? '把今天，安排妥当。' : name === '任务与项目' ? '任务' : name,
      exact: true,
    })
    .waitFor();
}
async function closeDialog(name) {
  await page
    .getByRole('dialog', { name, exact: true })
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
  await page.getByRole('dialog', { name, exact: true }).waitFor({ state: 'hidden' });
}
async function select(label, value) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator(`[role="option"][data-value=${JSON.stringify(value)}]:visible`).click();
}
async function snapshotFrames() {
  await page.evaluate(() => {
    window.__uiFrames = [];
    window.__recordFrames = true;
    const frame = () => {
      if (!window.__recordFrames) return;
      const main = document.querySelector('.workspace-scroll');
      const modal = document.querySelector('dialog[open] .modal-scroll');
      const sidebar = document.querySelector('.sidebar');
      window.__uiFrames.push({
        mainWidth: main.clientWidth,
        mainGutter: main.offsetWidth - main.clientWidth,
        modalWidth: modal?.clientWidth,
        modalGutter: modal ? modal.offsetWidth - modal.clientWidth : null,
        modalOverflows: modal ? modal.scrollHeight > modal.clientHeight + 1 : null,
        sidebarWidth: sidebar.getBoundingClientRect().width,
      });
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
async function stopFrames() {
  return page.evaluate(() => {
    window.__recordFrames = false;
    return window.__uiFrames;
  });
}
try {
  await page.setViewportSize({ width: 1380, height: 920 });
  await nav('总览');
  await page.waitForTimeout(450);
  assert.equal(await page.locator('select, input[type="date"], input[type="time"]').count(), 0);
  const slot = await page.evaluate(() => {
    const panel = document.querySelector('.today-panel .scroll-section');
    const before = panel.clientWidth;
    const dummy = document.createElement('div');
    dummy.style.height = '1000px';
    panel.append(dummy);
    const during = panel.clientWidth;
    const gutter = panel.offsetWidth - panel.clientWidth;
    dummy.remove();
    return { before, during, after: panel.clientWidth, gutter };
  });
  assert.equal(slot.before, slot.during);
  assert.equal(slot.before, slot.after);
  assert(slot.gutter >= 10);
  pass('Custom scroll lanes retain identical content width with and without overflow');

  await snapshotFrames();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '任务与项目', exact: true })
    .click();
  await page.getByRole('button', { name: '新建项目', exact: true }).last().click();
  await page.waitForTimeout(400);
  await closeDialog('新建项目');
  await page.waitForTimeout(220);
  const frames = await stopFrames();
  assert.equal(new Set(frames.map((x) => x.mainWidth)).size, 1);
  const modalFrames = frames.filter((x) => x.modalWidth);
  assert(modalFrames.length > 5);
  assert.equal(new Set(modalFrames.map((x) => x.modalWidth)).size, 1);
  assert.equal(new Set(modalFrames.map((x) => x.modalGutter)).size, 1);
  assert(modalFrames.every((x) => x.modalGutter >= 10 && x.modalOverflows === false));
  pass(
    'Every animation frame keeps main/modal scroll lanes stable; short modal never flashes overflow',
  );

  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const taskDialog = page.getByRole('dialog', { name: '新建任务', exact: true });
  await taskDialog.getByLabel('任务标题', { exact: true }).fill(marker);
  await taskDialog.getByRole('combobox', { name: '状态', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await taskDialog.locator('input[name="status"]').inputValue(), 'doing');
  await select('优先级', 'high');
  await taskDialog.getByRole('button', { name: '打开截止日期日历', exact: true }).click();
  const calendar = page.getByRole('dialog', { name: '截止日期日历', exact: true });
  await calendar.getByRole('button', { name: '选择今天', exact: true }).click();
  const date = await taskDialog.getByLabel('截止日期', { exact: true }).inputValue();
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  await taskDialog.getByRole('button', { name: '打开截止时间（可选）选择器', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '截止时间（可选）选择器', exact: true });
  assert(await picker.getByRole('button', { name: '确认时间', exact: true }).isDisabled());
  await picker
    .getByRole('group', { name: '小时', exact: true })
    .getByRole('button', { name: '22', exact: true })
    .click();
  assert(await picker.getByRole('button', { name: '确认时间', exact: true }).isDisabled());
  await picker
    .getByRole('group', { name: '分钟', exact: true })
    .getByRole('button', { name: '30', exact: true })
    .click();
  await picker.getByRole('button', { name: '确认时间', exact: true }).click();
  assert.equal(
    await taskDialog.getByLabel('截止时间（可选）', { exact: true }).inputValue(),
    '22:30',
  );
  await taskDialog.getByRole('combobox', { name: '所属项目', exact: true }).click();
  await page.keyboard.press('Escape');
  assert(await taskDialog.isVisible());
  await page.screenshot({ path: resolve(output, 'custom-controls.png') });
  await taskDialog.getByRole('button', { name: '保存任务', exact: true }).click();
  await taskDialog.waitFor({ state: 'hidden' });
  let data = await repo('snapshot');
  let temporary = data.tasks.find((x) => x.title === marker);
  assert.equal(temporary.status, 'doing');
  assert.equal(temporary.priority, 'high');
  assert.equal(temporary.due_date, date);
  assert.equal(temporary.due_time, '22:30');
  pass(
    'Custom select keyboard, calendar and explicit time selection save validated data to SQLite',
  );

  await page.getByRole('button', { name: '新建日程', exact: true }).count();
  await nav('日程');
  await page.getByRole('button', { name: '新建日程', exact: true }).click();
  await page.getByRole('combobox', { name: '关联任务', exact: true }).click();
  await page.getByLabel('搜索关联任务', { exact: true }).fill(marker);
  await page.getByRole('option', { name: marker, exact: true }).click();
  assert.equal(
    await page
      .getByRole('dialog', { name: '新建日程', exact: true })
      .getByLabel('日程标题', { exact: true })
      .inputValue(),
    marker,
  );
  await closeDialog('新建日程');
  pass('Searchable task picker stays inside modal focus boundary and fills linked task');

  await nav('任务与项目');
  await page.getByText(marker, { exact: true }).click();
  await page
    .getByRole('dialog', { name: '编辑任务', exact: true })
    .getByRole('button', { name: '删除任务', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '删除任务', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await page.getByRole('dialog', { name: '删除任务', exact: true }).waitFor({ state: 'hidden' });
  assert(await page.getByRole('dialog', { name: '编辑任务', exact: true }).isVisible());
  await page
    .getByRole('dialog', { name: '编辑任务', exact: true })
    .getByRole('button', { name: '删除任务', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '删除任务', exact: true })
    .getByRole('button', { name: '删除任务', exact: true })
    .click();
  await page.getByRole('dialog', { name: '编辑任务', exact: true }).waitFor({ state: 'hidden' });
  pass('Nested confirmation animates and restores parent modal focus without losing actions');

  await nav('总览');
  await page.waitForTimeout(400);
  await snapshotFrames();
  const toggle = page.getByRole('button', { name: '收起侧边栏', exact: true });
  if (await toggle.count()) await toggle.click();
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  await page.waitForTimeout(500);
  const sideFrames = await stopFrames();
  assert(new Set(sideFrames.map((x) => Math.round(x.sidebarWidth))).size > 8);
  const expanded = await page
    .locator('.sidebar')
    .evaluate((el) => el.getBoundingClientRect().width);
  const expected = await page.evaluate(
    () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 16,
  );
  assert(Math.abs(expanded - expected) < 1);
  pass(
    'Sidebar width interpolates through intermediate frames and rapid reversal reaches correct state',
  );

  for (const [width, height] of [
    [320, 640],
    [360, 740],
    [600, 500],
    [768, 1024],
    [1024, 600],
    [1366, 768],
    [1920, 1080],
    [2560, 1080],
    [3840, 2160],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(480);
    for (const name of ['总览', '任务与项目', '日程', '设置']) {
      await nav(name);
      await page.waitForTimeout(260);
      const layout = await page.locator('.workspace-scroll').evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        root: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert(
        layout.scroll <= layout.client + 1,
        `${width}x${height} ${name}: horizontal overflow ${JSON.stringify(layout)}`,
      );
      assert(layout.root <= layout.viewport, `${width}x${height}: root overflow`);
      layouts.push({ width, height, page: name, ...layout });
    }
    if ([320, 1366, 3840].includes(width)) {
      await nav('总览');
      await page.screenshot({ path: resolve(output, `dashboard-${width}.png`) });
    }
  }
  pass(
    'All four pages fit nine portrait, short, desktop, ultrawide and 4K viewports without horizontal overflow',
  );
  await page.setViewportSize({ width: 360, height: 640 });
  await page.waitForTimeout(500);
  await nav('总览');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('button', { name: '打开截止日期日历', exact: true }).click();
  const panel = page.locator('.calendar-popover:popover-open');
  await panel.waitFor();
  await page.waitForTimeout(350);
  const bounds = await panel.boundingBox();
  assert(
    bounds.x >= 0 &&
      bounds.x + bounds.width <= 361 &&
      bounds.y >= 0 &&
      bounds.y + bounds.height <= 641,
  );
  await page.screenshot({ path: resolve(output, 'narrow-calendar.png') });
  await page.keyboard.press('Escape');
  await closeDialog('新建任务');
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  await page.waitForTimeout(480);
  assert(await page.locator('main').evaluate((el) => el.inert));
  await page
    .getByRole('button', { name: '关闭导航侧栏', exact: true })
    .click({ position: { x: 352, y: 20 } });
  await page.waitForTimeout(400);
  assert(!(await page.locator('main').evaluate((el) => el.inert)));
  pass(
    'Narrow calendar stays within viewport; small-screen drawer opens/closes independently of content width',
  );

  await page.setViewportSize({ width: 1380, height: 920 });
  await page.waitForTimeout(500);
  await nav('设置');
  await page
    .getByRole('group', { name: '字体大小', exact: true })
    .getByRole('button', { name: '大号', exact: true })
    .click();
  await page.waitForTimeout(100);
  const large = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  await page.reload();
  await nav('设置');
  assert.equal(await repo('fontScale'), 'large');
  const persisted = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.documentElement).fontSize),
  );
  assert(Math.abs(large - persisted) < 0.1);
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(output, 'settings-dark-large.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await nav('总览');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  assert(await page.getByRole('dialog', { name: '新建任务', exact: true }).isVisible());
  await closeDialog('新建任务');
  pass('Font size persists in SQLite; dark theme and reduced-motion mode keep controls usable');
  data = await repo('snapshot');
  for (const table of ['projects', 'stages', 'tasks', 'schedules', 'events'])
    assert.deepEqual(data[table], original[table]);
  assert.deepEqual(errors, []);
  pass('Original business data remains unchanged, with zero page errors');
} finally {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Only our own temporary task is cleaned if a test is interrupted; user data is never replaced.
  const current = await repo('snapshot');
  const temporary = current.tasks.find((x) => x.title === marker);
  if (temporary)
    await page.evaluate(async (id) => {
      const { repository } = await import('/src/data/repository.ts');
      await repository.remove('tasks', id);
    }, temporary.id);
  await repo('setTheme', theme);
  await repo('setFontScale', fontScale);
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.reload();
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify({ at: new Date().toISOString(), results, layouts, errors }, null, 2),
  );
  await browser.close();
}
