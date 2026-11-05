/**
 * URL discovery for a site: the sitemap tree (with sitemap indexes), plus the
 * robots.txt fallback when no sitemap exists. Asset URLs are excluded.
 */
const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
const HREF = /href\s*=\s*["']([^"'#]+)["']/g;
const ROBOTS_SITEMAP = /^\s*sitemap:\s*(\S+)\s*$/gim;
const ASSET = /\.(png|jpe?g|gif|svg|webp|pdf|zip|css|js|xml)$/i;
const MAX_CHILDREN = 10;

function sameOrigin(url, origin) {
  try { return new URL(url, origin).origin === new URL(origin).origin; }
  catch { return false; }
}

function isAsset(url) {
  try { return ASSET.test(new URL(url).pathname); }
  catch { return true; }
}

export function parseSitemap(xml, origin) {
  const isIndex = /<sitemapindex[\s>]/.test(xml);
  const urls = [...xml.matchAll(LOC)]
    .map(m => m[1])
    .filter(u => sameOrigin(u, origin));
  return { urls, isIndex };
}

function robotsSitemaps(text, origin) {
  const urls = [];
  for (const match of text.matchAll(ROBOTS_SITEMAP)) {
    try {
      const url = new URL(match[1]);
      if (url.origin === new URL(origin).origin) urls.push(url.href);
    } catch { /* not an absolute URL */ }
  }
  return urls;
}

export async function discoverUrls({ fetchImpl, origin, maxPages = 500 }) {
  const found = new Set();
  const budget = maxPages + 25;
  let fetches = 0;
  let rootRejection = null;

  const load = async (url, { trackRoot = false } = {}) => {
    if (fetches >= budget) return null;
    fetches++;
    // A rejected probe (reset, DNS failure) is just a miss: try the next fallback.
    // The root fetch is the one exception: it is the only proof the origin exists,
    // so remember its rejection and surface it if nothing else is reachable.
    try {
      const res = await fetchImpl(url);
      return res.ok ? await res.text() : null;
    } catch (error) {
      if (trackRoot) rootRejection = error;
      return null;
    }
  };

  // Returns page URLs from a sitemap, or null when the URL is not a usable sitemap.
  const pagesFromSitemap = async (url) => {
    const xml = await load(url);
    if (!xml) return null;
    const parsed = parseSitemap(xml, origin);
    if (!parsed.urls.length) return null;
    if (!parsed.isIndex) return parsed.urls;
    const pages = [];
    for (const child of parsed.urls.slice(0, MAX_CHILDREN)) {
      if (fetches >= budget) break;
      const childXml = await load(child);
      if (childXml) pages.push(...parseSitemap(childXml, origin).urls);
    }
    return pages;
  };

  const root = new URL('/', origin).href;
  const standard = [
    new URL('/sitemap.xml', origin).href,
    new URL('/wp-sitemap.xml', origin).href
  ];

  let pages = null;
  for (const probe of standard) {
    const result = await pagesFromSitemap(probe);
    if (result && result.length) { pages = result; break; }
    if (fetches >= budget) break;
  }

  if ((!pages || !pages.length) && fetches < budget) {
    const robots = await load(new URL('/robots.txt', origin).href);
    if (robots) {
      for (const probe of robotsSitemaps(robots, origin)) {
        if (fetches >= budget) break;
        const result = await pagesFromSitemap(probe);
        if (result && result.length) { pages = result; break; }
      }
    }
  }

  if (pages && pages.length) {
    for (const url of pages) {
      if (found.size >= maxPages) break;
      if (!isAsset(url)) found.add(url);
    }
    if (found.size) return [...found];
  }

  const queue = [root];
  const seen = new Set();
  while (queue.length && found.size < maxPages && fetches < budget) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const html = await load(url, { trackRoot: url === root });
    if (!html) continue;
    found.add(url);
    for (const match of html.matchAll(HREF)) {
      let abs;
      try { abs = new URL(match[1], url); } catch { continue; }
      abs.hash = '';
      if (abs.origin !== new URL(origin).origin) continue;
      if (isAsset(abs.href)) continue;
      if (!seen.has(abs.href) && !found.has(abs.href)) queue.push(abs.href);
    }
  }
  // An empty result is never legitimate: a reachable origin contributes at least its root.
  // Nothing reachable plus a rejected root means the origin is unreachable, so surface
  // the real network error instead of reporting a green run over a site never read.
  if (!found.size && rootRejection) throw rootRejection;
  // A non-ok root (403 challenge, 404 docroot) never rejects, so it leaves no network
  // error to carry: fail with a message that at least names the origin.
  if (!found.size) throw new Error(`discovered no pages from ${origin}`);
  return [...found];
}
