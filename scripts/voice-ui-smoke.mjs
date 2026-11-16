// Controlled native voice events; no microphone is opened and no paid API called.
// Real app, real conversation persistence, exact fixture cleanup and data checks.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
const out = 'artifacts/voice-ui';
await mkdir(out, { recursive: true });
const ids = [crypto.randomUUID(), crypto.randomUUID()],
  marker = `VoiceUI ${crypto.randomUUID().slice(0, 8)}`;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const ai = (method, args = []) =>
  page.evaluate(
    async ({ method, args }) =>
      (await import('/src/data/assistant.ts')).assistantRepository[method](...args),
    { method, args },
  );
const data = () =>
  page.evaluate(async () => (await import('/src/data/repository.ts')).repository.load());
const chat = () => page.locator('[data-view="assistant-chat"][data-present="true"]');
const input = () => chat().getByRole('textbox', { name: '给 AI 助手的消息' });
const mic = () => chat().getByRole('button', { name: '开始语音输入', exact: true });
const stop = () => chat().getByRole('button', { name: '停止录音并识别', exact: true });
const cancel = () => chat().getByRole('button', { name: '取消语音输入', exact: true });
const pause = (ms) => page.waitForTimeout(ms);
const stats = () =>
  page.evaluate(() => ({
    starts: window.__voiceTest.starts.length,
    finishes: window.__voiceTest.finishes.length,
    cancelled: window.__voiceTest.cancelled.length,
    chats: window.__voiceTest.chats,
  }));
const resolve = (text) =>
  page.evaluate((text) => {
    const t = window.__voiceTest;
    t.resolve({ text, duration_ms: 3200 });
  }, text);
const begin = async () => {
  await mic().click();
  await stop().waitFor();
  await pause(380);
};
const sampleToolbar = () =>
  page.evaluate(() => {
    const rows = (window.__voiceFrames = []);
    const start = performance.now();
    const frame = () => {
      const c = document.querySelector('[data-view="assistant-chat"][data-present="true"]');
      const slot = c.querySelector('.voice-pill-slot').getBoundingClientRect();
      const model = c.querySelector('.assistant-model').getBoundingClientRect();
      const send = c.querySelector('.assistant-send').getBoundingClientRect();
      rows.push({
        t: performance.now() - start,
        width: slot.width,
        right: slot.right,
        model: model.x,
        send: send.x,
        viewport: document.documentElement.clientWidth,
      });
      if (performance.now() - start < 1100) requestAnimationFrame(frame);
    };
    frame();
  });
