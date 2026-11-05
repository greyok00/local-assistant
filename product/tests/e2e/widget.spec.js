import { test, expect } from '@playwright/test';
import { encodeVectors } from '../../src/indexcodec.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/product/tests/e2e/harness.html');
});

// Opening the panel installs the assistant; nothing to click but the launcher.
const consent = async (page) => {
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-input')).toBeEnabled();
};

test('opening the panel installs the assistant with no consent card', async ({ page }) => {
  await expect(page.locator('.la-launcher')).toBeVisible();
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-panel')).toBeVisible();
  await expect(page.locator('.la-consent')).toHaveCount(0);
  await expect(page.locator('.la-input')).toBeEnabled();
});

test('opening the panel shows progress, then clears the card once ready', async ({ page }) => {
  await page.evaluate(() => { window.__loadDelay = 500; });
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-progress')).toBeVisible();
  await expect(page.locator('.la-progress-text')).toContainText('100%');
  await expect(page.locator('.la-input')).toBeEnabled();
  await expect(page.locator('.la-progress')).toHaveCount(0);
});

test('a question renders an answer followed by its source chips', async ({ page }) => {
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-input')).toBeEnabled();
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  await expect(page.locator('.la-sources')).toContainText('Bonds');
  await expect(page.locator('.la-answer')).toContainText('stays enforcement');
  // Citations sit under the answer, not between the question and the answer.
  const order = await page.evaluate(() => {
    const body = document.querySelector('.la-body');
    const answer = body.querySelector('.la-answer').closest('.la-msg');
    const sources = body.querySelector('.la-sources');
    return !!(answer.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
});

test('sources appear only after the answer has finished', async ({ page }) => {
  await page.evaluate(() => { window.__askDelay = 800; });
  await consent(page);
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  await page.waitForSelector('.la-answer.la-streaming');
  await expect(page.locator('.la-sources')).toHaveCount(0);
  await expect(page.locator('.la-answer')).toContainText('stays enforcement');
  await expect(page.locator('.la-answer.la-streaming')).toHaveCount(0);
  await expect(page.locator('.la-sources')).toHaveCount(1);
});

test('the best page is one link and the rest ride along as related pages', async ({ page }) => {
  await page.evaluate(() => {
    const passages = Array.from({ length: 7 }, (_, i) => ({
      url: `/p${i}`, title: `Page ${i}, Site`, heading: 'H', text: 'An appeal bond stays enforcement.'
    }));
    window.__services.retriever = { search: () => ({ refused: false, best: 1, passages }) };
  });
  await consent(page);
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  await expect(page.locator('.la-answer')).toContainText('stays enforcement');
  // One link for the page the answer came from; the runners-up are named but
  // never expandable noise.
  await expect(page.locator('.la-sources a')).toHaveCount(1);
  await expect(page.locator('.la-sources')).toContainText('Page 0');
  await expect(page.locator('.la-related a')).toHaveCount(3);
  await expect(page.locator('.la-sources-more')).toHaveCount(0);
});

test('an answered question does not add follow-up link chips', async ({ page }) => {
  await consent(page);
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  await expect(page.locator('.la-answer')).toContainText('stays enforcement');
  await expect(page.locator('.la-chip')).toHaveCount(0);
});

test('answer text is inserted as text, never as HTML', async ({ page }) => {
  await page.evaluate(() => {
    window.__answerText = '<b>An appeal bond</b> stays enforcement.';
  });
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-input')).toBeEnabled();
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  // Markup in the model's text renders as characters, not as elements.
  await expect(page.locator('.la-answer b')).toHaveCount(0);
  await expect(page.locator('.la-answer')).toContainText('<b>An appeal bond</b>');
});

test('Escape closes the panel and focus returns to the launcher', async ({ page }) => {
  await page.locator('.la-launcher').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.la-panel')).toHaveCount(0);
  await expect(page.locator('.la-launcher')).toBeFocused();
});

test('launcher carries an accessible label and no emoji', async ({ page }) => {
  const launcher = page.locator('.la-launcher');
  await expect(launcher).toHaveAttribute('aria-label', /assistant/i);
  // The pill says what it does; the mark itself is an SVG, not an emoji.
  // innerText reflects the CSS uppercase transform.
  expect((await launcher.innerText()).trim()).toBe('AI CHAT');
  expect(await launcher.locator('img, .la-emoji').count()).toBe(0);
});

// Nothing downloads on a page the visitor never opened the panel on.
test('nothing loads until the panel is opened', async ({ page }) => {
  await expect(page.locator('.la-input')).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.locator('.la-progress')).toHaveCount(0);
  await page.evaluate(() => { window.__loadDelay = 800; });
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-progress')).toBeVisible();
  await expect(page.locator('.la-input')).toBeEnabled();
  await expect(page.locator('.la-progress')).toHaveCount(0);
});

// A broken download must not leave the panel dead or pinned at "Downloading…":
// with the search index and embedder present the turn ends in search-only,
// which still quotes the pages.
test('a failed install clears the download card and search still works', async ({ page }) => {
  await page.evaluate(() => {
    window.__loadDelay = 400; window.__loadFail = true;
    // A passage with real words in it: search-only quotes it verbatim.
    window.__services.retriever = { search: () => ({ refused: false, best: 1, passages: [{
      url: '/a', title: 'Bonds', heading: 'Appeal bond',
      text: 'An appeal bond stays enforcement until the appeal has been decided.'
    }] }) };
  });
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-progress')).toHaveCount(0);
  await expect(page.locator('.la-input')).toBeEnabled();
  await expect(page.locator('.la-status')).toHaveText('Online');
  // The engine never ran, and it must not be remembered as a completed one.
  expect(await page.evaluate(() => window.__askCount || 0)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('local-assistant.mode'))).toBe(null);
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  await expect(page.locator('.la-answer')).toContainText('An appeal bond stays enforcement');
  expect(await page.evaluate(() => window.__askCount || 0)).toBe(0);
});

// Extra: reopening after a successful load must not re-initialise.
test('reopening after load keeps the conversation and never re-shows consent', async ({ page }) => {
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-input')).toBeEnabled();
  await page.locator('.la-input').fill('bond');
  await page.locator('.la-send').click();
  await expect(page.locator('.la-answer')).toContainText('stays enforcement');
  await page.keyboard.press('Escape');
  await expect(page.locator('.la-panel')).toHaveCount(0);
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-panel')).toBeVisible();
  await expect(page.locator('.la-consent')).toHaveCount(0);
  await expect(page.locator('.la-answer')).toContainText('stays enforcement');
  await expect(page.locator('.la-input')).toBeEnabled();
});

// A returning visitor's weights are already in the browser cache; opening the
// panel must not look like a download again, and the mode must be remembered.
test('a returning visitor loads quietly and the mode is remembered', async ({ page }) => {
  await consent(page);
  await expect(page.locator('.la-status')).toHaveText('Online');
  expect(await page.evaluate(() => localStorage.getItem('local-assistant.mode'))).toBe('gpu');

  await page.evaluate(() => localStorage.setItem('local-assistant.mode', 'gpu'));
  await page.reload();
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-consent')).toHaveCount(0);
  // No download card at any point: the load starts on its own and finishes.
  await expect(page.locator('.la-progress')).toHaveCount(0);
  await expect(page.locator('.la-status')).toHaveText('Online', { timeout: 5000 });
  await expect(page.locator('.la-input')).toBeEnabled();
});

// I1: dialog semantics and a focus trap.
test('opening by keyboard moves focus into a modal dialog and Tab never escapes it', async ({ page }) => {
  await expect(page.locator('.la-panel')).toHaveCount(0);
  await page.locator('.la-launcher').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.la-panel')).toBeVisible();
  await expect(page.locator('.la-panel')).toHaveAttribute('aria-modal', 'true');
  expect(await page.evaluate(() => document.activeElement.closest('.la-panel') !== null)).toBe(true);

  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.activeElement.closest('.la-panel') !== null);
    expect(inside, `focus left the panel after ${i + 1} Tabs`).toBe(true);
  }
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    const inside = await page.evaluate(() => document.activeElement.closest('.la-panel') !== null);
    expect(inside, `focus left the panel after ${i + 1} Shift+Tabs`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(page.locator('.la-panel')).toHaveCount(0);
  await expect(page.locator('.la-launcher')).toBeFocused();
});

