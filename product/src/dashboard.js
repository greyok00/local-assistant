/**
 * Browser-side indexing page: crawl settings, ingest progress, the artifact
 * download and upload steps, and the shared configuration editor.
 */
import { runIngest } from './ingest.js';
import { createEmbedder } from './embedder.js';
import { validateConfig } from './config.js';

const $ = (id) => document.getElementById(id);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Fixture mode is a test affordance, never a deployed feature: a bookmarked
// dashboard.html?fixture=1 on a real host must not replace a live index with
// hash-noise vectors. Only honour the flag from a local page.
export function isFixtureMode(search, hostname, protocol = 'http:') {
  const value = new URLSearchParams(search).get('fixture');
  if (value === null || value === '' || value === '0') return false;
  if (protocol === 'file:') return true;
  return LOCAL_HOSTS.has(hostname);
}

const isFixture = isFixtureMode(location.search, location.hostname, location.protocol);
const wp = globalThis.wpAssistant;
const isWordPress = Boolean(wp);

// WordPress may hand over either a nested `config` object or the known fields
// flat on wpAssistant. Everything else (ajaxUrl, nonce) is transport, not config.
const wpConfig = wp?.config && typeof wp.config === 'object' ? wp.config : {};
const flatConfig = {};
for (const key of ['siteName', 'embedder', 'maxPages']) {
  if (wp?.[key] !== undefined) flatConfig[key] = wp[key];
}
const validated = validateConfig({ ...wpConfig, ...flatConfig });
const config = validated.config;

$('la-url').value = isWordPress ? location.origin : location.origin + '/';
const saveButton = $('la-save');
if (isWordPress) $('la-wp-save')?.removeAttribute('hidden');

// --- Fixture mode -----------------------------------------------------------
// The e2e suite must not download MiniLM from the HF CDN. In ?fixture=1 we swap
// in a deterministic 384-dim unit-vector embedder and point root-relative
// discovery probes at the checked-in fixture site. Production never takes this path.
const FIXTURE_BASE = '/product/tests/fixtures/site';

