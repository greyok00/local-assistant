/**
 * One-line install entry point: loads the config and index, boots the engine
 * chain, mounts the widget, and registers the service worker for offline use.
 */
import { mountWidget } from './widget.js';
import { createEmbedder } from './embedder.js';
import { createRetriever } from './retriever.js';
import { createChat } from './chat.js';
import { decodeVectors } from './indexcodec.js';
import { validateConfig, DEFAULT_CONFIG } from './config.js';

// One-line install: <script type="module" src=".../loader.js" data-assistant>.
// Every URL is derived from the script's own src, so the folder can be served
// from any path on any site. Nothing here downloads a model: the embedder and
// chat engine are only constructed/loaded when the visitor opens the panel.
const script = document.currentScript || document.querySelector('script[data-assistant]');
const self = script?.src || location.href;

// A load that stops reporting progress is dead, not slow. Without this the bar
// parks at "Preparing language model 95%" and stays there for the life of the
// tab; with it, the widget's failure path takes over and answers from the pages.
const STALL_MS = 60000;
const withStallWatchdog = (promise, lastEvent, ms = STALL_MS) => new Promise((resolve, reject) => {
  const timer = setInterval(() => {
    if (Date.now() - lastEvent() > ms) {
      clearInterval(timer);
      reject(new Error('model load stalled'));
    }
  }, 2000);
  promise.then(
    value => { clearInterval(timer); resolve(value); },
    cause => { clearInterval(timer); reject(cause); }
  );
});

// Transformers.js reports 0–100; web-llm reports 0–1.
const unitFraction = (p) => {
  const raw = Number(p?.progress);
  if (!Number.isFinite(raw)) return null;
  const value = raw > 1 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, value));
};

// The one-line install is one line: the stylesheet travels with the widget
// unless the host already linked the same file (the WordPress plugin does).
const ensureStylesheet = () => {
  const url = new URL('./widget.css', self);
  // A host that fingerprints assets (?ver=1.2.3, the WordPress plugin does)
  // links the same file under a different query string; compare paths only.
  const linked = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .some(link => {
      try { return new URL(link.href).pathname === url.pathname; } catch { return false; }
    });
  if (linked || document.querySelector('link[data-assistant-style]')) return;
  const href = url.href;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.assistantStyle = '';
  document.head.append(link);
};

