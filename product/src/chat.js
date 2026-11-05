/**
 * Model lifecycle for the WebGPU path: pick the runtime, watch load progress,
 * and time out a stalled download. Falls back to the CPU engine when WebGPU is
 * unusable, and reports which engine answered.
 */
import { webgpuStatus, WebGPUUnavailableError } from './gpu.js';
import { createCpuEngine } from './cpuchat.js';

export function buildAppConfig(prebuiltList, model, modelBaseUrl, modelLibUrl = '') {
  const entry = prebuiltList?.find(m => m.model_id === model);
  if (!entry) throw new Error(`unknown model for modelBaseUrl: ${model}`);
  // WebLLM reads the weight location from `model` (not a `model_url` field);
  // leaving it as the prebuilt Hugging Face URL silently ignores the mirror.
  const base = modelBaseUrl.replace(/\/+$/, '');
  return {
    model_list: [{
      model_id: model,
      model: base ? `${base}/${model}/` : entry.model,
      model_lib: modelLibUrl || entry.model_lib
    }]
  };
}

// Weights that finish downloading are not a working engine: a GPU that stalls
// while compiling the WGSL shaders leaves the visitor on "Preparing language
// model" with nothing happening. Give the GPU this long to produce an engine,
// then treat it like any other GPU failure and let the CPU path take over.
export const GPU_INIT_TIMEOUT_MS = 45000;

export async function defaultEngineFactory(model, {
  appConfig, modelBaseUrl = '', modelLibUrl = '', initProgressCallback,
  cpuModel = '', cpuDtype = 'int8', cpuModelMirror = '', gpuInitTimeoutMs = GPU_INIT_TIMEOUT_MS
} = {}) {
  // Fail before the weights download, not inside the WGSL compiler.
  const status = await webgpuStatus();
  const cpuEngine = async (reason) => {
    initProgressCallback?.({ progress: 0, text: 'Starting compatibility model' });
    const engine = await createCpuEngine(cpuModel, {
      // The CPU-weights mirror is its own key: the shipped site mirror only
      // hosts the small search model, so a copied modelMirror pointed the CPU
      // engine at a folder that never had the weights and the compatibility
      // path died to same-origin 404s in a deployed build. Empty mirror = HuggingFace.
      dtype: cpuDtype, mirror: cpuModelMirror, onProgress: initProgressCallback
    });
    engine.reason = reason;
    return engine;
  };
  if (!status.ok) {
    // No WebGPU is not "no assistant": the same model family runs on the CPU
    // through transformers.js. Only a deployment that switches cpuModel off
    // reaches the guidance card.
    if (cpuModel) return cpuEngine(status.reason);
    throw new WebGPUUnavailableError(status.reason);
  }
  // A GPU that passes the preflight can still fail later: a blocked download,
  // a driver that dies compiling the shaders, an offline visitor whose GPU
  // model was never cached. None of that should leave them with a quote when a
  // working engine is one model away.
  try {
    const webllm = await import('./vendor/web-llm/index.js');
    const config = appConfig ?? (modelBaseUrl || modelLibUrl
      ? buildAppConfig(webllm.prebuiltAppConfig?.model_list, model, modelBaseUrl, modelLibUrl)
      : undefined);
    // Without a mirror the id must be one WebLLM knows; otherwise the engine
    // throws deep inside the downloader and the visitor silently lands on the
    // CPU model. Say which id is wrong instead.
    if (!config) {
      const known = webllm.prebuiltAppConfig?.model_list?.some(entry => entry.model_id === model);
      if (!known) {
        throw new Error(`unknown WebLLM model id "${model}" in assistant.config.json`);
      }
    }
    // The race also covers the case where the download finishes and the engine
    // never becomes usable: the timer keeps running from construction.
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`WebGPU engine did not start within ${Math.round(gpuInitTimeoutMs / 1000)}s`)),
        gpuInitTimeoutMs
      );
    });
    try {
      const engine = await Promise.race([
        webllm.CreateMLCEngine(model, { appConfig: config, initProgressCallback }),
        timeout
      ]);
      return engine;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (!cpuModel) throw error;
    initProgressCallback?.({ progress: 0, text: 'Switching to compatibility model' });
    return cpuEngine('gpu-failed');
  }
}

const ABORTED = Symbol('aborted');