const checkMotion = (frames) => {
  const first = frames[0];
  for (const f of frames) {
    const delta = f.width - first.width;
    assert(Math.abs(f.right - first.right) < 1, 'Voice right anchor shifted');
    assert(Math.abs(first.send - f.send - delta) < 2, 'Send did not slide with capsule');
    assert(Math.abs(first.model - f.model - delta) < 2, 'Model did not slide with capsule');
    assert.equal(f.viewport, first.viewport, 'Scrollbar gutter shifted');
  }
};
const install = async () => {
  // Tauri's native invoke is non-writable. Patch every actual loaded ESM instance,
  // including HMR query URLs, and fail closed if the app's module is not found.
  const resources = performance.getEntriesByType('resource').map((r) => r.name);
  const voiceURLs = [
    ...new Set(resources.filter((url) => new URL(url).pathname === '/src/data/voice.ts')),
  ];
  const assistantURLs = [
    ...new Set(resources.filter((url) => new URL(url).pathname === '/src/data/assistant.ts')),
  ];
  if (!voiceURLs.length || !assistantURLs.length)
    throw Error('Actual voice modules not loaded; fixture cannot safely run');
  const t = (window.__voiceTest = {
    starts: [],
    finishes: [],
    cancelled: [],
    chats: 0,
    mode: 'normal',
    timer: null,
    resolve: null,
  });
  const reply = async (events) => {
    t.chats++;
    events.onmessage({ type: 'delta', text: '已收到手动发送的文字。' });
    return JSON.stringify({
      answer: '已收到手动发送的文字。',
      proposals: [],
      intent: 'agent',
      draft_action: 'none',
      target_id: null,
      expected_revision: null,
      draft_error: '',
    });
  };
  const start = async (id, channel) => {
    if (typeof channel?.onmessage !== 'function')
      throw Error('Voice fixture channel was not intercepted');
    const events = (event) => channel.onmessage(event);
    t.starts.push(id);
    t.events = events;
    t.current = id;
    if (t.mode === 'denied') throw Error('没有找到麦克风，请连接设备后重试');
    if (t.mode === 'pending') await new Promise((r) => (t.ready = r));
    const started = performance.now();
    clearInterval(t.timer);
    t.timer = setInterval(
      () =>
        events({
          type: 'level',
          level: 0.3 + 0.3 * Math.sin(performance.now() / 120),
          elapsed_ms: performance.now() - started,
        }),
      50,
    );
  };
  const finish = async (id) => {
    t.finishes.push(id);
    clearInterval(t.timer);
    return new Promise((r, j) => {
      t.resolve = r;
      t.reject = j;
    });
  };
  const cancel = async (id) => {
    t.cancelled.push(id);
    if (t.current === id) {
      clearInterval(t.timer);
      t.timer = null;
    }
  };
  for (const url of voiceURLs) {
    const { voiceRepository: v } = await import(url);
    v.start = (id, onEvent) => start(id, { onmessage: onEvent });
    v.finish = finish;
    v.cancel = cancel;
    if (v.finish !== finish) throw Error('Voice fixture could not be installed');
  }
  for (const url of assistantURLs) {
    const { assistantRepository: a } = await import(url);
    a.configured = async () => true;
    a.chat = async (request, delta) => JSON.parse(await reply({ onmessage: (e) => delta(e.text) }));
  }
};
let before, history;
const report = {};
try {
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await pause(1000);
  before = await data();
  history = await ai('conversations');
  for (const [i, id] of ids.entries()) {
    const stamp = new Date().toISOString();
    await ai('create', [{ id, title: `${marker} ${i}`, created_at: stamp, updated_at: stamp }]);
  }
  await page.reload();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await pause(1000);
  await page.evaluate(install);
  await page.locator(`[data-conversation-id="${ids[0]}"] > button:first-child`).click();
  await pause(900);
  await input().fill('明天复习');
  await input().evaluate((el) => el.setSelectionRange(2, 2));
  await sampleToolbar();
  await begin();
  assert.equal(
    (await stats()).starts,
    1,
    'Voice fixture was not used; aborting before recognition',
  );
  assert(await chat().getByRole('button', { name: '发送消息', exact: true }).isDisabled());
  await input().press('Enter');
  assert.equal((await stats()).chats, 0, 'Enter sent while recording');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await pause(500);
  await page.screenshot({ path: `${out}/recording-light.png` });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await pause(500);
  await page.screenshot({ path: `${out}/recording-dark.png` });
  await pause(1000);
  const frames = await page.evaluate(() => window.__voiceFrames);
  const first = frames[0];
  assert(Math.max(...frames.map((f) => f.width)) - first.width > 70);
  assert(frames.some((f) => f.width > first.width + 5 && f.width < 140));
  checkMotion(frames);
  await writeFile(`${out}/expansion-frames.json`, JSON.stringify(frames, null, 2));
  await stop().click();
  await chat().getByRole('button', { name: '正在识别语音', exact: true }).waitFor();
  await page.screenshot({ path: `${out}/recognizing.png` });
  assert.equal((await stats()).finishes, 1);
  await sampleToolbar();
  await resolve('下午');
  await mic().waitFor();
  await pause(1150);
  const closing = await page.evaluate(() => window.__voiceFrames);
  checkMotion(closing);
  assert(closing.at(-1).width < closing[0].width - 70);
  assert(
    closing.some((f) => f.width > 35 && f.width < closing[0].width - 5),
    'Close snapped instead of sliding',
  );
  await writeFile(`${out}/retraction-frames.json`, JSON.stringify(closing, null, 2));
  assert.equal(await input().inputValue(), '明天下午复习');
  assert.equal((await stats()).chats, 0);
  await input().fill('原有内容');
  await begin();
  await stop().click();
  await input().fill('录音期间的新输入');
  await resolve('语音结果');
  await mic().waitFor();
  assert.equal(await input().inputValue(), '录音期间的新输入\n语音结果');
  report.draftInsertion = true;
  await begin();
  await cancel().click();
  await mic().waitFor();
  assert.equal(await input().inputValue(), '录音期间的新输入\n语音结果');
  await begin();
  await stop().click();
  await page.locator(`[data-conversation-id="${ids[1]}"] > button:first-child`).click();
  await pause(450);
  await input().fill('另一对话的输入');
  await resolve('不能串入');
  await pause(300);
  assert.equal(await input().inputValue(), '另一对话的输入');
  await begin();
  await page.getByRole('button', { name: 'API 与隐私设置', exact: true }).click();
  await pause(350);
  await page.getByRole('button', { name: '回到对话', exact: true }).click();
  await pause(850);
  await mic().waitFor();
  assert.equal(await input().inputValue(), '另一对话的输入');
  report.contextCancellation = true;
  await page.evaluate(() => (window.__voiceTest.mode = 'denied'));
  await mic().click();
  await chat().getByRole('button', { name: '关闭语音提示' }).waitFor();
  assert((await chat().getByRole('alert').textContent()).includes('麦克风'));
  await chat().getByRole('button', { name: '关闭语音提示' }).click();
  await page.evaluate(() => (window.__voiceTest.mode = 'normal'));
  await begin();
  await stop().click();
  await page.evaluate(() => window.__voiceTest.reject(Error('测试：语音识别连接失败')));
  await mic().waitFor();
  assert.equal(await input().inputValue(), '另一对话的输入');
  await chat().getByRole('button', { name: '关闭语音提示' }).click();
  await page.evaluate(() => (window.__voiceTest.mode = 'pending'));
  await mic().click();
  await cancel().click();
  await page.evaluate(() => window.__voiceTest.ready());
  await pause(300);
  await mic().waitFor();
  assert.equal(
    await page.evaluate(() => window.__voiceTest.timer),
    null,
    'Late start did not release the microphone fixture',
  );
  report.failureRecovery = true;
  await page.evaluate(() => (window.__voiceTest.mode = 'normal'));
  await begin();
  await page.evaluate(() => window.__voiceTest.events({ type: 'limit' }));
  await chat().getByRole('button', { name: '正在识别语音', exact: true }).waitFor();
  await resolve('两分钟分段结果');
  await mic().waitFor();
  assert((await input().inputValue()).includes('两分钟分段结果'));
  await page.setViewportSize({ width: 760, height: 850 });
  await pause(400);
  const sidebar = page.getByRole('button', { name: '收起助手侧栏', exact: true });
  if (await sidebar.count()) {
    await sidebar.click();
    await pause(450);
  }
  await begin();
  await page.screenshot({ path: `${out}/narrow.png` });
  assert(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  await cancel().click();
  await mic().waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await begin();
  await cancel().click();
  await mic().waitFor();
  await page.setViewportSize({ width: 420, height: 850 });
  await pause(400);
  await begin();
  assert(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
  await page.screenshot({ path: `${out}/compact.png` });
  await cancel().click();
  await mic().waitFor();
  assert.equal((await stats()).chats, 0, 'Voice sent a message automatically');
  await input().fill('手动发送验收');
  await input().press('Enter');
  await page.waitForFunction(() => window.__voiceTest.chats === 1);
  await pause(500);
  assert.equal((await ai('messages', [ids[1]])).filter((m) => m.role === 'user').length, 1);
  assert.deepEqual(await data(), before, 'Voice changed business records');
  assert.deepEqual(errors, []);
  report.motion = true;
  report.manualSendOnly = true;
  report.passed = true;
  await writeFile(`${out}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await page
    .evaluate(() => {
      if (window.__voiceTest) clearInterval(window.__voiceTest.timer);
    })
    .catch(() => {});
  for (const id of ids) await ai('remove', [id]);
  if (before) assert.deepEqual(await data(), before);
  if (history) assert.deepEqual(await ai('conversations'), history);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1380, height: 920 });
  await page.reload();
  await browser.close();
}
