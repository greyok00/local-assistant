/**
 * Passage retrieval: cosine similarity over the indexed vectors plus a keyword
 * overlap bonus, capped by a relevance gate that refuses thin evidence.
 */
export const KEYWORD_WEIGHT = 0.3;

const STOP = new Set(('a an the and or of to in on for with is are was were be been by at as it this that ' +
  'from what how why who when where do does did can could should would please tell me about').split(' '));

function terms(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter(t => !STOP.has(t)) || [];
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function createRetriever({ meta, vectors, threshold = 0.35, topK = 6 }) {
  // The title joins the chunk's vocabulary: a starter chip asks "Tell me about
  // <page title>", and that title may appear nowhere in the page's prose.
  const chunkTerms = meta.chunks.map(c => new Set(terms(`${c.title} ${c.heading} ${c.text}`)));

  // Pages in descending chunk count: the widget offers the biggest ones as
  // starter chips, which is a better first question than an empty composer.
  const pages = [];
  const byUrl = new Map();
  for (const chunk of meta.chunks) {
    const key = chunk.url || chunk.title || '';
    const entry = byUrl.get(key);
    if (entry) {
      entry.chunks += 1;
    } else {
      const fresh = { url: chunk.url || '', title: chunk.title || '', chunks: 1 };
      byUrl.set(key, fresh);
      pages.push(fresh);
    }
  }
  pages.sort((a, b) => b.chunks - a.chunks);

  return {
    pages,
    search(vector, queryText, k) {
      const wanted = terms(queryText);
      const limit = Math.min(k || topK, meta.chunks.length);

      const scored = vectors.map((vec, i) => {
        const vectorScore = vector.length ? dot(vector, vec) : 0;
        const matched = wanted.length ? wanted.filter(t => chunkTerms[i].has(t)).length : 0;
        const hits = wanted.length ? matched / wanted.length : 0;
        return { index: i, score: vectorScore + KEYWORD_WEIGHT * hits, matched };
      });

      scored.sort((a, b) => b.score - a.score);
      const best = scored.length ? scored[0].score : 0;
      // Embeddings find topical neighbours, not answers: a weather question
      // scored 0.49 against a page about video timestamps that mentioned
      // Phoenix once. One borrowed word is coincidence, so the best passage
      // must carry at least two of the question's content words (or its only
      // one, for a one-word question) before the model is allowed to answer.
      const matched = scored.length ? scored[0].matched : 0;
      const corroborated = wanted.length === 0 || matched >= Math.min(2, wanted.length);
      const passages = scored.slice(0, limit).map(({ index, score }) => ({ score, ...meta.chunks[index] }));
      return { refused: best < threshold || !corroborated, best, matched, corroborated, passages };
    }
  };
}
