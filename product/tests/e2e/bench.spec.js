import { test, expect } from '@playwright/test';
import { DEFAULT_CONFIG } from '../../src/config.js';

const BENCH = '/product/bench/bench.html?fake=1&artifact=/product/tests/fixtures/artifact/assistant-index';

test('bench records one result per question with timings', async ({ page }) => {
  await page.goto(BENCH);
  await page.locator('#la-run').click();
  await expect(page.locator('#la-results tbody tr')).toHaveCount(20, { timeout: 120000 });
  const first = page.locator('#la-results tbody tr').first();
  await expect(first.locator('td').nth(2)).not.toHaveText('');
  await expect(first.locator('td').nth(3)).not.toHaveText('');
  // q01 ("What is chain of custody?") overlaps the fixture chunk, so the whole
  // plumbing (gate, prompt build, stream, parse, render) must have produced an
  // answer that cites a passage.
  await expect(first.locator('td[data-field="refused"]')).toHaveText('no');
  await expect(first.locator('td[data-field="answer"]')).toContainText('[1]');
  // With no overrides the summary reports the shipped defaults.
  const payload = JSON.parse(await page.locator('#la-summary').textContent());
  expect(payload.model).toBe(DEFAULT_CONFIG.model);
  expect(payload.modelBaseUrl).toBe(DEFAULT_CONFIG.modelBaseUrl);
});

test('a second run reuses the loaded engine and reports it honestly', async ({ page }) => {
  await page.goto(BENCH);
  await page.locator('#la-run').click();
  await expect(page.locator('#la-results tbody tr')).toHaveCount(20, { timeout: 120000 });
  const first = JSON.parse(await page.locator('#la-summary').textContent());
  expect(first.engineReused).toBe(false);

  await page.locator('#la-run').click();
  await page.waitForFunction(() => {
    try {
      const payload = JSON.parse(document.getElementById('la-summary').textContent);
      return payload.engineReused === true && payload.results.length === 20;
    } catch {
      return false;
    }
  }, null, { timeout: 10000 });
  const second = JSON.parse(await page.locator('#la-summary').textContent());
  // A reused engine is not a cold start: never report a near-zero init as one.
  expect(second.initMs).toBe(0);
  expect(second.engineReused).toBe(true);
});

test('model and modelBaseUrl come from query params and land in the summary', async ({ page }) => {
  await page.goto(`${BENCH}&model=bench-test-model&modelBaseUrl=/vendor/bench-models`);
  await page.locator('#la-run').click();
  await expect(page.locator('#la-results tbody tr')).toHaveCount(20, { timeout: 120000 });
  const payload = JSON.parse(await page.locator('#la-summary').textContent());
  expect(payload.model).toBe('bench-test-model');
  expect(payload.modelBaseUrl).toBe('/vendor/bench-models');
});

test('unanswerable questions are refused by the gate', async ({ page }) => {
  await page.goto(BENCH);
  await page.locator('#la-run').click();
  await expect(page.locator('#la-results tbody tr')).toHaveCount(20, { timeout: 120000 });
  const refused = await page.locator('#la-results tbody tr[data-expect="refuse"] td[data-field="refused"]')
    .evaluateAll(cells => cells.map(c => c.textContent));
  expect(refused).toHaveLength(6);
  expect(refused.every(v => v === 'yes')).toBe(true);
  // ttftMs must be 0 for every refused row, never a timestamp from another run.
  const ttfts = await page.locator('#la-results tbody tr[data-expect="refuse"] td[data-field="ttft"]')
    .evaluateAll(cells => cells.map(c => c.textContent));
  expect(ttfts.every(v => v === '0')).toBe(true);
});

test('fake mode is honoured only on a local host', async ({ page }) => {
  await page.goto('/product/bench/bench.html');
  const flags = await page.evaluate(async () => {
    const { isFakeMode } = await import('/product/bench/bench.js');
    return {
      local: isFakeMode('?fake=1', '127.0.0.1'),
      localhost: isFakeMode('?fake=1', 'localhost'),
      remote: isFakeMode('?fake=1', 'example.com'),
      disabled: isFakeMode('?fake=0', '127.0.0.1'),
      absent: isFakeMode('', '127.0.0.1')
    };
  });
  expect(flags).toEqual({
    local: true, localhost: true, remote: false, disabled: false, absent: false
  });
});

test('a failed run keeps the previous results and the download usable', async ({ page }) => {
  await page.goto(BENCH);
  await page.locator('#la-run').click();
  await expect(page.locator('#la-results tbody tr')).toHaveCount(20, { timeout: 120000 });
  const summaryBefore = await page.locator('#la-summary').textContent();
  await expect(page.locator('#la-save')).toBeEnabled();

  await page.route('**/assistant-index.bin', route => route.fulfill({ status: 500, body: 'boom' }));
  await page.locator('#la-run').click();
  await expect(page.locator('#la-status')).toContainText('Bench failed', { timeout: 10000 });
  await expect(page.locator('#la-results tbody tr')).toHaveCount(20);
  expect(await page.locator('#la-summary').textContent()).toBe(summaryBefore);
  await expect(page.locator('#la-save')).toBeEnabled();
  await expect(page.locator('#la-run')).toBeEnabled();

  // The downloaded JSON is the same object shown in the summary.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#la-save').click();
  const file = await downloadPromise;
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const downloaded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(downloaded).toEqual(JSON.parse(summaryBefore));
});
