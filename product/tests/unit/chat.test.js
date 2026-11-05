import test from 'node:test';
import assert from 'node:assert/strict';
import { createChat, buildAppConfig, defaultEngineFactory } from '../../src/chat.js';

const streamOf = (parts) => (async function* () {
  for (const p of parts) yield { choices: [{ delta: { content: p } }] };
})();

function fakeFactory(parts = ['Hello', ' world']) {
  const calls = [];
  const factory = async (model, opts) => {
    calls.push({ model, opts });
    opts.initProgressCallback?.({ progress: 0.5, text: 'loading' });
    return {
      chat: { completions: { create: async (req) => { calls.push({ req }); return streamOf(parts); } } },
      unload: async () => { calls.push({ unloaded: true }); }
    };
  };
  factory.calls = calls;
  return factory;
}

const trackingSignal = () => ({
  aborted: false,
  listeners: new Set(),
  addEventListener(type, fn) { if (type === 'abort') this.listeners.add(fn); },
  removeEventListener(type, fn) { if (type === 'abort') this.listeners.delete(fn); }
});

test('loads once and reports progress', async () => {
  const factory = fakeFactory();
  const progress = [];
  const chat = createChat({ engineFactory: factory, model: 'm', onProgress: p => progress.push(p) });
  await chat.load();
  await chat.load();
  assert.equal(factory.calls.filter(c => c.model).length, 1);
  assert.equal(progress[0].progress, 0.5);
  assert.equal(chat.isLoaded(), true);
  const first = factory.calls.find(c => c.model);
  assert.equal(first.opts.modelBaseUrl, '');
  assert.ok('appConfig' in first.opts);
  assert.equal(typeof first.opts.initProgressCallback, 'function');
});

test('streams deltas and resolves with the full text', async () => {
  const chat = createChat({ engineFactory: fakeFactory(), model: 'm' });
  await chat.load();
  const seen = [];
  const full = await chat.ask([{ role: 'user', content: 'hi' }], { onToken: t => seen.push(t) });
  assert.deepEqual(seen, ['Hello', ' world']);
  assert.equal(full, 'Hello world');
});

test('sends the configured sampling parameters', async () => {
  const factory = fakeFactory();
  const chat = createChat({ engineFactory: factory, model: 'm', temperature: 0.2, maxTokens: 256 });
  await chat.load();
  await chat.ask([{ role: 'user', content: 'hi' }]);
  const req = factory.calls.find(c => c.req).req;
  assert.equal(req.temperature, 0.2);
  assert.equal(req.max_tokens, 256);
  assert.equal(req.stream, true);
});

test('unload clears the engine', async () => {
  const factory = fakeFactory();
  const chat = createChat({ engineFactory: factory, model: 'm' });
  await chat.load();
  await chat.unload();
  assert.equal(chat.isLoaded(), false);
  assert.ok(factory.calls.some(c => c.unloaded));
});

test('concurrent loads share a single engine', async () => {
  let calls = 0;
  const factory = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return {
      chat: { completions: { create: async () => streamOf(['ok']) } },
      unload: async () => {}
    };
  };
  const chat = createChat({ engineFactory: factory, model: 'm' });
  await Promise.all([chat.load(), chat.load()]);
  assert.equal(calls, 1);
});

test('a failed load does not poison later loads', async () => {
  let calls = 0;
  const factory = async () => {
    calls++;
    if (calls === 1) throw new Error('network blip');
    return {
      chat: { completions: { create: async () => streamOf(['ok']) } },
      unload: async () => {}
    };
  };
  const chat = createChat({ engineFactory: factory, model: 'm' });
  await assert.rejects(() => chat.load(), /network blip/);
  assert.equal(chat.isLoaded(), false);
  await chat.load();
  assert.equal(calls, 2);
  assert.equal(chat.isLoaded(), true);
});

test('unload during an in-flight load does not orphan the engine', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const unloads = [];
  const factory = async () => {
    await gate;
    return {
      chat: { completions: { create: async () => streamOf(['ok']) } },
      unload: async () => { unloads.push('unloaded'); }
    };
  };
  const chat = createChat({ engineFactory: factory, model: 'm' });
  const loading = chat.load();
  const unloading = chat.unload();
  release();
  await Promise.all([loading, unloading]);
  assert.deepEqual(unloads, ['unloaded']);
  assert.equal(chat.isLoaded(), false);
});

