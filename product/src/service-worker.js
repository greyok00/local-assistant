// product/src/service-worker.js
// Precaches the widget and its index so a consented visitor keeps the assistant
// when the network drops. Registered by loader.js (and by the e2e harness) as
// service-worker.js?index=<index path stem>, the same stem the loader fetches.
// Bump this whenever the runtime changes. Install/activate then drops the old
// cache, so a visitor gets the new files on the next visit instead of the
// cached build they already have (cache-first is what serves the stale copy).
const CACHE = 'local-assistant-v11';

const workerUrl = new URL(self.location.href);
const indexPath = new URL(
  workerUrl.searchParams.get('index') || '/local-assistant/assistant-index',
  workerUrl.origin
).pathname.replace(/\.(bin|json)$/i, '');
// A host that points the loader at its own config would 404 on the default
// path; precache the file the loader actually reads.
const configPath = workerUrl.searchParams.get('config') || new URL('./assistant.config.json', workerUrl).pathname;

// Relative entries resolve against the worker's own folder, so the same file
// works from /product/src/ in dev and /local-assistant/ in production.
const PRECACHE = [
  './loader.js',
  './widget.js',
  './widget.css',
  './config.js',
  './embedder.js',
  './retriever.js',
  './prompt.js',
  './suggest.js',
  './overview.js',
  './theme.js',
  './gpu.js',
  './cpuchat.js',
  './cpu-worker.js',
  // loader.js imports indexcodec.js statically and fetches its config before
  // anything else; both must survive offline or the loader cannot boot.
  './indexcodec.js',
  configPath,
  `${indexPath}.bin`,
  `${indexPath}.json`
];

const assetPaths = new Set(PRECACHE.map(entry => new URL(entry, workerUrl).pathname));
const precacheUrls = new Set(PRECACHE.map(entry => new URL(entry, workerUrl).href));

// The vendored runtimes the widget imports at load time sit next to the
// precached files but are far too large to fetch before a visitor consents.
// They are cached the first time they are used and served from the cache
// afterwards, which is what keeps a consented visitor working offline.
const assetDir = new URL('./', workerUrl).pathname;
const isRuntimeAsset = (pathname) => pathname.startsWith(assetDir) && /\.(js|mjs|css|wasm|json|bin)$/i.test(pathname);

// A page is worth keeping only if it actually embeds the assistant: this is the
// only navigation content the widget promise covers.
const PAGE_MARKER = /data-assistant|local-assistant\/loader\.js/;
// no-cache means "revalidate before reuse", not "do not store": WordPress and
// most static hosts send it for ordinary HTML, which is exactly the page the
// offline copy exists for. Personalised pages are caught by the Cache-Control
// values that really mean "this copy is for one visitor" and by Set-Cookie.
const PRIVATE_CACHE = /\bno-store\b|\bprivate\b/i;
// WordPress admin, login, cart/checkout, and account pages are never stored.
const PRIVATE_PATH = /(?:^|\/)(wp-admin|wp-login\.php|cart|checkout|my-account)(?:\/|$)/i;

const offline = () => new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });

// Storage is best effort: a full quota must never change what the page got.
const matchStored = async (request, options) => {
  try {
    const cache = await caches.open(CACHE);
    return await cache.match(request, options);
  } catch {
    return null;
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // A fresh install has no index yet: one missing file must not sink the
    // rest. The fetch handler below caches it on a later online visit.
    await Promise.allSettled(PRECACHE.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('local-assistant') && name !== CACHE) await caches.delete(name);
    }
    // The cache name is fixed, so a version bump never drops stale entries by
    // name; prune anything in the live cache that is not part of the widget.
    try {
      const cache = await caches.open(CACHE);
      for (const key of await cache.keys()) {
        const keyUrl = new URL(key.url);
        // A ?ver= entry is the retired copy of an asset: lookups ignore the
        // query string, so the two would compete and the older one could win.
        if (keyUrl.search && assetPaths.has(keyUrl.pathname)) {
          await cache.delete(key);
          continue;
        }
        // Only stale widget files are pruned. Stored pages live under other
        // paths and are the whole point of the offline copy.
        if (keyUrl.pathname.startsWith(assetDir) && !precacheUrls.has(key.url) && !isRuntimeAsset(keyUrl.pathname)) {
          await cache.delete(key);
        }
      }
    } catch { /* storage unavailable: nothing to prune */ }
    await self.clients.claim();
  })());
});

