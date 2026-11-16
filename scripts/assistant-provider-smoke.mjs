import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
// Real provider, generic prompts only: no workbench records, attachments or key
// values are read by the test. Nothing is inserted into the conversation DB.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
try {
  const result = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((s) => s.includes('/src/data/assistant.ts'));
    const { assistantRepository: a } = await import(url || '/src/data/assistant.ts');
    const { wireMessages, localContext } = await import('/src/domain/assistant.ts');
    const context = localContext(
      { projects: [], stages: [], tasks: [], schedules: [], events: [] },
      false,
    );
    const messages = [],
      results = [];
    for (const text of [
      '请记住故事中主角叫林舟。只回复一句话。',
      '请写一篇约3000字的中文悬疑小说，主角沿用我刚刚说的名字，直接给出正文，不需要创建任务或读取工作台。',
      '用100字解释刚才故事的悬念，并告诉我主角叫什么。',
    ]) {
      const stamp = new Date().toISOString(),
        base = {
          conversation_id: 'provider-smoke',
          attachments: [],
          proposals: [],
          draft_state: 'none',
          created_at: stamp,
        };
      messages.push({ ...base, id: crypto.randomUUID(), role: 'user', text });
      let chunks = 0;
      const reply = await a.chat(
        {
          id: crypto.randomUUID(),
          model: 'deepseek-flash',
          messages: wireMessages(messages),
          context,
        },
        () => chunks++,
      );
      results.push({
        length: reply.answer.length,
        chunks,
        proposals: reply.proposals.length,
        containsName: reply.answer.includes('林舟'),
        sample: reply.answer.slice(0, 180),
      });
      messages.push({
        ...base,
        id: crypto.randomUUID(),
        role: 'assistant',
        text: reply.answer,
        proposals: reply.proposals,
      });
    }
    return results;
  });
  assert.equal(result.length, 3);
  assert(result.every((r) => r.length > 0 && r.proposals === 0));
  assert(result[1].length > 2000, 'Creative writing should produce a full story.');
  assert(result[1].containsName && result[2].containsName, 'Later turns must keep context.');
  await mkdir('artifacts/assistant-provider', { recursive: true });
  await writeFile('artifacts/assistant-provider/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
