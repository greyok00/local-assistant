// Proves the assistant installed in ~/umgc-library works from a deep page:
// the loader is depth-relative, the index resolves next to its config, the
// widget borrows the library's dark paper palette, answers a grounded
// question with live citations, refuses an off-corpus one, and follows the
// library's own light/dark toggle without a reload.
//
//   node demo/scripts/verify-umgc.mjs [profile-dir] [base-url]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pkg from '../../product/node_modules/playwright-core/index.js';

const { chromium } = pkg;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = process.env.DEMO_LIBRARY || path.join(path.dirname(REPO), 'umgc-library');
const profileDir = path.resolve(process.argv[2] || 'demo/build/verify-profile');
const baseUrl = process.argv[3] || 'http://127.0.0.1:4190';
const outPath = 'demo/bench/results/umgc-verify-2026-10-29.json';

const FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist'
];

const REFUSAL = /do not contain an answer|could not build a reliable answer/i;

async function fingerprint() {
  const out = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const stat = await fs.stat(full);
        out.push(`${full}\t${stat.size}\t${stat.mtimeMs}`);
      }
    }
  };
  await walk(SITE);
  out.sort();
  return { files: out.length, digest: crypto.createHash('sha256').update(out.join('\n')).digest('hex') };
}

const before = await fingerprint();
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false, args: FLAGS, viewport: { width: 1400, height: 900 }
});
const page = context.pages()[0] || await context.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
page.on('response', (response) => {
  if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`);
});
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`);
});

const result = { startedAt: new Date().toISOString(), baseUrl, steps: {}, problems };
const step = async (name, fn) => {
  const started = Date.now();
  const value = await fn();
  result.steps[name] = { ms: Date.now() - started, ...value };
  console.log(`[${name}] ${JSON.stringify(result.steps[name])}`);
  return value;
};

const palette = () => page.evaluate(() => {
  const root = document.querySelector('.la-root');
  const styles = getComputedStyle(root);
  const rgb = (node, property) => {
    if (!node) return null;
    const match = getComputedStyle(node)[property].match(/\d+(\.\d+)?/g);
    return match ? match.slice(0, 3).map(Number) : null;
  };
  return {
    vars: {
      accent: styles.getPropertyValue('--la-accent').trim(),
      surface: styles.getPropertyValue('--la-surface').trim(),
      body: styles.getPropertyValue('--la-body').trim(),
      text: styles.getPropertyValue('--la-text').trim()
    },
    mode: styles.colorScheme.trim().split(/\s+/)[0],
    launcher: rgb(document.querySelector('.la-launcher'), 'backgroundColor'),
    panel: rgb(document.querySelector('.la-panel'), 'backgroundColor'),
    page: rgb(document.body, 'backgroundColor')
  };
});

const lastAnswer = () => page.locator('.la-answer').last();
const waitAnswered = async () => {
  await page.waitForFunction(() => {
    const answers = [...document.querySelectorAll('.la-answer')];
    return answers.length > 0 && !answers[answers.length - 1].classList.contains('la-streaming');
  }, null, { timeout: 5 * 60 * 1000 });
};

