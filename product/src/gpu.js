// WebGPU is the only backend WebLLM can run on, but `navigator.gpu` existing is
// not enough: `requestAdapter()` returns null on a blocklisted GPU, a remote
// session, or Brave/Firefox on Linux, and a software adapter (SwiftShader) can
// appear while lacking the half-precision shader feature the q4f16 model
// compiles with. Checking both here turns a ~200 MB download that dies at
// compile time into one card the visitor can act on.

const ADAPTER_TIMEOUT_MS = 4000;

/**
 * @returns {Promise<{ok: true, adapter: object} | {ok: false, reason: 'no-api'|'no-adapter'|'no-f16'}>}
 */
export async function webgpuStatus(gpu = globalThis.navigator?.gpu, timeoutMs = ADAPTER_TIMEOUT_MS) {
  if (!gpu || typeof gpu.requestAdapter !== 'function') return { ok: false, reason: 'no-api' };
  let timer;
  try {
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      // A wedged driver should not leave the panel spinning forever.
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); })
    ]);
    if (!adapter) return { ok: false, reason: 'no-adapter' };
    // The model is q4f16; without shader-f16 its WGSL fails with
    // "extension 'f16' is not allowed", which means nothing to a visitor.
    if (adapter.features?.has && !adapter.features.has('shader-f16')) {
      return { ok: false, reason: 'no-f16' };
    }
    return { ok: true, adapter };
  } catch {
    return { ok: false, reason: 'no-adapter' };
  } finally {
    clearTimeout(timer);
  }
}

export class WebGPUUnavailableError extends Error {
  constructor(reason) {
    super(`WebGPU unavailable (${reason})`);
    this.name = 'WebGPUUnavailableError';
    this.code = 'webgpu-unavailable';
    this.reason = reason;
  }
}
