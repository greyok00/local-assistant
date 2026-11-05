// Browser/device matrix for the library assistant.
// Every case opens the shipped Desktop copy, launches the assistant the way a
// visitor would, asks one grounded question, and records:
//   - the header status text (must be "Online" in every case)
//   - whether a written or quoted answer came back
//   - any compatibility wording leaking into the panel (must be none)
//   - console errors and failed requests (excluding third-party telemetry)
//
//   node demo/scripts/matrix-assistant.mjs [case...]
//
// Cases: chromium-gpu, chromium-nogpu, firefox, chromium-mobile, webkit-mobile
import pkg from '../../product/node_modules/playwright-core/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const { chromium, firefox, webkit } = pkg;
const BASE = 'http://127.0.0.1:4192/';
const PAGE = 'index.html';
const QUESTION = process.env.Q || 'What is chain of custody in digital forensics?';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SHOTS = path.join(REPO, 'demo/bench/shots');
const OUT = path.join(REPO, 'demo/bench/results/matrix-assistant.json');

const BANNED = [
  'fallback', 'cpu mode', 'compatibility', 'webgpu', 'webgpu off',
  "can't run", 'cannot run', 'not supported here'
];

const GPU_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist'
];

const results = [];

async function run(name, launcher) {
  const started = Date.now();
  const rec = { case: name, ok: false, problems: [] };
  let browser;
  try {
    const { browser: b, context } = await launcher();
    browser = b;
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 200)));

    await page.goto(BASE + PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('.la-launcher', { timeout: 30000 });
    await page.click('.la-launcher');

    // The assistant installs itself; the input unlocks when the engine is up.
    await page.waitForFunction(() => {
      const i = document.querySelector('.la-input');
      return i && !i.disabled;
    }, { timeout: 240000 });
    rec.readyMs = Date.now() - started;

    rec.status = (await page.textContent('.la-status').catch(() => ''))?.trim();

    const greeting = ((await page.textContent('.la-bubble').catch(() => '')) || '').trim();
    await page.fill('.la-input', QUESTION);
    await page.press('.la-input', 'Enter');
    // The turn is over when an answer card holds text and the header is no
    // longer reporting that it is thinking.
    await page.waitForFunction((greet) => {
      const cards = [...document.querySelectorAll('.la-bubble')]
        .filter((b) => !b.closest('.la-consent') && !b.classList.contains('la-progress'));
      const text = cards.map((a) => (a.textContent || '').trim()).join(' ');
      const status = (document.querySelector('.la-status')?.textContent || '').trim();
      return text.length > 40 && text !== greet && status !== 'Thinking…';
    }, greeting, { timeout: 420000 });

    const panel = (await page.textContent('.la-panel')) || '';
    const meta = (await page.textContent('.la-meta')) || '';
    rec.answer = (await page.$$eval('.la-bubble', (bs) => {
      const b = bs[bs.length - 1];
      return (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    }).catch(() => '')) || '';
    rec.sources = await page.$$eval('.la-sources a', (els) => els.length).catch(() => 0);
    rec.panelChars = panel.length;
    rec.statusText = meta.replace(/\s+/g, ' ').trim();

    const haystack = (panel + ' ' + meta).toLowerCase();
    rec.banned = BANNED.filter((w) => haystack.includes(w));
    if (rec.banned.length) rec.problems.push('compatibility wording visible: ' + rec.banned.join(', '));
    if (rec.status && rec.status !== 'Online') rec.problems.push('status not Online: ' + rec.status);
    if (!/\w{3}/.test(rec.answer)) rec.problems.push('no answer text');
    // Errors from the model host or local mirror count; analytics noise does not.
    rec.consoleErrors = consoleErrors.filter((e) => !/favicon|analytics|gtag|cloudflare/i.test(e)).slice(0, 5);
    if (rec.consoleErrors.length) rec.problems.push('console errors: ' + rec.consoleErrors.length);

    await page.screenshot({ path: `${SHOTS}/matrix-${name}.png`, fullPage: false });
    rec.ok = rec.problems.length === 0;
  } catch (err) {
    rec.problems.push('FAILED: ' + (err.message || String(err)).slice(0, 300));
  } finally {
    try { await browser?.close(); } catch {}
  }
  rec.ms = Date.now() - started;
  results.push(rec);
  console.log(JSON.stringify(rec, null, 2));
  return rec;
}

const cases = {
  'chromium-gpu': async () => {
    const browser = await chromium.launch({ args: GPU_FLAGS, headless: true });
    return { browser, context: await browser.newContext() };
  },
  'chromium-nogpu': async () => {
    // A browser without WebGPU at all: the case every non-Chromium visitor has.
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
    return { browser, context };
  },
  'chromium-blocked': async () => {
    // Nothing can load: no WebGPU and the model files are unreachable. The
    // assistant must still open, say only "Online", and answer from the pages.
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
    // Block every language-model file, but leave the search embedder alone:
    // quoting the pages is the last rung and must still work.
    await context.route('**/models/**', (r) => (
      /SmolLM2|HuggingFaceTB/.test(r.request().url()) ? r.abort() : r.continue()
    ));
    return { browser, context };
  },
  firefox: async () => {
    const browser = await firefox.launch({ headless: true });
    return { browser, context: await browser.newContext() };
  },
  'chromium-mobile': async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ...pkg.devices['Pixel 7'], isMobile: true, hasTouch: true
    });
    return { browser, context };
  },
  'webkit-mobile': async () => {
    const browser = await webkit.launch({ headless: true });
    const iphone = pkg.devices['iPhone 15'] || pkg.devices['iPhone 13'];
    return { browser, context: await browser.newContext({ ...iphone }) };
  }
};

await fs.mkdir(SHOTS, { recursive: true });
await fs.mkdir(path.dirname(OUT), { recursive: true });

const want = process.argv.slice(2);
for (const name of (want.length ? want : Object.keys(cases))) {
  if (!cases[name]) { console.error('unknown case', name); continue; }
  await run(name, cases[name]);
}

await fs.writeFile(OUT, JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
console.log('\nwrote', OUT);
