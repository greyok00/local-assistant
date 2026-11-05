// product/bench/bench.js
//
// Internal measurement harness. Never shipped: it exists so every performance
// and fidelity claim in the release comes from a recorded run.
//
// Real mode (?fake absent) uses the real MiniLM embedder and WebLLM chat, so it
// needs WebGPU and downloads the models. ?fake=1 replaces both with deterministic
// stand-ins so the full plumbing can be exercised in headless Chromium.
import { createEmbedder } from '../src/embedder.js';
import { createRetriever } from '../src/retriever.js';
import { decodeVectors } from '../src/indexcodec.js';
import { buildMessages, parseAnswer } from '../src/prompt.js';
import { createChat } from '../src/chat.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const DIMS = 384;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Same stop list as the retriever, so the fake embedder and the keyword scorer
// agree about which tokens carry meaning.
const STOP = new Set(('a an the and or of to in on for with is are was were be been by at as it this that ' +
  'from what how why who when where do does did can could should would please tell me about').split(' '));

// Fake mode is a test affordance, never a deployed feature: a bookmarked
// bench.html?fake=1 on a real host must not report plausible-looking numbers
// for a fake embedder and a fake model. Only honour the flag from a local page.
export function isFakeMode(search, hostname, protocol = 'http:') {
  const value = new URLSearchParams(search).get('fake');
  if (value === null || value === '' || value === '0') return false;
  if (protocol === 'file:') return true;
  return LOCAL_HOSTS.has(hostname);
}

function tokens(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter(t => !STOP.has(t)) || [];
}

function fnv1a(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const chunkText = (chunk) => `${chunk.heading || ''} ${chunk.text || ''}`;

// Deterministic stand-in for the embedding model. Tokens that occur in the
// artifact's own chunks are given a dedicated dimension (assigned in sorted
// order, so the mapping is stable); every other token is hashed into the
// remaining dimensions. A question that shares no vocabulary with the corpus
// therefore gets an all-zero vector and is refused by the gate, deterministically,
// with no chance of a hash collision lifting an off-topic question over the
// threshold.
export function createFakeEmbedder({ chunks = [], dims = DIMS } = {}) {
  const vocabulary = new Map();
  const corpusTokens = new Set();
  for (const chunk of chunks) for (const token of tokens(chunkText(chunk))) corpusTokens.add(token);
  [...corpusTokens].sort().forEach((token, index) => {
    if (index < dims) vocabulary.set(token, index);
  });
  const free = Math.max(0, dims - vocabulary.size);

  const vectorFor = (text) => {
    const vector = new Float32Array(dims);
    const parts = tokens(text);
    if (parts.length === 0) return vector;
    for (const token of parts) {
      let dim = vocabulary.get(token);
      if (dim === undefined) {
        if (free === 0) continue;
        dim = vocabulary.size + (fnv1a(token) % free);
      }
      vector[dim] += 1;
    }
    let norm = 0;
    for (let i = 0; i < dims; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (!norm) return vector;
    for (let i = 0; i < dims; i++) vector[i] /= norm;
    return vector;
  };

  return {
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) throw new Error('embed: empty input');
      return texts.map(vectorFor);
    },
    async warmup() {},
    dispose() {}
  };
}

// Deterministic stand-in for the chat model: it streams a sentence rebuilt from
// the first retrieved passage, citing [1]. It is not a language model; it only
// proves the stream/parse/timing path runs end to end.
export function createFakeChat({ stepMs = 1 } = {}) {
  return {
    isLoaded: () => true,
    async load() {},
    async ask(messages, { onToken = () => {} } = {}) {
      const user = messages.find(m => m.role === 'user')?.content || '';
      const notes = user.replace(/\n\n[^\n]*\n\nAnswer[^\n]*:$/, '');
      const match = notes.match(/^\[1\] (.*), (.*)\n([\s\S]*)$/);
      if (!match) return 'NOT_COVERED';
      const section = match[2].trim();
      const text = match[3].trim();
      const answer = `${section ? `${section}: ` : ''}${text} [1]`;
      let full = '';
      for (const piece of answer.split(/(\s+)/)) {
        if (!piece) continue;
        if (stepMs) await new Promise(resolve => setTimeout(resolve, stepMs));
        full += piece;
        if (piece.trim()) onToken(piece);
      }
      return full;
    },
    unload() {}
  };
}

