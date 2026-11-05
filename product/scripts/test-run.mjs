// Opens both engine paths of the live site for a manual test run:
//   Chrome  -> WebGPU/WebLLM (the fast path)
//   Firefox -> the CPU compatibility model (no WebGPU adapter needed)
// The site is served from ~/umgc-library; Firefox refuses port 4190 (a
// protocol-restricted port), so it gets the same files on 4191.
//
// Usage: node scripts/test-run.mjs [--no-open]
// Leave it running; closing the Firefox window ends the script.
import { chromium, firefox } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const SITE = path.join(homedir(), 'umgc-library');
const CHROME_PORT = 4190;
const FIREFOX_PORT = 4191;
const PAGE = '/cybersecurity.html';
const CDP = 'http://127.0.0.1:9255';

// Node's global fetch is unreliable in this sandbox; a plain http.get is not.
const up = (url) => new Promise((resolve) => {
  const req = http.get(url, { timeout: 1500 }, (res) => { res.destroy(); resolve(true); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

async function serve(port) {
  if (await up(`http://127.0.0.1:${port}/`)) return null;
  const child = spawn('python3', ['-m', 'http.server', String(port), '-d', SITE],
    { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await up(`http://127.0.0.1:${port}/`)) return child;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`no server on ${port}`);
}

await serve(CHROME_PORT);
await serve(FIREFOX_PORT);

if (process.argv.includes('--no-open')) {
  console.log(`site ready: chrome http://127.0.0.1:${CHROME_PORT}${PAGE} | firefox http://127.0.0.1:${FIREFOX_PORT}${PAGE}`);
  process.exit(0);
}

// Chrome: reuse the running debug instance so the tab lands in the visible window.
try {
  const browser = await chromium.connectOverCDP(CDP, { timeout: 3000 });
  const page = await browser.contexts()[0].newPage();
  await page.goto(`http://127.0.0.1:${CHROME_PORT}${PAGE}`);
  await page.bringToFront().catch(() => {});
  // Disconnect without closing: the tab stays in the user's window.
  browser.close().catch(() => {});
  console.log(`chrome: opened http://127.0.0.1:${CHROME_PORT}${PAGE}`);
} catch (error) {
  console.log(`chrome: CDP ${CDP} unavailable (${error.message.split('\n')[0]})`);
  console.log(`        open http://127.0.0.1:${CHROME_PORT}${PAGE} in Chrome yourself`);
}

// Firefox: a persistent profile with a real window, so the install survives a restart.
const profile = path.join(homedir(), '.config', 'la-firefox-test');
if (!existsSync(profile)) mkdirSync(profile, { recursive: true });
const ctx = await firefox.launchPersistentContext(profile, { headless: false });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`http://127.0.0.1:${FIREFOX_PORT}${PAGE}`);
console.log(`firefox: opened http://127.0.0.1:${FIREFOX_PORT}${PAGE}`);
console.log('Both are open. Close the Firefox window to end this script.');

await new Promise(resolve => ctx.on('close', resolve));
