// Retrieval-only check on the real artifact. The WebGPU chat engine could not
// initialize on this machine (see demo/README.md), so this records the half of
// the bench that does not need it: MiniLM embedding + the relevance gate.
//
//   node demo/scripts/check-retrieval.mjs <base-url> <out.json>
import fs from 'node:fs/promises';
import path from 'node:path';
import pkg from '../../product/node_modules/playwright-core/index.js';

const { chromium } = pkg;
const [baseUrl, outPath] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(baseUrl + '/');

const rows = await page.evaluate(async () => {
  const [{ createEmbedder }, { createRetriever }, { decodeVectors }, { DEFAULT_CONFIG }] = await Promise.all([
    import('/local-assistant/embedder.js'),
    import('/local-assistant/retriever.js'),
    import('/local-assistant/indexcodec.js'),
    import('/local-assistant/config.js')
  ]);
  const metaResponse = await fetch('/local-assistant/assistant-index.json');
  const binResponse = await fetch('/local-assistant/assistant-index.bin');
  const meta = await metaResponse.json();
  const bin = new Uint8Array(await binResponse.arrayBuffer());
  const decoded = decodeVectors(bin);
  const questions = await (await fetch('/local-assistant/bench/questions.json')).json();
  const embedder = createEmbedder({ model: DEFAULT_CONFIG.embedder });
  await embedder.warmup();
  const retriever = createRetriever({
    meta, vectors: decoded.vectors,
    threshold: DEFAULT_CONFIG.relevanceThreshold, topK: DEFAULT_CONFIG.topK
  });
  const out = [];
  for (const item of questions) {
    const [vector] = await embedder.embed([item.question]);
    const found = retriever.search(vector, item.question);
    out.push({
      id: item.id, kind: item.kind, expect: item.expect, question: item.question,
      refused: found.refused, best: found.best,
      sources: found.passages.slice(0, 3).map(p => ({ score: p.score, url: p.url, title: p.title }))
    });
  }
  return { chunks: meta.chunks.length, dims: decoded.dims, count: decoded.count, threshold: DEFAULT_CONFIG.relevanceThreshold, rows: out };
});
await page.close();
await browser.close();

await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
await fs.writeFile(path.resolve(outPath), JSON.stringify(rows, null, 2) + '\n');
const refusalRows = rows.rows.filter(r => r.expect === 'refuse');
console.log(JSON.stringify({
  chunks: rows.chunks, dims: rows.dims, count: rows.count, threshold: rows.threshold,
  refusedTotal: rows.rows.filter(r => r.refused).length,
  refusalsOnUnanswerable: `${refusalRows.filter(r => r.refused).length}/${refusalRows.length}`
}, null, 2));
for (const row of rows.rows) {
  console.log(`${row.id} ${row.expect} refused=${row.refused} best=${row.best.toFixed(4)} top=${row.sources[0]?.title || '-'}`);
}