test('abort stops consumption and returns the partial text without throwing', async () => {
  const controller = new AbortController();
  const seen = [];
  const factory = async () => ({
    chat: {
      completions: {
        create: async () => streamOf(['Hello', ' world', ' again'])
      }
    },
    unload: async () => {}
  });
  const chat = createChat({ engineFactory: factory, model: 'm' });
  await chat.load();
  const full = await chat.ask([{ role: 'user', content: 'hi' }], {
    signal: controller.signal,
    onToken: (t) => { seen.push(t); controller.abort(); }
  });
  assert.deepEqual(seen, ['Hello']);
  assert.equal(full, 'Hello');
});

test('unload mid-stream resolves the ask with its partial text', async () => {
  const seen = [];
  let releaseToken;
  const tokenSeen = new Promise(resolve => { releaseToken = resolve; });
  const unloads = [];
  let engine;
  const factory = async () => {
    engine = {
      chat: {
        completions: {
          create: async () => (async function* () {
            yield { choices: [{ delta: { content: 'Hello' } }] };
            await new Promise(() => {}); // never yields again
          })()
        }
      },
      unload: async () => { unloads.push('unloaded'); }
    };
    return engine;
  };
  const chat = createChat({ engineFactory: factory, model: 'm' });
  await chat.load();
  const asking = chat.ask([{ role: 'user', content: 'hi' }], {
    onToken: (t) => { seen.push(t); releaseToken(); }
  });
  await tokenSeen;
  await chat.unload();
  const full = await asking;
  assert.deepEqual(seen, ['Hello']);
  assert.equal(full, 'Hello');
  assert.deepEqual(unloads, ['unloaded']);
  assert.ok(engine);
});

test('an unload during the load stops the ask instead of hanging it', async () => {
  // The abort hook used to be registered after await load(), so an unload that
  // landed during a slow download left the ask posting into a terminated
  // engine and its promise never settled.
  let releaseCreate;
  const gate = new Promise(resolve => { releaseCreate = resolve; });
  const factory = async () => {
    await gate;
    return {
      chat: { completions: { create: async () => streamOf(['late']) } },
      unload: async () => {}
    };
  };
  const chat = createChat({ engineFactory: factory, model: 'm' });
  const asking = chat.ask([{ role: 'user', content: 'hi' }]);
  await new Promise(resolve => setTimeout(resolve, 5));
  // unload() waits for the engine it is tearing down, so release it while the
  // teardown is in flight, the abort hook fires synchronously either way.
  const unloading = chat.unload();
  releaseCreate();
  await unloading;
  assert.equal(await asking, '');
});

test('load waits for a pending unload before constructing a second engine', async () => {
  const events = [];
  let releaseUnload;
  const unloadGate = new Promise(resolve => { releaseUnload = resolve; });
  let calls = 0;
  const factory = async () => {
    calls++;
    const n = calls;
    events.push(`create${n}`);
    return {
      chat: { completions: { create: async () => streamOf(['ok']) } },
      unload: async () => { events.push(`unload${n}:start`); await unloadGate; events.push(`unload${n}:done`); }
    };
  };
  const chat = createChat({ engineFactory: factory, model: 'm' });
  await chat.load();
  const unloading = chat.unload();
  const loading = chat.load();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1, 'second engine must not be built while the first unload is pending');
  releaseUnload();
  await unloading;
  await loading;
  assert.deepEqual(events, ['create1', 'unload1:start', 'unload1:done', 'create2']);
});

test('buildAppConfig maps a known model to the base URL', () => {
  const cfg = buildAppConfig(
    [{ model_id: 'm', model: 'https://cdn/m.wasm', model_lib: 'https://cdn/m.wasm' }],
    'm',
    'https://base'
  );
  assert.deepEqual(cfg, {
    model_list: [{
      model_id: 'm',
      model: 'https://base/m/',
      model_lib: 'https://cdn/m.wasm'
    }]
  });
});

test('buildAppConfig throws for an unknown model instead of building an empty entry', () => {
  assert.throws(
    () => buildAppConfig([{ model_id: 'other' }], 'nope', 'https://base'),
    /unknown model for modelBaseUrl: nope/
  );
});

test('an already-aborted signal skips the completion request', async () => {
  const factory = fakeFactory();
  const controller = new AbortController();
  controller.abort();
  const chat = createChat({ engineFactory: factory, model: 'm' });
  const full = await chat.ask([{ role: 'user', content: 'hi' }], { signal: controller.signal });
  assert.equal(full, '');
  assert.equal(factory.calls.filter(c => c.req).length, 0);
});