// I2: refusals list the closest titles as real links.
test('a refused question lists the closest titles as three links', async ({ page }) => {
  await page.evaluate(() => { window.__nextVector = new Float32Array(384); });
  await consent(page);
  await page.locator('.la-input').fill('zzz');
  await page.locator('.la-send').click();

  await expect(page.locator('.la-answer')).toHaveCount(0);
  const links = page.locator('.la-closest a');
  await expect(links).toHaveCount(3);
  expect(await links.evaluateAll(nodes => nodes.map(n => n.getAttribute('href'))))
    .toEqual(['/a', '/b', '/c']);
  await expect(page.locator('.la-closest')).toContainText("isn't covered");
});

// I2: page-supplied URLs are scheme-filtered before becoming hrefs.
test('unsafe URLs never become clickable links', async ({ page }) => {
  await page.evaluate(() => {
    window.__services.retriever = {
      search: () => ({
        refused: true,
        best: 0,
        passages: [
          { score: 0, url: 'javascript:alert(1)', title: 'Script' },
          { score: 0, url: 'JaVaScRiPt:alert(2)', title: 'Mixed case' },
          { score: 0, url: 'data:text/html,<b>x</b>', title: 'Data' }
        ]
      })
    };
  });
  await consent(page);
  await page.locator('.la-input').fill('zzz');
  await page.locator('.la-send').click();

  await expect(page.locator('a[href^="javascript"]')).toHaveCount(0);
  await expect(page.locator('a[href^="data:"]')).toHaveCount(0);
  const first = page.locator('.la-closest').last();
  await expect(first.locator('a')).toHaveCount(0);
  await expect(first).toContainText('Script');
  await expect(first).toContainText('Mixed case');

  // An http(s) URL stays clickable.
  await page.evaluate(() => {
    window.__services.retriever = {
      search: () => ({
        refused: true,
        best: 0,
        passages: [
          { score: 0, url: 'https://example.com/x', title: 'Remote' },
          { score: 0, url: 'javascript:alert(3)', title: 'Evil' }
        ]
      })
    };
  });
  await page.locator('.la-input').fill('zzz');
  await page.locator('.la-send').click();
  const second = page.locator('.la-closest').last();
  await expect(second.locator('a')).toHaveCount(1);
  expect(await second.locator('a').getAttribute('href')).toBe('https://example.com/x');
});

