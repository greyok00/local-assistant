import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Proves the shipped embedding path runs with nothing but same-origin files:
// dist/embedder.js loads the vendored transformers bundle and its ONNX runtime
// from dist/vendor, and the model weights are served from a local fixture
// cache. Any request to another origin (cdn.jsdelivr.net, huggingface.co, ...)
// is aborted, so a CDN regression fails the test instead of passing silently.
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CACHE = fileURLToPath(new URL('../fixtures/models/', import.meta.url));
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx'
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
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
      'cache-control': 'no-cache'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
};

// Downloads once, then reuses. Redirects are followed here so the browser never
// sees an HF redirect host; it only ever asks for the resolve URL.
async function ensureModelCache() {
  for (const file of MODEL_FILES) {
    const path = join(CACHE, MODEL, file);
    try {
      const info = await stat(path);
      if (info.size > 0) continue;
    } catch { /* not cached yet */ }
    const response = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${file}`);
    if (!response.ok) throw new Error(`model fixture ${file}: HTTP ${response.status}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }
}

// The first run downloads the ~23 MB quantised model into the fixture cache.
test.describe.configure({ timeout: 300_000 });

let server;
let origin;
const foreign = [];

test.beforeAll(async () => {
  await ensureModelCache();
  ({ server, origin } = await listen(serveRepo));
});

test.afterAll(() => server?.close());

test('embedding runs from dist/ with no request leaving the origin', async ({ page }) => {
  test.setTimeout(300_000);
  foreign.length = 0;

  // Everything that is not the local server is either served from the local
  // model cache (the official HF path) or refused.
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === origin) return route.continue();
    if (requestUrl.href.startsWith(`https://huggingface.co/${MODEL}/resolve/main/`)) {
      const relativePath = requestUrl.pathname.split('/resolve/main/')[1];
      try {
        const body = await readFile(join(CACHE, MODEL, relativePath));
        return route.fulfill({
          status: 200,
          contentType: relativePath.endsWith('.onnx') ? 'application/octet-stream' : TYPES[extname(relativePath)] || 'application/octet-stream',
          body
        });
      } catch { /* fall through to abort */ }
    }
    foreign.push(requestUrl.href);
    return route.abort();
  });

  await page.goto(`${origin}/product/tests/e2e/embed-smoke.html`);
  const vectors = await page.evaluate(() => window.__embed(['hello']));

  expect(vectors).toHaveLength(1);
  expect(vectors[0].size).toBe(384);
  expect(vectors[0].kind).toBe('[object Float32Array]');
  expect(Number.isFinite(vectors[0].first)).toBe(true);
  expect(foreign).toEqual([]);
});
