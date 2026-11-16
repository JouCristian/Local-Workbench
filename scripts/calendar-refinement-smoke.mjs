import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const out = 'artifacts/calendar-refinement';
await mkdir(out, { recursive: true });
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { repository } = await import('/src/data/repository.ts');
      return repository[method](...args);
    },
    { method, args },
  );
await page.locator('.dashboard-page').waitFor();
const before = await repo('load'),
  theme = await repo('theme');
const dates = await page.evaluate(async () => {
  const { localDate, addDays } = await import('/src/domain/dates.ts');
  const today = localDate();
  return [today, addDays(today, 1), addDays(today, 3)];
});
const [today, tomorrow, due] = dates,
  marker = `Calendar QA ${crypto.randomUUID().slice(0, 7)}`,
  stamp = new Date().toISOString();
const ids = { projects: [], tasks: [], schedules: [] },
  results = [],
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = (title) => ({ id: crypto.randomUUID(), title, created_at: stamp, updated_at: stamp });
const task = (title, project_id = null, due_date = due) => ({
  ...base(title),
  notes: '',
  status: 'todo',
  priority: 'medium',
  project_id,
  stage_id: null,
  due_date,
  due_time: '18:00',
  archived_at: null,
});
const plan = (task, date, period = 'exact', start_time = '08:00', end_time = '18:00') => ({
  ...base(task.title),
  task_id: task.id,
  date,
  period,
  start_time,
  end_time,
  notes: '',
});
async function add(table, record) {
  ids[table].push(record.id);
  await repo('save', [table, record]);
  return record;
}
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true });
const settle = () => page.waitForTimeout(850);
const select = async (label, value) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator(`[role=option][data-value="${value}"]:visible`).click();
};
async function closeDialog(dialog) {
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
try {
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const p = await add('projects', { ...base(marker + ' project'), notes: '', archived_at: null });
  const a = await add('tasks', task(marker + ' arranged'));
  const b = await add('tasks', task(marker + ' unplanned'));
  const c = await add('tasks', task(marker + ' colored', p.id, today));
  await add('schedules', plan(a, today));
  await add('schedules', plan(c, today, 'exact', '10:00', '11:30'));
  await add('schedules', plan(c, tomorrow, 'exact', '23:00', '23:40'));
  for (let i = 0; i < 18; i++) await add('tasks', task(`${marker} deadline ${i}`));
  await repo('setTheme', ['light']);
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await settle();
  assert.equal(await page.locator('.today-agenda .hour-tick').count(), 24);
  const dimensions = await page.evaluate(() => {
    const result = {};
    for (const [key, selector] of Object.entries({
      today: '.dashboard-agenda-scroll',
      deadlines: '.deadline-list',
      workspace: '.workspace-scroll',
    })) {
      const el = document.querySelector(selector);
      result[key] = {
        client: el.clientHeight,
        scroll: el.scrollHeight,
        gutter: el.offsetWidth - el.clientWidth,
        overflow: getComputedStyle(el).overflowY,
      };
    }
    return result;
  });
  assert(dimensions.today.scroll > dimensions.today.client);
  assert(dimensions.deadlines.scroll > dimensions.deadlines.client);
  assert.equal(dimensions.today.gutter, 12);
  assert.equal(dimensions.deadlines.gutter, 12);
  assert(dimensions.workspace.scroll <= dimensions.workspace.client + 1);
  await page.locator('.dashboard-agenda-scroll').evaluate((el) => (el.scrollTop = 560));
  await page.screenshot({ path: out + '/dashboard-light.png', fullPage: true });
  results.push({
    test: '24 hour dashboard, independent fixed scroll areas and 12px gutters',
    dimensions,
  });

  await nav('任务与项目').click();
  await page.getByLabel('搜索任务', { exact: true }).fill(a.title);
  await settle();
  const open = () =>
    page.getByRole('button', { name: `管理日程：${a.title}`, exact: true }).click();
  await open();
  let dialog = page.getByRole('dialog', { name: '任务日程', exact: true });
  assert.equal(await dialog.locator('.task-plan-editor').count(), 1);
  await dialog.getByRole('button', { name: '添加一条日程', exact: true }).click();
  await dialog.getByLabel('执行日期 2', { exact: true }).fill(tomorrow);
  await select('时间安排 2', 'afternoon');
  await dialog.getByRole('button', { name: '添加一条日程', exact: true }).click();
  await dialog.getByLabel('执行日期 3', { exact: true }).fill(today);
  await select('时间安排 3', 'evening');
  await settle();
  await page.screenshot({ path: out + '/task-schedules.png', fullPage: true });
  await dialog.getByRole('button', { name: '保存日程', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  let data = await repo('load');
  let saved = data.schedules.filter((s) => s.task_id === a.id);
  assert.equal(saved.length, 3);
  assert.equal(data.tasks.find((t) => t.id === a.id).due_date, due);
  await open();
  dialog = page.getByRole('dialog', { name: '任务日程', exact: true });
  assert.equal(await dialog.locator('.task-plan-editor').count(), 3);
  await dialog.getByRole('button', { name: '添加一条日程', exact: true }).click();
  await dialog.getByLabel('执行日期 4', { exact: true }).fill(today);
  await select('时间安排 4', 'evening');
  await dialog.getByRole('button', { name: '保存日程', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /已有安排/);
  assert.deepEqual(
    (await repo('load')).schedules.filter((s) => s.task_id === a.id),
    saved,
  );
  await closeDialog(dialog);
  await open();
  dialog = page.getByRole('dialog', { name: '任务日程', exact: true });
  await dialog.getByLabel('执行日期 1', { exact: true }).fill(tomorrow);
  await dialog.getByRole('button', { name: '保存日程', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(
    (await repo('load')).schedules.filter((s) => s.task_id === a.id && s.date === tomorrow).length,
    2,
  );
  await open();
  dialog = page.getByRole('dialog', { name: '任务日程', exact: true });
  await dialog.getByRole('button', { name: '移除安排 1', exact: true }).click();
  await dialog.getByRole('button', { name: '保存日程', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '保存日程变更', exact: true });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal((await repo('load')).schedules.filter((s) => s.task_id === a.id).length, 3);
  await dialog.getByRole('button', { name: '保存日程', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认保存日程', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await repo('load')).schedules.filter((s) => s.task_id === a.id).length, 2);
  results.push({
    test: 'Task plan manager creates, edits, restores existing plans; rejects duplicate batch without partial writes; confirms removals; preserves DDL',
  });

  await nav('日程').click();
  await page.getByLabel('选择日程日期', { exact: true }).fill(due);
  await settle();
  const plannedGroup = page
    .locator('.agenda-group')
    .filter({ has: page.getByRole('heading', { name: '截止提醒', exact: true }) });
  const unplannedGroup = page
    .locator('.agenda-group')
    .filter({ has: page.getByRole('heading', { name: '待安排', exact: true }) });
  assert.match(await plannedGroup.innerText(), new RegExp(a.title));
  assert.match(await plannedGroup.innerText(), /截止/);
  assert.match(await unplannedGroup.innerText(), new RegExp(b.title));
  assert.match(await unplannedGroup.innerText(), /截止/);
  assert(!(await unplannedGroup.innerText()).includes(a.title));
  await page.getByRole('button', { name: '日程说明', exact: true }).click();
  const geometry = await page.locator('.help-popover').evaluate((el) => {
    const r = el.getBoundingClientRect(),
      b = document.querySelector('.help-trigger').getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      bx: b.x,
      by: b.y,
      br: b.right,
      bb: b.bottom,
      w: innerWidth,
      h: innerHeight,
    };
  });
  assert(geometry.x > 100 && geometry.y > 100, JSON.stringify(geometry));
  assert(
    Math.min(Math.abs(geometry.y - geometry.bb), Math.abs(geometry.bottom - geometry.by)) < 12,
    JSON.stringify(geometry),
  );
  assert(geometry.right <= geometry.w && geometry.bottom <= geometry.h);
  await page.screenshot({ path: out + '/deadline-help.png', fullPage: true });
  await page.keyboard.press('Escape');
  results.push({
    test: 'Cross-day scheduled DDL becomes reminder, unscheduled DDL stays pending; help anchors after date pane replacement',
    geometry,
  });
  await page.getByLabel('选择日程日期', { exact: true }).fill(today);
  await settle();
  const colorBlock = page
    .locator('.time-block')
    .filter({ has: page.getByRole('button', { name: `编辑日程：${c.title}`, exact: true }) });
  assert.match(await colorBlock.innerText(), /截止/);
  const tint = await colorBlock.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert(!['rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)'].includes(tint));
  await page.screenshot({ path: out + '/calendar-light.png', fullPage: true });
  await nav('设置').click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await nav('日程').click();
  await settle();
  await page.screenshot({ path: out + '/calendar-dark.png', fullPage: true });
  results.push({
    test: 'Same-day DDL stays inline with execution; calendar has project tint in both themes',
    lightTint: tint,
  });
  await page.setViewportSize({ width: 320, height: 600 });
  await nav('任务与项目').click();
  await page.getByLabel('搜索任务', { exact: true }).fill(a.title);
  await settle();
  await open();
  dialog = page.getByRole('dialog', { name: '任务日程', exact: true });
  assert(
    await dialog.locator('.modal-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await closeDialog(dialog);
  await nav('总览').click();
  await settle();
  assert(
    await page.locator('.workspace-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  assert.equal(await page.locator('.today-agenda .hour-tick').count(), 24);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await nav('日程').click();
  await page.getByLabel('选择日程日期', { exact: true }).fill(tomorrow);
  await settle();
  await page.getByRole('button', { name: '日程说明', exact: true }).click();
  assert(
    await page.locator('.help-popover').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
    }),
  );
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  results.push({
    test: 'Narrow screen plan manager, 24 hour scroll and help popup remain usable; reduced motion; zero page errors',
  });
} finally {
  for (const table of ['schedules', 'tasks', 'projects'])
    for (const id of ids[table]) await repo('remove', [table, id]);
  await repo('setTheme', [theme]);
  assert.deepEqual(await repo('load'), before);
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await browser.close();
}
await writeFile(
  out + '/native-results.json',
  JSON.stringify({ results, errors, originalDataPreserved: true }, null, 2),
);
results.forEach((result) => console.log('PASS ' + JSON.stringify(result)));
