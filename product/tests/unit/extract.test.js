import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { extractPage } from '../../src/extract.js';

const HTML = `<!doctype html><html><head><title>  Evidence Handling, Library </title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <header>Site banner</header>
  <main>
    <h1>Evidence Handling</h1>
    <p>Chain of custody starts at seizure.</p>
    <h2>Packaging</h2>
    <p>Use antistatic bags.   Label every bag.</p>
    <script>console.log('ignore me')</script>
    <aside>Related links</aside>
    <h3>Storage</h3>
    <p>Keep devices powered off.</p>
  </main>
  <footer>© 2026</footer>
</body></html>`;

test('extracts title, headings and body text', () => {
  const page = extractPage(HTML, 'https://example.com/evidence.html', { parse: DOMParser });
  assert.equal(page.title, 'Evidence Handling, Library');
  assert.equal(page.sections.length, 3);
  assert.equal(page.sections[0].heading, 'Evidence Handling');
  assert.equal(page.sections[0].text, 'Chain of custody starts at seizure.');
  assert.equal(page.sections[1].heading, 'Packaging');
  assert.equal(page.sections[1].text, 'Use antistatic bags. Label every bag.');
});

test('drops nav, header, footer, aside, script and style', () => {
  const page = extractPage(HTML, 'https://example.com/evidence.html', { parse: DOMParser });
  const all = page.sections.map(s => s.text).join(' ');
  assert.ok(!all.includes('Home'));
  assert.ok(!all.includes('Site banner'));
  assert.ok(!all.includes('Related links'));
  assert.ok(!all.includes('© 2026'));
  assert.ok(!all.includes('ignore me'));
});

test('text before the first heading lands in a section titled by the page title', () => {
  const html = '<html><head><title>T</title></head><body><main><p>Intro text.</p><h2>Later</h2><p>More.</p></main></body></html>';
  const page = extractPage(html, 'https://example.com/', { parse: DOMParser });
  assert.equal(page.sections[0].heading, 'T');
  assert.equal(page.sections[0].text, 'Intro text.');
});

test('pages with no body text produce zero sections', () => {
  const html = '<html><head><title>Empty</title></head><body><nav>menu</nav></body></html>';
  const page = extractPage(html, 'https://example.com/', { parse: DOMParser });
  assert.equal(page.sections.length, 0);
});

test('inline elements keep the surrounding paragraph text', () => {
  const html = '<html><head><title>T</title></head><body><main><p>Call <a href="/contact">our team</a> today.</p></main></body></html>';
  const page = extractPage(html, 'https://example.com/', { parse: DOMParser });
  const all = page.sections.map(s => s.text).join(' ');
  assert.ok(all.includes('Call our team today.'));
});

test('loose text nodes under a heading are captured', () => {
  const html = '<html><head><title>T</title></head><body><main><h2>Location</h2>Mon–Fri 9–5</main></body></html>';
  const page = extractPage(html, 'https://example.com/', { parse: DOMParser });
  assert.equal(page.sections.length, 1);
  assert.equal(page.sections[0].heading, 'Location');
  assert.equal(page.sections[0].text, 'Mon–Fri 9–5');
});

test('table rows keep cell values separated', () => {
  const html = '<html><head><title>T</title></head><body><main><table><tr><td>Basic</td><td>$9</td></tr></table></main></body></html>';
  const page = extractPage(html, 'https://example.com/', { parse: DOMParser });
  const all = page.sections.map(s => s.text).join(' ');
  assert.ok(all.includes('Basic'));
  assert.ok(all.includes('$9'));
  assert.ok(!all.includes('Basic$9'));
});

test('adjacent inline spans do not fuse into one word', () => {
  const html = '<html><head><title>T</title></head><body><main>'
    + '<p class="meta"><span>Cybersecurity</span><span>Offensive Security</span>'
    + '<span>1,079 words</span></p></main></body></html>';
  const page = extractPage(html, 'https://example.com/', { parse: DOMParser });
  const all = page.sections.map(s => s.text).join(' ');
  assert.ok(all.includes('Cybersecurity Offensive Security 1,079 words'), all);
  assert.ok(!all.includes('CybersecurityOffensive'));
});
