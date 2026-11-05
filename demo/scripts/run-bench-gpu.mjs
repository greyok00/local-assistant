import pkg from '../../product/node_modules/playwright-core/index.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = pkg;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PROFILE = path.join(REPO, 'demo/build/chromium-profile');
const RESULTS = path.join(REPO, 'demo/bench/results');
const url = 'http://127.0.0.1:4180/local-assistant/bench/bench.html';
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: ['--enable-unsafe-webgpu','--enable-features=Vulkan','--use-angle=vulkan','--ignore-gpu-blocklist']
});
const page = ctx.pages()[0] || await ctx.newPage();
page.on('console', m => { if (m.type()==='error') console.log('PAGE-ERR', m.text().slice(0,200)); });
await page.goto(url);
const adapter = await page.evaluate(async () => {
  const a = await navigator.gpu.requestAdapter();
  return a ? { vendor: a.info?.vendor, arch: a.info?.architecture, maxBuffer: a.limits?.maxBufferSize } : null;
});
console.log('ADAPTER', JSON.stringify(adapter));
await page.click('#la-run');
const start = Date.now();
let last = '';
while (Date.now() - start < 40 * 60 * 1000) {
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => ({
    status: document.getElementById('la-status').textContent,
    rows: document.querySelectorAll('#la-results tbody tr').length,
    summary: document.getElementById('la-summary').textContent.slice(0, 200)
  }));
  if (s.status !== last) { console.log('PROGRESS', Math.round((Date.now()-start)/1000)+'s', JSON.stringify(s).slice(0,300)); last = s.status; }
  if (s.summary.trim().startsWith('{')) {
    const full = await page.evaluate(() => document.getElementById('la-summary').textContent);
    writeFileSync(path.join(RESULTS, 'run-gpu-' + new Date().toISOString().slice(0,10) + '.json'), full);
    console.log('DONE', Math.round((Date.now()-start)/1000)+'s');
    break;
  }
  if (s.summary.startsWith('Bench failed')) { console.log('FAILED', s.summary); break; }
}
await ctx.close();