export function createRow(record) {
  const row = document.createElement('tr');
  row.dataset.expect = record.expect;
  row.dataset.id = record.id;
  const cells = {};
  for (const field of ['id', 'question', 'ttft', 'total', 'refused', 'sources', 'answer']) {
    const cell = document.createElement('td');
    cell.dataset.field = field;
    cells[field] = cell;
    row.append(cell);
  }
  cells.id.textContent = record.id;
  cells.question.textContent = record.question;
  cells.ttft.textContent = String(record.ttftMs);
  cells.total.textContent = String(record.totalMs);
  cells.refused.textContent = record.refused ? 'yes' : 'no';
  cells.sources.textContent = record.sources.join(' ');
  cells.answer.textContent = record.answer;
  return row;
}

function expectationsMissed(results) {
  return results.filter(r =>
    (r.expect === 'refuse' && !r.refused) ||
    (r.expect === 'answer' && r.refused) ||
    (r.expect === 'answer' && /\[0\]/.test(r.answer))
  );
}

// Pure measurement loop, kept free of DOM so it can be reasoned about and, if
// needed, driven from a test harness. One record per question.
export async function runBench({
  questions, retriever, embedder, chat, maxAnswerWords = DEFAULT_CONFIG.maxAnswerWords,
  onRow = () => {}, now = () => performance.now()
}) {
  const results = [];
  for (const item of questions) {
    const [vector] = await embedder.embed([item.question]);
    const found = retriever.search(vector, item.question);
    let answer = '';
    let rejectedAnswer = '';
    let ttftMs = 0;
    let totalMs = 0;
    let refused = found.refused;

    if (!refused) {
      const start = now();
      let first = 0;
      const ask = (temperature) => chat.ask(
        buildMessages(item.question, found.passages, { maxAnswerWords }),
        { temperature, onToken: () => { if (!first) first = now(); } }
      );
      answer = await ask(undefined);
      let parsed = parseAnswer(answer, found.passages, { question: item.question });
      // Mirror the widget: a loop, an echoed passage, or an unverifiable answer
      // gets one colder retry, and the timing is the total a visitor waits.
      if (parsed.reason === 'repetition' || parsed.reason === 'fence' || parsed.reason === 'ungrounded') {
        answer = await ask(0);
        parsed = parseAnswer(answer, found.passages, { question: item.question });
      }
      const end = now();
      ttftMs = first ? Math.round(first - start) : 0;
      totalMs = Math.round(end - start);
      if (parsed.refused) {
        // Keep the text the guard rejected so a threshold can be tuned from
        // evidence instead of from guesses.
        rejectedAnswer = answer;
        refused = true;
        answer = '';
        // The model declined after generation: this row is a refusal, so its
        // timings are zeroed too. No timestamp from a generation may outlive
        // the answer it measured.
        ttftMs = 0;
        totalMs = 0;
      }
    }

    const record = {
      id: item.id,
      kind: item.kind,
      question: item.question,
      expect: item.expect,
      refused,
      answer,
      ttftMs,
      totalMs,
      sources: found.passages.map(p => p.url),
      best: found.best,
      ...(rejectedAnswer ? { rejectedAnswer } : {})
    };
    results.push(record);
    onRow(record);
  }
  return { results };
}

// --- Page wiring ------------------------------------------------------------