// Without the marker the loader has no way to find its own folder (a <script
// src> that is not the last one parsed has no currentScript), so say so once
// instead of doing nothing: an install that silently never appears is the
// hardest kind of bug to report.
if (!script?.hasAttribute('data-assistant')) {
  console.warn('[local-assistant] loader.js needs a <script type="module" data-assistant> tag; nothing was mounted.');
} else if (!document.querySelector('.la-root')) {
  ensureStylesheet();
  const configUrl = script.dataset.config || new URL('./assistant.config.json', self).href;

  let config = null;
  let error = null;
  // Visitors get one neutral sentence; the cause stays here for the console
  // and for an owner who inspects the loader.
  let errorDetail = '';
  let retriever = null;
  let embedder = null;

  try {
    const response = await fetch(configUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`assistant.config.json returned ${response.status}`);
    const checked = validateConfig(await response.json());
    if (!checked.ok) throw new Error(`invalid config: ${checked.errors.join('; ')}`);
    config = checked.config;
  } catch (cause) {
    config = {
      ...DEFAULT_CONFIG,
      siteName: document.title || 'This site',
      assistantName: 'AI Assistant',
      greeting: 'Assistant unavailable'
    };
    errorDetail = `config (${cause.message})`;
    error = 'The assistant is temporarily unavailable.';
    console.warn('[local-assistant] ' + errorDetail);
  }

  // Relative index stems resolve against the config file, not the page, so one
  // install folder works from any depth and under any subdirectory the site is
  // hosted at. Absolute stems (the WordPress default is a full URL) pass through.
  const indexBase = new URL('.', new URL(configUrl, document.baseURI));
  const indexJsonUrl = new URL(`${config.indexPath}.json`, indexBase);
  // Model mirrors follow the same rule: a relative URL means "next to the
  // config", so a self-hosted copy works from any page depth.
  const fromConfig = (value) => (typeof value === 'string' && value.trim()
    ? new URL(value, indexBase).href
    : value);

  // A failed index must not throw away a valid config: only the services fail.
  if (!error) {
    try {
      const [meta, bin] = await Promise.all([
        fetch(indexJsonUrl).then(r => {
          if (!r.ok) throw new Error(`index metadata returned ${r.status}`);
          return r.json();
        }),
        fetch(new URL(`${config.indexPath}.bin`, indexBase)).then(r => {
          if (!r.ok) throw new Error(`index vectors returned ${r.status}`);
          return r.arrayBuffer();
        })
      ]);
      const decoded = decodeVectors(new Uint8Array(bin));
      if (meta.chunks.length !== decoded.count) throw new Error('index metadata does not match its vectors');
      retriever = createRetriever({
        meta, vectors: decoded.vectors,
        threshold: config.relevanceThreshold, topK: config.topK
      });
    } catch (cause) {
      errorDetail = `index (${cause.message})`;
      error = 'The assistant is temporarily unavailable.';
      console.warn('[local-assistant] ' + errorDetail);
    }
  }

  // The embedder is constructed lazily (no pipeline import until warmup/embed)
  // and its progress feed is routed into the load bar.
  let embedderProgress = () => {};
  if (!error) {
    embedder = createEmbedder({
      model: config.embedder, mirror: fromConfig(config.modelMirror),
      onProgress: (p) => embedderProgress(p)
    });
  }

  // The model files live in the browser's own caches, but "have I loaded this
  // before" needs its own flag: without it every page load showed a download
  // card even though the weights were already on disk.
  const modeKey = 'local-assistant.mode';
  const cacheState = {
    /** 'gpu' | 'cpu' from the last successful load, or '' on a first visit. */
    get readyMode() {
      try {
        const mode = localStorage.getItem(modeKey);
        return mode === 'gpu' || mode === 'cpu' ? mode : '';
      } catch { return ''; }
    },
    markReady(mode) {
      try { localStorage.setItem(modeKey, mode === 'cpu' ? 'cpu' : 'gpu'); } catch { /* private mode */ }
    }
  };

  // Two-phase download behind one bar: search model 0–20%, chat model 20–100%.
  // The promise is memoised so reopening or asking again never re-downloads.
  let chatPromise = null;
  const loadChat = ({ onProgress }) => {
    if (chatPromise) return chatPromise;
    let lastEvent = Date.now();
    const emit = (progress, text) => {
      lastEvent = Date.now();
      onProgress({ progress, text });
    };

    chatPromise = (async () => {
      if (embedder) {
        emit(0, 'Downloading search model');
        embedderProgress = (p) => {
          const fraction = unitFraction(p);
          if (fraction === null) return;
          // At 100% the download is done and the browser is compiling; keep
          // the bar short of the end so the label change is visible.
          emit(0.2 * (fraction >= 1 ? 0.95 : fraction),
            fraction >= 1 ? 'Preparing search model' : 'Downloading search model');
        };
        try {
          await embedder.warmup();
        } finally {
          embedderProgress = () => {};
        }
        emit(0.2, 'Search model ready');
      }

      emit(0.2, 'Downloading language model');
      const chat = createChat({
        model: config.model,
        modelMobile: config.modelMobile,
        cpuModel: config.cpuModel,
        cpuDtype: config.cpuDtype,
        cpuModelMirror: fromConfig(config.cpuModelMirror),
        modelBaseUrl: fromConfig(config.modelBaseUrl),
        modelLibUrl: fromConfig(config.modelLibUrl),
        onProgress: (p) => {
          const fraction = unitFraction(p);
          if (fraction === null) {
            // Non-numeric events are lifecycle markers (ready/done): the
            // download has finished and the browser is compiling the weights.
            if (p && (p.status === 'done' || p.status === 'ready')) {
              emit(0.95, 'Preparing language model');
            }
            return;
          }
          if (fraction >= 1) {
            emit(0.95, 'Preparing language model');
          } else {
            emit(0.2 + 0.8 * fraction, 'Downloading language model');
          }
        }
      });
      await withStallWatchdog(chat.load(), () => lastEvent);
      emit(1, 'Ready offline');
      navigator.storage?.persist?.().catch(() => false);
      return { ask: (messages, opts) => chat.ask(messages, opts), mode: chat.mode() };
    })().catch(cause => {
      chatPromise = null;
      embedderProgress = () => {};
      throw cause;
    });
    return chatPromise;
  };

  if ('serviceWorker' in navigator && /^https?:/i.test(self)) {
    // ?index= and ?config= must be the absolute paths the page fetches, so a
    // relative indexPath still precaches the same artifact.
    const indexStem = indexJsonUrl.pathname.replace(/\.json$/i, '');
    const configPath = new URL(configUrl, document.baseURI).pathname;
    const worker = new URL(
      `./service-worker.js?index=${encodeURIComponent(indexStem)}&config=${encodeURIComponent(configPath)}`,
      self
    );
    // Scope '/' covers every page, but the browser refuses it unless the worker
    // is served from the origin root or the host sends Service-Worker-Allowed.
    // Asking anyway logs an error on every load, so default to the worker's own
    // folder and let a host that sends the header opt in with data-scope="/".
    const requestedScope = script.dataset.scope || new URL('./', worker).pathname;
    navigator.serviceWorker.register(worker, { scope: requestedScope })
      .catch(() => navigator.serviceWorker.register(worker))
      .then((registration) => {
        // The browser checks a registration for updates at most once a day, and
        // a host whose pages sit outside the worker's folder (this scope) never
        // triggers the controlled-page check at all, the first build we ever
        // shipped stayed active in the browser for exactly that reason. Ask
        // once an hour instead, so a fixed runtime reaches visitors the same day.
        const key = 'local-assistant.sw-check';
        let last = 0;
        try { last = Number(localStorage.getItem(key)) || 0; } catch { /* private mode */ }
        if (Date.now() - last < 60 * 60 * 1000) return;
        try { localStorage.setItem(key, String(Date.now())); } catch { /* private mode */ }
        registration.update?.().catch(() => {});
      })
      .catch(() => { /* the offline layer is optional */ });
  }

  try {
    mountWidget({ config, services: { embedder, retriever, loadChat, cacheState, error, errorDetail } });
  } catch (cause) {
    // A broken embed must never break the host page.
    console.warn('[local-assistant] widget not mounted:', cause);
  }
}
