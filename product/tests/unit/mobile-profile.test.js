// product/tests/unit/mobile-profile.test.js
// 2026-11-09: the mobile GPU profile — phones keep web-llm (never CPU) but
// drop to the 135M q0f16 MLC build with a longer compile watchdog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GPU_INIT_TIMEOUT_MS, MOBILE_INIT_TIMEOUT_MS,
         isMobileDevice, mobileProfile } from '../../src/chat.js'
assert.strictEqual(typeof GPU_INIT_TIMEOUT_MS, 'number');
test('isMobileDevice: android chrome, iphone, ipad', () => {
  assert.equal(
    isMobileDevice('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36'),
    true);
  assert.equal(
    isMobileDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile Safari/604.1'),
    true);
  assert.equal(isMobileDevice('Mozilla/5.0 (iPad; CPU OS 17_5)'), true);
});

test('isMobileDevice: desktop stays desktop', () => {
  assert.equal(
    isMobileDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36'),
    false);
});

test('mobileProfile: phones take the 135M build and the 90s watchdog', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/126 Mobile';
  const p = mobileProfile('SmolLM2-360M-Instruct-q4f16_1-MLC',
                          { modelMobile: 'SmolLM2-135M-Instruct-q0f16-MLC', ua });
  assert.equal(p.model, 'SmolLM2-135M-Instruct-q0f16-MLC');
  assert.equal(p.gpuInitTimeoutMs, MOBILE_INIT_TIMEOUT_MS);
  assert.ok(MOBILE_INIT_TIMEOUT_MS > GPU_INIT_TIMEOUT_MS);
});

test('mobileProfile: empty modelMobile keeps the desktop model', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5)';
  const p = mobileProfile('SmolLM2-360M-Instruct-q4f16_1-MLC',
                          { modelMobile: '', ua });
  assert.equal(p.model, 'SmolLM2-360M-Instruct-q4f16_1-MLC');
  assert.equal(p.gpuInitTimeoutMs, MOBILE_INIT_TIMEOUT_MS);
});

test('mobileProfile: desktops keep the current behavior exactly', () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126';
  const p = mobileProfile('SmolLM2-360M-Instruct-q4f16_1-MLC',
                          { modelMobile: 'ignored-on-desktop', ua });
  assert.equal(p.model, 'SmolLM2-360M-Instruct-q4f16_1-MLC');
  assert.equal(p.gpuInitTimeoutMs, GPU_INIT_TIMEOUT_MS);
});
