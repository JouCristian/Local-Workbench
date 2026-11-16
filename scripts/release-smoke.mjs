// Launches the actual release EXE twice, with all WebView networking offline.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const exe =
  process.env.WORKBENCH_RELEASE_EXE ?? resolve('src-tauri/target/release/local-workbench.exe');
const marker = `Offline acceptance ${crypto.randomUUID()}`;
const linkedPlan = crypto.randomUUID();
const secondPlan = crypto.randomUUID();
let child, browser, page;
let originalPreferences, persistedLayout, persistedAccent;
const results = [],
  errors = [],
  externalRequests = [];
const artifactDir = resolve(process.env.WORKBENCH_RELEASE_OUTPUT ?? 'artifacts/ui-iteration-2');
await mkdir(artifactDir, { recursive: true });
async function launch(port) {
  child = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: resolve('artifacts/webview-round2-release'),
    },
  });
  const start = Date.now();
  let lastError;
  while (Date.now() - start < 25000) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1500 });
      break;
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  assert(browser, String(lastError));
  const context = browser.contexts()[0];
  page = context.pages()[0];
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !/^http:\/\/(tauri|ipc|asset)\.localhost/.test(request.url())
    )
      externalRequests.push(request.url());
  });
  await page.locator('.dashboard-page').waitFor();
  results.push(`Release process ${child.pid} started in ${Date.now() - start}ms`);
  await context.setOffline(true);
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  return context;
}
async function shutdown() {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    if (page && !page.isClosed()) {
      await page
        .getByRole('button', { name: '关闭窗口', exact: true })
        .click({ noWaitAfter: true })
        .catch(() => {});
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    if (child.exitCode === null) {
      child.kill();
      await exited;
      throw new Error('Custom close button failed to exit release process');
    }
    results.push('Custom titlebar close exited the native process');
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = undefined;
  }
}

