// Actual Tauri/WebView2 QA. All mutations are limited to random fixture UUIDs.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const output = 'artifacts/batch-direction';
await mkdir(output, { recursive: true });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { repository } = await import('/src/data/repository.ts');
      return repository[method](...args);
    },
    { method, args },
  );
await page.locator('.dashboard-page,.tasks-page,.schedule-page').first().waitFor();
const before = await repo('load');
const stamp = new Date().toISOString(),
  prefix = `Batch QA ${crypto.randomUUID().slice(0, 8)}`;
const ids = { projects: [], stages: [], tasks: [], schedules: [] };
const results = [];
const base = (title) => ({ id: crypto.randomUUID(), title, created_at: stamp, updated_at: stamp });
const task = (title, project_id = null, stage_id = null) => ({
  ...base(title),
  notes: '',
  status: 'todo',
  priority: 'medium',
  due_date: '2026-11-18',
  due_time: null,
  project_id,
  stage_id,
  archived_at: null,
});
async function add(table, value) {
  ids[table].push(value.id);
  await repo('save', [table, value]);
  return value;
}
const navigation = (name) =>
  page.getByRole('navigation').getByRole('button', { name, exact: true });
const category = (name) =>
  page
    .getByRole('group', { name: '任务分类', exact: true })
    .getByRole('button', { name, exact: true });
const filter = (name) =>
  page
    .getByRole('group', { name: '任务状态筛选', exact: true })
    .getByRole('button', { name, exact: true });
const toolbar = () => page.getByRole('region', { name: '批量任务操作', exact: true });
async function settle() {
  await page.waitForTimeout(850);
}
async function enterBulk() {
  await page.getByRole('button', { name: '批量选择', exact: true }).click();
}
async function selectAll(count) {
  assert.match(await toolbar().innerText(), new RegExp(`全选当前结果（${count}）`));
  await toolbar().getByRole('checkbox', { name: '全选当前筛选结果', exact: true }).check();
  assert.match(await toolbar().innerText(), new RegExp(`已选 ${count} 项`));
}
async function route(name, target, axis, direction) {
  // DOM click samples the first animation frame without Playwright waiting for it to settle.
  await navigation(name).evaluate((el) => el.click());
  const pane = page.locator(`.page-transition[data-page="${target}"][data-present="true"]`);
  await pane.waitFor();
  assert.equal(await pane.getAttribute('data-axis'), axis);
  assert.equal(await pane.getAttribute('data-direction'), String(direction));
  const matrix = await pane.evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { x: m.m41, y: m.m42 };
  });
  assert((axis === 'x' ? matrix.x : matrix.y) * direction > 0, JSON.stringify(matrix));
  await settle();
}
async function calendar(date, direction, crossWeek) {
  await page.getByRole('button', { name: '打开选择日程日期日历', exact: true }).click();
  await page.locator(`.picker-days [data-date="${date}"]`).evaluate((el) => el.click());
  await page.waitForFunction(
    (date) =>
      document.querySelector('.date-strip .date-cell.selected')?.getAttribute('data-date') === date,
    date,
  );
  const highlight = page.locator('.date-strip > .date-selection');
  assert.equal(await highlight.count(), 1);
  assert.equal(await highlight.getAttribute('data-direction'), String(direction));
  const initial = await highlight.evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform);
    const cell = el.parentElement.querySelector('.date-cell.selected');
    return { x: m.m41, target: cell.offsetLeft };
  });
  if (crossWeek) assert((initial.target - initial.x) * direction > 0, JSON.stringify(initial));
  await settle();
  assert(
    await highlight.evaluate((el) => {
      const rect = el.getBoundingClientRect(),
        target = el.parentElement.querySelector('.date-cell.selected').getBoundingClientRect();
      return Math.abs(rect.x - target.x) < 1 && Math.abs(rect.width - target.width) < 1;
    }),
  );
}

