import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetriever, KEYWORD_WEIGHT } from '../../src/retriever.js';

const meta = { version: 1, chunks: [
  { url: '/a', title: 'Bonds', heading: 'Appeal bond', text: 'An appeal bond stays enforcement.' },
  { url: '/b', title: 'Evidence', heading: 'Chain', text: 'Chain of custody begins at seizure.' },
  { url: '/c', title: 'Venue', heading: 'Transfer', text: 'Venue may be transferred for convenience.' }
]};

const vec = (i) => { const v = new Float32Array(384); v[i] = 1; return v; };
const vectors = [vec(0), vec(1), vec(2)];
const q = (i) => { const v = new Float32Array(384); v[i] = 1; return v; };

test('returns passages ordered by score', () => {
  const r = createRetriever({ meta, vectors, threshold: 0.1, topK: 2 });
  const out = r.search(q(1), 'chain of custody');
  assert.equal(out.passages[0].url, '/b');
  assert.equal(out.refused, false);
});

test('refuses when the best score is below the threshold', () => {
  const r = createRetriever({ meta, vectors, threshold: 0.9, topK: 2 });
  const out = r.search(q(5), 'nothing related');
  assert.equal(out.refused, true);
  assert.ok(out.best < 0.9);
});

test('refuses a topically close page that shares no word with the question', () => {
  const r = createRetriever({ meta, vectors, threshold: 0.1, topK: 2 });
  const out = r.search(q(1), 'weather forecast phoenix tomorrow');
  assert.ok(out.best >= 1);         // the vector score alone would pass...
  assert.equal(out.matched, 0);
  assert.equal(out.corroborated, false);
  assert.equal(out.refused, true);  // ...but no word of the question is on the page
});

test('one borrowed word is not corroboration', () => {
  const m = { chunks: [
    { url: '/w', title: 'Chronolocation', heading: 'Timestamps', text: 'A clip filmed in Phoenix anchors the timeline.' }
  ]};
  const r = createRetriever({ meta: m, vectors: [vec(1)], threshold: 0.1, topK: 1 });
  const out = r.search(q(1), 'weather forecast phoenix tomorrow');
  assert.equal(out.matched, 1);
  assert.ok(out.best >= 0.5);       // vector + keyword weight clears the gate...
  assert.equal(out.refused, true);  // ...but the page answers nothing about weather
});

test('a one-word question is corroborated by that word', () => {
  const r = createRetriever({ meta, vectors, threshold: 0.1, topK: 2 });
  const out = r.search(q(1), 'custody');
  assert.equal(out.matched, 1);
  assert.equal(out.corroborated, true);
  assert.equal(out.refused, false);
});

test('a page title counts as vocabulary, so chips can ask about a page', () => {
  const r = createRetriever({ meta, vectors, threshold: 0.1, topK: 2 });
  const out = r.search(q(1), 'Tell me about Evidence');
  assert.equal(out.corroborated, true);
  assert.equal(out.refused, false);
});

test('keyword overlap lifts an exact name above a near tie', () => {
  const near = new Float32Array(384); near[0] = 0.85; near[1] = 0.53;
  const exact = new Float32Array(384); exact[1] = 0.8; exact[0] = 0.6;
  const m = { chunks: [
    { url: '/near', title: 'N', heading: 'N', text: 'unrelated words' },
    { url: '/exact', title: 'E', heading: 'E', text: 'Appeal bond motion' }
  ]};
  const r = createRetriever({ meta: m, vectors: [near, exact], threshold: 0.1, topK: 2 });
  const out = r.search(new Float32Array(384), 'appeal bond');
  assert.equal(out.passages[0].url, '/exact');
});

test('k overrides topK and is clamped to what exists', () => {
  const r = createRetriever({ meta, vectors, threshold: 0.1, topK: 6 });
  assert.equal(r.search(q(0), 'bond', 1).passages.length, 1);
  assert.equal(r.search(q(0), 'bond', 99).passages.length, 3);
});

test('KEYWORD_WEIGHT is the spec value', () => {
  assert.equal(KEYWORD_WEIGHT, 0.3);
});

test('pages lists each page once, biggest first', () => {
  const m = { chunks: [
    { url: '/small', title: 'Small', heading: 'A', text: 'one' },
    { url: '/big', title: 'Big', heading: 'A', text: 'one' },
    { url: '/big', title: 'Big', heading: 'B', text: 'two' },
    { url: '/big', title: 'Big', heading: 'C', text: 'three' }
  ]};
  const r = createRetriever({ meta: m, vectors: [vec(0), vec(1), vec(2), vec(3)], threshold: 0.1 });
  assert.deepEqual(r.pages.map(p => p.url), ['/big', '/small']);
  assert.equal(r.pages[0].chunks, 3);
});
