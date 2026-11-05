import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { runIngest } from '../../src/ingest.js';

const page = (title, body) => `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

const routes = {
  'https://ex.com/sitemap.xml': '<urlset><url><loc>https://ex.com/</loc></url><url><loc>https://ex.com/a</loc></url><url><loc>https://ex.com/missing</loc></url></urlset>',
  'https://ex.com/': page('Home', '<h1>Home</h1><p>Welcome to the site.</p>'),
  'https://ex.com/a': page('Article', '<h1>Article</h1><p>Something useful.</p>')
};

const fetchImpl = async (url) => {
  const body = routes[url];
  if (body === undefined) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, status: 200, text: async () => body };
};

const embedder = {
  async embed(texts) { return texts.map((t, i) => { const v = new Float32Array(384); v[i % 384] = 1; return v; }); }
};

test('ingests pages, skips failures, and reports them', async () => {
  const events = [];
  const result = await runIngest({
    fetchImpl, origin: 'https://ex.com', embedder, parse: DOMParser,
    onProgress: e => events.push(e)
  });
  assert.equal(result.meta.chunks.length, 2);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].url, 'https://ex.com/missing');
  assert.ok(events.some(e => e.phase === 'embed' && e.total === 2));
  assert.ok(events.some(e => e.phase === 'done'));
});

test('artifact validates against its vectors', async () => {
  const result = await runIngest({ fetchImpl, origin: 'https://ex.com', embedder, parse: DOMParser });
  const { decodeVectors, assertArtifact } = await import('../../src/indexcodec.js');
  assert.doesNotThrow(() => assertArtifact(result.meta, decodeVectors(result.bin)));
});

test('rejects when the embedder returns the wrong number of vectors', async () => {
  const shortEmbedder = {
    async embed(texts) {
      const vectors = texts.map((t, i) => { const v = new Float32Array(384); v[i % 384] = 1; return v; });
      return vectors.slice(0, -1);
    }
  };
  await assert.rejects(
    runIngest({ fetchImpl, origin: 'https://ex.com', embedder: shortEmbedder, parse: DOMParser }),
    /embedder returned 1 vectors for 2 chunks/
  );
});

test('rejects when discovery reaches nothing on the origin', async () => {
  const deadFetch = async () => { throw new TypeError('getaddrinfo ENOTFOUND typo.example'); };
  await assert.rejects(
    runIngest({ fetchImpl: deadFetch, origin: 'https://typo.example', embedder, parse: DOMParser }),
    /ENOTFOUND/
  );
});

test('a page fetch that throws a bare string is recorded and the run continues', async () => {
  const stringThrowingFetch = async (url) => {
    if (url === 'https://ex.com/a') throw 'boom';
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  const result = await runIngest({ fetchImpl: stringThrowingFetch, origin: 'https://ex.com', embedder, parse: DOMParser });
  const failure = result.failures.find(f => f.url === 'https://ex.com/a');
  assert.ok(failure, 'the thrown string is recorded as a failure');
  assert.equal(failure.reason, 'boom');
  assert.equal(result.meta.chunks.length, 1, 'the remaining page is still ingested');
});

test('pages with no text are not counted as chunks', async () => {
  const emptyFetch = async (url) => ({
    ok: true, status: 200,
    text: async () => url.endsWith('sitemap.xml')
      ? '<urlset><url><loc>https://ex.com/</loc></url></urlset>'
      : page('Empty', '')
  });
  const result = await runIngest({ fetchImpl: emptyFetch, origin: 'https://ex.com', embedder, parse: DOMParser });
  assert.equal(result.meta.chunks.length, 0);
  assert.equal(result.bin.byteLength, 12);
});
