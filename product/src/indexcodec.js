/**
 * Binary container for the embedding half of an index: a small header, then
 * Float32 vectors packed one after another, validated on both write and read.
 */
const MAGIC = [0x4c, 0x41, 0x49, 0x31]; // "LAI1"
const VERSION = 1;
const DIMS = 384;
const HEADER = 12;

export function encodeVectors(vectors, dims = DIMS) {
  if (!Number.isInteger(dims) || dims < 1 || dims > 65535) {
    throw new Error(`invalid dims ${dims}: must be an integer between 1 and 65535`);
  }
  const count = vectors.length;
  const bytes = new Uint8Array(HEADER + count * dims * 4);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, dims, true);
  view.setUint32(8, count, true);

  vectors.forEach((vec, i) => {
    if (vec.length !== dims) throw new Error(`vector ${i} has dims ${vec.length}, expected ${dims}`);
    new Float32Array(bytes.buffer, HEADER + i * dims * 4, dims).set(vec);
  });
  return bytes;
}

export function decodeVectors(bytes) {
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('bad magic: not an LAI1 index');
  }
  if (bytes.byteLength < HEADER) {
    throw new Error(`truncated index: ${bytes.byteLength} bytes cannot hold the ${HEADER}-byte header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const dims = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  if (version !== VERSION) throw new Error(`unsupported index version ${version}`);
  if (dims !== DIMS) throw new Error(`unsupported dims ${dims}`);

  // Never trust the header's count: the view must actually hold every row.
  const available = Math.floor((bytes.byteLength - HEADER) / (dims * 4));
  if (bytes.byteLength < HEADER + count * dims * 4 || available < count) {
    throw new Error(`truncated index: header declares ${count} vectors`);
  }

  const vectors = [];
  for (let i = 0; i < count; i++) {
    const start = HEADER + i * dims * 4;
    const copied = bytes.slice(start, start + dims * 4);
    vectors.push(new Float32Array(copied.buffer));
  }
  return { version, dims, count, vectors };
}

export function buildMeta({ siteName, model, chunks }) {
  return {
    version: VERSION,
    siteName,
    model,
    built: new Date().toISOString(),
    chunks
  };
}

export function assertArtifact(meta, decoded) {
  if (decoded.dims !== DIMS) {
    throw new Error(`dims mismatch: artifact has ${decoded.dims}, expected ${DIMS}`);
  }
  if (meta.chunks.length !== decoded.count) {
    throw new Error(`count mismatch: meta has ${meta.chunks.length}, vectors have ${decoded.count}`);
  }
  decoded.vectors.forEach((vec, i) => {
    if (vec.length !== decoded.dims) {
      throw new Error(`vector ${i} has ${vec.length} values, expected ${decoded.dims}`);
    }
    if (vec.some(n => Number.isNaN(n))) throw new Error(`vector ${i} contains NaN`);
    const len = Math.hypot(...vec);
    if (Math.abs(len - 1) > 1e-3) throw new Error(`vector ${i} is not normalized (length ${len.toFixed(4)})`);
  });
}
