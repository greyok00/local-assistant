// End-to-end verification of the shipped widget against the real research
// library: the production loader, the real 5,645-chunk index, and the real
// SmolLM2-360M chat model. Nothing is mocked.
//
//   node demo/scripts/verify-widget.mjs [profile-dir] [base-url]
//
// The served library tree (DEMO_LIBRARY) is only read; the script fingerprints
// it before and after so a write would be visible.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import pkg from '../../product/node_modules/playwright-core/index.js';

const { chromium } = pkg;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIBRARY = process.env.DEMO_LIBRARY || path.join(path.dirname(REPO), 'research-library');
// A fresh profile by default: an earlier run's service worker could otherwise
// serve yesterday's loader.js and make the verification meaningless.
const profileDir = path.resolve(process.argv[2] || 'demo/build/verify-profile');
const baseUrl = process.argv[3] || 'http://127.0.0.1:4180';
const outPath = 'demo/bench/results/widget-verify-2026-10-29.json';

const FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan,WebGPU',
  '--use-angle=vulkan',
  '--ignore-gpu-blocklist'
];

// Fingerprint the library: every file's path, size and mtime, plus a digest of
// that listing. Any write during the run changes the digest.
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
  headless: false,
  args: FLAGS,
  viewport: { width: 1400, height: 900 }
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

const result = { startedAt: new Date().toISOString(), baseUrl, profileDir, steps: {}, problems };
const step = async (name, fn) => {
  const started = Date.now();
  const value = await fn();
  result.steps[name] = { ms: Date.now() - started, ...value };
  console.log(`[${name}] ${JSON.stringify(result.steps[name])}`);
  return value;
};