try {
  const project = await add('projects', {
    ...base(prefix + ' project'),
    notes: '',
    archived_at: null,
  });
  const stage = await add('stages', {
    ...base(prefix + ' stage'),
    project_id: project.id,
    start_date: '2026-11-13',
    end_date: '2026-11-20',
  });
  const a = await add('tasks', task(prefix + ' independent A'));
  const b = await add('tasks', task(prefix + ' independent B'));
  const c = await add('tasks', task(prefix + ' project task', project.id, stage.id));
  const single = await add('tasks', task(prefix + ' single delete'));
  for (const t of [a, b, c, single]) {
    await add('schedules', {
      ...base(t.title + ' plan'),
      task_id: t.id,
      notes: '',
      date: '2026-11-13',
      period: 'morning',
      start_time: null,
      end_time: null,
    });
  }
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await settle();
  await route('设置', 'settings', 'y', 1);
  await route('总览', 'dashboard', 'y', -1);
  await page.locator('.date-strip [data-date="2026-11-18"]').evaluate((el) => el.click());
  const schedule = page.locator('.page-transition[data-page="schedule"][data-present="true"]');
  await schedule.waitFor();
  assert.equal(await schedule.getAttribute('data-axis'), 'x');
  assert.equal(await schedule.getAttribute('data-direction'), '1');
  await settle();
  await calendar('2026-11-04', -1, true);
  await calendar('2026-11-21', 1, true);
  await calendar('2026-11-04', -1, true);
  await calendar('2026-11-06', 1, false);
  await calendar('2026-11-02', -1, false);
  results.push(
    'Native vertical navigation and dashboard date drill-in direction; cross-week and same-week calendar direction/alignment',
  );

  await navigation('任务与项目').click();
  await page.getByLabel('搜索任务', { exact: true }).fill(prefix);
  await settle();
  await page.getByRole('button', { name: new RegExp('^' + single.title) }).click();
  const editor = page.getByRole('dialog', { name: '编辑任务', exact: true });
  await editor.getByRole('button', { name: '删除任务', exact: true }).click();
  const singleConfirm = page.getByRole('dialog', { name: '删除任务', exact: true });
  assert.match(await singleConfirm.innerText(), /1 条关联日程/);
  await singleConfirm.getByRole('button', { name: '取消', exact: true }).click();
  await singleConfirm.waitFor({ state: 'hidden' });
  assert((await repo('load')).tasks.some((t) => t.id === single.id));
  await editor.getByRole('button', { name: '删除任务', exact: true }).click();
  await singleConfirm.getByRole('button', { name: '删除任务', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  assert(!(await repo('load')).schedules.some((s) => s.task_id === single.id));
  results.push(
    'Single deletion cancellation preserves task; confirmed deletion removes linked schedule',
  );

  await enterBulk();
  await selectAll(2);
  await toolbar().getByRole('button', { name: '完成', exact: true }).click();
  await toolbar().waitFor({ state: 'hidden' });
  assert(
    (await repo('load')).tasks
      .filter((t) => [a.id, b.id].includes(t.id))
      .every((t) => t.status === 'done'),
  );
  await filter('已完成').click();
  await settle();
  await enterBulk();
  await selectAll(2);
  await toolbar().getByRole('button', { name: '重新打开', exact: true }).click();
  await toolbar().waitFor({ state: 'hidden' });
  await filter('未完成').click();
  await settle();
  await enterBulk();
  await selectAll(2);
  await toolbar().getByRole('button', { name: '归档', exact: true }).click();
  const archiveConfirm = page.getByRole('dialog', { name: '批量归档任务', exact: true });
  assert.match(await archiveConfirm.innerText(), /2 项尚未完成/);
  await archiveConfirm.getByRole('button', { name: '取消', exact: true }).click();
  await archiveConfirm.waitFor({ state: 'hidden' });
  assert(
    (await repo('load')).tasks
      .filter((t) => [a.id, b.id].includes(t.id))
      .every((t) => !t.archived_at),
  );
  await toolbar().getByRole('button', { name: '归档', exact: true }).click();
  await archiveConfirm.getByRole('button', { name: '归档 2 项任务', exact: true }).click();
  await archiveConfirm.waitFor({ state: 'hidden' });
  await category('归档').click();
  await settle();
  await enterBulk();
  await selectAll(2);
  await toolbar().getByRole('button', { name: '恢复', exact: true }).click();
  await toolbar().waitFor({ state: 'hidden' });
  assert(
    (await repo('load')).tasks
      .filter((t) => [a.id, b.id].includes(t.id))
      .every((t) => !t.archived_at && t.status === 'todo'),
  );
  results.push(
    'Bulk complete, reopen, unfinished archive cancel/confirm, restore with status preserved',
  );

  await category('项目').click();
  await settle();
  await enterBulk();
  await selectAll(1);
  await page.screenshot({ path: output + '/bulk-project.png', fullPage: true });
  await category('独立任务').click();
  await settle();
  assert.equal(await toolbar().count(), 0);
  await enterBulk();
  await selectAll(2);
  await page.getByLabel('搜索任务', { exact: true }).fill(a.title);
  assert.equal(await toolbar().count(), 0);
  await page.getByLabel('搜索任务', { exact: true }).fill(prefix);
  await enterBulk();
  await selectAll(2);
  await page.screenshot({ path: output + '/bulk-independent.png', fullPage: true });
  await toolbar().getByRole('button', { name: '删除', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '批量删除任务', exact: true });
  assert.match(await confirm.innerText(), /2 项任务/);
  assert.match(await confirm.innerText(), /2 条关联日程/);
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.equal((await repo('load')).tasks.filter((t) => [a.id, b.id].includes(t.id)).length, 2);
  await toolbar().getByRole('button', { name: '删除', exact: true }).click();
  await confirm.getByRole('button', { name: '删除 2 项任务', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  const after = await repo('load');
  assert(!after.tasks.some((t) => [a.id, b.id].includes(t.id)));
  assert(!after.schedules.some((s) => [a.id, b.id].includes(s.task_id)));
  assert(after.tasks.some((t) => t.id === c.id));
  assert(after.schedules.some((s) => s.task_id === c.id));
  results.push(
    'Project all-selection excludes independent tasks; context/query change clears selection; bulk delete confirmation, cancel, cascade and scope isolation',
  );

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await navigation('日程').click();
  await page.getByRole('button', { name: '今天', exact: true }).click();
  await settle();
  assert.equal(await page.locator('.date-strip > .date-selection').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  results.push(
    'Reduced motion, one selected-date highlight, no horizontal overflow or page errors',
  );
} finally {
  for (const table of ['schedules', 'tasks', 'stages', 'projects'])
    for (const id of ids[table]) await repo('remove', [table, id]);
  assert.deepEqual(await repo('load'), before);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await browser.close();
}
await writeFile(
  output + '/native-results.json',
  JSON.stringify(
    { completedAt: new Date().toISOString(), results, errors, originalBusinessDataPreserved: true },
    null,
    2,
  ),
);
results.forEach((result) => console.log('PASS ' + result));