// I2: zero chunks must not print "Closest topics: ." with nothing after it.
test('a refusal with no passages shows the reply alone', async ({ page }) => {
  await page.evaluate(() => {
    window.__services.retriever = { search: () => ({ refused: true, best: 0, passages: [] }) };
  });
  await consent(page);
  await page.locator('.la-input').fill('zzz');
  await page.locator('.la-send').click();

  const card = page.locator('.la-answer, .la-bubble').filter({ hasText: "isn't covered" }).last();
  await expect(card).toContainText("isn't covered in the pages I've read.");
  await expect(page.locator('.la-closest')).toHaveCount(0);
  await expect(card).not.toContainText('Closest topics');
});

// Minor: Enter while an answer streams must not start a second generation.
test('a second submit while an answer is streaming is ignored', async ({ page }) => {
  await page.evaluate(() => { window.__askDelay = 700; });
  await consent(page);
  await page.locator('.la-input').fill('bond');
  await page.locator('.la-send').click();
  await page.locator('.la-input').fill('bond again');
  // The composer disables itself while an answer streams; a programmatic
  // submit must be ignored too, not merely unreachable.
  await expect(page.locator('.la-send')).toBeDisabled();
  await page.locator('.la-form').evaluate(form => form.requestSubmit());
  await expect(page.locator('.la-answer')).toContainText('stays enforcement');
  await page.waitForTimeout(300);
  await expect(page.locator('.la-user')).toHaveCount(1);
  await expect(page.locator('.la-answer')).toHaveCount(1);
});

