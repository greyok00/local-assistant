/**
 * Index builder: discover URLs, fetch and extract each page, chunk the text,
 * embed the chunks in batches, and package the result for the codec.
 */
import { discoverUrls } from './sitemap.js';
import { extractPage } from './extract.js';
import { chunkSections } from './chunk.js';
import { encodeVectors, buildMeta, assertArtifact, decodeVectors } from './indexcodec.js';

export async function runIngest({
  fetchImpl = fetch, origin, embedder, parse, maxPages = 500, batchSize = 16,
  siteName = new URL(origin).host, model = 'all-MiniLM-L6-v2', onProgress = () => {}
}) {
  const urls = await discoverUrls({ fetchImpl, origin, maxPages });
  onProgress({ phase: 'crawl', done: 0, total: urls.length });

  const failures = [];
  const chunks = [];

  for (const [index, url] of urls.entries()) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) { failures.push({ url, reason: `HTTP ${res.status}` }); continue; }
      const html = await res.text();
      const extracted = extractPage(html, url, { parse });
      const pieces = chunkSections(extracted.sections);
      for (const piece of pieces) {
        chunks.push({ url, title: extracted.title, heading: piece.heading, text: piece.text });
      }
    } catch (error) {
      failures.push({ url, reason: error?.message || String(error) });
    }
    if (index % 5 === 0) onProgress({ phase: 'crawl', done: index + 1, total: urls.length });
  }
  onProgress({ phase: 'crawl', done: urls.length, total: urls.length });

  const vectors = [];
  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    const embedded = await embedder.embed(batch.map(c => c.text));
    if (embedded.length !== batch.length) {
      throw new Error(`embedder returned ${embedded.length} vectors for ${batch.length} chunks`);
    }
    vectors.push(...embedded);
    onProgress({ phase: 'embed', done: Math.min(start + batchSize, chunks.length), total: chunks.length });
  }

  const meta = buildMeta({ siteName, model, chunks });
  const bin = encodeVectors(vectors);
  assertArtifact(meta, decodeVectors(bin));
  onProgress({ phase: 'done', done: chunks.length, total: chunks.length });
  return { meta, bin, failures };
}