export function createChat({
  engineFactory = defaultEngineFactory, model, modelBaseUrl = '', modelLibUrl = '',
  cpuModel = '', cpuDtype = 'int8', cpuModelMirror = '',
  onProgress = () => {}, temperature = 0.2, maxTokens = 256
} = {}) {
  let enginePromise = null;
  let unloadPromise = null;
  let generation = 0;
  // 'gpu' until an engine says otherwise; the widget labels a CPU engine so a
  // slower answer is explained rather than mistaken for a broken one.
  let engineMode = 'gpu';
  const activeAsks = new Set();

  const load = async () => {
    // A pending unload must finish before a new engine is constructed, or the
    // old and new engines coexist briefly.
    while (unloadPromise) await unloadPromise;
    if (!enginePromise) {
      const gen = ++generation;
      enginePromise = engineFactory(model, {
        appConfig: undefined, modelBaseUrl, modelLibUrl, initProgressCallback: onProgress,
        cpuModel, cpuDtype, cpuModelMirror
      }).then(async engine => {
        engineMode = engine?.mode === 'cpu' ? 'cpu' : 'gpu';
        // Engines whose construction is cheap (the CPU worker) finish loading
        // here, where a failure still reaches the widget's error card.
        await engine?.load?.();
        return engine;
      }).catch(error => {
        // Only clear our own failed attempt: a newer load (or an unload) may
        // already own enginePromise by the time this rejection lands.
        if (generation === gen) enginePromise = null;
        throw error;
      });
    }
    return enginePromise;
  };

  return {
    isLoaded: () => enginePromise !== null,
    mode: () => engineMode,
    load,
    async ask(messages, { onToken = () => {}, signal, temperature: askTemperature = temperature } = {}) {
      // The abort hook exists before the await: an unload that lands while the
      // engine is still loading must stop this ask too. Registering it after
      // load() left the ask posting into a terminated engine and hanging.
      const internal = new AbortController();
      const hook = () => internal.abort();
      activeAsks.add(hook);
      const signals = [internal.signal, signal].filter(Boolean);
      const isAborted = () => signals.some(s => s.aborted);
      let iterator = null;
      let removeAbortListeners = () => {};
      try {
        const engine = await load();
        if (isAborted()) return '';
        const stream = await engine.chat.completions.create({
          messages, temperature: askTemperature, max_tokens: maxTokens, stream: true
        });
        iterator = stream[Symbol.asyncIterator]();
        const abortPromise = new Promise(resolve => {
          if (signals.some(s => s.aborted)) { resolve(ABORTED); return; }
          const listeners = [];
          const fire = () => resolve(ABORTED);
          for (const s of signals) {
            if (!s.addEventListener) continue;
            s.addEventListener('abort', fire, { once: true });
            listeners.push([s, fire]);
          }
          removeAbortListeners = () => {
            for (const [s, f] of listeners) s.removeEventListener?.('abort', f);
          };
        });
        let full = '';
        while (true) {
          const next = await Promise.race([iterator.next(), abortPromise]);
          if (next === ABORTED || isAborted()) break;
          if (next.done) break;
          const delta = next.value?.choices?.[0]?.delta?.content || '';
          if (delta) {
            full += delta;
            onToken(delta);
          }
        }
        return full;
      } finally {
        removeAbortListeners();
        activeAsks.delete(hook);
        // Release the upstream stream (web-llm aborts generation on return()).
        // Do not await: a pending next() may never settle after an abort.
        if (iterator) {
          try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* ignore */ }
        }
      }
    },
    unload() {
      if (unloadPromise) return unloadPromise;
      const pending = enginePromise;
      if (!pending) return Promise.resolve();
      // Clear synchronously so a fresh load() starts cleanly, then make sure
      // the in-flight engine (if any) is torn down rather than orphaned.
      enginePromise = null;
      engineMode = 'gpu';
      generation++;
      // Stop any live ask before the engine goes away; it returns its partial
      // text instead of waiting on a dead stream.
      for (const hook of [...activeAsks]) hook();
      const done = (async () => {
        try {
          const engine = await pending;
          await engine.unload?.();
        } catch {
          // A load that failed has no engine to unload.
        }
      })();
      let tracked;
      tracked = done.finally(() => {
        if (unloadPromise === tracked) unloadPromise = null;
      });
      unloadPromise = tracked;
      return tracked;
    }
  };
}