// Store a page only when the origin has not marked it private and its markup
// embeds the assistant. Admin, cart and search-result pages stay network-only.
async function storePage(request, response) {
  if (response.status !== 200 || response.type !== 'basic' || response.redirected) return;
  if (request.headers.has('authorization')) return;
  if (PRIVATE_CACHE.test(response.headers.get('cache-control') || '')) return;
  // Account, cart and search-result pages are per-visitor or per-query. The
  // cookie header that would identify them is not readable here (Chrome hides
  // it from the worker), and Set-Cookie is a forbidden response header, so the
  // path is the only reliable signal, the same list the comment promises.
  if (PRIVATE_PATH.test(new URL(request.url).pathname)) return;
  const type = response.headers.get('content-type') || '';
  if (!/text\/html/i.test(type)) return;

  const body = await response.text();
  if (!PAGE_MARKER.test(body)) return;

  // Rebuild without length/encoding headers: fetch hands back decoded bytes.
  const headers = new Headers({ 'content-type': type });
  const cache = await caches.open(CACHE);
  await cache.put(request, new Response(body, { status: 200, statusText: response.statusText, headers }));
}

// Pages are network-first so a visited page is still readable offline; only a
// failed network falls back to the stored copy, matched on the full URL so one
// query string is never served for another.
// Resolves to both the response the page gets and the promise that stores it.
// Reading the clone forces the whole document through the network, so the
// response must be returned first and the store handed to waitUntil; waiting
// for the store would leave the tab blank on a slow link.
async function navigation(request) {
  try {
    const fresh = await fetch(request);
    return { response: fresh, stored: storePage(request, fresh.clone()).catch(() => {}) };
  } catch {
    return { response: (await matchStored(request)) || offline(), stored: Promise.resolve() };
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Model weights live on the HF/MLC CDNs: never touched, never cached.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // waitUntil is called synchronously, as the spec requires; the store runs
    // behind the response the visitor already has.
    const nav = navigation(request);
    event.respondWith(nav.then(result => result.response));
    event.waitUntil(nav.then(result => result.stored).catch(() => {}));
    return;
  }

  // Anything that is not part of the widget passes straight through.
  if (!assetPaths.has(url.pathname) && !isRuntimeAsset(url.pathname)) return;

  const cacheReady = caches.open(CACHE).catch(() => null);
  const hitReady = cacheReady.then(cache =>
    cache ? cache.match(request, { ignoreSearch: true }).catch(() => null) : null);

  // Serve the cached copy at once, then revalidate behind it, so a re-run of
  // Ingest reaches the cache without ever making the visitor wait. waitUntil is
  // called synchronously here: calling it after an await would be dropped.
  event.waitUntil(hitReady.then(async (hit) => {
    if (!hit) return;
    const cache = await cacheReady;
    if (!cache) return;
    let fresh;
    try {
      // no-cache: a CDN max-age must not feed the old index back into storage.
      fresh = await fetch(request, { cache: 'no-cache' });
    } catch {
      return; // offline: keep the cached copy
    }
    // Lookups ignore the query string, so store the path only. Any ?ver=
    // variant already in the cache is deleted first: the oldest match wins an
    // ignoreSearch lookup, so leaving one behind would keep serving it.
    if (fresh.ok) {
      const canonical = new URL(url.pathname, url.origin);
      for (const stale of await cache.keys()) {
        const staleUrl = new URL(stale.url);
        if (staleUrl.pathname === url.pathname && staleUrl.search) await cache.delete(stale);
      }
      await cache.put(new Request(canonical), fresh.clone()).catch(() => {});
    }
  }).catch(() => { /* storage unavailable: keep the cached copy */ }));

  event.respondWith((async () => {
    const hit = await hitReady;
    if (hit) return hit;

    let fresh;
    try {
      fresh = await fetch(request);
    } catch {
      return offline();
    }
    if (fresh.ok) {
      const cache = await cacheReady;
      if (cache) await cache.put(new Request(new URL(url.pathname, url.origin)), fresh.clone()).catch(() => {});
    }
    return fresh;
  })());
});