function createFixtureEmbedder() {
  const DIMS = 384;
  const vectorFor = (text) => {
    const vec = new Float32Array(DIMS);
    // FNV-1a over the text, then xorshift32 to spread it across the vector.
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    let seed = hash >>> 0 || 1;
    let norm = 0;
    for (let i = 0; i < DIMS; i++) {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5; seed >>>= 0;
      const value = (seed / 4294967296) * 2 - 1;
      vec[i] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIMS; i++) vec[i] /= norm;
    return vec;
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

function fixtureFetch(url) {
  const target = new URL(url, location.href);
  const alreadyFixture = target.pathname === FIXTURE_BASE || target.pathname.startsWith(`${FIXTURE_BASE}/`);
  if (target.origin === location.origin && !alreadyFixture) {
    target.pathname = `${FIXTURE_BASE}${target.pathname === '/' ? '/' : target.pathname}`;
  }
  return fetch(target.href);
}

// --- Progress ---------------------------------------------------------------
// Crawl and embed each own part of the bar, and the bar only ever moves forward.
function createProgress(bar, report) {
  const WEIGHTS = { crawl: 0.4, embed: 0.6 };
  let lastPct = 0;

  return ({ phase, done, total }) => {
    let fraction = 1;
    if (phase === 'crawl' || phase === 'embed') {
      const within = total > 0 ? Math.min(done, total) / total : 0;
      fraction = (phase === 'embed' ? WEIGHTS.crawl : 0) + within * WEIGHTS[phase];
    }
    lastPct = Math.max(lastPct, Math.min(fraction, 1));
    const pct = Math.round(lastPct * 100);
    bar.style.width = `${pct}%`;
    report.textContent = total > 0
      ? `${phase}: ${done}/${total} (${pct}% overall)`
      : `${phase}: working…`;
  };
}

// --- Downloads --------------------------------------------------------------
let downloadUrls = [];

function offerDownloads(metaJson, bin) {
  // Replacing only after a successful run: a failed re-run leaves the previous
  // run's still-valid links on the page.
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls = [];
  const box = $('la-download');
  box.replaceChildren(...[
    ['assistant-index.json', new Blob([metaJson], { type: 'application/json' })],
    ['assistant-index.bin', new Blob([bin], { type: 'application/octet-stream' })]
  ].map(([name, blob]) => {
    const a = document.createElement('a');
    a.className = 'la-file';
    a.href = URL.createObjectURL(blob);
    downloadUrls.push(a.href);
    a.download = name;
    a.textContent = `Download ${name}`;
    return a;
  }));
}

// --- WordPress save ---------------------------------------------------------
let lastResult = null;

function describeError(data) {
  if (data == null) return 'no details returned';
  if (typeof data === 'string') return data;
  if (typeof data === 'object') {
    if (typeof data.message === 'string' && data.message) return data.message;
    try { return JSON.stringify(data); } catch { return String(data); }
  }
  return String(data);
}

// Posts the current result so the owner can retry after a failure. Returns the
// success line; throws a message the caller shows as "Save failed: …".
async function saveToWordPress(result) {
  if (!wp?.nonce) throw new Error('WordPress did not provide a nonce');
  if (!wp?.ajaxUrl) throw new Error('WordPress did not provide an ajax URL');

  const form = new FormData();
  form.append('action', 'local_assistant_save');
  form.append('nonce', wp.nonce);
  form.append('meta', new Blob([result.metaJson], { type: 'application/json' }));
  form.append('bin', new Blob([result.bin], { type: 'application/octet-stream' }));

  const res = await fetch(wp.ajaxUrl, { method: 'POST', body: form, credentials: 'same-origin' });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  if (!json) throw new Error(`unexpected response: ${text.slice(0, 200) || '(empty)'}`);
  if (!json.success) throw new Error(describeError(json.data));
  return `Saved to ${json.data?.path ?? describeError(json.data)}`;
}

if (isWordPress && saveButton) {
  saveButton.addEventListener('click', async () => {
    if (!lastResult) return;
    saveButton.disabled = true;
    try {
      const message = await saveToWordPress(lastResult);
      $('la-report').textContent += `\n${message}`;
    } catch (error) {
      $('la-report').textContent += `\nSave failed: ${error?.message || String(error)}`;
      saveButton.hidden = false;
    } finally {
      saveButton.disabled = false;
    }
  });
}

// --- Ingest -----------------------------------------------------------------
// The standalone page submits a form; the WordPress admin renders a bare
// button with no form around it. One handler serves both.
const ingest = async (event) => {
  event?.preventDefault?.();
  const button = $('la-start');
  const report = $('la-report');
  const bar = $('la-progress').firstElementChild;

  button.disabled = true;
  bar.style.width = '0%';
  // Previous artifacts stay downloadable until this run replaces them, so a
  // failure never strands the owner without a working index.
  report.textContent = 'Starting…';

  if (!validated.ok) {
    report.textContent = `Configuration error: ${validated.errors.join('; ')}`;
    button.disabled = false;
    return;
  }

  let origin;
  try {
    const typed = $('la-url').value.trim();
    const parsed = new URL(typed, location.href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('only http and https URLs are supported');
    }
    origin = parsed.origin;
  } catch (error) {
    report.textContent = `Ingest failed: ${error.message}. Enter a site URL such as https://example.com/`;
    button.disabled = false;
    return;
  }

  try {
    const embedder = isFixture
      ? createFixtureEmbedder()
      : createEmbedder({
        model: config.embedder,
        onProgress: (event) => {
          if (event?.status === 'progress' && Number.isFinite(event.progress)) {
            report.textContent = `Loading search model: ${Math.round(event.progress)}%`;
          }
        }
      });

    // Load (or no-op) the model before crawling so a download failure is reported
    // against the run instead of surfacing halfway through embedding.
    await embedder.warmup();

    const result = await runIngest({
      ...(isFixture ? { fetchImpl: fixtureFetch } : {}),
      origin,
      embedder,
      siteName: isWordPress ? config.siteName : new URL(origin).host,
      maxPages: config.maxPages,
      onProgress: createProgress(bar, report)
    });

    const metaJson = JSON.stringify(result.meta);
    lastResult = { meta: result.meta, bin: result.bin, metaJson };
    const pages = new Set(result.meta.chunks.map(c => c.url)).size;
    const failed = result.failures.length
      ? `\nSkipped pages:\n${result.failures.map(f => `  ${f.url}, ${f.reason}`).join('\n')}`
      : '\nNo skipped pages.';
    report.textContent =
      `${result.meta.chunks.length} ${result.meta.chunks.length === 1 ? 'chunk' : 'chunks'}` +
      ` from ${pages} ${pages === 1 ? 'page' : 'pages'}.` +
      `\nVectors: ${(result.bin.byteLength / 1048576).toFixed(2)} MB` +
      `\nMetadata: ${(new Blob([metaJson]).size / 1048576).toFixed(2)} MB${failed}`;

    if (isWordPress) {
      // A save problem is not an ingest problem: keep the run summary on screen
      // and append the save outcome instead of replacing it.
      try {
        report.textContent += `\n${await saveToWordPress(lastResult)}`;
      } catch (error) {
        report.textContent += `\nSave failed: ${describeError(error?.message || error)}`;
      } finally {
        if (saveButton) saveButton.hidden = false;
      }
    } else {
      offerDownloads(metaJson, result.bin);
    }
  } catch (error) {
    const message = error?.message || String(error);
    // The browser reports both an unreachable host and a cross-origin read that was
    // blocked by missing CORS headers as the same opaque "Failed to fetch".
    const hint = /failed to fetch|load failed|networkerror/i.test(message)
      ? '\nCould not read that site. Check the URL and your connection; if it is another domain, its server must allow cross-origin reads (CORS).'
      : '';
    report.textContent = `Ingest failed: ${message}${hint}`;
    bar.style.width = '0%';
  } finally {
    button.disabled = false;
  }
};

const ingestForm = $('la-form');
if (ingestForm) ingestForm.addEventListener('submit', ingest);
else $('la-start').addEventListener('click', ingest);

// --- Settings ---------------------------------------------------------------
// A static install has no server, so the Settings tab edits the values that
// belong in assistant.config.json and hands back a finished file. WordPress
// saves the same fields through its own form; this form is only rendered on
// the static page, so the two never fight over the same option.
const settingsForm = $('la-settings');

if (settingsForm) {
  const SETTING_FIELDS = {
    assistantName: 'la-set-name',
    greeting: 'la-set-greeting',
    accent: 'la-set-accent',
    topK: 'la-set-topk',
    maxAnswerWords: 'la-set-words',
    relevanceThreshold: 'la-set-threshold',
    maxPages: 'la-set-pages',
  };

  for (const [key, id] of Object.entries(SETTING_FIELDS)) {
    const field = $(id);
    if (field && config[key] !== undefined) field.value = config[key];
  }

  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const note = $('la-settings-note');
    const next = { ...config };

    for (const [key, id] of Object.entries(SETTING_FIELDS)) {
      const field = $(id);
      if (!field) continue;
      const value = field.value.trim();
      next[key] = field.type === 'number' ? Number(value) : value;
    }

    const checked = validateConfig(next);
    if (!checked.ok) {
      note.textContent = `Check these values: ${checked.errors.join('; ')}`;
      return;
    }

    const blob = new Blob([JSON.stringify(checked.config, null, 2) + '\n'], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'assistant.config.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    note.textContent = 'Downloaded assistant.config.json. Put it beside assistant-index.json and .bin.';
  });
}

if (isFixture) {
  const probe = await fetch(`${FIXTURE_BASE}/sitemap.xml`);
  if (probe.ok && !$('la-report').textContent.trim()) {
    $('la-report').textContent = 'Fixture site detected.';
  }
}
