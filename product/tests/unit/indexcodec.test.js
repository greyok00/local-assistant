import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeVectors, decodeVectors, buildMeta, assertArtifact } from '../../src/indexcodec.js';

const unit = (seed) => {
  const v = new Float32Array(384);
  v[seed % 384] = 1;
  return v;
};

test('round-trips vectors and header fields', () => {
  const vectors = [unit(0), unit(1), unit(2)];
  const decoded = decodeVectors(encodeVectors(vectors));
  assert.equal(decoded.version, 1);
  assert.equal(decoded.dims, 384);
  assert.equal(decoded.count, 3);
  assert.equal(decoded.vectors[2][2], 1);
});

test('rejects a bad magic number', () => {
  const bytes = encodeVectors([unit(0)]);
  bytes[0] = 0x58;
  assert.throws(() => decodeVectors(bytes), /magic/);
});

test('rejects mismatched dimensions instead of silently truncating', () => {
  const bad = new Float32Array(10);
  assert.throws(() => encodeVectors([bad]), /dims/);
});

test('assertArtifact catches count mismatch and unnormalized rows', () => {
  const meta = buildMeta({ siteName: 'S', model: 'm', chunks: [{ url: '/a', title: 'A', heading: 'H', text: 't' }] });
  const decoded = decodeVectors(encodeVectors([unit(0)]));
  assert.doesNotThrow(() => assertArtifact(meta, decoded));

  const two = decodeVectors(encodeVectors([unit(0), unit(1)]));
  assert.throws(() => assertArtifact(meta, two), /count/);

  const long = unit(0);
  long[0] = 5;
  assert.throws(() => assertArtifact(meta, decodeVectors(encodeVectors([long]))), /normalized/);
});

test('buildMeta records a version, build time and chunk array', () => {
  const meta = buildMeta({ siteName: 'S', model: 'm', chunks: [] });
  assert.equal(meta.version, 1);
  assert.match(meta.built, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(meta.chunks, []);
});

const header = ({ version = 1, dims = 384, count = 0 } = {}) => {
  const bytes = new Uint8Array(12);
  bytes.set([0x4c, 0x41, 0x49, 0x31], 0); // "LAI1"
  const view = new DataView(bytes.buffer);
  view.setUint16(4, version, true);
  view.setUint16(6, dims, true);
  view.setUint32(8, count, true);
  return bytes;
};

test('rejects a header that declares more vectors than the buffer holds', () => {
  const bytes = header({ count: 4_000_000 });
  const started = Date.now();
  assert.throws(() => decodeVectors(bytes), /truncated/);
  assert.ok(Date.now() - started < 1000, 'truncated header must fail without allocating rows');
});

test('rejects a buffer truncated mid-row', () => {
  const full = encodeVectors([unit(0), unit(1)]);
  const cut = full.slice(0, 12 + 384 * 4 + 192); // copy with a shorter underlying buffer
  assert.throws(() => decodeVectors(cut), /truncated/);
});

test('does not read outside a subarray view', () => {
  const artifact = encodeVectors([unit(0), unit(1), unit(2)]);
  const padded = new Uint8Array(artifact.length + 20);
  padded.set(artifact, 10);

  const oneRow = padded.subarray(10, 10 + 12 + 384 * 4);
  assert.throws(() => decodeVectors(oneRow), /truncated/);

  const allRows = padded.subarray(10);
  const decoded = decodeVectors(allRows);
  assert.equal(decoded.count, 3);
  assert.deepEqual(decoded.vectors.map(v => v.length), [384, 384, 384]);
  assert.equal(decoded.vectors[2][2], 1);
});

test('rejects an unsupported dims header', () => {
  assert.throws(() => decodeVectors(header({ dims: 999 })), /unsupported dims/);
});

test('encodeVectors refuses dims that overflow the uint16 header', () => {
  assert.throws(() => encodeVectors([unit(0)], 70000), /dims/);
  assert.throws(() => encodeVectors([unit(0)], 384.5), /dims/);
});

test('assertArtifact rejects non-384 dims and short rows', () => {
  const meta = buildMeta({ siteName: 'S', model: 'm', chunks: [{}] });
  const wrongDims = { version: 1, dims: 999, count: 1, vectors: [unit(0)] };
  assert.throws(() => assertArtifact(meta, wrongDims), /dims/);

  const shortRow = { version: 1, dims: 384, count: 1, vectors: [new Float32Array(192)] };
  assert.throws(() => assertArtifact(meta, shortRow), /expected 384/);
});

test('assertArtifact rejects a vector containing NaN', () => {
  const meta = buildMeta({ siteName: 'S', model: 'm', chunks: [{}] });
  const nan = unit(0);
  nan[1] = NaN;
  const decoded = decodeVectors(encodeVectors([nan]));
  assert.throws(() => assertArtifact(meta, decoded), /NaN/);
});
