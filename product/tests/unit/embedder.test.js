import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedder } from '../../src/embedder.js';

const fakePipeline = async (texts) => ({
  tolist: () => texts.map(t => [t.length, 1])
});

test('embeds a batch through the injected pipeline', async () => {
  let seenOptions;
  const recordingPipeline = async (texts, options) => {
    seenOptions = options;
    return { tolist: () => texts.map(t => [t.length, 1]) };
  };
  const e = createEmbedder({ load: async () => recordingPipeline, model: 'fake' });
  const out = await e.embed(['ab', 'abcd']);
  assert.equal(out.length, 2);
  assert.ok(out[1] instanceof Float32Array);
  assert.deepEqual(Array.from(out[1]), [4, 1]);
  assert.deepEqual(seenOptions, { pooling: 'mean', normalize: true });
});

test('loads the pipeline exactly once across calls', async () => {
  let calls = 0;
  const e = createEmbedder({ load: async () => { calls++; return fakePipeline; }, model: 'fake' });
  await e.embed(['a']);
  await e.embed(['b']);
  assert.equal(calls, 1);
});

test('concurrent embeds share a single load', async () => {
  let calls = 0;
  const e = createEmbedder({ load: async () => { calls++; return fakePipeline; }, model: 'fake' });
  const [a, b] = await Promise.all([e.embed(['a']), e.embed(['b'])]);
  assert.equal(calls, 1);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
});

test('rejects empty input instead of sending a pointless request', async () => {
  const e = createEmbedder({ load: async () => fakePipeline, model: 'fake' });
  await assert.rejects(() => e.embed([]), /empty/);
});

test('dispose clears the pipeline so the next embed reloads', async () => {
  let calls = 0;
  const e = createEmbedder({ load: async () => { calls++; return fakePipeline; }, model: 'fake' });
  await e.embed(['a']);
  e.dispose();
  await e.embed(['b']);
  assert.equal(calls, 2);
});

test('a failed load does not poison later embeds', async () => {
  let calls = 0;
  const e = createEmbedder({
    load: async () => {
      calls++;
      if (calls === 1) throw new Error('network blip');
      return fakePipeline;
    },
    model: 'fake'
  });
  await assert.rejects(() => e.embed(['a']), /network blip/);
  const out = await e.embed(['b']);
  assert.equal(calls, 2);
  assert.equal(out.length, 1);
});

test('the mirror is handed to the loader so models come from the site', async () => {
  let seen;
  const e = createEmbedder({
    load: async (model, onProgress, mirror) => { seen = { model, mirror }; return fakePipeline; },
    model: 'owner/model', mirror: 'https://site.example/assistant/models/hf/'
  });
  await e.embed(['a']);
  assert.equal(seen.model, 'owner/model');
  assert.equal(seen.mirror, 'https://site.example/assistant/models/hf/');
});
