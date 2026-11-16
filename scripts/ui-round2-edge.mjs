import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222'),
  p = b.contexts()[0].pages()[0];
p.setDefaultTimeout(10000);
const repo = (method, args = []) =>
  p.evaluate(
    async ({ method, args }) => {
      const { repository } = await import('/src/data/repository.ts');
      return repository[method](...args);
    },
    { method, args },
  );
const before = await repo('load');
const stamp = new Date().toISOString(),
  id = crypto.randomUUID(),
  pid = crypto.randomUUID(),
  title = `Completion QA ${id.slice(0, 6)}`;
try {
  await repo('save', [
    'projects',
    { id: pid, title, notes: '', created_at: stamp, updated_at: stamp },
  ]);
  await repo('save', [
    'tasks',
    {
      id,
      title,
      notes: '',
      status: 'todo',
      priority: 'medium',
      project_id: pid,
      stage_id: null,
      due_date: null,
      due_time: null,
      created_at: stamp,
      updated_at: stamp,
    },
  ]);
  await p.setViewportSize({ width: 1380, height: 920 });
  await p.reload();
  await p.locator('.dashboard-page').waitFor();
  await p.getByRole('navigation').getByRole('button', { name: '任务与项目', exact: true }).click();
  await p
    .getByRole('group', { name: '任务分类', exact: true })
    .getByRole('button', { name: '项目', exact: true })
    .click();
  await p.getByRole('combobox', { name: '筛选项目', exact: true }).click();
  await p.locator(`[role=option][data-value="${pid}"]:visible`).click();
  await p.evaluate(() => {
    window.__frames = [];
    window.__capture = true;
    function f() {
      if (!window.__capture) return;
      const r = document.querySelector('.task-row');
      window.__frames.push({
        height: r?.getBoundingClientRect().height ?? 0,
        gray: r?.classList.contains('is-done'),
        check: !!r?.querySelector('.check-drawing'),
        animations: document.getAnimations().length,
      });
      requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
  });
  await p.getByRole('button', { name: `完成任务：${title}`, exact: true }).click();
  await p.waitForTimeout(500);
  const frames = await p.evaluate(() => {
    window.__capture = false;
    return window.__frames;
  });
  assert(frames.some((f) => f.gray && f.check));
  assert(frames.some((f) => f.height > 0 && f.height < 39));
  assert.equal(frames.at(-1).height, 0);
  await writeFile(
    'artifacts/ui-iteration-2/completion-frames.json',
    JSON.stringify(frames, null, 2),
  );
  console.log('PASS Last task in group checks, grays, then collapses over sampled frames');
  await p.setViewportSize({ width: 320, height: 360 });
  await p.getByRole('button', { name: '快速新建', exact: false }).click();
  const dlg = p.getByRole('dialog', { name: '新建任务', exact: true });
  await dlg.getByRole('button', { name: '打开截止日期日历', exact: true }).click();
  await p.getByRole('button', { name: '选择今天', exact: true }).scrollIntoViewIfNeeded();
  await p.getByRole('button', { name: '选择今天', exact: true }).click();
  assert.match(await dlg.getByLabel('截止日期', { exact: true }).inputValue(), /月.*日/);
  await dlg.getByRole('button', { name: '打开截止时间（可选）选择器', exact: true }).click();
  await p
    .getByRole('group', { name: '小时', exact: true })
    .getByRole('button', { name: '23', exact: true })
    .scrollIntoViewIfNeeded();
  await p
    .getByRole('group', { name: '小时', exact: true })
    .getByRole('button', { name: '23', exact: true })
    .click();
  await p
    .getByRole('group', { name: '分钟', exact: true })
    .getByRole('button', { name: '59', exact: true })
    .scrollIntoViewIfNeeded();
  await p
    .getByRole('group', { name: '分钟', exact: true })
    .getByRole('button', { name: '59', exact: true })
    .click();
  await p.getByRole('button', { name: '确认时间', exact: true }).click();
  assert.equal(await dlg.getByLabel('截止时间（可选）', { exact: true }).inputValue(), '23:59');
  await p.screenshot({ path: 'artifacts/ui-iteration-2/compact-editor.png' });
  await dlg.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await dlg.waitFor({ state: 'hidden' });
  console.log('PASS Calendar and all hour/minute options reachable at 320×360');
  await p.setViewportSize({ width: 1380, height: 920 });
  await p.getByRole('navigation').getByRole('button', { name: '总览', exact: true }).click();
  await repo('load'); // Warm the dev-module URL before network emulation.
  await p.context().setOffline(true);
  await p.getByRole('button', { name: '新建任务', exact: true }).click();
  await p.getByLabel('任务标题', { exact: true }).fill(title + ' offline');
  await p.getByRole('button', { name: '保存任务', exact: true }).click();
  await p.getByRole('dialog', { name: '新建任务', exact: true }).waitFor({ state: 'hidden' });
  assert((await repo('load')).tasks.some((t) => t.title === title + ' offline'));
  console.log('PASS Native SQLite task creation with WebView network offline');
} finally {
  await p.context().setOffline(false);
  const current = await repo('load');
  for (const t of current.tasks.filter((t) => t.id === id || t.title === title + ' offline'))
    await repo('remove', ['tasks', t.id]);
  await repo('remove', ['projects', pid]);
  assert.deepEqual(await repo('load'), before);
  await p.setViewportSize({ width: 1380, height: 920 });
  await p.reload();
  await p.locator('.dashboard-page').waitFor();
  await b.close();
}
