// Questions about the site itself ("what all is in this library") are not
// answerable from six retrieved passages, a 360M model reads an index page
// and loops ("the 205 articles are ... the 205 articles are ..."), which was
// the worst answer the widget shipped. The index already knows the count and
// the sections, so answer those questions from the index and never call the
// model. Everything else still goes through retrieval.

const META = [
  /\b(what|what's|whats|list|show|tell me)\b[^?]{0,40}\b(in|inside|does)\b[^?]{0,20}\b(this|the)\s+(library|site)\b/i,
  /\bwhat('?s| is)?\s+(this|the)\s+(library|site)\b/i,
  /\bhow many\s+(articles|pages|topics|sections|subjects)\b/i,
  /\bwhat can (i|you)\s+(ask|search|find)\b/i,
  /\bwhat (topics|subjects|sections)\s+(are|does)\b/i
];

export function isLibraryQuestion(question) {
  const text = String(question ?? '').replace(/\s+/g, ' ').trim();
  return META.some(pattern => pattern.test(text));
}

// Match the names the site prints in its own sidebar, so the answer never
// reads as a second, disagreeing table of contents.
const SECTION_LABELS = {
  cybersecurity: 'Cybersecurity',
  'offensive-security': 'Offensive Security',
  'defense-and-detection': 'Defense & Detection',
  'threat-analysis': 'Threat Analysis',
  cryptography: 'Cryptography',
  'emerging-tech': 'Emerging Tech',
  'digital-forensics': 'Digital Forensics',
  'evidence-and-methods': 'Evidence & Methods',
  'windows-security': 'Windows Security',
  'linux-security': 'Linux Security',
  'security-operations': 'Security Operations',
  'network-analysis': 'Network Analysis',
  standards: 'Standards & Compliance',
  'nist-frameworks': 'NIST Frameworks',
  'compliance-and-policy': 'Compliance & Policy',
  coursework: 'UMGC Coursework'
};

function sectionName(segment) {
  if (SECTION_LABELS[segment]) return SECTION_LABELS[segment];
  return segment
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/** Article and section counts from the index itself; '' when not a meta question. */
export function libraryOverview(question, pages = []) {
  if (!isLibraryQuestion(question)) return '';
  const urls = [...new Set((pages || []).map(page => String(page?.url ?? '')).filter(Boolean))];
  if (!urls.length) return '';
  // Landing pages describe the site, they are not articles.
  const isLanding = (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
    return path === '' || path === '/' || /\/(index\.html?)?$/i.test(path);
  };
  const articles = urls.filter(url => !isLanding(url));
  if (!articles.length) return '';
  const counts = new Map();
  for (const url of articles) {
    const path = url.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
    const segment = path.split('/')[0].replace(/\.html?$/i, '');
    if (!segment) continue;
    counts.set(segment, (counts.get(segment) || 0) + 1);
  }
  const sections = [...counts].sort((a, b) => b[1] - a[1]);
  const total = articles.length;
  const list = sections.map(([segment, count]) => `${sectionName(segment)} (${count})`);
  const phrase = list.length > 1
    ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
    : list[0];
  return `I can answer from ${total} indexed articles across ${sections.length} sections: ${phrase}. Ask about any topic in those sections and I'll answer from the pages.`;
}

// "Tell me about emerging tech" is a request for a section, not a passage: six
// retrieved chunks cover six unrelated articles, and a 360M model asked to
// summarise them invents connective tissue that fails the grounding check:
// the visitor sees "I could not build a reliable answer" for a section the
// library plainly has. Answer section-level asks from the index's titles.
const BROAD_ASK = /\b(tell me about|overview|explain|what'?s in|whats in|what is in|what are in|list|show me|what does .* cover|what do .* cover|everything about)\b/i;

const words = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .split(' ')
  .filter(Boolean);

const titleCase = (value) => value
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, c => c.toUpperCase());

// Indexed titles carry the site's own suffix ("…, Reference Library");
// a listing should read as titles, not as browser tab text.
const EMDASH = String.fromCharCode(0x2014);
function stripSite(title, siteName) {
  const text = String(title ?? '').trim();
  if (!siteName) return text;
  const suffixes = [`${EMDASH} ${siteName}`, ` – ${siteName}`, ` | ${siteName}`, ` - ${siteName}`, `, ${siteName}`];
  for (const suffix of suffixes) {
    if (text.endsWith(suffix)) return text.slice(0, -suffix.length).trim();
  }
  return text;
}

/** Titles under each domain/sub-domain, keyed by slug path. */
function sectionsOf(pages) {
  const sections = new Map();
  for (const page of pages || []) {
    const url = String(page?.url ?? '');
    if (!url) continue;
    const path = url.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\/+/, '');
    // Drop the .html suffix so a directory and an article cannot look alike.
    const segments = path.split('/').filter(Boolean).map(s => s.replace(/\.html?$/i, ''));
    const last = segments.at(-1) || '';
    // Landing/index pages name a section; they are not an article inside one.
    if (!last || /^index$/i.test(last)) continue;
    // An article always sits inside a section; a bare root page does not.
    if (segments.length < 2) continue;
    const title = String(page?.title ?? '').trim() || titleCase(last);
    for (const depth of [1, 2]) {
      // The depth must be a directory: a two-segment path's last piece is the article.
      if (segments.length <= depth) continue;
      const key = segments.slice(0, depth).join('/');
      const entry = sections.get(key) || { slug: key, titles: new Set() };
      entry.titles.add(title);
      sections.set(key, entry);
    }
  }
  return sections;
}

/**
 * A short, accurate listing when the question names a whole section.
 * '' when the question is not section-level or names no section in the index.
 */
export function sectionOverview(question, pages = [], siteName = '') {
  const text = String(question ?? '').replace(/\s+/g, ' ').trim();
  if (!BROAD_ASK.test(text)) return '';
  const asked = new Set(words(text));
  let best = null;
  const sections = sectionsOf(pages);

  // Course codes share a prefix ("ctch605", "ctch625"); "tell me about the
  // ctch classes" names the family, not one code, so list the whole family.
  const families = new Map();
  for (const [key, entry] of sections) {
    const code = /^([a-z]+)\d+$/i.exec(key.split('/').at(-1));
    if (!code) continue;
    const prefix = code[1].toLowerCase();
    if (!asked.has(prefix)) continue;
    const bucket = families.get(prefix) || { titles: new Set() };
    for (const title of entry.titles) bucket.titles.add(title);
    families.set(prefix, bucket);
  }
  for (const [prefix, bucket] of families) {
    if (bucket.titles.size < 2) continue;
    const candidate = { titles: bucket.titles, label: `${prefix.toUpperCase()} coursework`, weight: 1 };
    if (!best
      || candidate.weight > best.weight
      || (candidate.weight === best.weight && candidate.titles.size > best.titles.size)) {
      best = candidate;
    }
  }

  for (const [key, entry] of sections) {
    const segment = key.split('/').at(-1);
    const label = SECTION_LABELS[segment] || titleCase(segment);
    const nameWords = words(label);
    if (!nameWords.length || !nameWords.every(word => asked.has(word))) continue;
    const candidate = { ...entry, label, weight: nameWords.length };
    // "Security Operations" must beat a bare "Security" match; ties go to the
    // section with more articles so the answer is the more useful one.
    if (!best
      || candidate.weight > best.weight
      || (candidate.weight === best.weight && candidate.titles.size > best.titles.size)) {
      best = candidate;
    }
  }
  if (!best || best.titles.size < 2) return '';
  const titles = [...new Set([...best.titles].map(title => stripSite(title, siteName)).filter(Boolean))];
  const shown = titles.slice(0, 8);
  const rest = titles.length - shown.length;
  const list = shown.join('; ');
  return `${best.label} covers ${titles.length} pages in this library: ${list}`
    + `${rest > 0 ? `, and ${rest} more` : ''}. Ask about any one of them and I'll answer from its page.`;
}
