import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const fixture = JSON.parse(
  await readFile('artifacts/assistant/restart-fixture.local.json', 'utf8'),
);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
const api = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { assistantRepository: r } = await import('/src/data/assistant.ts');
      return r[method](...args);
    },
    { method, args },
  );
const repo = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) => {
      const { repository: r } = await import('/src/data/repository.ts');
      return r[method](...args);
    },
    { method, args },
  );
try {
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(650);
  await page.getByRole('button', { name: fixture.marker, exact: true }).click();
  await page.getByText('已保存到工作台', { exact: true }).waitFor();
  const messages = await api('messages', [fixture.conversation.id]);
  assert.equal(messages.filter((m) => m.draft_state === 'applied').length, 1);
  assert.equal(messages.filter((m) => m.draft_state === 'cancelled').length, 1);
  const data = await repo('load');
  assert.equal(data.tasks.filter((t) => t.id === fixture.taskId).length, 1);
  assert.equal(data.schedules.filter((s) => s.task_id === fixture.taskId).length, 2);
  await writeFile(
    'artifacts/assistant/restart-result.json',
    JSON.stringify({ passed: true, history: true, draftState: true, businessRows: true }),
  );
  console.log(
    'Actual process restart: local history, edited draft state and linked business records persisted.',
  );
} finally {
  await repo('remove', ['tasks', fixture.taskId]);
  await repo('remove', ['events', fixture.eventId]);
  await api('remove', [fixture.conversation.id]);
  assert.deepEqual(await repo('load'), fixture.before, 'user business data must remain unchanged');
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(650);
  await browser.close();
}