try {
  await step('cache-reset', async () => {
    await page.goto(`${baseUrl}/digital-forensics/windows-security/bitlocker-overview.html`);
    const dropped = await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) await registration.unregister();
      const names = (await caches.keys()).filter(name => name.startsWith('local-assistant'));
      for (const name of names) await caches.delete(name);
      return names;
    });
    await page.reload();
    problems.length = 0;
    return { dropped };
  });

  const mounted = await step('mount', async () => {
    const webgpu = await page.evaluate(async () => {
      if (!navigator.gpu) return { available: false, reason: 'no navigator.gpu' };
      const adapter = await navigator.gpu.requestAdapter().catch(() => null);
      return { available: !!adapter, reason: adapter ? '' : 'no adapter' };
    });
    await page.waitForSelector('.la-launcher', { state: 'visible', timeout: 30 * 1000 });
    await page.locator('.la-launcher').click();
    const body = (await page.locator('.la-body').innerText()).replace(/\s+/g, ' ').trim();
    return { webgpu, indexError: /site index could not load/i.test(body), body };
  });

  const dark = await step('dark', async () => {
    await page.locator('.la-consent-start').click();
    // Fail visibly instead of idling: a busy GPU or a blocked download shows
    // up as text in the panel, and that is more useful than a 15-minute wait.
    const started = Date.now();
    let state = {};
    while (Date.now() - started < 8 * 60 * 1000) {
      state = await page.evaluate(() => ({
        ready: !!(document.querySelector('.la-input') && !document.querySelector('.la-input').disabled),
        progress: document.querySelector('.la-progress-text')?.textContent || '',
        consent: (document.querySelector('.la-consent')?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
        status: document.querySelector('.la-status')?.textContent || ''
      }));
      console.log(`[load ${Math.round((Date.now() - started) / 1000)}s] ${JSON.stringify(state)}`);
      if (state.ready) break;
      if (/fail|not supported|cannot|could not|WebGPU/i.test(state.consent)) {
        throw new Error(`assistant did not load: ${state.consent}`);
      }
      await page.waitForTimeout(5000);
    }
    if (!state.ready) throw new Error(`assistant did not load: ${JSON.stringify(state)}`);
    await page.screenshot({ path: '/tmp/la-umgc-dark.png' });
    return await palette();
  });

  const grounded = await step('answer', async () => {
    await page.locator('.la-input').fill('How does BitLocker protect data on a drive?');
    await page.locator('.la-send').click();
    await waitAnswered();
    const text = (await lastAnswer().innerText()).replace(/\s+/g, ' ').trim();
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll('.la-panel a[href]')].map(a => a.getAttribute('href'))
        .filter(href => !/^https?:/i.test(href)));
    const statuses = await page.evaluate(async (urls) => Promise.all(
      urls.map(url => fetch(url).then(r => r.status).catch(() => 0))), hrefs);
    await page.screenshot({ path: '/tmp/la-umgc-answer.png' });
    return { text, refused: REFUSAL.test(text), hrefs, statuses };
  });

  const refused = await step('refuse', async () => {
    await page.locator('.la-input').fill('What is the weather in Phoenix today?');
    await page.locator('.la-send').click();
    await waitAnswered();
    const text = (await lastAnswer().innerText()).replace(/\s+/g, ' ').trim();
    return { text, refused: REFUSAL.test(text) };
  });

  const light = await step('light', async () => {
    await page.locator('[data-rl-theme-toggle]').click();
    await page.waitForFunction(() =>
      document.querySelector('.la-root')?.style.getPropertyValue('--la-accent').trim() === '#4d565e');
    await page.waitForTimeout(150);
    await page.screenshot({ path: '/tmp/la-umgc-light.png' });
    return await palette();
  });

  result.checks = {
    widgetMounted: !mounted.indexError,
    darkSurface: dark.vars.surface === '#1f2124',
    darkAccent: dark.vars.accent === '#c9a84c',
    darkPanelMatchesPage: JSON.stringify(dark.panel) === JSON.stringify([31, 33, 36]),
    answeredGrounded: !grounded.refused && /bitlocker|encrypt|protect|recovery/i.test(grounded.text),
    citationsRelative: grounded.hrefs.length > 0 && grounded.hrefs.every(href => href.startsWith('/')),
    citationsLive: grounded.statuses.length > 0 && grounded.statuses.every(status => status === 200),
    offCorpusRefused: refused.refused,
    lightSurface: light.vars.surface === '#f8f9fa',
    lightAccent: light.vars.accent === '#4d565e',
    lightPanelMatchesPage: JSON.stringify(light.panel) === JSON.stringify([248, 249, 250])
  };
} catch (error) {
  result.failure = String(error?.message || error);
  await page.screenshot({ path: '/tmp/la-umgc-failure.png' }).catch(() => {});
} finally {
  await context.close();
}

const after = await fingerprint();
result.site = { before, after, unchanged: before.digest === after.digest && before.files === after.files };
result.finishedAt = new Date().toISOString();
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({
  failure: result.failure || null,
  checks: result.checks,
  siteUnchanged: result.site.unchanged,
  problems: result.problems.slice(0, 5)
}, null, 2));
process.exit(result.failure || Object.values(result.checks || {}).some(value => !value) ? 1 : 0);