// Minor: the transcript is not a live region; only finished answers are announced.
test('aria-live sits on a dedicated element, not the transcript', async ({ page }) => {
  await consent(page);
  // role="log" implies a polite live region; the transcript switches it off so
  // streamed tokens are not announced one by one.
  await expect(page.locator('.la-body')).toHaveAttribute('aria-live', 'off');
  const live = page.locator('.la-live');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await page.locator('.la-input').fill('bond');
  await page.locator('.la-send').click();
  await expect(live).toContainText('stays enforcement');
});

// Minor: on mobile the launcher stays bottom-right.
test('the launcher is one pill with the mark and the words', async ({ page }) => {
  const launcher = page.locator('.la-launcher');
  const label = page.locator('.la-launcher-label');
  await expect(label).toHaveText('AI chat');
  const buttonBox = await launcher.boundingBox();
  const labelBox = await label.boundingBox();
  const iconBox = await page.locator('.la-launcher-icon').boundingBox();
  // Both parts live inside the same outlined control.
  expect(iconBox.x).toBeGreaterThanOrEqual(buttonBox.x);
  expect(labelBox.x).toBeGreaterThan(iconBox.x + iconBox.width - 1);
  expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(buttonBox.x + buttonBox.width);
  expect(Math.round(buttonBox.height)).toBe(48);
});

test('the label animates in and settles', async ({ page }) => {
  const spacing = await page.locator('.la-launcher-label').evaluate(n => ({
    animation: getComputedStyle(n).animationName,
    tracking: getComputedStyle(n).letterSpacing
  }));
  expect(spacing.animation).toBe('la-label-reveal');
  expect(parseFloat(spacing.tracking)).toBeGreaterThan(0);
});

test('the pill keeps its words on phones', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.reload();
  await expect(page.locator('.la-launcher-label')).toBeVisible();
});

test('at 400px the launcher sits bottom-right', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.reload();
  const box = await page.locator('.la-launcher').boundingBox();
  expect(box.x + box.width).toBeCloseTo(400 - 16, 0);
  expect(box.y + box.height).toBeCloseTo(800 - 16, 0);
});

