// Real-hardware driver. Launches the Playwright-bundled Chromium
// headed with WebGPU/Vulkan flags, drives the demo tenant, and records the raw
// numbers. Never used by the product; it exists so the run is reproducible.
//
//   node demo/scripts/run-real.mjs ingest <profile-dir> <base-url>
//   node demo/scripts/run-real.mjs bench  <profile-dir> <base-url> <out.json>
import fs from 'node:fs/promises';
import path from 'node:path';
import pkg from '../../product/node_modules/playwright-core/index.js';

const { chromium } = pkg;
// BENCH_FLAGS=swiftshader selects software WebGPU (CPU) so the bench can run
// while another process holds the discrete GPU. These timings are a
// correctness/fidelity measurement, not GPU performance.
const SOFTWARE = process.env.BENCH_FLAGS === 'swiftshader';
const FLAGS = SOFTWARE
  ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']
  : [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
    '--use-angle=vulkan',
    '--ignore-gpu-blocklist'
  ];

console.log('flags:', JSON.stringify(FLAGS), 'software:', SOFTWARE);
const [mode, profileDir, baseUrl, outPath] = process.argv.slice(2);
if (!mode || !profileDir || !baseUrl) {
  console.error('usage: run-real.mjs ingest|bench <profile-dir> <base-url> [out.json]');
  process.exit(2);
}

const isLocal = (url) => {
  try { return new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost'; }
  catch { return true; }
};

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: FLAGS,
  viewport: { width: 1400, height: 900 }
});
const page = context.pages()[0] || await context.newPage();

// Exact bytes received on the wire, including redirects, for non-local hosts.
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
const urls = new Map();
const wire = new Map();
cdp.on('Network.requestWillBeSent', (e) => urls.set(e.requestId, e.request.url));
cdp.on('Network.responseReceived', (e) => {
  const url = e.response?.url || urls.get(e.requestId) || '';
  if (!isLocal(url)) urls.set(e.requestId, url);
});
cdp.on('Network.loadingFinished', (e) => {
  const url = urls.get(e.requestId) || '';
  if (isLocal(url)) return;
  wire.set(url, (wire.get(url) || 0) + (e.encodedDataLength || 0));
});

const report = async (label) => {
  const status = await page.locator('#la-status').textContent({ timeout: 2000 }).catch(() => '');
  const progress = await page.locator('#la-report').textContent({ timeout: 2000 }).catch(() => '');
  console.log(`[${label}] ${status} ${progress ? `| ${progress.replace(/\n/g, ' ')}` : ''}`);
};
for (const p of [page, ...context.pages()]) {
  p.on('crash', () => console.error('PAGE CRASHED'));
  p.on('pageerror', e => console.error('PAGE ERROR:', e.message));
  p.on('console', m => { if (m.type() === 'error') console.error('CONSOLE ERROR:', m.text().slice(0, 300)); });
}

