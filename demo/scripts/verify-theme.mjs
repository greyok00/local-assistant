// Proves the widget takes its palette from the host page: the page here is
// styled with the research library's own theme.css, so its colours are the
// library's paper, ink and vermilion. Then the page flips to its dark paper
// theme and the already-open widget must follow without a reload.
//
//   node demo/scripts/verify-theme.mjs [profile-dir] [base-url]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pkg from '../../product/node_modules/playwright-core/index.js';

const { chromium } = pkg;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIBRARY = process.env.DEMO_LIBRARY || path.join(path.dirname(REPO), 'research-library');
const profileDir = path.resolve(process.argv[2] || 'demo/build/verify-profile');
const baseUrl = process.argv[3] || 'http://127.0.0.1:4180';
const outPath = 'demo/bench/results/theme-verify-2026-10-29.json';

const FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist'
];

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
  await walk(LIBRARY);
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
      onAccent: styles.getPropertyValue('--la-on-accent').trim(),
      surface: styles.getPropertyValue('--la-surface').trim(),
      body: styles.getPropertyValue('--la-body').trim(),
      text: styles.getPropertyValue('--la-text').trim()
    },
    mode: styles.colorScheme.trim().split(/\s+/)[0],
    launcher: rgb(document.querySelector('.la-launcher'), 'backgroundColor'),
    panel: rgb(document.querySelector('.la-panel'), 'backgroundColor'),
    page: rgb(document.body, 'backgroundColor'),
    header: rgb(document.querySelector('.la-header'), 'backgroundColor')
  };
});

try {
  await step('cache-reset', async () => {
    await page.goto(`${baseUrl}/local-assistant/bench/theme.html`);
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

  const light = await step('light', async () => {
    await page.waitForSelector('.la-launcher', { state: 'visible' });
    await page.waitForFunction(() =>
      document.querySelector('.la-root')?.style.getPropertyValue('--la-accent').trim() === '#c8342a');
    const launcher = await palette();
    await page.locator('.la-launcher').click();
    await page.locator('.la-consent').waitFor();
    await page.screenshot({ path: '/tmp/la-theme-light-consent.png' });
    return { ...await palette(), launcherFrom: launcher.launcher };
  });

  await step('answer', async () => {
    await page.locator('.la-consent-start').click();
    await page.waitForFunction(() => {
      const input = document.querySelector('.la-input');
      return input && !input.disabled;
    }, null, { timeout: 15 * 60 * 1000 });
    await page.locator('.la-input').fill('How does disk forensics preserve storage media without altering it?');
    await page.locator('.la-send').click();
    await page.locator('.la-answer:not(.la-streaming)').waitFor({ timeout: 5 * 60 * 1000 });
    const answer = (await page.locator('.la-answer').innerText()).replace(/\s+/g, ' ').trim();
    await page.screenshot({ path: '/tmp/la-theme-light-answer.png' });
    return { answer, ...await palette() };
  });

  await step('dark', async () => {
    await page.locator('#flip').click();
    await page.waitForFunction(() =>
      document.querySelector('.la-root')?.style.getPropertyValue('--la-accent').trim() === '#e2632f');
    await page.waitForFunction(() => {
      const panel = document.querySelector('.la-panel');
      if (!panel) return false;
      const [r, g, b] = getComputedStyle(panel).backgroundColor.match(/\d+/g).map(Number);
      return (r + g + b) / 3 < 60;
    });
    await page.waitForTimeout(150);
    await page.screenshot({ path: '/tmp/la-theme-dark.png' });
    return await palette();
  });

  result.checks = {
    lightAccent: result.steps.light.vars.accent === '#c8342a',
    lightSurface: result.steps.light.vars.surface === '#fffdf8',
    lightPanelMatchesPage: JSON.stringify(result.steps.light.panel) === JSON.stringify([255, 253, 248]),
    darkAccent: result.steps.dark.vars.accent === '#e2632f',
    darkSurface: result.steps.dark.vars.surface === '#1e1a15',
    darkPanelMatchesPage: JSON.stringify(result.steps.dark.panel) === JSON.stringify([30, 26, 21]),
    answeredGrounded: /write blocker|imaging|copy/i.test(result.steps.answer.answer)
  };
} catch (error) {
  result.failure = String(error?.message || error);
  await page.screenshot({ path: '/tmp/la-theme-failure.png' }).catch(() => {});
} finally {
  await context.close();
}

const after = await fingerprint();
result.library = { before, after, unchanged: before.digest === after.digest && before.files === after.files };
result.finishedAt = new Date().toISOString();
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({
  failure: result.failure || null,
  checks: result.checks,
  libraryUnchanged: result.library.unchanged,
  problems: result.problems.slice(0, 5)
}, null, 2));
process.exit(result.failure ? 1 : 0);