// Minor: destroy removes the widget and its accent; a double mount is inert.
test('destroy cleans up and a second mount is ignored', async ({ page }) => {
  expect(await page.evaluate(() => document.querySelector('.la-root').style.getPropertyValue('--la-accent')))
    .toBe('#e8622c');
  // The palette belongs to the widget, not to the host page.
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--la-accent')))
    .toBe('');

  await page.evaluate(() => {
    window.__mountWidget({
      config: { siteName: 'Dup', indexPath: '/test-index' },
      services: window.__services
    });
  });
  await expect(page.locator('.la-root')).toHaveCount(1);

  await page.evaluate(() => window.__widget.destroy());
  await expect(page.locator('.la-root')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--la-accent')))
    .toBe('');
});

// The widget borrows the page palette, including after a live theme flip.
test('the widget takes its colours from the page and follows a theme switch', async ({ page }) => {
  await page.addStyleTag({ content: `
    :root { --accent: #c8342a; }
    body { background: #f7f2e7; color: #171310; }
  ` });
  await page.waitForFunction(() =>
    getComputedStyle(document.querySelector('.la-root')).getPropertyValue('--la-accent').trim() === '#c8342a');

  expect(await page.locator('.la-launcher').evaluate(n => getComputedStyle(n).backgroundColor))
    .toBe('rgb(200, 52, 42)');
  await page.locator('.la-launcher').click();
  expect(await page.locator('.la-panel').evaluate(n => getComputedStyle(n).backgroundColor))
    .toBe('rgb(247, 242, 231)');

  await page.addStyleTag({ content: `
    :root { --accent: #ffb000; }
    body { background: #0d1015; color: #dde6f0; }
  ` });
  await page.waitForFunction(() =>
    getComputedStyle(document.querySelector('.la-root')).getPropertyValue('--la-accent').trim() === '#ffb000');
  const panel = await page.locator('.la-panel').evaluate(n => {
    const [r, g, b] = getComputedStyle(n).backgroundColor.match(/\d+/g).map(Number);
    return { r, g, b, header: getComputedStyle(document.querySelector('.la-header')).color };
  });
  expect((panel.r + panel.g + panel.b) / 3).toBeLessThan(60);
  expect(panel.header).toBe('rgb(22, 24, 29)');
});

// I4 / I5 exercise the real loader against stubbed model libraries.
const VECTOR_BYTES = (() => {
  const vec = (i) => { const v = new Float32Array(384); v[i] = 1; return v; };
  return Buffer.from(encodeVectors([vec(0), vec(1)]));
})();

const CONFIG = {
  siteName: 'Loader Site',
  assistantName: 'Keeper AI',
  greeting: 'Ask away',
  indexPath: '/test-index',
  model: 'stub-model',
  embedder: 'stub-embedder',
  relevanceThreshold: 0.3,
  topK: 2,
  maxAnswerWords: 120,
  maxPages: 500,
  accent: '#e8622c',
  modelBaseUrl: ''
};

async function stubLoader(page, { assistantName = CONFIG.assistantName, indexStatus = 200 } = {}) {
  const config = { ...CONFIG, assistantName };
  // Headless Chromium exposes no WebGPU adapter; the engine's preflight would
  // stop before the stubbed web-llm module ever loads. A hardware-shaped stub
  // (shader-f16 present) lets the loader tests exercise the real path.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', {
      configurable: true,
      value: { requestAdapter: async () => ({ features: { has: () => true } }) }
    });
  });
  await page.route('**/assistant.config.json', route => route.fulfill({ json: config }));
  if (indexStatus !== 200) {
    await page.route('**/test-index.json', route => route.fulfill({ status: indexStatus, body: 'nope' }));
    await page.route('**/test-index.bin', route => route.fulfill({ status: indexStatus, body: 'nope' }));
  } else {
    await page.route('**/test-index.json', route => route.fulfill({
      json: {
        version: 1,
        siteName: 'Loader Site',
        model: 'stub-embedder',
        built: new Date(0).toISOString(),
        chunks: [
          { url: '/a', title: 'Bonds', heading: 'Appeal bond', text: 'An appeal bond stays enforcement.' },
          { url: '/b', title: 'Evidence', heading: 'Chain', text: 'Chain of custody begins at seizure.' }
        ]
      }
    }));
    await page.route('**/test-index.bin', route => route.fulfill({
      contentType: 'application/octet-stream',
      body: VECTOR_BYTES
    }));
  }

  await page.route('**/product/src/vendor/transformers/transformers.min.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      export const env = { backends: { onnx: { wasm: { numThreads: 1 } } } };
      // cpuchat.js imports the streamer; a missing export fails module linking.
      export class TextStreamer { constructor(tokenizer, opts) { this.opts = opts; } }
      export async function pipeline(task, model, options) {
        window.__pipelineOptions = options;
        window.__pipelineCalls = (window.__pipelineCalls || 0) + 1;
        options.progress_callback?.({ status: 'progress', progress: 50, file: 'model.onnx' });
        await new Promise(r => setTimeout(r, 1500));
        return async (texts) => ({
          tolist: () => texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)))
        });
      }
    `
  }));

  await page.route('**/product/src/vendor/web-llm/index.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      // The loader now refuses a model id the real WebLLM build does not know;
      // the stub model is registered here so the GPU path is the one exercised.
      export const prebuiltAppConfig = { model_list: [
        { model_id: 'stub-model', model: 'https://example/model/', model_lib: 'https://example/lib.wasm' }
      ] };
      export async function CreateMLCEngine(model, opts) {
        opts.initProgressCallback?.({ progress: 0.5, text: 'half' });
        return {
          unload() {},
          chat: { completions: { create: async () => (async function* () {
            yield { choices: [{ delta: { content: 'Stub answer. [1]' } }] };
          })() } }
        };
      }
    `
  }));
}