test('removes abort listeners after a completed ask', async () => {
  const signal = trackingSignal();
  const chat = createChat({ engineFactory: fakeFactory(), model: 'm' });
  await chat.load();
  await chat.ask([{ role: 'user', content: 'hi' }], { signal });
  assert.equal(signal.listeners.size, 0);
});

test('buildAppConfig honours a model_lib override', () => {
  const cfg = buildAppConfig(
    [{ model_id: 'm', model: 'https://cdn/m.wasm', model_lib: 'https://github/m-lib.wasm' }],
    'm',
    'https://base',
    'https://self-hosted/m-lib.wasm'
  );
  assert.equal(cfg.model_list[0].model_lib, 'https://self-hosted/m-lib.wasm');
});

test('buildAppConfig sets the weight URL (model) and tolerates a trailing slash', () => {
  const cfg = buildAppConfig(
    [{ model_id: 'm', model: 'https://cdn/m/', model_lib: 'https://cdn/m.wasm' }],
    'm',
    'https://base/mirror/'
  );
  assert.equal(cfg.model_list[0].model, 'https://base/mirror/m/');
  assert.equal(cfg.model_list[0].model_url, undefined);
});

test('buildAppConfig keeps the prebuilt weight URL when no mirror is configured', () => {
  const cfg = buildAppConfig([{ model_id: 'm', model: 'https://cdn/m/' }], 'm', '');
  assert.equal(cfg.model_list[0].model, 'https://cdn/m/');
});

test('defaultEngineFactory refuses to download when WebGPU is unavailable', async () => {
  // Node has no navigator.gpu; the check must fire before vendor/web-llm loads.
  await assert.rejects(
    defaultEngineFactory('m', {}),
    error => error.code === 'webgpu-unavailable' && error.reason === 'no-api'
  );
});

test('createChat passes the compatibility model to the engine factory', async () => {
  const factory = fakeFactory();
  const chat = createChat({
    engineFactory: factory, model: 'gpu-model', cpuModel: 'owner/cpu-model', cpuDtype: 'q8'
  });
  await chat.load();
  assert.equal(factory.calls[0].model, 'gpu-model');
  assert.equal(factory.calls[0].opts.cpuModel, 'owner/cpu-model');
  assert.equal(factory.calls[0].opts.cpuDtype, 'q8');
});

test('createChat forwards a CPU-only mirror and never the site mirror', async () => {
  const factory = fakeFactory();
  const chat = createChat({ engineFactory: factory, model: 'm', cpuModelMirror: 'https://cdn/c/' });
  await chat.load();
  const opts = factory.calls[0].opts;
  assert.equal(opts.cpuModelMirror, 'https://cdn/c/');
  // The site mirror (search model files) must not reach the CPU engine: it
  // hosts none of the chat weights, so pointing there is a silent dead end.
  assert.equal('modelMirror' in opts, false);
});

test('createChat reports the mode the engine actually used', async () => {
  const cpuChat = createChat({
    engineFactory: async () => ({ mode: 'cpu', chat: { completions: { create: async () => streamOf([]) } } })
  });
  await cpuChat.load();
  assert.equal(cpuChat.mode(), 'cpu');

  const gpuChat = createChat({ engineFactory: fakeFactory() });
  await gpuChat.load();
  assert.equal(gpuChat.mode(), 'gpu');

  // An unload must not leave the CPU label on the next engine.
  const reuser = createChat({
    engineFactory: (() => {
      const modes = ['cpu', 'gpu'];
      return async () => ({
        mode: modes.shift(),
        chat: { completions: { create: async () => streamOf([]) } },
        unload: async () => {}
      });
    })()
  });
  await reuser.load();
  assert.equal(reuser.mode(), 'cpu');
  await reuser.unload();
  await reuser.load();
  assert.equal(reuser.mode(), 'gpu');
});

// GPU-to-CPU fallback: a real CPU fallback engine (mode 'cpu') must be reported
// by chat.mode() so the widget can label the slower path instead of hiding it.
test('a mode-cpu fallback engine is reported as cpu', async () => {
  let calls = 0;
  const cpuEngine = { mode: 'cpu', chat: { completions: { create: async () => {
    const token = { done: true, value: { choices: [{ delta: { content: 'ok' } }] } };
    async function* gen() { yield token; }
    return gen();
  } } } };
  const chat = createChat({
    engineFactory: async () => { calls++; return cpuEngine; },
    model: 'm', onProgress: () => {}
  });
  await chat.ask([{ role: 'user', content: 'q' }]);
  assert.equal(calls, 1);
  assert.equal(chat.mode(), 'cpu');
});
