/**
 * Turns a crawled HTML page into readable text plus its title and current
 * heading, dropping navigation, scripts, and other page furniture.
 */
const DROP = 'script, style, noscript, nav, header, footer, aside, form, iframe, svg, [aria-hidden="true"]';
const HEADINGS = new Set(['H1', 'H2', 'H3']);

function clean(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Adjacent inline elements carry no whitespace in textContent: a metadata row
// of <span> labels came out as "CybersecurityOffensive Security1,079 words".
// Walk the tree and put a boundary wherever an element starts or ends, then let
// clean() collapse the runs. Words stay words, and a quote can be read aloud.
function textOf(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += child.textContent;
    } else if (child.nodeType === 1) {
      out += ` ${textOf(child)} `;
    }
  }
  return out;
}

function tableText(table) {
  const rows = [];
  for (const row of table.querySelectorAll('tr')) {
    const cells = Array.from(row.querySelectorAll('th, td'))
      .map((cell) => clean(textOf(cell)))
      .filter(Boolean);
    if (cells.length) rows.push(cells.join(' | '));
  }
  const text = rows.join(' ; ');
  return text || clean(table.textContent);
}

export function extractPage(html, url, options = {}) {
  const Parser = options.parse || globalThis.DOMParser;
  if (!Parser) throw new Error('extractPage needs a DOMParser');
  const doc = new Parser().parseFromString(html, 'text/html');

  const title = clean(doc.querySelector('title')?.textContent || '') || url;
  for (const node of doc.querySelectorAll(DROP)) node.remove();

  const root = doc.querySelector('main, article, [role="main"]') || doc.body;
  const sections = [];
  let current = { heading: title, parts: [] };

  const flush = () => {
    const text = clean(current.parts.join(' '));
    if (text) sections.push({ heading: clean(current.heading) || title, text });
  };

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = clean(child.textContent);
        if (text) current.parts.push(text);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (HEADINGS.has(child.tagName)) {
        flush();
        current = { heading: clean(textOf(child)), parts: [] };
      } else if (child.tagName === 'TABLE') {
        current.parts.push(tableText(child));
      } else if (child.querySelector('h1, h2, h3')) {
        walk(child);
      } else {
        current.parts.push(clean(textOf(child)));
      }
    }
  };

  walk(root);
  flush();
  return { url, title, sections };
}