try {
  await launch(9223);
  originalPreferences = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
      db: 'sqlite:workbench.db',
      query: "SELECT key,value FROM settings WHERE key IN ('accent','dashboard-layout')",
      values: [],
    }),
  );
  persistedAccent =
    originalPreferences.find((row) => row.key === 'accent')?.value === 'teal' ? 'violet' : 'teal';
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '任务与项目', exact: true })
    .click();
  await page.getByLabel('快速添加任务', { exact: true }).fill(marker);
  await page.getByLabel('快速添加任务', { exact: true }).press('Enter');
  await page.getByRole('button', { name: new RegExp('^' + marker) }).waitFor();
  await page.evaluate(
    async ({ marker, linkedPlan, secondPlan }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const [task] = await invoke('plugin:sql|select', {
        db: 'sqlite:workbench.db',
        query: 'SELECT id FROM tasks WHERE title=? AND project_id IS NULL',
        values: [marker],
      });
      if (!task) throw new Error('Temporary release task missing');
      for (const action of ['complete', 'reopen']) {
        const count = await invoke('batch_tasks', { ids: [task.id], action });
        if (count !== 1) throw new Error('Release native batch command failed');
      }
      const stamp = new Date().toISOString();
      await invoke('plugin:sql|execute', {
        db: 'sqlite:workbench.db',
        query:
          'INSERT INTO schedules(id,task_id,title,date,period,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        values: [
          linkedPlan,
          task.id,
          marker + ' linked plan',
          '2026-11-13',
          'morning',
          '',
          stamp,
          stamp,
        ],
      });
    },
    { marker, linkedPlan, secondPlan },
  );
  results.push(
    'Release native bulk command completed/reopened the temporary task; added one linked plan for cascade verification',
  );
  await page.evaluate(
    async ({ linkedPlan, secondPlan }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const [existing] = await invoke('plugin:sql|select', {
        db: 'sqlite:workbench.db',
        query: 'SELECT * FROM schedules WHERE id=?',
        values: [linkedPlan],
      });
      const count = await invoke('save_task_schedules', {
        taskId: existing.task_id,
        expected: [{ id: linkedPlan, updated_at: existing.updated_at }],
        plans: [existing, { ...existing, id: secondPlan, date: '2026-11-14', period: 'afternoon' }],
      });
      if (count !== 2) throw new Error('Release task schedules transaction failed');
    },
    { linkedPlan, secondPlan },
  );
  results.push('Release task schedules command atomically saved two executions');
  await page.getByRole('button', { name: `完成任务：${marker}`, exact: true }).click();
  await page
    .getByRole('group', { name: '任务状态筛选', exact: true })
    .getByRole('button', { name: '已完成', exact: true })
    .click();
  await page.getByRole('button', { name: `归档任务：${marker}`, exact: true }).click();
  await page
    .getByRole('group', { name: '任务分类', exact: true })
    .getByRole('button', { name: '归档', exact: true })
    .click();
  await page.getByRole('button', { name: new RegExp('^' + marker) }).waitFor();
  results.push('Offline release created, completed and archived a task through UI');
  await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
  await page
    .getByRole('group', { name: '个性化颜色', exact: true })
    .getByRole('button', { name: persistedAccent === 'teal' ? '青绿' : '紫罗兰', exact: true })
    .click();
  await page.waitForFunction(
    (value) => document.documentElement.dataset.accent === value,
    persistedAccent,
  );
  await page.getByRole('navigation').getByRole('button', { name: '总览', exact: true }).click();
  await page.waitForTimeout(850);
  for (const [axis, ratio] of [
    ['columns', 0.47],
    ['rows', 0.57],
  ]) {
    const bar = await page.locator(`.splitter-${axis}`).boundingBox(),
      box = await page
        .locator(axis === 'columns' ? '.dashboard-columns' : '.dashboard-workbench')
        .boundingBox();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      axis === 'columns' ? box.x + 6 + (box.width - 12) * ratio : bar.x + bar.width / 2,
      axis === 'rows' ? box.y + 6 + (box.height - 12) * ratio : bar.y + bar.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    await page.waitForTimeout(350);
  }
  persistedLayout = await page.evaluate(async () => {
    const [row] = await window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
      db: 'sqlite:workbench.db',
      query: "SELECT value FROM settings WHERE key='dashboard-layout'",
      values: [],
    });
    return JSON.parse(row.value);
  });
  assert(
    Math.abs(persistedLayout.columns - 0.47) < 0.015 &&
      Math.abs(persistedLayout.rows - 0.57) < 0.015,
  );
  results.push('Offline release saved accent and both dashboard splitter ratios through UI');
  await shutdown();
  await launch(9224);
  assert.equal(await page.locator('html').getAttribute('data-accent'), persistedAccent);
  const restoredLayout = await page.evaluate(async () => {
    const [row] = await window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
      db: 'sqlite:workbench.db',
      query: "SELECT value FROM settings WHERE key='dashboard-layout'",
      values: [],
    });
    return JSON.parse(row.value);
  });
  assert.deepEqual(restoredLayout, persistedLayout);
  assert(
    Math.abs(
      Number(
        await page
          .getByRole('separator', { name: '调整今天与截止倒计时宽度' })
          .getAttribute('aria-valuenow'),
      ) - 47,
    ) <= 1,
  );
  results.push(
    'Full process restart restored accent before data display and applied saved dashboard proportions',
  );
  const persistedPlans = await page.evaluate(
    async (ids) =>
      window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
        db: 'sqlite:workbench.db',
        query: 'SELECT id FROM schedules WHERE id IN (?,?)',
        values: ids,
      }),
    [linkedPlan, secondPlan],
  );
  assert.equal(persistedPlans.length, 2);
  results.push('Two execution plans persisted after full release process restart');
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '任务与项目', exact: true })
    .click();
  await page
    .getByRole('group', { name: '任务分类', exact: true })
    .getByRole('button', { name: '归档', exact: true })
    .click();
  await page.getByRole('button', { name: new RegExp('^' + marker) }).click();
  const editor = page.getByRole('dialog', { name: '编辑任务', exact: true });
  assert.match(
    await editor.getByRole('combobox', { name: '状态', exact: true }).innerText(),
    /已完成/,
  );
  await editor
    .getByLabel('备注', { exact: true })
    .fill('Persisted after complete process shutdown and restart');
  await editor.getByRole('button', { name: '保存任务', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: `恢复任务：${marker}`, exact: true }).click();
  await page
    .getByRole('group', { name: '任务分类', exact: true })
    .getByRole('button', { name: '独立任务', exact: true })
    .click();
  await page
    .getByRole('group', { name: '任务状态筛选', exact: true })
    .getByRole('button', { name: '已完成', exact: true })
    .click();
  await page.getByRole('button', { name: new RegExp('^' + marker) }).waitFor();
  results.push(
    'Offline restart retained archive metadata; editing and restoring preserved completion status',
  );
  await page.getByRole('button', { name: new RegExp('^' + marker) }).click();
  await page
    .getByRole('dialog', { name: '编辑任务', exact: true })
    .getByRole('button', { name: '删除任务', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '删除任务', exact: true })
    .getByRole('button', { name: '删除任务', exact: true })
    .click();
  await page.getByRole('dialog', { name: '编辑任务', exact: true }).waitFor({ state: 'hidden' });
  const remainingPlan = await page.evaluate(
    async (id) => {
      return window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
        db: 'sqlite:workbench.db',
        query: 'SELECT id FROM schedules WHERE id IN (?,?)',
        values: id,
      });
    },
    [linkedPlan, secondPlan],
  );
  assert.equal(remainingPlan.length, 0);
  results.push('Removed only the temporary acceptance task via confirmed UI deletion');
  results.push('Migration 6 deleted its linked schedule in the release database');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('navigation').getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('.dashboard-page').waitFor();
  assert.equal(await page.locator('.date-strip .date-cell').count(), 14);
  assert.equal(await page.locator('.today-agenda,.deadline-section,.project-section').count(), 3);
  await page.waitForTimeout(850);
  await page.screenshot({ path: resolve(artifactDir, 'release-dashboard.png'), fullPage: true });
  await page.getByRole('button', { name: '查看月历', exact: true }).click();
  await page.locator('.month-calendar').waitFor();
  assert.equal(await page.locator('.month-day').count(), 42);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: '查看年份', exact: true }).evaluate((el) => el.click());
  await page.waitForTimeout(850);
  await page.getByRole('button', { name: '返回总览', exact: true }).evaluate((el) => el.click());
  await page.locator('.page-transition[data-page="dashboard"][data-present="true"]').waitFor();
  await page.getByRole('button', { name: '查看月历', exact: true }).evaluate((el) => el.click());
  await page.waitForTimeout(850);
  assert.equal(
    await page
      .locator('.page-transition[data-page="calendar"][data-present="true"] .month-day')
      .count(),
    42,
  );
  results.push('Rapid year → overview → calendar reentry resets to month in the offline release');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '查看年份', exact: true }).click();
  await page.locator('.year-calendar').waitFor();
  assert.equal(await page.locator('.year-month').count(), 12);
  const today = await page.evaluate(() => {
    const d = new Date();
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    };
  });
  await page
    .getByRole('button', { name: `展开${today.year}年${today.month}月`, exact: true })
    .click();
  await page.locator(`.month-day[data-date="${today.date}"]`).click();
  results.push('Full month/year calendar and day drill-in work in the offline release');
  await page.getByRole('navigation').getByRole('button', { name: '日程', exact: true }).click();
  const scheduleTicks = page.locator(
    '.page-transition[data-page="schedule"][data-present="true"] .hour-tick',
  );
  await scheduleTicks.first().waitFor();
  assert.equal(await scheduleTicks.count(), 16);
  await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
  const originalThemeLabel = (
    await page.locator('.theme-option[aria-pressed="true"]').innerText()
  ).trim();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.waitForTimeout(250);
  await page.screenshot({
    path: resolve(artifactDir, 'release-settings-dark.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: originalThemeLabel, exact: true }).click();
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  results.push(
    'All four pages, dark theme and SQLite work offline with zero external requests/errors',
  );
  await writeFile(
    resolve(artifactDir, 'release-results.json'),
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        executable: exe,
        results,
        errors,
        externalRequests,
        markerRemoved: true,
      },
      null,
      2,
    ),
  );
  results.forEach((line) => console.log(`PASS ${line}`));
} finally {
  // Only the exact random acceptance task is eligible for emergency cleanup.
  if (page && !page.isClosed())
    await page
      .evaluate(
        async ({ title, linkedPlan, secondPlan }) => {
          await window.__TAURI_INTERNALS__.invoke('plugin:sql|execute', {
            db: 'sqlite:workbench.db',
            query: 'DELETE FROM schedules WHERE id IN (?,?)',
            values: [linkedPlan, secondPlan],
          });
          await window.__TAURI_INTERNALS__.invoke('plugin:sql|execute', {
            db: 'sqlite:workbench.db',
            query: 'DELETE FROM tasks WHERE title=? AND project_id IS NULL',
            values: [title],
          });
        },
        { title: marker, linkedPlan, secondPlan },
      )
      .catch(() => {});
  if (originalPreferences && page && !page.isClosed())
    await page.evaluate(async (original) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      for (const key of ['accent', 'dashboard-layout']) {
        const row = original.find((row) => row.key === key);
        await invoke('plugin:sql|execute', {
          db: 'sqlite:workbench.db',
          query: row
            ? 'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
            : 'DELETE FROM settings WHERE key=?',
          values: row ? [key, row.value] : [key],
        });
      }
    }, originalPreferences);
  await shutdown();
}
