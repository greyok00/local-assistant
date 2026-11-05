import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkSections } from '../../src/chunk.js';

const words = (n, tag = 'w') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');

test('short section becomes one chunk prefixed by heading', () => {
  const out = chunkSections([{ heading: 'Packaging', text: 'Use antistatic bags.' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].heading, 'Packaging');
  assert.equal(out[0].text, 'Packaging: Use antistatic bags.');
});

test('long section is split with overlap and no chunk over 180 words', () => {
  const out = chunkSections([{ heading: 'Long', text: words(400) }], { words: 180, overlap: 40 });
  assert.equal(out.length, 3);
  for (const chunk of out) {
    assert.ok(chunk.text.split(' ').length <= 181, `too long: ${chunk.text.length}`);
  }
  assert.ok(out[0].text.includes('w179'));
  assert.ok(out[1].text.includes('w140'), 'overlap must repeat the last 40 words');
});

test('empty sections are skipped', () => {
  assert.deepEqual(chunkSections([{ heading: 'X', text: '   ' }]), []);
});

test('rejects overlap greater than or equal to window', () => {
  assert.throws(() => chunkSections([{ heading: 'X', text: 'a b' }], { words: 10, overlap: 10 }), /overlap/);
});