const adapterInfo = await (async () => {
  await page.goto(baseUrl + '/');
  return page.evaluate(async () => {
    // A software adapter can be missing for the first few hundred ms while the
    // GPU process starts; retry so the measurement does not record a race.
    for (let attempt = 0; attempt < 15; attempt++) {
      try {
        const a = await navigator.gpu?.requestAdapter();
        if (a) {
          const info = a.info || {};
          return {
            available: true, attempts: attempt + 1,
            vendor: info.vendor, architecture: info.architecture, device: info.device,
            description: info.description, fallback: a.isFallbackAdapter,
            shaderF16: a.features.has('shader-f16')
          };
        }
      } catch (error) {
        if (attempt === 14) return { available: false, error: String(error) };
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { available: false };
  });
})();
console.log('WebGPU adapter:', JSON.stringify(adapterInfo));

let exitCode = 0;
try {
  if (mode === 'ingest') {
    // The dashboard's embed loop starves the renderer's task queue, so polling
    // the DOM can block. Beacon progress to the server (which logs it) so the
    // run is observable without touching ingest logic.
    await page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
      Object.defineProperty(Node.prototype, 'textContent', {
        configurable: true,
        get: descriptor.get,
        set(value) {
          if (typeof value === 'string' &&
              /^(crawl:|embed:|done:|Loading search model|Ingest failed)|\d+ chunks? from/.test(value)) {
            try { navigator.sendBeacon('/__progress', value); } catch { /* observability only */ }
          }
          return descriptor.set.call(this, value);
        }
      });
      // The dashboard hands the finished index to the browser as Blobs. Mirror
      // them to the server so the artifact survives even if this driver's own
      // wait times out on a slow machine.
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        try {
          if (blob instanceof Blob && blob.type === 'application/json') {
            fetch('/__artifact.json', { method: 'POST', body: blob }).catch(() => {});
          } else if (blob instanceof Blob && blob.type === 'application/octet-stream') {
            fetch('/__artifact.bin', { method: 'POST', body: blob }).catch(() => {});
          }
        } catch { /* mirror is best effort */ }
        return original(blob);
      };
    });
    await page.goto(`${baseUrl}/local-assistant/dashboard.html`);
    await page.fill('#la-url', `${baseUrl}/`);
    await page.click('#la-start');
    const started = Date.now();
    let last = '';
    // Where the finished artifact lands. Defaults to the demo build; another
    // site install points this at its own assistant folder.
    const build = path.resolve(process.env.ASSISTANT_ARTIFACT_DIR || 'demo/build');
    await fs.mkdir(build, { recursive: true });
    while (true) {
      await page.waitForTimeout(10000);
      const line = await page.locator('#la-report').textContent({ timeout: 5000 }).catch(() => '(renderer busy)');
      if (line !== last) { console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${String(line).replace(/\n/g, ' | ')}`); last = line; }
      const done = /\d+ chunks? from/.test(line);
      const files = await page.locator('.la-download .la-file').count().catch(() => 0);
      if (done || files === 2) break;
      if (/Ingest failed/.test(line)) throw new Error(line);
      const bin = await fs.stat(path.join(build, 'assistant-index.bin')).catch(() => null);
      if (bin && bin.size > 0) break;
      if (Date.now() - started > 120 * 60 * 1000) throw new Error('ingest exceeded 120 minutes');
    }
    const finalReport = await page.locator('#la-report').textContent({ timeout: 60000 });
    console.log('INGEST REPORT:\n' + finalReport);
    // The page mirrors the Blobs to the server; give that a moment, then fall
    // back to the download anchors if the mirror did not land.
    let mirrored = false;
    for (const name of ['assistant-index.json', 'assistant-index.bin']) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const stat = await fs.stat(path.join(build, name)).catch(() => null);
        if (stat && stat.size > 0) { console.log(`MIRRORED ${name} ${stat.size} bytes`); mirrored = true; break; }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    if (!mirrored) {
      for (const [index, name] of ['assistant-index.json', 'assistant-index.bin'].entries()) {
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('.la-download .la-file').nth(index).click()
        ]);
        await download.saveAs(path.join(build, name));
        const stat = await fs.stat(path.join(build, name));
        console.log(`SAVED ${name} ${stat.size} bytes`);
      }
    }
  } else if (mode === 'bench') {
    // Beacon each completed question so a slow software-WebGPU run is
    // observable and a stalled question is visible in the server log.
    await page.addInitScript(() => {
      const attach = () => {
        const tbody = document.querySelector('#la-results tbody');
        if (!tbody) return;
        new MutationObserver(() => {
          const rows = [...tbody.querySelectorAll('tr')];
          const last = rows[rows.length - 1];
          if (!last) return;
          const cell = (field) => last.querySelector(`[data-field="${field}"]`)?.textContent ?? '';
          try {
            fetch('/__progress', {
              method: 'POST',
              body: `bench row ${rows.length} ${last.dataset.id || ''} ttft=${cell('ttft')} total=${cell('total')} refused=${cell('refused')}`
            });
          } catch { /* observability only */ }
        }).observe(tbody, { childList: true });
      };
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', attach);
      else attach();
    });

    const model = process.env.BENCH_MODEL || '';
    const benchUrl = `${baseUrl}/local-assistant/bench/bench.html${model ? `?model=${encodeURIComponent(model)}` : ''}`;
    await page.goto(benchUrl);
    const started = Date.now();
    let last = '';
    let rows = 0;
    let lastRowAt = started;
    let runStartedAt = 0;
    let stopped = null;
    try {
      await page.click('#la-run');
      while (true) {
        await page.waitForTimeout(10000);
        const line = await page.locator('#la-status').textContent({ timeout: 5000 }).catch(() => '(renderer busy)');
        if (line !== last) { console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${String(line)}`); last = line; }
        if (!runStartedAt && /Running \d+ questions/.test(line)) runStartedAt = Date.now();
        const count = await page.locator('#la-results tbody tr').count().catch(() => rows);
        if (count > rows) { rows = count; lastRowAt = Date.now(); console.log(`[${Math.round((Date.now() - started) / 1000)}s] completed ${rows}/20`); }
        if (rows === 20) break;
        if (/Bench failed/.test(line)) throw new Error(line);
        if (runStartedAt && Date.now() - lastRowAt > 10 * 60 * 1000) {
          stopped = `no question completed in 10 minutes (${rows}/20 done)`;
          break;
        }
        if (Date.now() - started > 90 * 60 * 1000) { stopped = `bench exceeded 90 minutes (${rows}/20 done)`; break; }
      }
    } catch (error) {
      stopped = error?.message || String(error);
    }

    const readRows = () => page.evaluate(() => [...document.querySelectorAll('#la-results tbody tr')].map(row => {
      const cell = (field) => row.querySelector(`[data-field="${field}"]`)?.textContent ?? '';
      return {
        id: row.dataset.id, expect: row.dataset.expect,
        ttftMs: Number(cell('ttft')), totalMs: Number(cell('total')),
        refused: cell('refused') === 'yes', sources: cell('sources').split(' ').filter(Boolean),
        answer: cell('answer')
      };
    })).catch(() => []);

    if (stopped) {
      const partial = await readRows();
      const partialPayload = {
        status: 'stopped', reason: stopped, elapsedMs: Date.now() - started,
        model: model || 'SmolLM2-360M-Instruct-q4f16_1-MLC', software: SOFTWARE,
        adapter: adapterInfo, flags: FLAGS, rows: partial
      };
      await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
      await fs.writeFile(path.resolve(outPath), JSON.stringify(partialPayload, null, 2) + '\n');
      console.log('STOPPED:', stopped, 'rows', partial.length);
      throw new Error(stopped);
    }

    const summary = await page.locator('#la-summary').textContent();
    const payload = JSON.parse(summary);
    // Cache Storage after the cold load: what was actually stored on disk.
    const caches = await page.evaluate(async () => {
      const out = {};
      for (const name of await globalThis.caches.keys()) {
        const cache = await globalThis.caches.open(name);
        let bytes = 0, entries = 0;
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          if (!response) continue;
          const buffer = await response.clone().arrayBuffer();
          bytes += buffer.byteLength;
          entries += 1;
        }
        out[name] = { entries, bytes };
      }
      return out;
    });
    const wireBytes = [...wire.entries()].map(([url, bytes]) => ({ url, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    const modelBytes = wireBytes.filter(entry => /huggingface\.co|mlc-ai|cdn-lfs/.test(entry.url))
      .reduce((sum, entry) => sum + entry.bytes, 0);
    const extra = {
      measuredAt: new Date().toISOString(),
      adapter: adapterInfo,
      softwareWebGPU: SOFTWARE,
      flags: FLAGS,
      modelNetworkBytesThisLaunch: modelBytes,
      modelCacheReused: modelBytes === 0,
      userAgent: await page.evaluate(() => navigator.userAgent),
      coldCacheStorage: caches,
      coldCacheTotalBytes: Object.values(caches).reduce((sum, c) => sum + c.bytes, 0),
      networkBytesTotal: wireBytes.reduce((sum, entry) => sum + entry.bytes, 0),
      networkBytes: wireBytes
    };
    const merged = { ...payload, measurement: extra };
    await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await fs.writeFile(path.resolve(outPath), JSON.stringify(merged, null, 2) + '\n');
    console.log('SUMMARY:', JSON.stringify({
      initMs: payload.initMs, engineReused: payload.engineReused, chunks: payload.chunks,
      indexBytes: payload.indexBytes, model: payload.model,
      refused: payload.results.filter(r => r.refused).length,
      cacheTotalBytes: extra.coldCacheTotalBytes, networkTotalBytes: extra.networkBytesTotal
    }));
    for (const result of payload.results) {
      console.log(`ROW ${result.id} refused=${result.refused} ttft=${result.ttftMs} total=${result.totalMs} answer=${JSON.stringify(result.answer.slice(0, 160))}`);
    }
    console.log('CACHES:', JSON.stringify(caches));
  }
} catch (error) {
  console.error('RUN FAILED:', error?.stack || String(error));
  await report('failure');
  exitCode = 1;
} finally {
  await context.close();
}
process.exit(exitCode);