async function storageEstimate() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate) return { usage: 0, quota: 0 };
    return { usage: estimate.usage || 0, quota: estimate.quota || 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

async function loadArtifact(base) {
  const [metaResponse, binResponse] = await Promise.all([
    fetch(`${base}.json`),
    fetch(`${base}.bin`)
  ]);
  if (!metaResponse.ok) throw new Error(`artifact meta: HTTP ${metaResponse.status}`);
  if (!binResponse.ok) throw new Error(`artifact vectors: HTTP ${binResponse.status}`);
  const meta = await metaResponse.json();
  const bytes = new Uint8Array(await binResponse.arrayBuffer());
  return { meta, decoded: decodeVectors(bytes), indexBytes: bytes.byteLength };
}

function init() {
  const params = new URLSearchParams(location.search);
  const fake = isFakeMode(location.search, location.hostname, location.protocol);
  const artifact = params.get('artifact') || DEFAULT_CONFIG.indexPath;
  const model = params.get('model') || DEFAULT_CONFIG.model;
  // loader.js hands a tenant's modelBaseUrl to createChat; the bench has to be
  // able to reproduce that shipped configuration, not just the model id.
  const modelBaseUrl = params.get('modelBaseUrl') ?? DEFAULT_CONFIG.modelBaseUrl;
  const threshold = Number(params.get('threshold') || DEFAULT_CONFIG.relevanceThreshold);
  const topK = Number(params.get('topK') || DEFAULT_CONFIG.topK);
  const maxAnswerWords = Number(params.get('maxAnswerWords') || DEFAULT_CONFIG.maxAnswerWords);

  const runButton = document.getElementById('la-run');
  const saveButton = document.getElementById('la-save');
  const summary = document.getElementById('la-summary');
  const status = document.getElementById('la-status');
  const tbody = document.querySelector('#la-results tbody');
  let payload = null;

  // One chat instance per page, reused across runs while its configuration is
  // unchanged. createChat/WebLLM holds the engine in VRAM; building a fresh one
  // per run would stack engines instead of replacing them. `initMs` is only a
  // real measurement on the cold acquisition; a reused engine reports 0 with
  // engineReused: true so it can never be read as a fast cold start.
  let engine = null; // { key, chat }

  const releaseEngine = () => {
    const current = engine;
    engine = null;
    try {
      const pending = current?.chat.unload?.();
      pending?.catch?.(() => {});
    } catch { /* unload is best effort */ }
  };
  addEventListener('pagehide', releaseEngine);
  addEventListener('beforeunload', releaseEngine);

  const acquireChat = async () => {
    const key = JSON.stringify({ fake, model, modelBaseUrl });
    if (engine && engine.key === key && engine.chat.isLoaded?.() !== false) {
      return { chat: engine.chat, reused: true };
    }
    releaseEngine();
    const chat = fake ? createFakeChat() : createChat({ model, modelBaseUrl });
    await chat.load();
    engine = { key, chat };
    return { chat, reused: false };
  };

  const download = () => {
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `bench-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
  };

  runButton.addEventListener('click', async () => {
    if (runButton.disabled) return;
    // A failed run must not destroy the last good measurement.
    const priorRows = [...tbody.children].map(node => node.cloneNode(true));
    const priorSummary = summary.textContent;
    runButton.disabled = true;
    summary.textContent = 'Running…';
    status.textContent = 'Loading artifact and models…';
    tbody.replaceChildren();

    try {
      // The "before" sample has to precede the model/embedder downloads or the
      // storage delta measures nothing.
      const storageBefore = await storageEstimate();
      const [{ meta, decoded, indexBytes }, questions] = await Promise.all([
        loadArtifact(artifact),
        fetch('./questions.json').then(response => {
          if (!response.ok) throw new Error(`questions.json: HTTP ${response.status}`);
          return response.json();
        })
      ]);

      const embedder = fake ? createFakeEmbedder({ chunks: meta.chunks }) : createEmbedder({ model: DEFAULT_CONFIG.embedder });
      const retriever = createRetriever({ meta, vectors: decoded.vectors, threshold, topK });

      const initStart = performance.now();
      await embedder.warmup?.();
      const { chat, reused } = await acquireChat();
      const engineReused = reused;
      const initMs = engineReused ? 0 : Math.round(performance.now() - initStart);

      status.textContent = `Running ${questions.length} questions…`;
      const { results } = await runBench({
        questions,
        retriever,
        embedder,
        chat,
        maxAnswerWords,
        onRow: record => tbody.append(createRow(record))
      });

      const storageAfter = await storageEstimate();
      const failures = expectationsMissed(results).map(f => ({ id: f.id, expect: f.expect, refused: f.refused }));

      payload = {
        artifact,
        artifactBytes: Math.max(0, storageAfter.usage - storageBefore.usage),
        indexBytes,
        model,
        modelBaseUrl,
        fake,
        initMs,
        engineReused,
        chunks: meta.chunks.length,
        threshold,
        topK,
        storageBeforeBytes: storageBefore.usage,
        storageAfterBytes: storageAfter.usage,
        quotaBytes: storageAfter.quota,
        failures,
        results
      };

      summary.textContent = JSON.stringify(payload, null, 2);
      const refused = results.filter(r => r.refused).length;
      status.textContent = `Done: ${results.length - refused} answered, ${refused} refused, ` +
        `${failures.length} expectation miss${failures.length === 1 ? '' : 'es'}.`;

      saveButton.disabled = false;
      saveButton.onclick = download;
    } catch (error) {
      tbody.replaceChildren(...priorRows);
      summary.textContent = priorSummary;
      status.textContent = `Bench failed: ${error.message}`;
      if (payload) {
        saveButton.disabled = false;
        saveButton.onclick = download;
      } else {
        saveButton.disabled = true;
        saveButton.onclick = null;
      }
    } finally {
      runButton.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') init();
