import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

// No provider calls or conversation writes. Restore the original context toggle.
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(15000);
let original;
const checkbox = () => page.getByRole('checkbox', { name: '读取本地工作台数据' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.assistant-context-toggle');
    return el && !el.disabled;
  }, null, { timeout: 60000 });
  await page.waitForTimeout(900);
  original = await checkbox().getAttribute('aria-checked');
  const result = await page.evaluate(async () => {
    const cube = document.querySelector('.assistant-caption-cube');
    const toggle = document.querySelector('.assistant-context-toggle');
    const traces = new Map(), heights = new Set();
    let sampling = true, raf;
    const sample = () => {
      heights.add(cube.clientHeight);
      for (const face of cube.querySelectorAll('[data-caption-sequence]')) {
        const key = face.dataset.captionSequence;
        const matrix = new DOMMatrixReadOnly(getComputedStyle(face).transform);
        const angle = Math.atan2(matrix.m23, matrix.m22) * 180 / Math.PI;
        if (!traces.has(key)) traces.set(key, []);
        traces.get(key).push(angle);
      }
      if (sampling) raf = requestAnimationFrame(sample);
    };
    sample();
    for (let i = 0; i < 12; i++) {
      toggle.click();
      await new Promise(resolve => setTimeout(resolve, 65));
    }
    await new Promise(resolve => setTimeout(resolve, 700));
    sampling = false; cancelAnimationFrame(raf);
    const reversals = [...traces].flatMap(([key, angles]) => angles.flatMap((angle, i) => i && angle < angles[i - 1] - .25 ? [{ key, before: angles[i - 1], after: angle }] : []));
    return { faces: traces.size, reversals, heights: [...heights], remainingFaces: cube.querySelectorAll('p').length, frames: [...traces.values()].reduce((sum, rows) => sum + rows.length, 0) };
  });
  assert.equal(result.reversals.length, 0, JSON.stringify(result.reversals));
  assert.equal(result.faces, 13);
  assert.equal(result.heights.length, 1);
  assert.equal(result.remainingFaces, 1);
  assert.equal(await checkbox().getAttribute('aria-checked'), original);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await checkbox().evaluate(el => el.click());
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.assistant-caption-cube p').count(), 1);
  await checkbox().evaluate(el => el.click());
  await page.waitForTimeout(80);
  assert.equal(await checkbox().getAttribute('aria-checked'), original);
  assert.deepEqual(errors, []);
  await mkdir('artifacts/caption-direction', { recursive: true });
  await writeFile('artifacts/caption-direction/result.json', JSON.stringify({ passed: true, ...result }, null, 2));
  console.log(JSON.stringify({ passed: true, ...result }, null, 2));
} finally {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (original !== undefined && await checkbox().getAttribute('aria-checked') !== original) {
    await checkbox().evaluate(el => el.click());
    await page.waitForTimeout(650);
  }
  await browser.close();
}
