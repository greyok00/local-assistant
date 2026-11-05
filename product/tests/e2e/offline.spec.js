import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeVectors } from '../../src/indexcodec.js';

// The worker lives at /product/src/service-worker.js but is registered with a
// /product/ scope, so the dev host has to send Service-Worker-Allowed just like
// the shipped WordPress host does. python3 -m http.server cannot, so this spec
// serves the repo itself (and the fake /test-index artifacts) from a tiny
// static server instead.
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const VEC = (i) => { const v = new Float32Array(384); v[i] = 1; return v; };
const CHUNKS = [
  { url: '/a', title: 'Bonds', heading: 'Appeal bond', text: 'An appeal bond stays enforcement.' },
  { url: '/b', title: 'Evidence', heading: 'Chain', text: 'Chain of custody begins at seizure.' },
  { url: '/c', title: 'Witnesses', heading: 'Testimony', text: 'A witness testifies under oath.' },
  { url: '/d', title: 'Deadlines', heading: 'Filing', text: 'A filing must meet the deadline.' }
];
const VECTORS = Buffer.from(encodeVectors(CHUNKS.map((_, i) => VEC(i))));

// Mutable per test: whether the index exists yet, and which build it reports.
const state = { indexAvailable: true, indexVersion: 'v1' };

// Pages the spec synthesises: one with no assistant marker, one the origin marks
// private, and one that echoes its query string through distinct cached URLs.
const PAGES = {
  '/product/tests/e2e/plain.html': {
    body: '<!doctype html><html><head><title>plain</title></head><body><p>Plain page</p></body></html>'
  },
  '/product/tests/e2e/private.html': {
    body: '<!doctype html><html><head><title>private</title></head><body><!-- local-assistant/loader.js --><p>Private page</p></body></html>',
    headers: { 'cache-control': 'private, max-age=60' }
  },
  '/product/tests/e2e/search.html': {
    body: '<!doctype html><html><head><title>search</title></head><body><!-- local-assistant/loader.js --><p>results</p></body></html>'
  },
  // A WooCommerce cart page: it embeds the assistant like any page, but it is
  // one visitor's state and must never be stored.
  '/product/tests/e2e/cart': {
    body: '<!doctype html><html><head><title>cart</title></head><body><!-- local-assistant/loader.js --><p>cart</p></body></html>'
  }
};

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ server, origin: `http://127.0.0.1:${port}` });
  });
});

const serveRepo = async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/test-index.json' || pathname === '/test-index.bin') {
    if (!state.indexAvailable) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('index not generated yet');
      return;
    }
    if (pathname === '/test-index.json') {
      const meta = {
        version: 1,
        siteName: 'Test Site',
        model: 'stub-embedder',
        built: state.indexVersion,
        chunks: CHUNKS
      };
      // A long max-age is deliberate: it is what a real CDN sends, and it proves
      // the worker's revalidation bypasses the HTTP cache.
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'max-age=3600' });
      res.end(JSON.stringify(meta));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'max-age=3600' });
    res.end(VECTORS);
    return;
  }

  const page = PAGES[pathname];
  if (page) {
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache', ...page.headers });
    res.end(page.body);
    return;
  }

  const file = join(REPO, pathname);
  if (!file.startsWith(REPO)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      // Mirrors the production host: lets the worker claim the whole site.
      'service-worker-allowed': '/product/',
      'cache-control': 'no-cache'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
};

// Stands in for the cross-origin CDN that serves model weights.
const serveWeights = (req, res) => {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'access-control-allow-origin': '*'
  });
  res.end('weights');
};

let origin;
let crossOrigin;
let app;
let weights;
let cross;

test.beforeAll(async () => {
  ({ server: app, origin } = await listen(serveRepo));
  ({ server: cross, origin: crossOrigin } = await listen(serveWeights));
});

test.afterAll(async () => {
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => cross.close(resolve));
});

test.beforeEach(() => {
  state.indexAvailable = true;
  state.indexVersion = 'v1';
});

// Loads the harness with ?sw=1, waits for the worker to activate, then keeps
// reloading until a load is actually controlled, that controlled reload is the
// one the worker is able to store for offline use.
async function ensureControlled(page) {
  await page.goto(`${origin}/product/tests/e2e/harness.html?sw=1`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect(async () => {
    const controller = await page.evaluate(() => navigator.serviceWorker.controller !== null);
    if (!controller) await page.reload();
    expect(controller).toBe(true);
  }).toPass({ timeout: 15000 });
  await page.reload();
}

const cachedPaths = (page) => page.evaluate(async () => {
  const names = await caches.keys();
  const cache = await caches.open(names.find(n => n.startsWith('local-assistant')));
  return (await cache.keys()).map(r => new URL(r.url).pathname);
});

const cachedUrls = (page) => page.evaluate(async () => {
  const urls = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) urls.push(request.url);
  }
  return urls;
});

const worker = async (context) => context.serviceWorkers()[0] || context.waitForEvent('serviceworker');

