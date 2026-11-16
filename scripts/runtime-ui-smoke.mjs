// Controlled model events + real Tauri/SQLite operation commands. All records
// are uniquely scoped fixtures; no API request or user-data export is performed.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(18000);
const out = 'artifacts/runtime-ui';
await mkdir(out, { recursive: true });
const marker = `RuntimeUI ${crypto.randomUUID().slice(0, 8)}`,
  conversationId = crypto.randomUUID();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const ai = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const url = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((s) => s.includes('/src/data/assistant.ts'));
      return (await import(url || '/src/data/assistant.ts')).assistantRepository[method](...args);
    },
    { method, args },
  );
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) =>
      (await import('/src/data/repository.ts')).repository[method](...args),
    { method, args },
  );
const input = () =>
  page
    .locator('[data-view="assistant-chat"][data-present="true"]')
    .getByRole('textbox', { name: '给 AI 助手的消息' });
const settled = async () => {
  await page.waitForTimeout(200);
  await page.waitForFunction(() => !document.querySelector('button[aria-label="停止生成"]'));
};
const send = async (text) => {
  await input().fill(text);
  await input().press('Enter');
  await settled();
};
const install = async ({ marker, conversationId }) => {
  const url = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((s) => s.includes('/src/data/assistant.ts'));
  const { assistantRepository: a } = await import(url);
  const { repository: r, assistantDatabase } = await import('/src/data/repository.ts');
  const db = await assistantDatabase();
  a.configured = async () => true;
  const base = () => ({
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const make = async (request, title, actions) => {
    const data = await r.load(),
      preview = [],
      now = new Date().toISOString();
    for (const action of actions) {
      action.id ??= crypto.randomUUID();
      if (action.action === 'create' && action.table === 'schedules')
        action.fields = { date: '2026-11-13', period: 'afternoon', ...action.fields };
      const before = data[action.table].find((row) => row.id === action.id) ?? null;
      const defaults =
        action.table === 'tasks'
          ? {
              notes: '',
              status: 'todo',
              priority: 'medium',
              due_date: null,
              due_time: null,
              project_id: null,
              stage_id: null,
              archived_at: null,
            }
          : action.table === 'schedules'
            ? {
                notes: '',
                task_id: null,
                date: '2026-11-13',
                period: 'afternoon',
                start_time: null,
                end_time: null,
                completed_at: null,
              }
            : action.table === 'projects'
              ? { notes: '', archived_at: null }
              : action.table === 'events'
                ? { notes: '', kind: 'event' }
                : {};
      const after =
        action.action === 'delete'
          ? null
          : {
              ...(before || { ...base(), ...defaults, id: action.id }),
              ...action.fields,
              updated_at: now,
            };
      const affected = before ? [{ table: action.table, record: before }] : [];
      if (action.action === 'delete' && action.table === 'tasks')
        for (const s of data.schedules
          .filter((s) => s.task_id === action.id)
          .sort((a, b) => a.id.localeCompare(b.id)))
          affected.push({ table: 'schedules', record: s });
      preview.push({
        key: action.key,
        table: action.table,
        action: action.action,
        id: action.id,
        before,
        after,
        affected,
      });
    }
    const op = {
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      message_id: request.context.message_id,
      title,
      state: 'pending',
      revision: 0,
      actions,
      preview,
      receipt: null,
      created_at: now,
      updated_at: now,
    };
    await db.execute(
      'INSERT INTO assistant_operations(id,conversation_id,message_id,title,state,revision,actions,preview,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        op.id,
        conversationId,
        op.message_id,
        title,
        'pending',
        0,
        JSON.stringify(actions),
        JSON.stringify(preview),
        now,
        now,
      ],
    );
    return op;
  };
  const tool = async (request, callback, name, result, state = 'complete') => {
    if (
      state === 'complete' &&
      ['prepare_operation', 'revise_operation', 'present_operation', 'replace_operation'].includes(
        name,
      )
    ) {
      const operation = result.operation ?? result;
      const reason = {
        prepare_operation: 'create',
        revise_operation: 'revise',
        present_operation: 'present',
        replace_operation: 'replace',
      }[name];
      await db.execute(
        'INSERT INTO assistant_operation_presentations(operation_id,message_id,revision,reason,created_at) VALUES (?,?,?,?,?) ON CONFLICT(operation_id,message_id) DO UPDATE SET revision=excluded.revision,reason=excluded.reason',
        [
          operation.id,
          request.context.message_id,
          operation.revision,
          reason,
          new Date().toISOString(),
        ],
      );
    }
    const step = {
      id: crypto.randomUUID(),
      run_id: request.id,
      message_id: request.context.message_id,
      tool: name,
      label: name === 'query_records' ? '查询工作台' : '准备操作预览',
      state,
      result: { ok: state === 'complete', data: result },
    };
    await db.execute(
      "INSERT OR IGNORE INTO assistant_runs(id,conversation_id,message_id,state,started_at) VALUES (?,?,?,'complete',?)",
      [request.id, conversationId, request.context.message_id, new Date().toISOString()],
    );
    const [{ n }] = await db.select('SELECT count(*) AS n FROM assistant_steps WHERE run_id=?', [
      request.id,
    ]);
    await db.execute(
      'INSERT INTO assistant_steps(id,run_id,sequence,tool,label,state,result) VALUES (?,?,?,?,?,?,?)',
      [step.id, request.id, n + 1, name, step.label, state, JSON.stringify(step.result)],
    );
    callback?.(step);
  };
  a.chat = async (request, delta, phase, onTool) => {
    phase?.('understanding');
    const content = request.messages.at(-1)?.content;
    const text =
      typeof content === 'string'
        ? content
        : (content
            ?.filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n') ?? '');
    let answer = '正常回答。';
    if (request.context.operation_event) {
      if (window.__runtimeOffline) throw Error('测试：反馈时断网');
      const op = (await a.operations(conversationId)).find(
        (o) => o.id === request.context.operation_event,
      );
      answer = op.state === 'applied' ? '**已保存**，实际结果已核对。' : `操作状态：${op.state}。`;
    } else if (text.includes('runtime:seed')) {
      const taskA = crypto.randomUUID(),
        taskB = crypto.randomUUID();
      const op = await make(request, '创建验收任务和历史安排', [
        {
          key: 'a',
          id: taskA,
          action: 'create',
          table: 'tasks',
          fields: { title: `${marker} 任务甲`, due_date: '2026-11-15', due_time: '23:59' },
        },
        {
          key: 'b',
          id: taskB,
          action: 'create',
          table: 'tasks',
          fields: { title: `${marker} 任务乙`, due_date: '2026-11-15', due_time: '23:59' },
        },
        {
          key: 'sa',
          action: 'create',
          table: 'schedules',
          fields: {
            title: `${marker} 执行甲`,
            task_id: taskA,
            completed_at: '2026-11-15T08:48:00Z',
          },
        },
        {
          key: 'sb',
          action: 'create',
          table: 'schedules',
          fields: {
            title: `${marker} 执行乙`,
            task_id: taskB,
            completed_at: '2026-11-15T08:48:00Z',
          },
        },
      ]);
      await tool(request, onTool, 'prepare_operation', op);
      answer =
        '## 待你核对\n\n**两项任务**和历史安排的预览已准备。\n\n|任务|截止|\n|---|---|\n|甲|11月15日|\n\n```ts\nconst ready = true;\n```';
    } else if (text.includes('runtime:shift')) {
      const data = await r.load();
      const tasks = data.tasks.filter((t) => t.title.startsWith(marker));
      await tool(request, onTool, 'query_records', {
        table: 'tasks',
        total: tasks.length,
        records: tasks.map((t) => ({
          ...t,
          facts: {
            overdue: true,
            days_until_due: -1,
            schedule_total: 1,
            schedule_pending: 0,
            schedule_completed: 1,
          },
        })),
        as_of: new Date().toISOString(),
      });
      const op = await make(
        request,
        '两项任务顺延两天',
        tasks.map((t, i) => ({
          key: `u${i}`,
          table: 'tasks',
          action: 'update',
          id: t.id,
          fields: { due_date: '2026-11-17' },
        })),
      );
      await tool(request, onTool, 'prepare_operation', op);
      answer = '已准备两项**修改预览**，历史日程保持原样。';
    } else if (text.includes('runtime:refine')) {
      const op = (await a.operations(conversationId)).find((o) => o.state === 'pending');
      const actions = structuredClone(op.actions);
      actions[1].fields.priority = 'high';
      const updated = await a.editOperation(op, actions);
      await tool(request, onTool, 'revise_operation', updated);
      answer = '已原位更新预览，手动备注保留。';
    } else if (text.includes('runtime:replace')) {
      const old = (await a.operations(conversationId)).find(
        (o) => o.state === 'pending' || o.state === 'paused',
      );
      const actions = structuredClone(old.actions);
      actions[0].fields.title = `${marker} 替代休息日`;
      const next = await make(request, '替换验收方案', actions);
      await db.execute(
        "UPDATE assistant_operations SET state='cancelled',superseded_by=?,revision=revision+1 WHERE id=?",
        [next.id, old.id],
      );
      await tool(request, onTool, 'replace_operation', next);
      answer = '原方案已替换，请核对下方新方案。';
    } else if (text.includes('runtime:present')) {
      const op = (await a.operations(conversationId)).find(
        (o) => o.state === 'pending' || o.state === 'paused',
      );
      await tool(request, onTool, 'present_operation', { operation: op, presented: true });
      answer = '最新表单已放在这条回复下方，手动内容保留。';
    } else if (text.includes('runtime:interrupted-present')) {
      const op = (await a.operations(conversationId)).find(
        (o) => o.state === 'pending' || o.state === 'paused',
      );
      await tool(request, onTool, 'present_operation', { operation: op, presented: true });
      throw Error('测试：重新展示后断网');
    } else if (text.includes('runtime:stale')) {
      const op = (await a.operations(conversationId)).find((o) => o.state === 'pending');
      const task = (await r.load()).tasks.find((t) => t.id === op.actions[0].id);
      await r.save('tasks', {
        ...task,
        notes: '其它页面修改',
        updated_at: new Date().toISOString(),
      });
      answer = '模拟其它页面修改完成。';
    } else if (text.includes('runtime:delete')) {
      const task = (await r.load()).tasks.find((t) => t.title === `${marker} 任务甲`);
      const op = await make(request, '删除任务及其历史日程', [
        { key: 'd', table: 'tasks', action: 'delete', id: task.id },
      ]);
      await tool(request, onTool, 'prepare_operation', op);
      answer = '删除影响已列出，请确认。';
    } else if (text.includes('runtime:partial')) {
      delta('**这段正文已经收到**，即使中断也保留。');
      throw Error('测试：连接中断');
    } else if (text.includes('从上一条未完成')) answer = '从断点继续。';
    else if (text.includes('runtime:event')) {
      const op = await make(request, '验收休息日', [
        {
          key: 'e',
          table: 'events',
          action: 'create',
          fields: { title: `${marker} 休息日`, date: '2026-11-19', kind: 'rest' },
        },
      ]);
      await tool(request, onTool, 'prepare_operation', op);
      answer = '休息日预览已准备。';
    }
    phase?.('answering');
    delta(answer);
    return {
      answer,
      proposals: [],
      intent: 'agent',
      draft_action: 'none',
      target_id: null,
      expected_revision: null,
      draft_error: '',
    };
  };
};
let before, history;
const report = {};
// Sample actual rendered frames: terminal states must fade the old form before
// the measured body shrinks, with no width/scrollbar change or scaled text.
const terminalTransition = async (id, button, label, reduced = false) => {
  await page.locator(`[data-operation-id="${id}"]`).scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.evaluate(
    ({ id }) => {
      const samples = [];
      window.__operationMotion = { samples, done: false };
      const started = performance.now();
      const frame = () => {
        const el = document.querySelector(`[data-operation-id="${id}"]`);
        const preview = el?.querySelector('[data-operation-content="preview"]');
        const result = el?.querySelector('[data-operation-content="result"]');
        const rect = el?.getBoundingClientRect();
        samples.push({
          t: performance.now() - started,
          height: rect?.height,
          width: rect?.width,
          state: el?.querySelector('[data-operation-view]')?.getAttribute('data-operation-view'),
          preview: preview ? Number(getComputedStyle(preview).opacity) : null,
          result: result ? Number(getComputedStyle(result).opacity) : null,
          inert: preview?.inert,
          viewport: document.documentElement.clientWidth,
        });
        if (performance.now() - started < 1600) requestAnimationFrame(frame);
        else window.__operationMotion.done = true;
      };
      requestAnimationFrame(frame);
    },
    { id },
  );
  await page
    .locator(`[data-operation-id="${id}"]`)
    .getByRole('button', { name: button, exact: true })
    .click();
  await page.waitForFunction(() => window.__operationMotion.done);
  const samples = await page.evaluate(() => window.__operationMotion.samples);
  const first = samples[0],
    last = samples.at(-1);
  assert(last.height < first.height - 30, `${label}: result did not become compact`);
  assert(
    samples.every((s) => Math.abs(s.width - first.width) < 1 && s.viewport === first.viewport),
    `${label}: scrollbar/width shifted`,
  );
  if (!reduced) {
    assert(
      samples.some((s) => s.preview > 0.05 && s.preview < 0.95),
      `${label}: no form fade-out`,
    );
    assert(
      samples.some((s) => s.result > 0.05 && s.result < 0.95),
      `${label}: no result fade-in`,
    );
    assert(
      samples.filter((s) => s.height > last.height + 2 && s.height < first.height - 2).length >= 4,
      `${label}: height snapped`,
    );
    assert(
      samples.filter((s) => s.preview !== null && s.state !== 'preview').every((s) => s.inert),
      `${label}: outgoing form still interactive`,
    );
    assert(!samples.some((s) => s.preview > 0.05 && s.result > 0.05), `${label}: contents overlap`);
  }
  await writeFile(`${out}/${label}-frames.json`, JSON.stringify(samples, null, 2));
  await page.screenshot({ path: `${out}/${label}-result.png` });
  (report.transitions ??= {})[label] = { passed: true, reduced, frames: samples.length };
};
try {
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(1100);
  before = await repo('load');
  history = await ai('conversations');
  const stamp = new Date().toISOString();
  await ai('create', [{ id: conversationId, title: marker, created_at: stamp, updated_at: stamp }]);
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator(`[data-conversation-id="${conversationId}"] > button:first-child`).click();
  await page.waitForTimeout(900);
  await page.evaluate(install, { marker, conversationId });
  await send('runtime:seed');
  let ops = await ai('operations', [conversationId]),
    seed = ops.find((o) => o.state === 'pending');
  const card = (id) => page.locator(`[data-operation-id="${id}"]`);
  assert.equal(await page.locator('.assistant-markdown h2').count(), 1);
  assert.equal(await page.locator('.assistant-markdown table').count(), 1);
  assert.equal(await page.locator('.assistant-markdown pre').count(), 1);
  assert.equal((await repo('load')).tasks.length, before.tasks.length);
  await card(seed.id).getByRole('button', { name: '确认并保存 4 项', exact: true }).click();
  await settled();
  let data = await repo('load');
  assert.equal(data.tasks.filter((t) => t.title.startsWith(marker)).length, 2);
  const histories = data.schedules.filter((s) => s.title.startsWith(marker));
  assert.equal(histories.length, 2);
  await send('runtime:shift');
  ops = await ai('operations', [conversationId]);
  let batch = ops.find((o) => o.state === 'pending');
  assert.equal(batch.preview.length, 2);
  assert((await card(batch.id).textContent()).includes('11月17日'));
  assert((await page.locator('.agent-query').textContent()).includes('待执行 0 次'));
  await page.getByRole('button', { name: 'API 与隐私设置', exact: true }).click();
  await page.getByRole('button', { name: '回到对话', exact: true }).click();
  await page.waitForTimeout(900);
  assert.equal(await card(batch.id).count(), 1);
  await card(batch.id).getByRole('button', { name: '编辑预览', exact: true }).click();
  await card(batch.id)
    .getByRole('textbox', { name: '预览 u0 备注', exact: true })
    .fill('手动备注必须保留');
  await send('runtime:refine');
  batch = (await ai('operations', [conversationId])).find((o) => o.id === batch.id);
  assert.equal(batch.preview[0].after.notes, '手动备注必须保留');
  assert.equal(batch.preview[1].after.priority, 'high');
  assert.equal(
    (await ai('operations', [conversationId])).filter((o) => o.state === 'pending').length,
    1,
  );
  const owner = async (id) =>
    card(id).evaluate(
      (el) => el.closest('[data-message-id]')?.getAttribute('data-message-id') ?? 'recovery',
    );
  const afterRefine = (await ai('messages', [conversationId])).at(-1);
  assert.equal(await owner(batch.id), afterRefine.id);
  assert.equal(await card(batch.id).count(), 1);
  assert((await page.locator(`[data-operation-reference="${batch.id}"]`).count()) > 0);
  const beforePresent = await ai('operations', [conversationId]);
  await send('runtime:interrupted-present');
  assert.equal(await card(batch.id).count(), 1);
  assert.equal(await owner(batch.id), 'recovery');
  assert.deepEqual(await ai('operations', [conversationId]), beforePresent);
  await send('runtime:present');
  assert.deepEqual(await ai('operations', [conversationId]), beforePresent);
  assert.equal(await owner(batch.id), (await ai('messages', [conversationId])).at(-1).id);
  assert.equal(await card(batch.id).count(), 1);
  // Old references lead to the only active editor, rather than another confirm button.
  const oldReference = page.locator(`[data-operation-reference="${batch.id}"]`).first();
  await oldReference.getByRole('button', { name: '查看最新版', exact: true }).click();
  assert(await card(batch.id).evaluate((el) => document.activeElement === el));
  await card(batch.id).getByRole('button', { name: '暂停', exact: true }).click();
  await settled();
  assert(
    await card(batch.id).getByRole('button', { name: '确认并保存 2 项', exact: true }).isDisabled(),
  );
  const paused = await ai('operations', [conversationId]);
  await send('runtime:present');
  assert.deepEqual(await ai('operations', [conversationId]), paused);
  assert(
    await card(batch.id).getByRole('button', { name: '确认并保存 2 项', exact: true }).isDisabled(),
  );
  await card(batch.id).getByRole('button', { name: '继续准备', exact: true }).click();
  await settled();
  await card(batch.id).scrollIntoViewIfNeeded();
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/preview-light.png` });
  await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), originalTheme);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/preview-dark.png` });
  // Reload recreates components and proves preview edits/lifecycle persist.
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator(`[data-conversation-id="${conversationId}"] > button:first-child`).click();
  await page.waitForTimeout(900);
  await page.evaluate(install, { marker, conversationId });
  batch = (await ai('operations', [conversationId])).find((o) => o.id === batch.id);
  assert.equal(batch.preview[0].after.notes, '手动备注必须保留');
  await terminalTransition(batch.id, '确认并保存 2 项', 'applied');
  await settled();
  data = await repo('load');
  assert(
    data.tasks
      .filter((t) => t.title.startsWith(marker))
      .every((t) => t.due_date === '2026-11-17' && t.due_time === '23:59'),
  );
  assert.deepEqual(
    data.schedules.filter((s) => s.title.startsWith(marker)),
    histories,
  );
  report.workflow = {
    markdown: true,
    queryCards: true,
    realBatchUpdate: true,
    manualFieldsPreserved: true,
    noDuplicatePreview: true,
    pauseResume: true,
    reloadPersists: true,
    rapidSettingsReturnPreservesEditor: true,
    completedHistoryUnchanged: true,
    currentReplyOwnsOnlyEditor: true,
    redisplayPreservesOperationAndPausedState: true,
    historicalReferenceFindsLatest: true,
  };
  await send('runtime:shift');
  const conflict = (await ai('operations', [conversationId])).find((o) => o.state === 'pending');
  await send('runtime:stale');
  const dueBefore = (await repo('load')).tasks
    .filter((t) => t.title.startsWith(marker))
    .map((t) => t.due_date);
  await card(conflict.id).getByRole('button', { name: '确认并保存 2 项', exact: true }).click();
  await settled();
  assert((await card(conflict.id).textContent()).includes('其它页面变化'));
  assert.deepEqual(
    (await repo('load')).tasks.filter((t) => t.title.startsWith(marker)).map((t) => t.due_date),
    dueBefore,
  );
  await terminalTransition(conflict.id, '取消操作', 'cancelled');
  await settled();
  await send('runtime:delete');
  const deletion = (await ai('operations', [conversationId])).find((o) => o.state === 'pending');
  assert((await card(deletion.id).textContent()).includes('同时删除'));
  await card(deletion.id).getByRole('button', { name: '确认删除 1 项', exact: true }).click();
  await settled();
  assert.equal((await repo('load')).tasks.filter((t) => t.title.startsWith(marker)).length, 1);
  assert.equal((await repo('load')).schedules.filter((s) => s.title.startsWith(marker)).length, 1);
  await send('runtime:partial');
  const partial = (await ai('messages', [conversationId])).at(-1);
  assert.equal(partial.response_status, 'partial');
  await page
    .locator(`[data-message-id="${partial.id}"]`)
    .getByRole('button', { name: '从这里继续', exact: true })
    .click();
  await settled();
  await send('runtime:event');
  const replaced = (await ai('operations', [conversationId])).find((o) => o.state === 'pending');
  await send('runtime:replace');
  const middle = (await ai('operations', [conversationId])).find((o) => o.state === 'pending');
  await send('runtime:replace');
  const replacement = (await ai('operations', [conversationId])).find((o) => o.state === 'pending');
  assert.equal(await card(replaced.id).count(), 0);
  assert.equal(await card(middle.id).count(), 0);
  assert.equal(await card(replacement.id).count(), 1);
  const retired = page.locator(`[data-operation-reference="${replaced.id}"]`).first();
  assert((await retired.textContent()).includes('被新方案替换'));
  await retired.getByRole('button', { name: '查看新方案', exact: true }).click();
  assert(await card(replacement.id).evaluate((el) => document.activeElement === el));
  await assert.rejects(ai('applyOperation', [replaced]));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await terminalTransition(replacement.id, '取消操作', 'cancelled-reduced', true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settled();
  await send('runtime:event');
  const event = (await ai('operations', [conversationId])).find((o) => o.state === 'pending');
  await page.evaluate(() => (window.__runtimeOffline = true));
  await card(event.id).getByRole('button', { name: '确认并保存 1 项', exact: true }).click();
  await settled();
  assert.equal(
    (await ai('operations', [conversationId])).find((o) => o.id === event.id).state,
    'applied',
  );
  assert((await page.locator('.assistant-error').textContent()).includes('操作已在本地完成'));
  report.recovery = {
    staleRecordRejectsWholeBatch: true,
    cascadeDeletion: true,
    partialContinuation: true,
    feedbackOfflinePreservesSave: true,
    interruptedRedisplayRecovers: true,
    replacementRetiresOldEditorAndFollowsChain: true,
  };
  await page.setViewportSize({ width: 760, height: 850 });
  await page.waitForTimeout(350);
  const sidebarToggle = page.getByRole('button', { name: '收起助手侧栏', exact: true });
  if (await sidebarToggle.count()) {
    await sidebarToggle.click();
    await page.waitForTimeout(450);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  assert(!overflow);
  await page.screenshot({ path: `${out}/narrow.png` });
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  report.passed = true;
  await writeFile(`${out}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  const data = await repo('load');
  for (const table of ['schedules', 'events', 'tasks', 'stages', 'projects'])
    for (const row of data[table].filter((r) => r.title.startsWith(marker)))
      await repo('remove', [table, row.id]);
  await ai('remove', [conversationId]);
  if (before) assert.deepEqual(await repo('load'), before, 'Original business records changed');
  if (history)
    assert.deepEqual(await ai('conversations'), history, 'Original conversations changed');
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  await browser.close();
}
