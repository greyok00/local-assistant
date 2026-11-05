// Compatibility engine: a small instruct model running through transformers.js
// on the CPU (WASM), for browsers without WebGPU. Same interface as the WebLLM
// engine, so chat.js and the widget cannot tell the difference beyond speed.
//
// WebGPU is the fast path (a 360M model on the GPU answers in about a second).
// Without it, WebLLM cannot run at all, not slowly, not at all. This module is
// the reason a Firefox, Safari, or older-machine visitor still gets a written
// answer instead of a quoted passage: a smaller instruct model, answering from
// system memory.
//
// The model and the generation loop live in cpu-worker.js. Running them on this
// thread froze the page for the length of every answer; in a worker the main
// thread stays free to paint the tokens as they arrive.
const DEFAULT_MAX_TOKENS = 160;

export async function createCpuEngine(model, {
  dtype = 'int8', mirror = '', onProgress = () => {}, maxTokens = DEFAULT_MAX_TOKENS,
  workerUrl = new URL('./cpu-worker.js', import.meta.url)
} = {}) {
  if (!model) throw new Error('cpu engine: no model configured');

  const worker = new Worker(workerUrl, { type: 'module' });
  const pending = new Map();
  const cancelled = new Set();
  let nextId = 1;
  let resolveReady;
  let rejectReady;

  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => { /* a load failure surfaces through generate() */ });

  const failAll = (error) => {
    rejectReady(error);
    for (const turn of pending.values()) turn.finish(error);
    pending.clear();
  };

  const onMessage = (event) => {
    const message = event.data || {};
    if (message.type === 'progress') {
      onProgress({ progress: message.progress, text: message.text });
      return;
    }
    if (message.type === 'error') return failAll(new Error(message.message));
    if (message.type === 'ready') return resolveReady();
    const turn = pending.get(message.id);
    if (!turn) return;
    if (message.type === 'token') turn.push(message.text);
    else if (message.type === 'done') turn.finish(null);
    else if (message.type === 'generate-error') turn.finish(new Error(message.message));
  };
  worker.addEventListener('message', onMessage);
  worker.postMessage({ type: 'init', model, dtype, mirror });

  const create = ({ messages, temperature = 0.2, max_tokens } = {}) => {
    const budget = Math.max(32, Math.min(Number(max_tokens) || maxTokens, maxTokens));
    const id = nextId++;
    const queue = [];
    let finished = false;
    let failure = null;
    let wake = null;
    let aborted = false;

    const settle = () => { if (wake) { const resolve = wake; wake = null; resolve(); } };

    pending.set(id, {
      push(text) { queue.push(text); settle(); },
      finish(error) { failure = error; finished = true; pending.delete(id); settle(); }
    });

    ready
      .then(() => worker.postMessage({ type: 'generate', id, messages, maxTokens: budget, temperature }))
      .catch((error) => {
        pending.delete(id);
        failure = error;
        finished = true;
        settle();
      });

    const iterator = {
      async next() {
        while (!queue.length && !finished && !aborted) {
          await new Promise((resolve) => { wake = resolve; });
        }
        if (aborted) return { done: true, value: undefined };
        if (queue.length) {
          return { done: false, value: { choices: [{ delta: { content: queue.shift() } }] } };
        }
        pending.delete(id);
        if (failure) throw failure;
        return { done: true, value: undefined };
      },
      async return() {
        // The run continues in the worker; its tokens are dropped from here on
        // so the caller returns at once without freezing anything.
        aborted = true;
        cancelled.add(id);
        queue.length = 0;
        worker.postMessage({ type: 'cancel', id });
        settle();
        return { done: true, value: undefined };
      }
    };

    return { [Symbol.asyncIterator]: () => iterator };
  };

  return {
    mode: 'cpu',
    // The factory resolving only means the worker exists; load() is what makes
    // the download real. Without this the widget showed "ready" before the
    // model was on disk and every question then failed with nothing to retry.
    load: () => ready,
    chat: { completions: { create } },
    async unload() {
      cancelled.clear();
      // Finish the turns instead of dropping them: an iterator waiting on a
      // token has to wake up, or its next() never settles.
      failAll(new Error('engine unloaded'));
      worker.removeEventListener('message', onMessage);
      worker.terminate();
    }
  };
}