async function mountLoader(page, options) {
  await stubLoader(page, options);
  await page.goto('/product/tests/e2e/');
  await page.setContent('<script type="module" src="/product/src/loader.js" data-assistant></script>');
  await expect(page.locator('.la-launcher')).toBeVisible();
}

test('the one-line install brings its stylesheet exactly once', async ({ page }) => {
  await mountLoader(page);
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel="stylesheet"]')].map(link => link.href));
  expect(hrefs.filter(href => href.endsWith('/widget.css'))).toHaveLength(1);
});

test('loader charges the bar for the embedder before the chat model', async ({ page }) => {
  await mountLoader(page);
  await page.locator('.la-launcher').click();

  // The embedder stub holds for 1.5s, so at 300ms the bar must still be early.
  await page.waitForTimeout(300);
  const early = await page.evaluate(() => {
    const fill = document.querySelector('.la-bar span');
    return {
      width: fill ? parseFloat(fill.style.width || '0') : -1,
      label: document.querySelector('.la-progress-text')?.textContent || ''
    };
  });
  expect(early.width).toBeGreaterThanOrEqual(0);
  expect(early.width).toBeLessThan(100);
  expect(early.label).toMatch(/search model/i);

  await expect(page.locator('.la-input')).toBeEnabled({ timeout: 15000 });
  // Ready means the card is retired; the header's dot carries the state.
  await expect(page.locator('.la-progress')).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.__pipelineOptions?.progress_callback)).toBe('function');
  expect(await page.evaluate(() => window.__pipelineCalls)).toBe(1);
});

test('loader keeps the validated config when the index is missing', async ({ page }) => {
  await mountLoader(page, { indexStatus: 404 });
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-panel strong')).toHaveText('Keeper AI');
  await expect(page.locator('.la-body')).toContainText('temporarily unavailable');
  await expect(page.locator('.la-consent')).toHaveCount(0);
});

test('a relative index path resolves next to the config, not the page', async ({ page }) => {
  await stubLoader(page);
  const requested = [];
  page.on('request', request => requested.push(new URL(request.url()).pathname));
  // Later routes win, so these replace the stubs above for this install.
  await page.route('**/nested/assistant.config.json', route => route.fulfill({
    json: { ...CONFIG, indexPath: './index' }
  }));
  await page.route('**/nested/index.json', route => route.fulfill({
    json: {
      version: 1,
      siteName: 'Loader Site',
      model: 'stub-embedder',
      built: new Date(0).toISOString(),
      chunks: [
        { url: '/a', title: 'Bonds', heading: 'Appeal bond', text: 'An appeal bond stays enforcement.' },
        { url: '/b', title: 'Evidence', heading: 'Chain', text: 'Chain of custody begins at seizure.' }
      ]
    }
  }));
  await page.route('**/nested/index.bin', route => route.fulfill({
    contentType: 'application/octet-stream',
    body: VECTOR_BYTES
  }));

  await page.goto('/product/tests/e2e/');
  await page.setContent('<script type="module" src="/product/src/loader.js" data-assistant data-config="/nested/assistant.config.json"></script>');
  await expect(page.locator('.la-launcher')).toBeVisible();
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-body')).not.toContainText('temporarily unavailable');
  expect(requested).toContain('/nested/index.json');
  expect(requested).toContain('/nested/index.bin');
  // A page-relative read would land here, which is the bug this guards.
  expect(requested).not.toContain('/index.json');
});

// UI pass: starter chips come from the index, not the model.
test('loaded widget offers page chips and sends one when clicked', async ({ page }) => {
  await consent(page);
  const chips = page.locator('.la-chip');
  await expect(chips).toHaveCount(3);
  await expect(chips.first()).toContainText('Bonds');
  await chips.first().click();
  await expect(page.locator('.la-user .la-bubble').last()).toContainText('Tell me about Bonds');
  await expect(page.locator('.la-answer')).toContainText('stays enforcement');
});

