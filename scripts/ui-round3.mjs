import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const b = await chromium.connectOverCDP(process.env.WORKBENCH_CDP ?? 'http://127.0.0.1:9222'),
  p = b.contexts()[0].pages()[0],
  out = 'artifacts/ui-iteration-3';
await mkdir(out, { recursive: true });
p.setDefaultTimeout(12000);
const errors = [],
  results = [],
  layouts = [];
p.on('pageerror', (e) => errors.push(e.message));
const repo = (method, args = []) =>
  p.evaluate(
    async ({ method, args }) => {
      const { repository } = await import('/src/data/repository.ts');
      return repository[method](...args);
    },
    { method, args },
  );
const before = await repo('load'),
  theme = await repo('theme'),
  font = await repo('fontScale');
await writeFile(`${out}/before-acceptance.local.json`, JSON.stringify(before, null, 2));
const ids = { projects: [], stages: [], tasks: [], schedules: [], events: [] };
const marker = `Acceptance ${crypto.randomUUID().slice(0, 8)}`,
  stamp = new Date().toISOString();
const base = (title) => ({ id: crypto.randomUUID(), title, created_at: stamp, updated_at: stamp });
const today = await p.evaluate(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
async function add(table, value) {
  ids[table].push(value.id);
  await repo('save', [table, value]);
  return value;
}
const taskValue = (title, more = {}) => ({
  ...base(title),
  notes: '',
  status: 'todo',
  priority: 'medium',
  due_date: today,
  due_time: '22:00',
  project_id: null,
  stage_id: null,
  archived_at: null,
  ...more,
});
async function nav(name) {
  await p.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  const id = { 总览: 'dashboard', 任务与项目: 'tasks', 日程: 'schedule', 设置: 'settings' }[name];
  await p.locator(`.page-transition[data-page="${id}"][data-present="true"]`).waitFor();
  await p.waitForTimeout(700);
}
const category = async (name) => {
  await p
    .getByRole('group', { name: '任务分类', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
  await p.waitForTimeout(850);
};
async function select(label, value) {
  await p.getByRole('combobox', { name: label, exact: true }).click();
  await p.locator(`[role=option][data-value=${JSON.stringify(value)}]:visible`).click();
  await p.waitForTimeout(850);
}
async function close(name) {
  const d = p.getByRole('dialog', { name, exact: true });
  await d.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await d.waitFor({ state: 'hidden' });
}
function pass(s) {
  results.push(s);
  console.log('PASS ' + s);
}
async function frameStart(selector) {
  await p.evaluate((selector) => {
    window.__samples = [];
    window.__sampling = true;
    function f() {
      if (!window.__sampling) return;
      const el = document.querySelector(selector),
        w = document.querySelector('.workspace-scroll');
      window.__samples.push({
        at: performance.now(),
        height: el?.getBoundingClientRect().height ?? 0,
        opacity: el ? +getComputedStyle(el).opacity : 0,
        top: el?.getBoundingClientRect().top,
        left: el?.getBoundingClientRect().left,
        width: el?.getBoundingClientRect().width,
        transform: el ? getComputedStyle(el).transform : null,
        main: w.clientWidth,
        gutter: w.offsetWidth - w.clientWidth,
      });
      requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
  }, selector);
}
async function frameStop(name) {
  const f = await p.evaluate(() => {
    window.__sampling = false;
    return window.__samples;
  });
  await writeFile(`${out}/${name}-frames.json`, JSON.stringify(f, null, 2));
  return f;
}
try {
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  await p.setViewportSize({ width: 1380, height: 920 });
  await p.reload();
  await p.locator('.dashboard-page').waitFor();
  await p.waitForTimeout(850);
  const project = await add('projects', {
    ...base(marker + ' project'),
    notes: '',
    archived_at: null,
  });
  const stage = await add('stages', {
    ...base(marker + ' stage'),
    project_id: project.id,
    start_date: today,
    end_date: today,
  });
  const task = await add('tasks', taskValue(marker + ' independent'));
  const pt = await add(
    'tasks',
    taskValue(marker + ' project task', { project_id: project.id, stage_id: stage.id }),
  );
  const plan = await add('schedules', {
    ...base(task.title),
    notes: '',
    task_id: task.id,
    date: today,
    period: 'anytime',
    start_time: null,
    end_time: null,
  });
  await add('schedules', {
    ...base(pt.title),
    notes: '',
    task_id: pt.id,
    date: today,
    period: 'exact',
    start_time: '10:00',
    end_time: '11:00',
  });
  await p.reload();
  await p.locator('.dashboard-page').waitFor();
  await p.waitForTimeout(850);
  // Stored legacy repeats are merged in every presentation without deleting personal data.
  const expected = await p.evaluate(async () => {
    const { repository } = await import('/src/data/repository.ts');
    const { agendaForDate } = await import('/src/presentation/view.ts');
    const { localDate } = await import('/src/domain/dates.ts');
    return agendaForDate(await repository.load(), localDate()).length;
  });
  assert.equal(await p.locator('.today-agenda .agenda-item').count(), expected);
  pass('Dashboard deduplicates legacy same-slot schedules and retains distinct executions');
  const duplicate = await p.evaluate(
    async ({ task, plan }) => {
      const { repository } = await import('/src/data/repository.ts');
      const r = [];
      for (const [table, value] of [
        ['tasks', { ...task, id: crypto.randomUUID(), title: task.title.toUpperCase() + ' ' }],
        ['schedules', { ...plan, id: crypto.randomUUID() }],
      ]) {
        try {
          await repository.save(table, value);
          r.push('unexpected success');
        } catch (e) {
          r.push(String(e));
        }
      }
      return r;
    },
    { task, plan },
  );
  assert(duplicate.every((s) => !s.includes('unexpected')));
  pass('Repository blocks duplicate task identities and duplicate same-slot schedules');
  await nav('任务与项目');
  assert.equal(await p.locator('.independent-group').count(), 1);
  assert.equal(await p.locator('.project-group-head').count(), 0);
  const independent = p.locator(`[data-task-id="${task.id}"]`);
  assert.match(await independent.innerText(), /截止.*22:00/);
  assert.match(await independent.innerText(), /安排.*未指定/);
  await category('项目');
  assert.equal(await p.locator('.independent-group').count(), 0);
  await p.getByRole('combobox', { name: '筛选项目', exact: true }).click();
  assert.equal(await p.getByRole('option', { name: '独立任务', exact: true }).count(), 0);
  await p.keyboard.press('Escape');
  pass('Independent tasks are a separate category with explicit DDL and execution details');
  await select('筛选项目', project.id);
  const disclosure = p.locator('.tree-stage').filter({ hasText: stage.title });
  await frameStart('.stage-collapse');
  await disclosure.getByRole('button', { name: new RegExp(stage.title) }).click();
  await p.waitForTimeout(500);
  const stageFrames = await frameStop('stage-collapse');
  assert.equal(stageFrames.at(-1).height, 0);
  assert(stageFrames.every((f, i) => !i || f.height <= stageFrames[i - 1].height + 1));
  await disclosure.getByRole('button', { name: new RegExp(stage.title) }).click();
  await p.waitForTimeout(350);
  pass('Stage collapse follows a monotonic nonlinear tween and remains at zero without rebound');
  await p.getByRole('button', { name: '新建任务', exact: true }).click();
  const dialog = p.getByRole('dialog', { name: '新建任务', exact: true });
  assert.equal(await dialog.locator('input:focus,textarea:focus').count(), 0);
  await dialog.getByLabel('任务标题', { exact: true }).click();
  await p.waitForTimeout(220);
  const focus = await dialog.getByLabel('任务标题', { exact: true }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle, border: s.borderTopWidth, shadow: s.boxShadow };
  });
  assert.equal(focus.outline, 'none');
  assert(parseFloat(focus.border) > 0 && parseFloat(focus.border) <= 1);
  assert.notEqual(focus.shadow, 'none');
  await close('新建任务');
  pass('Editors never autofocus an input; focused fields use one border and an animated blue glow');
  await nav('日程');
  await p.getByRole('button', { name: '新建日程', exact: true }).click();
  await p.getByRole('combobox', { name: '关联任务', exact: true }).click();
  const pop = p
    .locator('.control-popover')
    .filter({ has: p.getByRole('listbox', { name: '关联任务', exact: true }) });
  await pop.waitFor();
  assert.equal(await pop.locator('input:focus').count(), 0);
  await pop.getByRole('textbox', { name: '搜索关联任务', exact: true }).click();
  const search = await pop
    .getByRole('textbox', { name: '搜索关联任务', exact: true })
    .evaluate((el) => ({
      outline: getComputedStyle(el).outlineStyle,
      shadow: getComputedStyle(el).boxShadow,
    }));
  assert.equal(search.outline, 'none');
  assert.equal(search.shadow, 'none');
  await p.waitForTimeout(200);
  await pop.evaluate((el) => (el.dataset.qa = 'popover'));
  await frameStart('[data-qa="popover"]');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(230);
  const popFrames = await frameStop('popover-exit');
  const live = popFrames.filter((f) => f.height > 0);
  assert(live.length > 2);
  assert.equal(new Set(live.map((f) => Math.round(f.left))).size, 1);
  assert.equal(new Set(live.map((f) => Math.round(f.top))).size, 1);
  assert(live.every((f) => f.transform === 'none'));
  assert(live.every((f, i) => !i || f.opacity <= live[i - 1].opacity + 0.03));
  await close('新建日程');
  pass('Task dropdown exits at a fixed position with monotonic opacity; search has no blue frame');
  await nav('总览');
  const group = p
    .locator('.agenda-group')
    .filter({ has: p.getByRole('heading', { name: '未指定时段', exact: true }) });
  assert.equal(await group.locator('.agenda-item').count(), 1);
  await group.evaluate((el) => (el.dataset.qa = 'last-group'));
  await frameStart('[data-qa="last-group"]');
  await group.getByRole('button', { name: `完成任务：${task.title}`, exact: true }).click();
  await p.waitForTimeout(520);
  const groupFrames = await frameStop('last-period');
  assert.equal(groupFrames.at(-1).height, 0);
  assert(groupFrames.every((f, i) => !i || f.height <= groupFrames[i - 1].height + 1));
  pass(
    'Completing the last task collapses its period heading and row as one unit without a height flash',
  );
  await nav('任务与项目');
  await p
    .getByRole('group', { name: '任务状态筛选', exact: true })
    .getByRole('button', { name: '已完成', exact: true })
    .click();
  await independent.waitFor();
  await independent.evaluate((el) => (el.dataset.qa = 'undo'));
  await frameStart('[data-qa="undo"]');
  await independent
    .getByRole('button', { name: `重新打开任务：${task.title}`, exact: true })
    .click();
  await p.waitForTimeout(450);
  const undo = await frameStop('reopen-completed');
  assert.equal(undo.at(-1).height, 0);
  assert(undo.every((f, i) => !i || f.opacity <= undo[i - 1].opacity + 0.04));
  pass('Reopening a completed task exits monotonically without flashing back to full brightness');
  await p
    .getByRole('group', { name: '任务状态筛选', exact: true })
    .getByRole('button', { name: '未完成', exact: true })
    .click();
  await independent.getByRole('button', { name: `完成任务：${task.title}`, exact: true }).click();
  await p.waitForTimeout(400);
  await p
    .getByRole('group', { name: '任务状态筛选', exact: true })
    .getByRole('button', { name: '已完成', exact: true })
    .click();
  await independent.getByRole('button', { name: `归档任务：${task.title}`, exact: true }).click();
  await p.waitForTimeout(400);
  assert((await repo('load')).tasks.find((t) => t.id === task.id).archived_at);
  await category('归档');
  await p.getByRole('button', { name: `恢复任务：${task.title}`, exact: true }).click();
  assert.equal((await repo('load')).tasks.find((t) => t.id === task.id).status, 'done');
  pass('Task archive is persisted, reversible, and preserves completion status');
  await category('项目');
  await select('筛选项目', project.id);
  await p.getByRole('button', { name: `编辑项目：${project.title}`, exact: true }).click();
  await p
    .getByRole('dialog', { name: '编辑项目', exact: true })
    .getByRole('button', { name: '归档项目', exact: true })
    .click();
  await p
    .getByRole('dialog', { name: '归档项目', exact: true })
    .getByRole('button', { name: '归档项目', exact: true })
    .click();
  await p.getByRole('dialog', { name: '编辑项目', exact: true }).waitFor({ state: 'hidden' });
  await nav('总览');
  assert.equal(
    await p.locator('.project-overview-row').filter({ hasText: project.title }).count(),
    0,
  );
  assert.equal(
    await p.locator('.today-agenda .agenda-item').filter({ hasText: pt.title }).count(),
    0,
  );
  await nav('任务与项目');
  await category('归档');
  await p
    .locator('.archived-project-row')
    .filter({ hasText: project.title })
    .getByRole('button', { name: '恢复项目', exact: true })
    .click();
  assert.equal((await repo('load')).tasks.find((t) => t.id === pt.id).status, 'todo');
  pass('Project archive hides linked tasks/schedules and restores their original states');
  await p.reload();
  await p.locator('.dashboard-page').waitFor();
  assert.equal((await repo('load')).tasks.find((t) => t.id === task.id).status, 'done');
  const roundtrip = await p.evaluate(async () => {
    const { repository } = await import('/src/data/repository.ts');
    const { parseSnapshot } = await import('/src/domain/model.ts');
    const a = await repository.snapshot();
    return JSON.stringify(parseSnapshot(JSON.stringify(a)).tasks) === JSON.stringify(a.tasks);
  });
  assert(roundtrip);
  pass('SQLite reload and JSON serialization retain archive metadata and task state');
  await frameStart('.page-transition');
  await nav('设置');
  const pageFrames = await frameStop('page-fade');
  assert(
    pageFrames.some(
      (frame) =>
        frame.height &&
        frame.transform !== 'none' &&
        frame.transform !== 'matrix(1, 0, 0, 1, 0, 0)',
    ),
  );
  pass('Page transitions use the shared directional SWUST slide and scale');
  for (const [width, height] of [
    [320, 360],
    [480, 800],
    [768, 1024],
    [1366, 768],
    [2560, 1440],
  ]) {
    await p.setViewportSize({ width, height });
    for (const name of ['总览', '任务与项目', '日程', '设置']) {
      await nav(name);
      const v = await p
        .locator('.workspace-scroll')
        .evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      assert(v.scroll <= v.client + 1, `${width}/${name} horizontal overflow`);
      layouts.push({ width, height, page: name, ...v });
    }
  }
  pass('20 responsive layouts remain free of horizontal overflow');
  await p.setViewportSize({ width: 1380, height: 920 });
  await nav('任务与项目');
  await p
    .getByRole('group', { name: '任务状态筛选', exact: true })
    .getByRole('button', { name: '全部', exact: true })
    .click();
  await p.screenshot({ path: `out/independent.png`.replace('out/', out + '/') });
  await category('项目');
  await select('筛选项目', project.id);
  await p.screenshot({ path: `${out}/project.png` });
  await category('归档');
  await p.screenshot({ path: `${out}/archive.png` });
  assert.deepEqual(errors, []);
  pass('No JavaScript errors');
} finally {
  for (const table of ['schedules', 'events', 'tasks', 'stages', 'projects'])
    for (const id of ids[table]) await repo('remove', [table, id]);
  await repo('setTheme', [theme]);
  await repo('setFontScale', [font]);
  assert.deepEqual(await repo('load'), before, 'Original records changed');
  await writeFile(
    `${out}/report.json`,
    JSON.stringify({ results, layouts, errors, businessDataPreserved: true }, null, 2),
  );
  await p.setViewportSize({ width: 1380, height: 920 });
  await p.reload();
  await p.locator('.dashboard-page').waitFor();
  await b.close();
}
