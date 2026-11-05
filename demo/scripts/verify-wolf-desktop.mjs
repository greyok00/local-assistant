// Full probe for the shipped Desktop deliverable: load the engine (GPU if the
// browser offers it, else the CPU rung), ask one grounded question, confirm
// the answer + sources, count wolf icons, screenshot.
import path from 'node:path';
import pkg from '../../product/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const profileDir = path.resolve(process.argv[2] || 'demo/build/wolf-desktop-profile');
const baseUrl = process.argv[3] || 'http://127.0.0.1:4191';
const WOLF = 'M22.00 10.25';
const SPARK = 'M12 2l2.1';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist']
});
const page = context.pages()[0] || await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', r => problems.push(`requestfailed: ${r.url()}`));
page.on('response', r => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });

await page.goto(`${baseUrl}/digital-forensics/windows-security/bitlocker-overview.html`, { waitUntil: 'load' });
const webgpu = await page.evaluate(async () => {
  if (!navigator.gpu) return false;
  const adapter = await navigator.gpu.requestAdapter().catch(() => null);
  return !!adapter;
});
await page.locator('.la-launcher').click({ timeout: 30000 });
let ready = false;
const started = Date.now();
while (Date.now() - started < 6 * 60 * 1000) {
  ready = await page.evaluate(() => !!(document.querySelector('.la-input') && !document.querySelector('.la-input')?.disabled));
  if (ready) break;
  await page.waitForTimeout(2000);
}
const status = await page.evaluate(() => document.querySelector('.la-status')?.textContent || '');

let answer = '', sources = 0;
if (ready) {
  await page.locator('.la-input').fill('What is chain of custody in digital forensics?');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const a = [...document.querySelectorAll('.la-answer')];
    return a.length > 0 && !a[a.length - 1].classList.contains('la-streaming');
  }, null, { timeout: 3 * 60 * 1000 });
  answer = (await page.locator('.la-answer').last().innerText()).replace(/\s+/g, ' ').slice(0, 300);
  sources = await page.locator('.la-sources a, .la-sources span').count();
}
const icons = await page.evaluate(([wolf, spark]) => {
  const paths = [...document.querySelectorAll('.la-root svg path')].map(p => p.getAttribute('d') || '');
  return {
    total: paths.length,
    wolf: paths.filter(d => d.startsWith(wolf)).length,
    sparkle: paths.filter(d => d.startsWith(spark)).length,
    hoverRule: [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } })
      .find(r => r.selectorText?.includes('.la-launcher:hover .la-launcher-icon'))?.style?.transform || 'none'
  };
}, [WOLF, SPARK]);
await page.screenshot({ path: 'demo/bench/shots/wolf-desktop.png', fullPage: false });
console.log(JSON.stringify({ webgpu, status, ready, icons, answer, sources, problems }, null, 1));
await context.close();
