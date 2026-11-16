import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const b = await chromium.connectOverCDP(process.env.WORKBENCH_CDP ?? 'http://127.0.0.1:9222'),
  p = b.contexts()[0].pages()[0];
const out = 'artifacts/motion-restore';
await mkdir(out, { recursive: true });
p.setDefaultTimeout(10000);
const results = [],
  errors = [];
p.on('pageerror', (e) => errors.push(e.message));
const pass = (s) => {
  results.push(s);
  console.log('PASS ' + s);
};
async function framesStart() {
  await p.evaluate(() => {
    window.__motionFrames = [];
    window.__motionCapture = true;
    function frame() {
      if (!window.__motionCapture) return;
      const side = document.querySelector('.sidebar'),
        nav = document.querySelector('.sidebar nav'),
        w = document.querySelector('.workspace-scroll'),
        m = document.querySelector('dialog[open] .modal-scroll'),
        surface = document.querySelector('dialog[open] .modal-surface');
      window.__motionFrames.push({
        at: performance.now(),
        side: side.getBoundingClientRect().width,
        navTop: nav.getBoundingClientRect().top,
        label: +getComputedStyle(document.querySelector('.brand div')).opacity,
        width: w.clientWidth,
        gutter: w.offsetWidth - w.clientWidth,
        modalWidth: m?.clientWidth,
        modalGutter: m ? m.offsetWidth - m.clientWidth : null,
        modalOverflow: m ? m.scrollHeight > m.clientHeight + 1 : null,
        surfaceOpacity: surface ? +getComputedStyle(surface).opacity : null,
        surfaceTop: surface?.getBoundingClientRect().top,
        pages: document.querySelectorAll('.page-transition').length,
        animations: document.getAnimations().length,
      });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}
async function framesStop(name) {
  const f = await p.evaluate(() => {
    window.__motionCapture = false;
    return window.__motionFrames;
  });
  await writeFile(`${out}/${name}-frames.json`, JSON.stringify(f, null, 2));
  return f;
}
const nav = (name) =>
  p.getByRole('navigation').getByRole('button', { name, exact: true }).dispatchEvent('click');
try {
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  await p.setViewportSize({ width: 1380, height: 920 });
  await p.reload();
  await p.locator('.dashboard-page').waitFor();
  await p.waitForTimeout(850);
  await framesStart();
  await p.getByRole('button', { name: '收起侧边栏', exact: true }).dispatchEvent('click');
  await p.waitForTimeout(80);
  await p.getByRole('button', { name: '展开侧边栏', exact: true }).dispatchEvent('click');
  await p.waitForTimeout(90);
  await p.getByRole('button', { name: '收起侧边栏', exact: true }).dispatchEvent('click');
  await p.waitForTimeout(70);
  await p.getByRole('button', { name: '展开侧边栏', exact: true }).dispatchEvent('click');
  await p.waitForTimeout(600);
  const sidebar = await framesStop('sidebar-reversal');
  assert(sidebar.length > 20);
  assert(new Set(sidebar.map((f) => Math.round(f.side))).size > 10);
  assert(Math.abs(sidebar.at(-1).side - 230) < 1);
  assert.equal(new Set(sidebar.map((f) => Math.round(f.navTop))).size, 1);
  assert(
    sidebar.every(
      (f, i) =>
        !i ||
        Math.abs(f.side - sidebar[i - 1].side) <
          Math.max(80, (f.at - sidebar[Math.max(0, i - 2)].at) * 2.5),
    ),
  );
  assert(sidebar.some((f) => f.label > 0 && f.label < 1));
  pass('Sidebar reverses mid-animation without width snaps, icon jumps or text wrapping');
  await framesStart();
  await nav('任务与项目');
  await p.waitForTimeout(40);
  await nav('设置');
  await p.waitForTimeout(45);
  await nav('日程');
  await p.waitForTimeout(35);
  await nav('总览');
  await p.waitForTimeout(1000);
  const pages = await framesStop('rapid-navigation');
  assert(pages.every((f) => f.pages <= 2));
  assert.equal(
    await p.locator('.page-transition[data-page="dashboard"][data-present="true"]').count(),
    1,
  );
  assert.equal(await p.locator('.page-transition[inert]').count(), 0);
  assert(pages.some((f) => f.animations > 0));
  pass('Rapid page switching cancels stale entrances and leaves one interactive current page');
  await framesStart();
  await p.getByRole('button', { name: '新建任务', exact: true }).click();
  await p.waitForTimeout(420);
  const dialog = p.getByRole('dialog', { name: '新建任务', exact: true });
  await dialog.getByRole('button', { name: '打开截止日期日历', exact: true }).click();
  await p.waitForTimeout(300);
  const popup = await p.locator('.calendar-popover').evaluate((el) => ({
    open: el.matches(':popover-open'),
    duration: getComputedStyle(el).transitionDuration,
    transform: getComputedStyle(el).transform,
  }));
  assert(popup.open);
  assert.equal(popup.transform, 'none');
  await p.keyboard.press('Escape');
  await dialog.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await p.waitForTimeout(100);
  const modal = await framesStop('modal');
  assert.equal(new Set(modal.map((f) => f.width)).size, 1);
  assert.equal(new Set(modal.map((f) => f.gutter)).size, 1);
  const shown = modal.filter((f) => f.modalWidth);
  assert.equal(new Set(shown.map((f) => f.modalWidth)).size, 1);
  assert.equal(new Set(shown.map((f) => f.modalGutter)).size, 1);
  assert.equal(new Set(shown.map((f) => f.modalOverflow)).size, 1);
  assert(shown.some((f) => f.surfaceOpacity > 0 && f.surfaceOpacity < 0.95));
  assert(shown.some((f) => f.surfaceOpacity > 0.99));
  pass(
    'Modal and custom calendar animate both directions with constant scroll slots and no transient overflow',
  );
  await p.getByRole('button', { name: '新建任务', exact: true }).click();
  await p.waitForTimeout(50);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(35);
  await p.getByRole('button', { name: '快速新建', exact: false }).dispatchEvent('click');
  await p.waitForTimeout(450);
  assert.equal(await p.locator('dialog[open]').count(), 1);
  assert.equal(
    await p.locator('dialog[open] .modal-surface').evaluate((el) => +getComputedStyle(el).opacity),
    1,
  );
  await p.keyboard.press('Escape');
  await p.locator('dialog[open]').waitFor({ state: 'hidden' });
  pass('Interrupted modal close/reopen settles correctly without duplicate dialogs');
  await nav('日程');
  await p.locator('.schedule-page').waitFor();
  await p.waitForTimeout(800);
  const cells = p.locator('.date-strip .date-cell');
  await cells.nth(1).click();
  await p.waitForTimeout(100);
  assert.equal(await p.locator('.date-selection').count(), 1);
  await p.waitForTimeout(650);
  await p.screenshot({ path: `${out}/schedule.png` });
  pass('Date selection uses a spring highlight and day content transitions');
  await nav('任务与项目');
  await p.locator('.task-groups').waitFor();
  await p.waitForTimeout(800);
  await p
    .getByRole('group', { name: '任务分类', exact: true })
    .getByRole('button', { name: '项目', exact: true })
    .click();
  const stage = p.locator('.tree-stage').first();
  if (await stage.count()) {
    await stage.locator('.stage-summary').click();
    await p.waitForTimeout(350);
    assert.equal(await stage.getAttribute('data-open'), 'false');
    await stage.locator('.stage-summary').click();
    await p.waitForTimeout(350);
    assert.equal(await stage.getAttribute('data-open'), 'true');
  }
  pass('Stage disclosure and chevron remain functional with animated expansion');
  await nav('设置');
  await p.waitForTimeout(180);
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await p.waitForTimeout(80);
  assert.equal(
    await p.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    ),
    0,
  );
  await p.getByRole('button', { name: '新建项目', exact: true }).click();
  await p.waitForTimeout(60);
  assert.equal(
    await p.locator('.modal-surface').evaluate((el) => getComputedStyle(el).transform),
    'none',
  );
  await p.keyboard.press('Escape');
  await p.locator('dialog[open]').waitFor({ state: 'hidden' });
  pass('Changing reduced-motion preference during animation immediately settles all content');
  await p.setViewportSize({ width: 320, height: 360 });
  await nav('总览');
  await p.waitForTimeout(100);
  assert.equal(
    await p.locator('.workspace-scroll').evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    true,
  );
  await p.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  assert.equal(await p.locator('main').getAttribute('inert'), '');
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('main').getAttribute('inert'), null);
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  await p.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${out}/drawer.png` });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  pass(
    'Compact drawer preserves its navigation rail and focus/inert boundary in both motion modes',
  );
  await p.setViewportSize({ width: 1380, height: 920 });
  await p.reload();
  await p.locator('.dashboard-page').waitFor();
  await p.waitForTimeout(900);
  await p.screenshot({ path: `${out}/dashboard.png` });
  assert.deepEqual(errors, []);
  pass('No JavaScript errors');
} finally {
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  await p.setViewportSize({ width: 1380, height: 920 });
  await writeFile(`${out}/motion-report.json`, JSON.stringify({ results, errors }, null, 2));
  await b.close();
}
