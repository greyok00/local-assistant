import test from 'node:test';
import assert from 'node:assert/strict';
import { webgpuStatus, WebGPUUnavailableError } from '../../src/gpu.js';

const adapterWith = (...features) => ({
  features: { has: name => features.includes(name) }
});

test('no navigator.gpu means no WebGPU at all', async () => {
  assert.deepEqual(await webgpuStatus(undefined), { ok: false, reason: 'no-api' });
  assert.deepEqual(await webgpuStatus({}), { ok: false, reason: 'no-api' });
});

test('a null adapter means WebGPU is present but unusable', async () => {
  const gpu = { requestAdapter: async () => null };
  assert.deepEqual(await webgpuStatus(gpu), { ok: false, reason: 'no-adapter' });
});

test('a rejecting adapter request is reported, never thrown at the widget', async () => {
  const gpu = { requestAdapter: async () => { throw new Error('driver reset'); } };
  assert.deepEqual(await webgpuStatus(gpu), { ok: false, reason: 'no-adapter' });
});

test('a software adapter without shader-f16 is rejected before download', async () => {
  // SwiftShader exposes an adapter but fails q4f16 WGSL at compile time.
  const gpu = { requestAdapter: async () => adapterWith('shader-f32') };
  assert.deepEqual(await webgpuStatus(gpu), { ok: false, reason: 'no-f16' });
});

test('a hardware adapter with shader-f16 passes and is returned', async () => {
  const adapter = adapterWith('shader-f16', 'timestamp-query');
  const gpu = { requestAdapter: async () => adapter };
  const status = await webgpuStatus(gpu);
  assert.equal(status.ok, true);
  assert.equal(status.adapter, adapter);
});

test('an adapter that never answers times out instead of hanging the panel', async () => {
  const gpu = { requestAdapter: () => new Promise(() => {}) };
  assert.deepEqual(await webgpuStatus(gpu, 20), { ok: false, reason: 'no-adapter' });
});

test('the error carries a code and reason the widget can branch on', () => {
  const error = new WebGPUUnavailableError('no-f16');
  assert.equal(error.code, 'webgpu-unavailable');
  assert.equal(error.reason, 'no-f16');
  assert.ok(error instanceof Error);
});