// Enter sends; Shift+Enter is a newline and must not send.
test('Enter sends and Shift+Enter keeps typing', async ({ page }) => {
  await consent(page);
  await page.locator('.la-input').fill('bond');
  await page.keyboard.press('Shift+Enter');
  expect(await page.locator('.la-input').inputValue()).toContain('\n');
  await expect(page.locator('.la-user')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('.la-user .la-bubble')).toContainText('bond');
});

test('the header shows a ready status after loading', async ({ page }) => {
  await consent(page);
  await expect(page.locator('.la-dot-ready')).toHaveCount(1);
  await expect(page.locator('.la-status')).toHaveText('Online');
  await expect(page.locator('.la-launcher')).toHaveAttribute('data-ready', 'true');
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the panel becomes a full-screen sheet and locks page scroll', async ({ page }) => {
    await page.locator('.la-launcher').click();
    const box = await page.locator('.la-panel').boundingBox();
    expect(Math.round(box.width)).toBe(390);
    expect(box.height).toBeGreaterThanOrEqual(800);
    // Both the body and the document element are locked: the root element is
    // the real scroll container, so body alone leaves the page sliding.
    expect(await page.evaluate(() => document.body.classList.contains('la-open'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.classList.contains('la-open'))).toBe(true);
    // The sheet covers the launcher, so a tap on the bottom-right cannot
    // open a second panel behind it.
    const launcher = await page.locator('.la-launcher').boundingBox();
    expect(box.y + box.height >= launcher.y + launcher.height).toBe(true);
    await expect(page.locator('.la-send')).toBeVisible();
  });

  test('closing the sheet unlocks the page', async ({ page }) => {
    await page.locator('.la-launcher').click();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.body.classList.contains('la-open'))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.classList.contains('la-open'))).toBe(false);
  });
});

// The preflight card with browser-fix steps was removed: a browser without
// WebGPU now loads nothing, falls straight through to search-only, and the
// turn still ends with the page quoted (tested below). Chat.js owns the real
// WebGPU probe; the widget only sees success or a thrown load error.

test('an answer the guard cannot verify still ends somewhere useful', async ({ page }) => {
  // Ungrounded text fails the guard both times, and the harness passages are
  // too short to quote; the turn must end in an honest failure note that
  // never claims the pages lack the topic.
  await page.evaluate(() => { window.__answerText = 'Zebras migrate across the tundra every year.'; });
  await consent(page);
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  const answer = page.locator('.la-answer-text');
  await expect(answer).toContainText('could not finish a verified answer', { timeout: 10000 });
  await expect(answer).not.toContainText('do not contain an answer');
  // The failure notice says what happened instead of looking like silence.
  await expect(page.locator('.la-answer-notice')).toContainText('Generation');
  expect(await page.evaluate(() => window.__askCount)).toBe(2);
});

test('a CPU compatibility engine answers and the header says so', async ({ page }) => {
  // No WebGPU: the loader hands back a CPU engine instead of failing, so the
  // visitor gets a written answer rather than being pushed to search. The
  // header names the slower engine instead of pretending it is the GPU one.
  await page.evaluate(() => {
    window.__webgpuStatus = { ok: false, reason: 'no-api' };
    window.__loadMode = 'cpu';
  });
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-status')).toHaveText('CPU mode');
  await expect(page.locator('.la-input')).toBeEnabled();
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  // A written answer, not a quoted passage, and no fallback caption.
  await expect(page.locator('.la-answer')).toContainText('An appeal bond stays enforcement');
  expect(await page.evaluate(() => window.__askCount)).toBe(1);
  await expect(page.locator('.la-gpu')).toHaveCount(0);
});

