import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const out = 'artifacts/calendar-personalization';
await mkdir(out, { recursive: true });
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { repository } = await import('/src/data/repository.ts');
      return repository[method](...args);
    },
    { method, args },
  );
await page.reload();
await page.locator('.dashboard-page').waitFor();
const before = await repo('load'),
  preferences = await repo('preferences');
const settings = await page.evaluate(() =>
  window.__TAURI_INTERNALS__.invoke('plugin:sql|select', {
    db: 'sqlite:workbench.db',
    query: 'SELECT key,value FROM settings',
    values: [],
  }),
);
const errors = [],
  results = [],
  ids = { projects: [], tasks: [], schedules: [], events: [] };
page.on('pageerror', (error) => errors.push(error.message));
const stamp = new Date().toISOString(),
  marker = `Calendar layout QA ${crypto.randomUUID().slice(0, 7)}`;
const base = (title) => ({ id: crypto.randomUUID(), title, created_at: stamp, updated_at: stamp });
const today = await page.evaluate(async () => {
  const { localDate } = await import('/src/domain/dates.ts');
  return localDate();
});
async function add(table, record) {
  ids[table].push(record.id);
  await repo('save', [table, record]);
  return record;
}
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true });
const settle = () => page.waitForTimeout(850);
async function drag(axis, ratio) {
  const selector = axis === 'columns' ? '.splitter-columns' : '.splitter-rows',
    area = axis === 'columns' ? '.dashboard-columns' : '.dashboard-workbench';
  const bar = await page.locator(selector).boundingBox(),
    box = await page.locator(area).boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    axis === 'columns' ? box.x + 6 + (box.width - 12) * ratio : bar.x + bar.width / 2,
    axis === 'rows' ? box.y + 6 + (box.height - 12) * ratio : bar.y + bar.height / 2,
    { steps: 16 },
  );
  await page.mouse.up();
  await settle();
  const saved = (await repo('preferences')).layout;
  assert(Math.abs(saved[axis] - ratio) < 0.015, JSON.stringify(saved));
}
async function currentRoute(name) {
  const pane = page.locator(`.page-transition[data-page="${name}"][data-present="true"]`);
  await pane.waitFor();
  return pane;
}
async function restoreSettings() {
  await page.evaluate(async (settings) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    for (const key of ['accent', 'dashboard-layout', 'theme']) {
      const old = settings.find((row) => row.key === key);
      if (old)
        await invoke('plugin:sql|execute', {
          db: 'sqlite:workbench.db',
          query:
            'INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          values: [key, old.value],
        });
      else
        await invoke('plugin:sql|execute', {
          db: 'sqlite:workbench.db',
          query: 'DELETE FROM settings WHERE key=?',
          values: [key],
        });
    }
  }, settings);
}
try {
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await repo('setDashboardLayout', [{ columns: 0.6, rows: 0.72 }]);
  for (let i = 0; i < 12; i++)
    await add('projects', { ...base(`${marker} project ${i}`), notes: '', archived_at: null });
  const task = await add('tasks', {
    ...base(marker),
    notes: '',
    status: 'todo',
    priority: 'medium',
    project_id: ids.projects[0],
    stage_id: null,
    due_date: today,
    due_time: '18:00',
    archived_at: null,
  });
  await add('schedules', {
    ...base(marker + ' plan'),
    task_id: task.id,
    date: today,
    period: 'exact',
    start_time: '10:00',
    end_time: '11:00',
    notes: '',
  });
  await add('events', { ...base(marker + ' rest'), date: today, kind: 'rest', notes: '' });
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await settle();
  const horizon = await page.locator('.horizon-section').boundingBox();
  assert(
    await page
      .locator('.project-progress-scroll')
      .evaluate(
        (el) => el.scrollHeight > el.clientHeight && el.offsetWidth - el.clientWidth === 12,
      ),
  );
  await drag('columns', 0.48);
  await drag('rows', 0.55);
  assert.equal((await page.locator('.horizon-section').boundingBox()).height, horizon.height);
  await page.screenshot({ path: out + '/dashboard-custom.png', fullPage: true });
  await nav('设置').click();
  await nav('总览').click();
  await settle();
  assert(
    Math.abs(
      Number(
        await page
          .getByRole('separator', { name: '调整今天与截止倒计时宽度' })
          .getAttribute('aria-valuenow'),
      ) - 48,
    ) <= 1,
  );
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await settle();
  const afterReload = await repo('preferences');
  assert(
    Math.abs(afterReload.layout.columns - 0.48) < 0.015 &&
      Math.abs(afterReload.layout.rows - 0.55) < 0.015,
  );
  results.push(
    'Both splitters resize continuously; horizon fixed; projects scroll in a reserved 12px gutter; layout persists across navigation and SQLite reload',
  );
  await page.evaluate(() => {
    window.__resetFrames = [];
    window.__resetCapture = true;
    function frame() {
      if (!window.__resetCapture) return;
      window.__resetFrames.push(
        document.querySelector('.today-agenda').getBoundingClientRect().width,
      );
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  await page
    .getByRole('button', { name: '恢复默认布局', exact: true })
    .evaluate((el) => el.click());
  await settle();
  const frames = await page.evaluate(() => {
    window.__resetCapture = false;
    return window.__resetFrames;
  });
  assert(new Set(frames.map(Math.round)).size > 8);
  assert(frames.every((value, i) => !i || value >= frames[i - 1] - 0.5));
  assert.deepEqual((await repo('preferences')).layout, { columns: 0.6, rows: 0.72 });
  await page.getByRole('separator', { name: '调整今天与截止倒计时宽度' }).focus();
  await page.keyboard.press('ArrowLeft');
  await settle();
  assert(Math.abs((await repo('preferences')).layout.columns - 0.575) < 0.002);
  await page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
  await settle();
  results.push(
    'Reset interpolates through multiple monotonic widths and saves defaults; keyboard splitter adjustments persist',
  );
  await nav('设置').click();
  await settle();
  const colors = page.getByRole('group', { name: '个性化颜色', exact: true });
  assert.equal(await colors.getByRole('button').count(), 7);
  const names = ['雾蓝', '青绿', '森林', '紫罗兰', '玫瑰', '琥珀', '石墨'];
  const values = ['blue', 'teal', 'green', 'violet', 'rose', 'amber', 'graphite'];
  const contrastResults = [];
  for (const theme of ['浅色', '深色']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    for (let i = 0; i < names.length; i++) {
      await colors.getByRole('button', { name: names[i], exact: true }).click();
      await page.waitForFunction((id) => document.documentElement.dataset.accent === id, values[i]);
      const contrast = await page.evaluate(() => {
        function rgb(name) {
          const el = document.createElement('span');
          el.style.color = `var(${name})`;
          document.body.append(el);
          const c = getComputedStyle(el).color;
          el.remove();
          return c
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number);
        }
        const lum = (c) =>
          c
            .map((v) => {
              v /= 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            })
            .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
        const a = lum(rgb('--primary')),
          b = lum(rgb('--on-primary')),
          c = lum(rgb('--surface'));
        return {
          button: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
          text: (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05),
          overdue: getComputedStyle(document.documentElement).getPropertyValue('--overdue').trim(),
        };
      });
      assert(
        contrast.button >= 4.5 && contrast.text >= 4.5,
        JSON.stringify({ theme, color: names[i], contrast }),
      );
      assert.equal(contrast.overdue, '#c8372d');
      contrastResults.push({ theme, color: names[i], ...contrast });
    }
  }
  await colors.getByRole('button', { name: '紫罗兰', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'violet');
  await page.screenshot({ path: out + '/accents-dark.png', fullPage: true });
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  assert.equal((await repo('preferences')).accent, 'violet');
  assert.equal(await page.locator('html').getAttribute('data-accent'), 'violet');
  await nav('设置').click();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await nav('总览').click();
  await settle();
  results.push({
    test: 'Seven accents in both themes pass 4.5:1 primary/button contrast, preserve overdue color and persist in SQLite',
    contrastResults,
  });

  await page.evaluate(() => {
    window.__depthFrames = [];
    window.__depthCapture = true;
    function frame() {
      if (!window.__depthCapture) return;
      window.__depthFrames.push(
        [...document.querySelectorAll('.page-transition')].map((el) => ({
          present: el.dataset.present === 'true',
          opacity: Number(getComputedStyle(el).opacity),
          scale: new DOMMatrix(getComputedStyle(el).transform).m11,
        })),
      );
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  await page.getByRole('button', { name: '查看月历', exact: true }).evaluate((el) => el.click());
  let pane = await currentRoute('calendar');
  assert.equal(await pane.getAttribute('data-axis'), 'z');
  assert.equal(await pane.getAttribute('data-direction'), '-1');
  await settle();
  const depthFrames = await page.evaluate(() => {
    window.__depthCapture = false;
    return window.__depthFrames;
  });
  assert(depthFrames.some((frame) => frame.some((pane) => !pane.present && pane.scale < 0.98)));
  assert(depthFrames.some((frame) => frame.some((pane) => pane.present && pane.scale > 1.015)));
  assert(
    depthFrames.every(
      (frame) => frame.length <= 2 && frame.reduce((sum, pane) => sum + pane.opacity, 0) > 0.4,
    ),
  );
  await writeFile(out + '/depth-frames.json', JSON.stringify(depthFrames));
  assert.equal(await page.locator('.month-day').count(), 42);
  const day = page.locator(`.month-day[data-date="${today}"]`);
  assert.match(await day.innerText(), /截止/);
  assert.match(await day.innerText(), /休/);
  await page.screenshot({ path: out + '/month.png', fullPage: true });
  await page.getByRole('button', { name: '查看年份', exact: true }).click();
  await settle();
  assert.equal(await page.locator('.year-month').count(), 12);
  await page.screenshot({ path: out + '/year.png', fullPage: true });
  await page
    .getByRole('button', {
      name: `展开${Number(today.slice(0, 4))}年${Number(today.slice(5, 7))}月`,
      exact: true,
    })
    .click();
  await settle();
  const section = page.locator(
    '.calendar-page [data-switch="section"] > .view-switch-pane[data-present="true"]',
  );
  assert.equal(await section.getAttribute('data-axis'), 'z');
  assert.equal(await section.getAttribute('data-direction'), '1');
  await page.locator(`.month-day[data-date="${today}"]`).click();
  pane = await currentRoute('schedule');
  assert.equal(await pane.getAttribute('data-axis'), 'z');
  assert.equal(await pane.getAttribute('data-direction'), '1');
  await settle();
  assert.match(
    await page.locator('.schedule-date-navigation h2').innerText(),
    new RegExp(`${Number(today.slice(5, 7))}月${Number(today.slice(-2))}日`),
  );
  await page.getByRole('button', { name: '查看月历', exact: true }).click();
  await settle();
  results.push(
    'Overview zooms out into full month, month zooms out to year, year expands to month, date drills into the existing schedule; all read the same fixture data',
  );
  // Interrupt depth changes repeatedly; obsolete panes must not accumulate.
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '查看年份', exact: true }).dispatchEvent('click');
    await page.waitForTimeout(60);
    await page
      .getByRole('button', {
        name: `展开${Number(today.slice(0, 4))}年${Number(today.slice(5, 7))}月`,
        exact: true,
      })
      .dispatchEvent('click');
    await page.waitForTimeout(60);
    assert(
      (await page
        .locator('.calendar-page > [data-switch="section"] > .view-switch-pane')
        .count()) <= 2,
    );
  }
  await settle();
  assert.equal(
    await page.locator('.calendar-page [data-switch="section"] > [data-present="false"]').count(),
    0,
  );
  await page.getByRole('button', { name: '查看年份', exact: true }).evaluate((el) => el.click());
  await settle();
  await page.evaluate(() => {
    window.__reentryFrames = [];
    window.__reentryCapture = true;
    function frame() {
      if (!window.__reentryCapture) return;
      window.__reentryFrames.push(
        [...document.querySelectorAll('.page-transition')].map((el) =>
          Number(getComputedStyle(el).opacity),
        ),
      );
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  await page.getByRole('button', { name: '返回总览', exact: true }).evaluate((el) => el.click());
  await currentRoute('dashboard');
  await page.getByRole('button', { name: '查看月历', exact: true }).evaluate((el) => el.click());
  await settle();
  assert.equal(
    await page
      .locator('.page-transition[data-page="calendar"][data-present="true"] .month-day')
      .count(),
    42,
  );
  const reentry = await page.evaluate(() => {
    window.__reentryCapture = false;
    return window.__reentryFrames;
  });
  await writeFile(out + '/reentry-frames.json', JSON.stringify(reentry));
  assert(
    reentry.every(
      (frame) => frame.length <= 2 && frame.reduce((sum, value) => sum + value, 0) > 0.4,
    ),
  );
  results.push(
    'Rapid year → overview → calendar reentry always opens month and retains a visible background without blank frames',
  );
  await page.setViewportSize({ width: 320, height: 600 });
  await settle();
  assert(
    await page.locator('.workspace-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await page.getByRole('button', { name: '查看年份', exact: true }).click();
  await settle();
  assert.equal(await page.locator('.year-month').count(), 12);
  assert(
    await page.locator('.workspace-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await nav('总览').click();
  await settle();
  assert.equal(await page.locator('.dashboard-splitter:visible').count(), 0);
  assert.deepEqual((await repo('preferences')).layout, { columns: 0.6, rows: 0.72 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '查看月历', exact: true }).click();
  await page.getByRole('button', { name: '查看年份', exact: true }).click();
  await settle();
  assert.equal(await page.locator('.year-month').count(), 12);
  assert.deepEqual(errors, []);
  results.push(
    'Rapid depth reversals settle without stale panes; month/year fit 320px; compact layout preserves saved ratios; reduced motion stays functional',
  );
} finally {
  for (const table of ['schedules', 'events', 'tasks', 'projects'])
    for (const id of ids[table]) await repo('remove', [table, id]);
  await restoreSettings();
  assert.deepEqual(await repo('load'), before);
  assert.deepEqual(await repo('preferences'), preferences);
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await page.locator('.dashboard-page').waitFor();
  await browser.close();
}
await writeFile(
  out + '/native-results.json',
  JSON.stringify({ results, errors, originalBusinessDataPreserved: true }, null, 2),
);
results.forEach((result) =>
  console.log('PASS ' + (typeof result === 'string' ? result : result.test)),
);
