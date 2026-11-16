// Render actual app components with fictional read-only data in a separate Edge
// browser. No Tauri IPC, personal database, credentials or external API is used.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({
  viewport: { width: 1500, height: 1020 },
  deviceScaleFactor: 1,
  timezoneId: 'Asia/Shanghai',
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await mkdir('docs/images', { recursive: true });
try {
  await page.goto('http://127.0.0.1:1420/');
  await page.waitForTimeout(700);
  await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((r) => r.name);
    const module = async (path) => import(urls.find((u) => new URL(u).pathname === path) || path);
    const { repository: r } = await module('/src/data/repository.ts');
    const { assistantRepository: a } = await module('/src/data/assistant.ts');
    const reactModule = await module('/node_modules/.vite/deps/react.js');
    const React = reactModule.default ?? reactModule;
    const domModule = await module('/node_modules/.vite/deps/react-dom_client.js');
    const { createRoot } = domModule.default ?? domModule;
    const { Provider } = await module('/src/state.tsx');
    const { default: App } = await module('/src/App.tsx');
    const date = (offset = 0) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const base = (title) => ({
      id: crypto.randomUUID(),
      title,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const project = {
      ...base('个人作品集'),
      notes: '从想法到第一版作品，按阶段推进。',
      archived_at: null,
    };
    const stage1 = {
      ...base('明确方向'),
      project_id: project.id,
      start_date: date(-5),
      end_date: date(-1),
    };
    const stage2 = {
      ...base('完成第一版'),
      project_id: project.id,
      start_date: date(0),
      end_date: date(7),
    };
    const task = (title, due, project_id = null, stage_id = null, status = 'todo') => ({
      ...base(title),
      notes: '',
      due_date: due,
      due_time: null,
      project_id,
      stage_id,
      status,
      priority: 'medium',
      archived_at: null,
    });
    const tasks = [
      task('整理参考资料', date(-1), project.id, stage1.id, 'done'),
      task('确定作品主题', date(-1), project.id, stage1.id, 'done'),
      task('完成首页草图', date(2), project.id, stage2.id),
      task('准备演示内容', date(5), project.id, stage2.id),
      task('提交课程报告', date(1)),
      task('阅读并整理笔记', date(3)),
    ];
    const schedule = (
      title,
      period,
      start_time = null,
      end_time = null,
      task_id = null,
      offset = 0,
    ) => ({
      ...base(title),
      notes: '',
      date: date(offset),
      period,
      start_time,
      end_time,
      task_id,
      completed_at: null,
    });
    const schedules = [
      schedule('阅读并整理笔记', 'morning', null, null, tasks[5].id),
      schedule('完成首页草图', 'exact', '14:00', '15:30', tasks[2].id),
      schedule('散步与放松', 'evening'),
      schedule('整理课程报告', 'afternoon', null, null, tasks[4].id, 1),
      schedule('作品集交流', 'exact', '10:00', '11:00', null, 3),
    ];
    const data = {
      projects: [project],
      stages: [stage1, stage2],
      tasks,
      schedules,
      events: [
        { ...base('留给自己的休息日'), date: date(4), kind: 'rest', notes: '' },
        { ...base('读书分享'), date: date(6), kind: 'event', notes: '' },
      ],
    };
    r.load = async () => structuredClone(data);
    r.theme = async () => 'light';
    r.fontScale = async () => 'standard';
    r.preferences = async () => ({ accent: 'blue', layout: { columns: 0.6, rows: 0.72 } });
    const conv = { ...base('安排本周的学习与创作') };
    const user = {
      ...base(''),
      conversation_id: conv.id,
      role: 'user',
      text: '明天下午安排一次作品集整理，先让我核对。',
      attachments: [],
      proposals: [],
      draft_state: 'none',
    };
    const assistant = {
      ...base(''),
      conversation_id: conv.id,
      role: 'assistant',
      text: '已准备**明天下午**的独立日程，内容为「整理个人作品集」。\n\n请核对下方预览后保存，具体小时保持未设置。',
      attachments: [],
      proposals: [],
      draft_state: 'none',
    };
    const record = schedule('整理个人作品集', 'afternoon', null, null, null, 1);
    const op = {
      ...base('安排一次作品集整理'),
      conversation_id: conv.id,
      message_id: assistant.id,
      state: 'pending',
      revision: 0,
      actions: [
        { key: 'session', table: 'schedules', action: 'create', id: record.id, fields: record },
      ],
      preview: [
        {
          key: 'session',
          table: 'schedules',
          action: 'create',
          id: record.id,
          before: null,
          after: record,
          affected: [],
        },
      ],
      receipt: null,
    };
    a.configured = async () => true;
    a.conversations = async () => [conv];
    a.messages = async () => [user, assistant];
    a.activity = async () => ({ ops: [op], views: [], trace: [] });
    const original = document.getElementById('root');
    original.id = 'original-root';
    original.style.display = 'none';
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    createRoot(root).render(React.createElement(Provider, null, React.createElement(App)));
    window.__publicDemo = { conv, project };
  });
  const app = page.locator('#root');
  await app.locator('.dashboard-page').waitFor();
  await page.waitForTimeout(1400);
  // Put the day's populated hours into view without altering any preferences.
  await app.locator('.today-agenda').evaluate((el) => {
    const area = [...el.querySelectorAll('*')].find(
      (x) => x.scrollHeight > x.clientHeight + 100 && getComputedStyle(x).overflowY === 'auto',
    );
    if (area) area.scrollTop = 430;
  });
  await page.screenshot({ path: 'docs/images/overview.png' });
  await app
    .getByRole('navigation')
    .getByRole('button', { name: '任务与项目', exact: true })
    .click();
  await page.waitForTimeout(850);
  const projectId = await page.evaluate(() => window.__publicDemo.project.id);
  const projectButton = app.locator(`[data-project-id="${projectId}"]`);
  if (await projectButton.count()) await projectButton.first().click();
  else
    await app
      .getByRole('button', { name: /个人作品集/ })
      .first()
      .click();
  await page.waitForTimeout(850);
  await page.screenshot({ path: 'docs/images/projects.png' });
  await app.getByRole('navigation').getByRole('button', { name: '总览', exact: true }).click();
  await page.waitForTimeout(850);
  await app.getByRole('button', { name: '查看月历', exact: true }).click();
  await page.waitForTimeout(850);
  await page.screenshot({ path: 'docs/images/calendar.png' });
  await app.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForTimeout(1000);
  const convId = await page.evaluate(() => window.__publicDemo.conv.id);
  await app.locator(`[data-conversation-id="${convId}"] > button:first-child`).click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'docs/images/assistant.png' });
  if (errors.length) throw Error(errors.join('\n'));
  console.log('Public screenshots rendered using fictional data only.');
} finally {
  await browser.close();
}