test('a browser without WebGPU still ends usable: search-only quotes the page', async ({ page }) => {
  await page.evaluate(() => {
    window.__loadError = 'no-api';
    // A passage with real words in it: search-only quotes it verbatim.
    window.__services.retriever = { search: () => ({ refused: false, best: 1, passages: [{
      url: '/a', title: 'Bonds', heading: 'Appeal bond',
      text: 'An appeal bond stays enforcement until the appeal has been decided.'
    }] }) };
  });
  // The chat engine cannot start; the widget does not dead-end on an error
  // card, it drops to search-only on its own and quotes what it finds.
  await page.locator('.la-launcher').click();
  await expect(page.locator('.la-gpu')).toHaveCount(0);
  await expect(page.locator('.la-input')).toBeEnabled();
  await expect(page.locator('.la-status')).toHaveText('Online');
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  const answer = page.locator('.la-answer');
  await expect(answer).toContainText('An appeal bond stays enforcement');
  await expect(answer).toContainText('From');
  await expect(page.locator('.la-sources')).toHaveCount(1);
  // Search-only quotes the page; it never calls the chat engine.
  expect(await page.evaluate(() => window.__askCount || 0)).toBe(0);
});

test('two readable attempts are not thrown away for a refusal', async ({ page }) => {
  // Weakly grounded (0.4): rejected by the 0.5 bar, but well above invention.
  await page.evaluate(() => {
    window.__answerText = 'The appeal bond stays enforcement; zebras migrate across tundra valleys during winter storms.';
  });
  await consent(page);
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  const answer = page.locator('.la-answer');
  await expect(answer).toContainText('appeal bond stays enforcement');
  await expect(answer).not.toContainText("couldn't confirm");
  await expect(page.locator('.la-sources')).toHaveCount(1);
});

test('an accepted answer is never replaced after generation completes', async ({ page }) => {
  await consent(page);
  await page.evaluate(() => { window.__answerText = 'An appeal bond stays enforcement while the appeal is pending. [1]'; });
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  const answer = page.locator('.la-answer-text');
  await expect(answer).toContainText('appeal bond stays enforcement', { timeout: 10000 });
  const text = await answer.textContent();
  await page.waitForTimeout(600);
  // The published answer still stands one moment later: no silent swap.
  await expect(answer).toHaveText(text);
  await expect(page.locator('.la-answer-notice')).not.toContainText('Generation');
  // Links under the answer, independent of the text element.
  await expect(page.locator('.la-sources')).toContainText('Bonds');
});

test('an explicit NOT_COVERED is a refusal, with links, not an excerpt', async ({ page }) => {
  await consent(page);
  await page.evaluate(() => { window.__answerText = 'NOT_COVERED'; });
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  const answer = page.locator('.la-answer-text');
  await expect(answer).toContainText('do not contain an answer', { timeout: 10000 });
  const text = await answer.textContent();
  await page.waitForTimeout(400);
  await expect(answer).toHaveText(text);
  await expect(answer).not.toContainText('NOT_COVERED');
});

test('a repetitive answer is replaced by a labelled failure note or excerpt, never an absence claim', async ({ page }) => {
  // The passages are short, so nothing is quotable; the branch must say that
  // generation failed, and must never say the library lacks the question.
  await consent(page);
  await page.evaluate(() => {
    window.__answerText = '1. appeal bond 1. appeal bond 1. appeal bond 1. appeal bond 1. appeal bond 1. appeal bond';
  });
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  const answer = page.locator('.la-answer-text');
  await expect(answer).toContainText('could not finish a verified answer', { timeout: 10000 });
  await expect(answer).not.toContainText('do not contain an answer');
  const text = await answer.textContent();
  await page.waitForTimeout(400);
  await expect(answer).toHaveText(text);
  await expect(page.locator('.la-answer-notice')).toContainText('Generation');
});

test('a CPU-mode engine still answers and shows the build version', async ({ page }) => {
  await page.evaluate(() => { window.__loadMode = 'cpu'; });
  await consent(page);
  await expect(page.locator('.la-ver')).toContainText('0.3.14');
  await page.locator('.la-input').fill('what is an appeal bond');
  await page.locator('.la-send').click();
  await expect(page.locator('.la-answer-text')).toContainText('stays enforcement', { timeout: 10000 });
  await expect(page.locator('.la-sources')).toBeVisible();
});
