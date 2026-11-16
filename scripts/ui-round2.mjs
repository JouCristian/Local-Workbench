import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
const browser = await chromium.connectOverCDP(process.env.WORKBENCH_CDP ?? 'http://127.0.0.1:9222');
const context = browser.contexts()[0],
  page = context.pages().find((p) => p.url().includes('1420')) ?? context.pages()[0];
page.setDefaultTimeout(12000);
const out = process.env.WORKBENCH_UI_OUTPUT ?? 'artifacts/ui-iteration-2';
await mkdir(out, { recursive: true });
const errors = [],
  results = [],
  layouts = [];
page.on('pageerror', (e) => errors.push(e.message));
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { repository } = await import('/src/data/repository.ts');
      return repository[method](...args);
    },
    { method, args },
  );
const before = await repo('load'),
  theme = await repo('theme'),
  font = await repo('fontScale');
await writeFile(`${out}/before.local.json`, JSON.stringify(before, null, 2));
const ids = { projects: [], stages: [], tasks: [], schedules: [], events: [] };
const marker = `Round2 ${crypto.randomUUID().slice(0, 8)}`;
const today = await page.evaluate(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
const plus = async (n) =>
  page.evaluate(
    ({ today, n }) => {
      const d = new Date(`${today}T12:00:00`);
      d.setDate(d.getDate() + n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    { today, n },
  );
const tomorrow = await plus(1),
  six = await plus(6),
  past = await plus(-1);
const stamp = new Date().toISOString();
const base = (title) => ({ id: crypto.randomUUID(), title, created_at: stamp, updated_at: stamp });
const pass = (s) => {
  results.push(s);
  console.log(`PASS ${s}`);
};
async function nav(name) {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  const id = { 总览: 'dashboard', 任务与项目: 'tasks', 日程: 'schedule', 设置: 'settings' }[name];
  await page.locator(`.page-transition[data-page="${id}"][data-present="true"]`).waitFor();
  await page.waitForTimeout(750);
}
async function close() {
  await page
    .locator('dialog[open]')
    .last()
    .getByRole('button', { name: '关闭弹窗', exact: true })
    .click();
}
async function select(label, value) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator(`[role=option][data-value=${JSON.stringify(value)}]:visible`).click();
}
async function save(name) {
  await page
    .getByRole('dialog', { name, exact: true })
    .getByRole('button', { name: /^保存/ })
    .click();
  await page.getByRole('dialog', { name, exact: true }).waitFor({ state: 'hidden' });
}
async function remember(table, title) {
  const item = (await repo('load'))[table].find((x) => x.title === title);
  assert(item, `${table} persisted`);
  ids[table].push(item.id);
  return item;
}
async function add(table, record) {
  ids[table].push(record.id);
  await repo('save', [table, record]);
  return record;
}
try {
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await nav('设置');
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.getByRole('button', { name: '标准', exact: true }).click();
  await nav('总览');
  assert.equal(await page.locator('.dashboard-page .panel').count(), 0);
  assert.equal(await page.locator('.date-strip .date-cell').count(), 14);
  assert.equal(await page.locator('select,input[type=date],input[type=time]').count(), 0);
  const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return ['canvas', 'sidebar', 'primary', 'primary-tint'].map((x) =>
      s.getPropertyValue('--' + x).trim(),
    );
  });
  assert.deepEqual(
    tokens.map((x) => x.toUpperCase()),
    ['#F3F5F7', '#E9EDF2', '#2F5D8A', '#E3ECF5'],
  );
  pass('New dashboard regions, 14-day horizon, custom controls and exact light tokens');
  // UI creates a project and stage, with custom date input and select.
  await nav('任务与项目');
  await page.getByRole('button', { name: '新建项目', exact: true }).last().click();
  await page.getByLabel('项目标题', { exact: true }).fill(marker);
  await save('新建项目');
  const project = await remember('projects', marker);
  await page
    .locator('.task-group')
    .filter({ has: page.getByRole('heading', { name: marker, exact: true }) })
    .getByRole('button', { name: '添加阶段', exact: true })
    .click();
  await page.getByLabel('阶段标题', { exact: true }).fill(`${marker} stage`);
  await page.getByLabel('开始日期', { exact: true }).fill(today);
  await page.getByLabel('结束日期', { exact: true }).fill(six);
  await save('新建阶段');
  const stage = await remember('stages', `${marker} stage`);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('任务标题', { exact: true }).fill(`${marker} task`);
  await select('所属项目', project.id);
  await select('所属阶段', stage.id);
  await page.getByLabel('截止日期', { exact: true }).fill(six);
  await save('新建任务');
  const task = await remember('tasks', `${marker} task`);
  assert.equal(task.stage_id, stage.id);
  pass('Project, stage, task creation through real editors persists to SQLite');
  await nav('日程');
  await page.getByRole('button', { name: '新建日程', exact: true }).click();
  await select('关联任务', task.id);
  await select('时间安排', 'exact');
  await page.getByLabel('执行日期', { exact: true }).fill(today);
  await page.getByLabel('开始时间', { exact: true }).fill('10:00');
  await page.getByLabel('结束时间（可选）', { exact: true }).fill('12:00');
  await save('新建日程');
  const schedule = (await repo('load')).schedules.find((x) => x.task_id === task.id);
  assert(schedule);
  ids.schedules.push(schedule.id);
  await add('schedules', {
    ...base(`${marker} overlap`),
    notes: '',
    task_id: task.id,
    date: today,
    period: 'exact',
    start_time: '10:30',
    end_time: null,
  });
  await add('schedules', {
    ...base(`${marker} fuzzy`),
    notes: '',
    task_id: null,
    date: tomorrow,
    period: 'afternoon',
    start_time: null,
    end_time: null,
  });
  await add('events', { ...base(`${marker} event`), notes: '', date: tomorrow, kind: 'event' });
  await add('tasks', {
    ...task,
    id: crypto.randomUUID(),
    title: `${marker} overdue`,
    due_date: past,
    project_id: null,
    stage_id: null,
  });
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  assert.equal(
    await page.locator('.today-agenda .agenda-item').filter({ hasText: task.title }).count(),
    2,
  );
  const due = page.locator('.deadline-row').filter({ hasText: task.title });
  assert.match(await due.innerText(), /还剩 6 天/);
  assert(await page.locator('.overdue-text').count());
  assert.equal(
    await page.locator(`.date-cell[data-date="${tomorrow}"] .date-flags svg`).count(),
    1,
  );
  const segment = page.getByRole('progressbar', { name: stage.title, exact: true });
  assert.equal(await segment.getAttribute('aria-valuenow'), '0');
  pass('Today preserves multiple executions, deadline countdown and event flag; no duplicate task');
  await page.screenshot({ path: `${out}/dashboard-light.png` });
  await page.locator(`.date-cell[data-date="${today}"]`).click();
  await page.locator('.schedule-page').waitFor();
  const blocks = await page.locator('.hour-event-position').evaluateAll((elements) =>
    elements
      .filter((e) => e.textContent.includes('Round2'))
      .map((e) => ({
        top: parseFloat(e.style.top),
        left: parseFloat(e.style.left),
        width: parseFloat(e.style.width),
        height: e.getBoundingClientRect().height,
      })),
  );
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].top, 112);
  assert.equal(blocks[0].height, 112);
  assert.equal(blocks[1].top, 140);
  assert.notEqual(blocks[0].left, blocks[1].left);
  assert.equal(await page.locator('.hour-tick').count(), 16);
  pass('Hour axis positions 10:00/10:30 proportionally and preserves overlap lanes and duration');
  await page.screenshot({ path: `${out}/schedule-light.png` });
  await page.locator(`.date-cell[data-date="${tomorrow}"]`).click();
  assert.match(
    await page
      .locator('.agenda-group')
      .filter({ hasText: `${marker} fuzzy` })
      .innerText(),
    /下午/,
  );
  assert.equal(
    await page
      .locator('.hour-event-position')
      .filter({ hasText: `${marker} fuzzy` })
      .count(),
    0,
  );
  pass('Fuzzy afternoon plan never becomes a fake hour; empty period groups absent');
  await page.getByRole('button', { name: '日程说明', exact: true }).click();
  assert(await page.locator('.help-popover').isVisible());
  await page.keyboard.press('Escape');
  await nav('总览');
  await due.getByRole('button', { name: `完成任务：${task.title}`, exact: true }).click();
  await due.waitFor({ state: 'hidden' });
  await page.waitForTimeout(400);
  assert.equal(await segment.getAttribute('aria-valuenow'), '100');
  assert.equal((await repo('load')).tasks.find((x) => x.id === task.id).status, 'done');
  assert.equal(
    await page.locator('.today-agenda .agenda-item').filter({ hasText: task.title }).count(),
    0,
  );
  pass(
    'Completion check/gray/collapse synchronizes dashboard deadline, timeline and stage progress',
  );
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  assert.equal(
    await page
      .getByRole('progressbar', { name: stage.title, exact: true })
      .getAttribute('aria-valuenow'),
    '100',
  );
  pass('Reload reads persisted completion from SQLite');
  // Record frame widths across popup opening, while the modal and popover animate.
  await page.evaluate(() => {
    window.__frames = [];
    window.__capture = true;
    function frame() {
      if (!window.__capture) return;
      const w = document.querySelector('.workspace-scroll'),
        m = document.querySelector('dialog[open] .modal-scroll');
      window.__frames.push({
        width: w.clientWidth,
        gutter: w.offsetWidth - w.clientWidth,
        modal: m?.clientWidth,
        modalGutter: m ? m.offsetWidth - m.clientWidth : null,
        animated: document.getAnimations().length,
      });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '打开截止日期日历', exact: true }).click();
  await page.locator('.calendar-picker').waitFor();
  await page.screenshot({ path: `${out}/editor-light.png` });
  await page.keyboard.press('Escape');
  await close();
  await page.waitForTimeout(250);
  const frames = await page.evaluate(() => {
    window.__capture = false;
    return window.__frames;
  });
  assert.equal(new Set(frames.map((f) => f.width)).size, 1);
  assert.equal(new Set(frames.map((f) => f.gutter)).size, 1);
  assert.equal(new Set(frames.filter((f) => f.modal).map((f) => f.modalGutter)).size, 1);
  assert.equal(
    frames.some((f) => f.animated),
    true,
  );
  await writeFile(`${out}/scroll-frames.json`, JSON.stringify(frames));
  pass(
    'Modal and custom calendar open without scrollbar width changes during entrance and exit animations',
  );
  await nav('设置');
  assert((await page.locator('.settings-page').boundingBox()).width <= 720);
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await nav('总览');
  await page.screenshot({ path: `${out}/dashboard-dark.png` });
  pass('Themed dark interface and centered settings max 720px');
  for (const [width, height] of [
    [320, 360],
    [480, 800],
    [768, 1024],
    [1024, 768],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ]) {
    await page.setViewportSize({ width, height });
    for (const name of ['总览', '任务与项目', '日程', '设置']) {
      await nav(name);
      const v = await page.evaluate(() => {
        const w = document.querySelector('.workspace-scroll');
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          client: w.clientWidth,
          scroll: w.scrollWidth,
          nested: [...document.querySelectorAll('.dashboard-page *,.schedule-page *')]
            .filter((e) => {
              const s = getComputedStyle(e);
              return (
                ['auto', 'scroll'].includes(s.overflowY) && e.scrollHeight > e.clientHeight + 1
              );
            })
            .map((e) => e.className),
        };
      });
      assert(v.document <= width, `document overflow at ${width}/${name}`);
      assert(
        v.scroll <= v.client + 1,
        `workspace overflow at ${width}/${name}: ${JSON.stringify(v)}`,
      );
      assert.deepEqual(v.nested, []);
      layouts.push({ width, height, page: name, ...v });
    }
  }
  pass(
    '28 layouts from 320×360 through 4K: no horizontal overflow or nested dashboard/schedule scroll',
  );
  await page.setViewportSize({ width: 480, height: 800 });
  await nav('设置');
  await page.getByRole('button', { name: '大号', exact: true }).click();
  await nav('总览');
  await page.screenshot({ path: `${out}/compact-dark-large.png` });
  assert(await page.locator('.dashboard-page').isVisible());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  pass('Large text, compact layout and reduced motion remain usable');
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
  await page.getByRole('button', { name: '还原窗口', exact: true }).waitFor();
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await page.getByRole('button', { name: '最大化窗口', exact: true }).waitFor();
  pass('Custom native titlebar maximize and restore work with Tauri permissions');
  assert.deepEqual(errors, []);
  pass('No JavaScript errors');
} finally {
  for (const table of ['schedules', 'events', 'tasks', 'stages', 'projects'])
    for (const id of ids[table]) await repo('remove', [table, id]);
  await repo('setTheme', [theme]);
  await repo('setFontScale', [font]);
  const after = await repo('load');
  assert.deepEqual(after, before, 'Existing business records unchanged');
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        results,
        layouts,
        errors,
        originalRecords: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.length])),
        businessDataPreserved: true,
      },
      null,
      2,
    ),
  );
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await browser.close();
}
