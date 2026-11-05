/**
 * Splits extracted sections into overlapping word windows. Each passage keeps its
 * heading as a prefix so retrieval can rank by the section it came from.
 */
export function chunkSections(sections, { words = 180, overlap = 40 } = {}) {
  if (overlap >= words) throw new Error('overlap must be smaller than words');
  const step = words - overlap;
  const out = [];

  for (const section of sections) {
    const tokens = section.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    for (let start = 0; start < tokens.length; start += step) {
      const slice = tokens.slice(start, start + words);
      if (slice.length === 0) break;
      out.push({ heading: section.heading, text: `${section.heading}: ${slice.join(' ')}` });
      if (start + words >= tokens.length) break;
    }
  }
  return out;
}