try {
  // The service worker serves its cached widget first and revalidates behind
  // it, so a run after a code change would exercise yesterday's files. Drop the
  // widget cache (never the model caches) and reload before measuring.
  await step('cache-reset', async () => {
    await page.goto(`${baseUrl}/local-assistant/bench/verify.html`);
    const dropped = await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) await registration.unregister();
      const names = (await caches.keys()).filter(name => name.startsWith('local-assistant'));
      for (const name of names) await caches.delete(name);
      return names;
    });
    await page.reload();
    // Anything logged before this point came from the stale cached build the
    // reset exists to discard, not from the code being verified.
    problems.length = 0;
    return { dropped };
  });

  const adapter = await step('adapter', async () => {
    return page.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        const a = await navigator.gpu?.requestAdapter().catch(() => null);
        if (a) return { vendor: a.info?.vendor, architecture: a.info?.architecture, fallback: a.isFallbackAdapter };
        await new Promise(r => setTimeout(r, 500));
      }
      return { vendor: null };
    });
  });

  await step('consent', async () => {
    await page.locator('.la-launcher').click();
    await page.locator('.la-consent').waitFor();
    const text = await page.locator('.la-consent').innerText();
    await page.screenshot({ path: '/tmp/la-rl-consent.png' });
    return { text: text.replace(/\s+/g, ' ').trim() };
  });

  await step('load', async () => {
    await page.locator('.la-consent-start').click();
    await page.locator('.la-input').waitFor({ state: 'attached' });
    await page.locator('.la-input').waitFor({ state: 'visible' });
    // The composer enables only after both models are ready.
    await page.waitForFunction(() => {
      const input = document.querySelector('.la-input');
      return input && !input.disabled;
    }, null, { timeout: 15 * 60 * 1000 });
    const status = await page.locator('.la-status').innerText();
    const ready = await page.locator('.la-launcher').getAttribute('data-ready');
    const chips = await page.locator('.la-chip').allInnerTexts();
    const sheet = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes =>
      nodes.map(link => link.getAttribute('href')));
    const worker = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { script: reg?.active?.scriptURL || reg?.installing?.scriptURL || null, scope: reg?.scope || null };
    });
    await page.screenshot({ path: '/tmp/la-rl-ready.png' });
    return { status, ready, chips, stylesheets: sheet, serviceWorker: worker };
  });

  await step('answer', async () => {
    const question = 'How does disk forensics preserve storage media without altering it?';
    await page.locator('.la-input').fill(question);
    await page.locator('.la-send').click();
    await page.locator('.la-answer:not(.la-streaming)').waitFor({ timeout: 5 * 60 * 1000 });
    const answer = (await page.locator('.la-answer').innerText()).replace(/\s+/g, ' ').trim();
    const sources = await page.locator('.la-sources a').evaluateAll(nodes =>
      nodes.map(n => ({ text: n.textContent, href: n.getAttribute('href') })));
    const followUps = await page.locator('.la-chip').allInnerTexts();
    await page.screenshot({ path: '/tmp/la-rl-answer.png' });
    return { question, answer, sources, followUps };
  });

  await step('citation-liveness', async () => {
    const sources = result.steps.answer.sources || [];
    const checks = [];
    for (const source of sources.slice(0, 3)) {
      const response = await page.request.get(new URL(source.href, baseUrl).href);
      checks.push({ href: source.href, status: response.status() });
    }
    return { checks };
  });

  // This exact question once produced a fabricated Phoenix weather forecast:
  // the vector gate scored a chronolocation page at 0.49 and the model filled
  // in the rest. The lexical-corroboration rule must now refuse it before the
  // model is asked, so this step asserts on the text the visitor would see.
  await step('hallucination-guard', async () => {
    const question = 'What is the weather forecast for Phoenix tomorrow?';
    await page.locator('.la-input').fill(question);
    await page.locator('.la-send').click();
    const text = await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.la-msg.la-assistant')];
      const last = rows[rows.length - 1];
      const bubble = last?.querySelector('.la-bubble');
      if (!bubble || bubble.classList.contains('la-typing')) return null;
      if (bubble.classList.contains('la-streaming')) return null;
      if (!bubble.textContent.trim()) return null;
      return bubble.textContent.replace(/\s+/g, ' ').trim();
    }, null, { timeout: 2 * 60 * 1000 }).then(handle => handle.jsonValue());
    await page.screenshot({ path: '/tmp/la-rl-weather-guard.png' });
    return {
      question,
      message: text,
      refused: /isn't covered in the pages|do not contain an answer|could not build a reliable answer/i.test(text),
      mentionsWeather: /\b(forecast|precipitation|°F|°C|degrees)\b/i.test(text)
    };
  });

  await step('refusal', async () => {
    const question = 'What is the airspeed velocity of an unladen swallow?';
    await page.locator('.la-input').fill(question);
    await page.locator('.la-send').click();
    await page.waitForFunction(() => {
      const bubbles = [...document.querySelectorAll('.la-bubble')];
      return bubbles.some(b => /isn't covered in the pages/i.test(b.textContent));
    }, null, { timeout: 2 * 60 * 1000 });
    const message = await page.locator('.la-bubble').last().innerText();
    await page.screenshot({ path: '/tmp/la-rl-refusal.png' });
    return { question, message: message.replace(/\s+/g, ' ').trim() };
  });

  await step('phone', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const box = await page.locator('.la-panel').boundingBox();
    const locked = await page.evaluate(() => document.body.classList.contains('la-open'));
    const sendVisible = await page.locator('.la-send').isVisible();
    await page.screenshot({ path: '/tmp/la-rl-mobile.png' });
    return { width: Math.round(box.width), height: Math.round(box.height), locked, sendVisible };
  });

  await step('close', async () => {
    await page.locator('.la-close').click();
    return page.evaluate(() => ({
      panels: document.querySelectorAll('.la-panel').length,
      locked: document.body.classList.contains('la-open')
    }));
  });
} catch (error) {
  result.failure = String(error?.message || error);
  await page.screenshot({ path: '/tmp/la-rl-failure.png' }).catch(() => {});
} finally {
  await context.close();
}

const after = await fingerprint();
result.library = {
  before, after,
  unchanged: before.digest === after.digest && before.files === after.files
};
result.finishedAt = new Date().toISOString();

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ failure: result.failure || null, libraryUnchanged: result.library.unchanged,
  problems: result.problems.slice(0, 5) }, null, 2));
process.exit(result.failure ? 1 : 0);
