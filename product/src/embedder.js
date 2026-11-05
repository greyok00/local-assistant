/**
 * The search-side embedding model (MiniLM through transformers.js), including
 * the self-hosted mirror layout and the batching used while indexing.
 */
// A self-hosted mirror is laid out as <mirror>/<org>/<model>/<file>; the
// default Hugging Face template would insert /resolve/<revision>/ in the middle.
function useMirror(env, mirror) {
  if (!mirror || !/^https?:/i.test(mirror)) return;
  env.remoteHost = mirror.endsWith('/') ? mirror : `${mirror}/`;
  env.remotePathTemplate = '{model}/';
}

export async function defaultLoad(model, onProgress, mirror = '') {
  const { pipeline, env } = await import('./vendor/transformers/transformers.min.js');
  useMirror(env, mirror);
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    // Without this the bundle falls back to jsdelivr for its ONNX runtime, which
    // breaks the "no third-party CDN at runtime" promise. The vendored copy of
    // the same files sits next to transformers.min.js. Only http(s) URLs can be
    // fetched by the runtime, so a file:// or other scheme keeps the default.
    const wasmBase = new URL('./vendor/transformers/', import.meta.url);
    if (wasmBase.protocol === 'http:' || wasmBase.protocol === 'https:') {
      env.backends.onnx.wasm.wasmPaths = wasmBase.href;
    }
  }
  return pipeline('feature-extraction', model, { dtype: 'q8', progress_callback: onProgress });
}

export function createEmbedder({ load = defaultLoad, model = 'Xenova/all-MiniLM-L6-v2', mirror = '', onProgress } = {}) {
  let pipelinePromise = null;

  const get = () => {
    if (!pipelinePromise) {
      pipelinePromise = load(model, onProgress, mirror).catch(error => {
        pipelinePromise = null;
        throw error;
      });
    }
    return pipelinePromise;
  };

  return {
    async embed(texts) {
      if (!Array.isArray(texts) || texts.length === 0) throw new Error('embed: empty input');
      const pipe = await get();
      const output = await pipe(texts, { pooling: 'mean', normalize: true });
      return output.tolist().map(row => Float32Array.from(row));
    },
    // Starts the (single) pipeline download without embedding anything, so the
    // widget can charge the consent bar for the search model as well.
    async warmup() {
      await get();
    },
    dispose() {
      pipelinePromise = null;
    }
  };
}
