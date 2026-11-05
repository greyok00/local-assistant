// product/tests/unit/config.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validateConfig } from '../../src/config.js';

test('defaults are valid', () => {
  const r = validateConfig({});
  assert.equal(r.ok, true);
  assert.equal(r.config.topK, 6);
  assert.equal(r.config.relevanceThreshold, 0.35);
  assert.equal(r.config.maxAnswerWords, 120);
});

test('indexPath must not end in .json or .bin', () => {
  const r = validateConfig({ indexPath: '/local-assistant/assistant-index.json' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /indexPath/);
});

test('threshold must be between 0 and 1', () => {
  assert.equal(validateConfig({ relevanceThreshold: 1.5 }).ok, false);
  assert.equal(validateConfig({ relevanceThreshold: -0.1 }).ok, false);
});

test('accent must be a hex color', () => {
  assert.equal(validateConfig({ accent: 'orange' }).ok, false);
  assert.equal(validateConfig({ accent: '#e8622c' }).ok, true);
});

test('unknown keys are rejected so typos surface', () => {
  const r = validateConfig({ topk: 3 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /unknown key: topk/);
});

test('DEFAULT_CONFIG is frozen', () => {
  assert.throws(() => { DEFAULT_CONFIG.topK = 9; }, TypeError);
});

test('prototype-named keys are rejected', () => {
  const r = validateConfig({ toString: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /unknown key: toString/);
});

test('__proto__ payload is rejected and does not pollute the config', () => {
  const r = validateConfig(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(r.ok, false);
  assert.equal(Object.getPrototypeOf(r.config), Object.prototype);
  assert.equal(r.config.polluted, undefined);
});

test('valid config keeps a clean prototype', () => {
  const r = validateConfig({});
  assert.equal(r.ok, true);
  assert.equal(Object.getPrototypeOf(r.config), Object.prototype);
  assert.equal(r.config.polluted, undefined);
});

test('indexPath must not end in .bin', () => {
  assert.equal(validateConfig({ indexPath: '/x/assistant-index.bin' }).ok, false);
});

test('modelBaseUrl and modelLibUrl accept empty, relative, or https and reject the rest', () => {
  assert.equal(validateConfig({}).ok, true);
  assert.equal(validateConfig({ modelBaseUrl: '/models', modelLibUrl: '/models/m.wasm' }).ok, true);
  assert.equal(validateConfig({ modelBaseUrl: './models', modelLibUrl: '../models/m.wasm' }).ok, true);
  assert.equal(validateConfig({ modelBaseUrl: 'https://cdn.example/models' }).ok, true);
  assert.equal(validateConfig({ modelBaseUrl: 'http://insecure.example' }).ok, false);
  assert.equal(validateConfig({ modelLibUrl: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateConfig({ modelLibUrl: 42 }).ok, false);
  // A bare relative path is the form the docs show; the loader resolves it
  // next to the config, so rejecting it broke a documented install.
  assert.equal(validateConfig({ modelBaseUrl: 'mirror/model' }).ok, true);
  assert.equal(validateConfig({ modelBaseUrl: '//evil.example/model' }).ok, false);
});

test('model must be one WebLLM id, not a sentence or a path', () => {
  assert.equal(validateConfig({}).ok, true);
  assert.equal(validateConfig({ model: 'SmolLM2-360M-Instruct-q4f16_1-MLC' }).ok, true);
  assert.equal(validateConfig({ model: 'SmolLM2 360M' }).ok, false);
  assert.equal(validateConfig({ model: 'owner/model' }).ok, false);
});

test('cpuModelMirror accepts empty, relative, or https and rejects the rest', () => {
  assert.equal(validateConfig({ cpuModelMirror: '' }).ok, true);
  assert.equal(validateConfig({ cpuModelMirror: './models/hf/' }).ok, true);
  assert.equal(validateConfig({ cpuModelMirror: 'https://cdn.example/hf/' }).ok, true);
  assert.equal(validateConfig({ cpuModelMirror: '//evil.example/hf/' }).ok, false);
  assert.equal(validateConfig({ cpuModelMirror: 42 }).ok, false);
});

test('cpuModel must be exactly owner/model with no dot segments', () => {
  assert.equal(validateConfig({ cpuModel: 'HuggingFaceTB/SmolLM2-135M-Instruct' }).ok, true);
  assert.equal(validateConfig({ cpuModel: '' }).ok, true);
  assert.equal(validateConfig({ cpuModel: '../evil' }).ok, false);
  assert.equal(validateConfig({ cpuModel: 'owner/../evil' }).ok, false);
  assert.equal(validateConfig({ cpuModel: 'owner/model/extra' }).ok, false);
});

test('modelMirror accepts empty, relative, or https and rejects the rest', () => {
  assert.equal(validateConfig({}).ok, true);
  assert.equal(validateConfig({ modelMirror: './models/hf/' }).ok, true);
  assert.equal(validateConfig({ modelMirror: '/assistant/models/hf/' }).ok, true);
  assert.equal(validateConfig({ modelMirror: 'https://cdn.example/hf/' }).ok, true);
  assert.equal(validateConfig({ modelMirror: 'http://insecure.example/hf/' }).ok, false);
  assert.equal(validateConfig({ modelMirror: '//evil.example/hf/' }).ok, false);
  assert.equal(validateConfig({ modelMirror: 42 }).ok, false);
});
