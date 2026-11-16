// Runs against an actual Tauri dev window via WebView2 CDP. No SQL mocks.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const browser = await chromium.connectOverCDP(process.env.WORKBENCH_CDP ?? 'http://127.0.0.1:9222');
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes('127.0.0.1:1420')) ?? context.pages()[0];
assert(page, 'Start npm run tauri dev with WebView2 CDP enabled.');
page.setDefaultTimeout(12000);
const failures = [];
page.on('pageerror', (e) => failures.push(e.message));
const out = resolve('artifacts');
await mkdir(out, { recursive: true });
const repo = (method, argument) =>
  page.evaluate(
    async ({ method, argument }) => {
      const { repository } = await import('/src/data/repository.ts');
      return argument === undefined ? repository[method]() : repository[method](argument);
    },
    { method, argument },
  );
const original = await repo('snapshot');
await writeFile(resolve(out, 'before-desktop-test.local.json'), JSON.stringify(original, null, 2));
const originalTheme = await repo('theme');
const today = await page.evaluate(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
const tomorrow = await page.evaluate((date) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}, today);
const results = [];
function pass(name) {
  results.push(name);
  console.log(`PASS ${name}`);
}
async function nav(name) {
  await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
}
async function saveDialog(name) {
  const dialog = page.getByRole('dialog', { name });
  await dialog.getByRole('button', { name: /^保存/ }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function select(locator, option) {
  await locator.click();
  if (typeof option === 'string')
    await page.locator(`[role="option"][data-value=${JSON.stringify(option)}]:visible`).click();
  else await page.getByRole('option', { name: option.label, exact: true }).click();
}
async function plan(title, period, date, taskId) {
  await nav('日程');
  await page.getByRole('button', { name: '新建日程', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建日程' });
  if (taskId) await select(dialog.getByLabel('关联任务', { exact: true }), taskId);
  await dialog.getByLabel('日程标题', { exact: true }).fill(title);
  await dialog.getByLabel('执行日期', { exact: true }).fill(date);
  await select(dialog.getByLabel('时间安排', { exact: true }), period);
  if (period === 'exact') {
    await dialog.getByLabel('开始时间', { exact: true }).fill('22:00');
    await dialog.getByLabel('结束时间（可选）', { exact: true }).fill('22:45');
  }
  await saveDialog('新建日程');
}
try {
  await repo('restore', {
    format: 'local-workbench',
    version: 1,
    exported_at: new Date().toISOString(),
    projects: [],
    stages: [],
    tasks: [],
    schedules: [],
    events: [],
  });
  await page.reload();
  await page.getByRole('heading', { name: '把今天，安排妥当。' }).waitFor();
  assert.equal(await page.locator('.dashboard-grid > section').count(), 6);
  pass('Empty dashboard exposes all six information regions');
  await nav('任务与项目');
  await page.getByRole('button', { name: '新建项目', exact: true }).last().click();
  await page.getByLabel('项目标题', { exact: true }).fill('Acceptance project');
  await page.getByLabel('备注', { exact: true }).fill('Generic automated desktop acceptance data');
  await saveDialog('新建项目');
  const projectPanel = page
    .locator('.task-group')
    .filter({ has: page.getByRole('heading', { name: 'Acceptance project', exact: true }) });
  await projectPanel.getByRole('button', { name: '添加阶段', exact: true }).click();
  await page.getByLabel('阶段标题', { exact: true }).fill('Acceptance stage');
  await page.getByLabel('开始日期', { exact: true }).fill(today);
  await page.getByLabel('结束日期', { exact: true }).fill(tomorrow);
  await saveDialog('新建阶段');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新建任务' });
  await dialog.getByLabel('任务标题', { exact: true }).fill('Acceptance task');
  await select(dialog.getByLabel('状态', { exact: true }), 'doing');
  await select(dialog.getByLabel('优先级', { exact: true }), 'high');
  await dialog.getByLabel('截止日期', { exact: true }).fill(today);
  await dialog.getByLabel('截止时间（可选）', { exact: true }).fill('23:30');
  await select(dialog.getByLabel('所属项目', { exact: true }), { label: 'Acceptance project' });
  await select(dialog.getByLabel('所属阶段', { exact: true }), { label: 'Acceptance stage' });
  await saveDialog('新建任务');
  let snapshot = await repo('snapshot');
  const task = snapshot.tasks[0];
  assert.equal(task.due_date, today);
  assert.equal(task.due_time, '23:30');
  assert.equal(task.stage_id, snapshot.stages[0].id);
  pass('Created project, stage and task with status, priority, DDL and relationships through UI');
  await page.getByLabel('快速添加任务', { exact: true }).fill('Quick independent task');
  await page.getByLabel('快速添加任务', { exact: true }).press('Enter');
  await page.getByText('Quick independent task', { exact: true }).waitFor();
  await plan('Exact execution', 'exact', today, task.id);
  await plan('Afternoon A', 'afternoon', tomorrow, task.id);
  await plan('Afternoon B', 'afternoon', tomorrow, task.id);
  await plan('Independent plan', 'evening', today, null);
  snapshot = await repo('snapshot');
  assert.equal(snapshot.schedules.length, 4);
  assert(
    snapshot.schedules
      .filter((s) => s.period === 'afternoon')
      .every((s) => s.start_time === null && s.end_time === null),
  );
  assert.equal(snapshot.tasks.find((t) => t.id === task.id).due_date, today);
  pass('Multiple overlapping schedules retain fuzzy periods and independent DDL');
  await page.getByRole('button', { name: '标记事件', exact: true }).click();
  await page.getByLabel('事件标题', { exact: true }).fill('Acceptance rest day');
  await page.getByLabel('事件日期', { exact: true }).fill(tomorrow);
  await select(page.getByLabel('事件类型', { exact: true }), 'rest');
  await saveDialog('新建事件');
  await nav('总览');
  await page.locator('.today-panel').getByText('Independent plan', { exact: true }).waitFor();
  for (const name of [
    '今日任务',
    '近期截止',
    '近期工作阶段',
    '项目进度',
    '接下来的日程',
    '重要事件与休息日',
  ])
    await page.getByRole('heading', { name: new RegExp(name) }).waitFor();
  await page.screenshot({ path: resolve(out, 'dashboard-light.png'), fullPage: true });
  await page
    .getByRole('button', { name: '完成任务：Acceptance task', exact: true })
    .first()
    .click();
  await page.getByRole('progressbar', { name: 'Acceptance project' }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '100',
  );
  assert.equal(
    await page.getByRole('button', { name: '完成任务：Acceptance task', exact: true }).count(),
    0,
  );
  pass(
    'Dashboard synchronizes task completion, deadline removal, linked schedule state and 100% progress',
  );
  await nav('设置');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal((await repo('snapshot')).tasks.find((t) => t.id === task.id).status, 'done');
  pass('Reload preserves SQLite data and theme');
  await page.screenshot({ path: resolve(out, 'dashboard-dark.png'), fullPage: true });
  const before = await repo('snapshot');
  const invalid = structuredClone(before);
  invalid.tasks[0].stage_id = crypto.randomUUID();
  await assert.rejects(() => repo('restore', invalid));
  assert.deepEqual((await repo('snapshot')).tasks, before.tasks);
  // Bypass the frontend validator to exercise the native transaction rollback itself.
  const sqlInvalid = structuredClone(before);
  sqlInvalid.tasks[0].title = '';
  const rollback = await page.evaluate(async (snapshot) => {
    const { invoke } = await import('/node_modules/@tauri-apps/api/core.js');
    try {
      await invoke('restore_snapshot', { snapshot });
      return false;
    } catch {
      return true;
    }
  }, sqlInvalid);
  assert.equal(rollback, true);
  assert.deepEqual((await repo('snapshot')).tasks, before.tasks);
  const roundTrip = JSON.parse(JSON.stringify(before));
  await repo('restore', roundTrip);
  assert.deepEqual((await repo('snapshot')).schedules, before.schedules);
  pass('JSON round trip, reference validation and native transaction rollback preserve data');
  await context.setOffline(true);
  await nav('任务与项目');
  await page.getByLabel('快速添加任务', { exact: true }).fill('Offline persisted task');
  await page.getByLabel('快速添加任务', { exact: true }).press('Enter');
  await page.getByText('Offline persisted task', { exact: true }).waitFor();
  assert((await repo('snapshot')).tasks.some((t) => t.title === 'Offline persisted task'));
  await nav('日程');
  await page.getByLabel('选择日程日期', { exact: true }).fill(tomorrow);
  await page.getByText('Afternoon A', { exact: true }).waitFor();
  await page.getByText('Afternoon B', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(out, 'schedule.png'), fullPage: true });
  pass(
    'Offline WebView2 can create persisted tasks, navigate and show simultaneous afternoon plans',
  );
  await context.setOffline(false);
  await nav('任务与项目');
  await page.getByRole('button', { name: '编辑项目：Acceptance project', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '编辑项目' });
  await dialog.getByLabel('项目标题', { exact: true }).fill('Edited project');
  await saveDialog('编辑项目');
  snapshot = await repo('snapshot');
  assert.equal(snapshot.projects[0].title, 'Edited project');
  await page.getByRole('button', { name: '编辑项目：Edited project', exact: true }).click();
  await page
    .getByRole('dialog', { name: '编辑项目', exact: true })
    .getByRole('button', { name: '删除项目', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', { name: '删除项目', exact: true });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await repo('snapshot')).projects.length, 1);
  await page
    .getByRole('dialog', { name: '编辑项目', exact: true })
    .getByRole('button', { name: '删除项目', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '删除项目', exact: true })
    .getByRole('button', { name: '删除项目', exact: true })
    .click();
  await page.getByRole('dialog', { name: '编辑项目', exact: true }).waitFor({ state: 'hidden' });
  snapshot = await repo('snapshot');
  assert.equal(snapshot.stages.length, 0);
  assert.equal(snapshot.tasks.find((t) => t.id === task.id).project_id, null);
  assert.equal(snapshot.schedules.length, 4);
  pass(
    'Project edit, cancel-delete and confirmed deletion preserve tasks/schedules and remove stages',
  );
  assert.deepEqual(failures, []);
} finally {
  await context.setOffline(false);
  await repo('restore', original);
  await repo('setTheme', originalTheme);
  await page.reload();
  await writeFile(
    resolve(out, 'desktop-results.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        passed: results,
        errors: failures,
        restoredOriginalData: true,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
console.log(`Desktop acceptance complete: ${results.length} checks; original data restored.`);
