import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, discoverUrls } from '../../src/sitemap.js';

const URLSET = `<?xml version="1.0"?><urlset>
  <url><loc>https://ex.com/a</loc></url><url><loc>https://ex.com/b</loc></url>
  <url><loc>https://other.com/x</loc></url></urlset>`;
const INDEX = `<sitemapindex><sitemap><loc>https://ex.com/s1.xml</loc></sitemap></sitemapindex>`;

test('parses a urlset and keeps same-origin URLs only', () => {
  const r = parseSitemap(URLSET, 'https://ex.com');
  assert.equal(r.isIndex, false);
  assert.deepEqual(r.urls, ['https://ex.com/a', 'https://ex.com/b']);
});

test('detects a sitemap index', () => {
  const r = parseSitemap(INDEX, 'https://ex.com');
  assert.equal(r.isIndex, true);
  assert.deepEqual(r.urls, ['https://ex.com/s1.xml']);
});

function fakeFetch(routes) {
  const fetchImpl = async (url) => {
    fetchImpl.calls.push(url);
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  fetchImpl.calls = [];
  return fetchImpl;
}

test('follows one level of sitemap index and caps the page count', async () => {
  const fetchImpl = fakeFetch({
    'https://ex.com/sitemap.xml': INDEX,
    'https://ex.com/s1.xml': URLSET
  });
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 1 });
  assert.deepEqual(urls, ['https://ex.com/a']);
});

test('falls back to link following when the sitemap is missing', async () => {
  const fetchImpl = fakeFetch({
    'https://ex.com/': '<a href="/one">1</a><a href="/two">2</a><a href="/missing">m</a><a href="https://evil.com/x">x</a>',
    'https://ex.com/one': '<a href="/three">3</a>',
    'https://ex.com/two': 'no links',
    'https://ex.com/three': 'end'
  });
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 10 });
  assert.deepEqual(urls.sort(), ['https://ex.com/', 'https://ex.com/one', 'https://ex.com/three', 'https://ex.com/two']);
  assert.ok(urls.includes('https://ex.com/'), 'crawl root belongs in the discovered set');
  assert.ok(!urls.includes('https://ex.com/missing'), 'pages that 404 are not discovered');
  assert.ok(!urls.includes('https://evil.com/x'), 'off-origin links are never followed');
});

test('probes /wp-sitemap.xml when /sitemap.xml is missing', async () => {
  const fetchImpl = fakeFetch({
    'https://ex.com/wp-sitemap.xml': '<urlset><url><loc>https://ex.com/post</loc></url></urlset>'
  });
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 10 });
  assert.deepEqual(urls, ['https://ex.com/post']);
  assert.ok(!fetchImpl.calls.includes('https://ex.com/robots.txt'), 'robots.txt is not needed');
});

test('uses a same-origin Sitemap line from robots.txt', async () => {
  const fetchImpl = fakeFetch({
    'https://ex.com/robots.txt': 'User-agent: *\nDisallow:\nSitemap: https://ex.com/sm.xml\n',
    'https://ex.com/sm.xml': '<urlset><url><loc>https://ex.com/feed</loc></url></urlset>'
  });
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 10 });
  assert.deepEqual(urls, ['https://ex.com/feed']);
});

test('a 200 HTML body at /sitemap.xml falls back to link following', async () => {
  const fetchImpl = fakeFetch({
    'https://ex.com/sitemap.xml': '<html><body>not a sitemap</body></html>',
    'https://ex.com/': '<a href="/page">page</a>',
    'https://ex.com/page': 'end'
  });
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 10 });
  assert.deepEqual(urls.sort(), ['https://ex.com/', 'https://ex.com/page']);
});

test('caps total fetches when pages link to many dead URLs', async () => {
  const links = Array.from({ length: 200 }, (_, i) => `<a href="/dead/${i}">x</a>`).join('');
  const fetchImpl = fakeFetch({ 'https://ex.com/': links });
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 3 });
  assert.deepEqual(urls, ['https://ex.com/']);
  assert.ok(fetchImpl.calls.length <= 28, `expected <= 28 fetches, got ${fetchImpl.calls.length}`);
});

function rejectingFetch(routes, rejects) {
  const fetchImpl = async (url) => {
    fetchImpl.calls.push(url);
    if (rejects.has(url)) throw new TypeError('Failed to fetch');
    const body = routes[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  fetchImpl.calls = [];
  return fetchImpl;
}

test('a rejected /sitemap.xml falls through to /wp-sitemap.xml', async () => {
  const fetchImpl = rejectingFetch(
    { 'https://ex.com/wp-sitemap.xml': '<urlset><url><loc>https://ex.com/post</loc></url></urlset>' },
    new Set(['https://ex.com/sitemap.xml'])
  );
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 10 });
  assert.deepEqual(urls, ['https://ex.com/post']);
  assert.ok(fetchImpl.calls.includes('https://ex.com/wp-sitemap.xml'), 'next sitemap probe is tried');
});

test('link following survives rejected sitemap and robots probes', async () => {
  const fetchImpl = rejectingFetch(
    { 'https://ex.com/': '<a href="/page">page</a>', 'https://ex.com/page': 'end' },
    new Set(['https://ex.com/sitemap.xml', 'https://ex.com/wp-sitemap.xml', 'https://ex.com/robots.txt'])
  );
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 10 });
  assert.deepEqual(urls.sort(), ['https://ex.com/', 'https://ex.com/page']);
});

function rootStatusFetch(status) {
  return async (url) => {
    if (url === 'https://ex.com/') return { ok: false, status, text: async () => '' };
    return { ok: true, status: 200, text: async () => '<html><body>not a sitemap</body></html>' };
  };
}

test('rejects when the root answers 403 and nothing else is usable', async () => {
  await assert.rejects(
    discoverUrls({ fetchImpl: rootStatusFetch(403), origin: 'https://ex.com', maxPages: 10 }),
    /discovered no pages from https:\/\/ex\.com/
  );
});

test('rejects when the root answers 404 and nothing else is usable', async () => {
  await assert.rejects(
    discoverUrls({ fetchImpl: rootStatusFetch(404), origin: 'https://ex.com', maxPages: 10 }),
    /discovered no pages from https:\/\/ex\.com/
  );
});

test('counts the crawl root against maxPages', async () => {
  const fetchImpl = fakeFetch({
    'https://ex.com/': '<a href="/one">1</a><a href="/two">2</a>',
    'https://ex.com/one': '<a href="/three">3</a>'
  });
  const urls = await discoverUrls({ fetchImpl, origin: 'https://ex.com', maxPages: 1 });
  assert.deepEqual(urls.sort(), ['https://ex.com/']);
});