test('widget assets and index survive the network going away', async ({ page, context }) => {
  await page.goto(`${origin}/product/tests/e2e/harness.html?sw=1`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  // One more controlled load, so the worker has seen a page it can fall back to.
  await page.reload();

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.la-launcher')).toBeVisible();

  const cached = await cachedPaths(page);
  expect(cached.some(p => p.endsWith('/widget.js'))).toBe(true);
  expect(cached.some(p => p.endsWith('/indexcodec.js'))).toBe(true);
  expect(cached.some(p => p.endsWith('/test-index.bin'))).toBe(true);

  await context.setOffline(false);
});

test('an index that 404s at install does not fail the worker and is picked up later', async ({ page, context }) => {
  state.indexAvailable = false;
  await ensureControlled(page);

  const registrationState = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state);
  expect(registrationState).toBe('activated');
  expect((await cachedPaths(page)).some(p => p.endsWith('/test-index.bin'))).toBe(false);

  // The owner runs Ingest: the artifact exists on the next online visit.
  state.indexAvailable = true;
  const online = await page.evaluate(async () => {
    const response = await fetch('/test-index.bin');
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  });
  expect(online).toEqual({ status: 200, bytes: VECTORS.byteLength });
  expect((await cachedPaths(page)).some(p => p.endsWith('/test-index.bin'))).toBe(true);

  await context.setOffline(true);
  const offline = await page.evaluate(async () => {
    const response = await fetch('/test-index.bin');
    return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  });
  expect(offline).toEqual({ status: 200, bytes: VECTORS.byteLength });
  await context.setOffline(false);
});

test('cross-origin model weights pass through and are never cached', async ({ page }) => {
  await ensureControlled(page);

  const result = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { ok: response.ok, text: await response.text() };
  }, `${crossOrigin}/weights/model.bin`);
  expect(result).toEqual({ ok: true, text: 'weights' });

  const origins = await page.evaluate(async () => {
    const seen = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) seen.push(new URL(request.url).origin);
    }
    return seen;
  });
  expect(origins.some(o => o !== origin)).toBe(false);
});

test('a background revalidation replaces the cached index after Ingest reruns', async ({ page }) => {
  await ensureControlled(page);

  const first = await page.evaluate(() => fetch('/test-index.json').then(r => r.json()));
  expect(first.built).toBe('v1');

  // The owner re-runs Ingest while the visitor stays on the page.
  state.indexVersion = 'v2';
  const second = await page.evaluate(() => fetch('/test-index.json').then(r => r.json()));
  expect(second.built).toBe('v1'); // cache-first: this load still sees the old index

  // The worker's cache name carries a version; read whichever one it created
  // rather than pinning a name the next bump would break.
  await expect.poll(async () => page.evaluate(async () => {
    for (const name of await caches.keys()) {
      if (!name.startsWith('local-assistant')) continue;
      const cache = await caches.open(name);
      const hit = await cache.match('/test-index.json');
      if (hit) return (await hit.json()).built;
    }
    return null;
  }), { timeout: 10000 }).toBe('v2');
});

test('a failed cache write never turns an online page into an offline error', async ({ page, context }) => {
  await ensureControlled(page);
  const sw = await worker(context);

  // Simulate a full quota: every store attempt rejects inside the worker.
  await sw.evaluate(() => {
    self.__put = Cache.prototype.put;
    Cache.prototype.put = () => Promise.reject(new Error('quota exceeded'));
  });
  try {
    // A page this context has never stored, so the old copy cannot mask the bug.
    const response = await page.goto(`${origin}/product/tests/e2e/search.html?q=quota`);
    expect(response.status()).toBe(200);
    await expect(page.locator('body')).toContainText('results');
  } finally {
    await sw.evaluate(() => { Cache.prototype.put = self.__put; });
  }
});

test('pages without the assistant marker or marked private are never stored', async ({ page }) => {
  await ensureControlled(page);

  await page.goto(`${origin}/product/tests/e2e/plain.html`);
  await page.goto(`${origin}/product/tests/e2e/private.html`);

  const urls = await cachedUrls(page);
  expect(urls.some(u => u.endsWith('/plain.html'))).toBe(false);
  expect(urls.some(u => u.endsWith('/private.html'))).toBe(false);
});

test('cart and account paths are never stored for offline', async ({ page }) => {
  await ensureControlled(page);

  await page.goto(`${origin}/product/tests/e2e/cart`);
  const urls = await cachedUrls(page);
  expect(urls.some(u => new URL(u).pathname.endsWith('/cart'))).toBe(false);
});

test('a versioned asset is stored once under its path, not once per version', async ({ page }) => {
  await ensureControlled(page);

  await page.evaluate(() => fetch('/product/src/widget.css?ver=0.1.0'));
  await page.evaluate(() => fetch('/product/src/widget.css?ver=0.2.0'));
  // The second load revalidates in the background; wait for the cache to settle.
  await expect.poll(async () => cachedUrls(page)).toContain(
    `${origin}/product/src/widget.css`
  );
  const urls = await cachedUrls(page);
  const copies = urls.filter(u => u.includes('/product/src/widget.css'));
  expect(copies).toEqual([`${origin}/product/src/widget.css`]);
});

test('offline never serves a page cached under a different query string', async ({ page, context }) => {
  await ensureControlled(page);

  await page.goto(`${origin}/product/tests/e2e/search.html?q=bonds`);
  expect((await cachedUrls(page)).some(u => u.endsWith('/search.html?q=bonds'))).toBe(true);

  await context.setOffline(true);
  const wrong = await page.goto(`${origin}/product/tests/e2e/search.html?q=evidence`);
  expect(wrong.status()).toBe(503);
  const right = await page.goto(`${origin}/product/tests/e2e/search.html?q=bonds`);
  expect(right.status()).toBe(200);
  await expect(page.locator('body')).toContainText('results');

  await context.setOffline(false);
});
