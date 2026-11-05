/**
 * The chat panel: launcher button, transcript, streaming answer rendering,
 * the answer guards, source links, and per-page theming of the whole panel.
 */
import { validateConfig } from './config.js';
import { buildMessages, cleanAnswer, groundingScore, parseAnswer, stripLabelEcho, trimSentences } from './prompt.js';
import { libraryOverview, sectionOverview } from './overview.js';
import { groupSources, pageChips, sourceLabel } from './suggest.js';
import { applyTheme, readPageTheme, watchTheme } from './theme.js';

// What a CPU engine is given to read: short enough to answer in about a minute.
const CPU_PASSAGE_CHARS = 600;

const SVG_NS = 'http://www.w3.org/2000/svg';
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const COMPOSER_MAX_PX = 120;

// Visible build identifier: rendered in the panel header so a visitor or owner
// can always tell which runtime is answering. Bump on every behavioural change.
export const LA_VERSION = '0.3.14';

// The engine reports its mode as a string on some paths and a mode() accessor on
// the real WebGPU/CPU wrapper; normalise so both are readable.
const chatCpu = (c) => (typeof c?.mode === 'function' ? c.mode() : c?.mode) === 'cpu';

const svg = (path, { stroke = false } = {}) => {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('width', '24');
  el.setAttribute('height', '24');
  el.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  if (stroke) {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2');
    p.setAttribute('stroke-linecap', 'round');
  } else {
    p.setAttribute('fill', 'currentColor');
  }
  el.append(p);
  return el;
};

// Running wolf silhouette used as the assistant's logo, so the widget reads as
// this site's own tool rather than a generic cloud-assistant button.
const WOLF_ICON = 'M22.00 10.25L20.33 9.28L19.37 8.32L19.37 7.18L18.67 7.70L18.40 6.82L17.61 7.53L17.00 8.58L15.95 9.02L15.25 9.02L15.33 9.37L14.19 9.37L14.28 9.63L12.96 9.54L13.14 9.89L9.98 9.81L6.04 10.60L4.37 10.60L3.05 10.16L2.00 9.19L2.09 9.98L2.53 10.95L3.32 11.65L3.05 11.82L4.02 12.09L3.93 12.35L5.42 12.35L7.09 11.74L6.65 12.70L5.68 13.75L7.53 13.14L6.47 14.11L4.28 14.02L3.93 14.19L2.96 15.51L2.09 15.86L2.00 16.21L3.14 16.30L4.54 14.98L4.81 15.25L4.19 16.12L3.32 16.65L3.32 17.00L4.54 17.00L5.68 15.60L7.00 15.60L8.40 14.89L9.89 13.23L9.54 12.88L9.81 12.79L12.00 13.23L12.18 13.40L11.91 13.58L12.96 13.58L12.79 13.84L14.81 13.84L15.68 13.40L16.91 14.98L17.96 15.51L20.33 17.18L21.56 17.18L21.30 16.65L20.33 16.39L18.14 14.19L16.82 13.67L17.00 13.49L18.93 13.32L19.46 13.75L19.46 14.37L19.72 14.81L19.89 14.54L20.16 14.98L20.33 14.89L20.42 14.02L19.63 12.53L19.37 12.35L17.96 12.53L17.88 12.35L19.54 10.68L20.16 10.60L20.86 11.04L21.56 11.04L21.74 10.77L21.21 10.60L21.12 10.33L21.82 10.51ZM20.60 10.86L20.86 10.77L20.42 10.51L20.16 10.60ZM17.79 9.28L17.88 9.46L18.32 9.19L18.23 9.02Z';
const CLOSE_ICON = 'M6 6l12 12M18 6L6 18';
const SEND_ICON = 'M3 20l18-8L3 4l4 8-4 8z';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const clock = () => {
  try {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

// Page URLs come from ingested page markup, so only same-origin relative paths
// and http(s) URLs may ever become a clickable href.
/** Words a quoted passage needs before it may stand in for an answer. */
export const QUOTE_MIN_WORDS = 8;

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text of a passage with the page's own title/heading echo removed from
 * the front. Extraction prepends the label to the body, so quoting the first
 * words quoted the label: after a failed answer a visitor saw
 * the page title itself quoted back instead of a passage.
 */
export function passageBody(passage) {
  let body = String(passage?.text || '').trim();
  // Only the title is stripped. The heading is often a word the sentence
  // itself starts with ("Writing essays on…"), and cutting it turned real
  // prose into a fragment.
  const labels = [passage?.title]
    .map((label) => String(label || '').trim())
    .filter((label) => label.length >= 3);
  for (const label of labels) {
    const re = new RegExp(`^\\s*${escapeRe(label)}[\\s:\u2014\u2013.·|,-]*`, 'i');
    body = body.replace(re, '').trim();
  }
  return body;
}

const quoteWeight = (passage) => passageBody(passage).split(/\s+/).filter(Boolean).length;

/**
 * The passage worth quoting when no answer can be shown. Relevance decides
 * among real text; a passage that is only a label is never quoted, and when
 * every candidate is a label the caller refuses instead of printing noise.
 */
export function pickQuotable(near = [], fallback = []) {
  const usable = (passage) => quoteWeight(passage) >= QUOTE_MIN_WORDS;
  const byLength = (a, b) => passageBody(b).length - passageBody(a).length;
  return [...near].filter(usable).sort(byLength)[0]
    || [...fallback].filter(usable).sort(byLength)[0]
    || null;
}

/**
 * Why the turn ends the way it does. Deterministic rejections
 * ('not-covered', 'empty') are facts; heuristic reasons ('invented',
 * 'ungrounded', 'repetition', 'fence') only ever lead to a labelled excerpt or
 * an honest generation-failure notice, never to "the library does not contain
 * an answer", so a valid paraphrase that scored badly still cannot erase the
 * answer a visitor was promised.
 */
export const HEURISTIC_REASONS = ['invented', 'ungrounded', 'repetition', 'fence'];

export function finalBranch(selected, { retrievalRefused = false, quotable = true } = {}) {
  if (retrievalRefused) return { kind: 'refusal', why: 'retrieval-refused' };
  if (!selected?.parsed?.refused || selected.rescued) {
    return { kind: 'answer', why: selected.rescued ? 'rescued' : 'grounded' };
  }
  const reason = selected.parsed.reason;
  if (reason === 'not-covered') return { kind: 'refusal', why: 'not-covered' };
  if (reason === 'empty') return { kind: 'failure', why: 'generation-empty' };
  if (HEURISTIC_REASONS.includes(reason)) {
    return quotable
      ? { kind: 'excerpt', why: `heuristic:${reason}` }
      : { kind: 'failure', why: `heuristic:${reason}` };
  }
  return { kind: 'failure', why: `unclassified:${reason}` };
}

export function safeHref(url) {
  // Control characters can be used to disguise a scheme (java\u0000script:).
  const value = String(url ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!value) return null;
  if (/^https?:/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null; // javascript:, data:, vbscript:, ...
  if (value.startsWith('//')) return value; // protocol-relative -> http(s)
  return value; // "/path", "./path", "path", "#fragment"
}

export function mountWidget({ config: raw, services = {} }) {
  // A host may mount twice by mistake; one widget per document.
  if (document.querySelector('.la-root')) {
    return { destroy() {}, setState() {} };
  }

  const { ok, errors, config } = validateConfig(raw);
  if (!ok) throw new Error(`invalid config: ${errors.join('; ')}`);

  // Page titles carry the site's own suffix ("…, Reference Library"); a
  // citation should read as the page's name, not as browser tab text.
  const emDash = String.fromCharCode(0x2014);
  const stripSite = (value) => {
    const text = String(value ?? '').trim();
    const name = String(config.siteName || '').trim();
    if (!name) return text;
    const suffixes = [` ${emDash} ${name}`, ` – ${name}`, ` | ${name}`, ` - ${name}`, `, ${name}`];
    for (const suffix of suffixes) {
      if (text.endsWith(suffix)) return text.slice(0, -suffix.length).trim();
    }
    return text;
  };

  // The chat engine is created only after the visitor consents: opening the
  // panel must not start a download.
  let chat = null;
  // Search-only mode: no model, but the embedder and index still work on any
  // browser (WASM, no WebGPU). It is the fallback for phones, Firefox on
  // Linux, and desktops where the GPU is blocklisted.
  let searchOnly = false;
  let loading = false;
  let asking = false;

  const launcher = el('button', 'la-launcher');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', `Open ${config.assistantName}`);
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'la-panel');
  // One pill: the sparkle mark and the words are the same control, so the
  // label never reads as text pasted beside a button. The mark is kept
  // because the same sparkle returns in the panel header and message
  // avatars; a text-only circle would leave those with no anchor.
  const icon = el('span', 'la-launcher-icon');
  icon.append(svg(WOLF_ICON));
  const badge = el('span', 'la-badge');
  icon.append(badge);
  launcher.append(icon, el('span', 'la-launcher-label', 'AI chat'));

  const panel = el('section', 'la-panel');
  panel.id = 'la-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', config.assistantName);
  panel.tabIndex = -1;

  const header = el('header', 'la-header');
  const avatar = el('span', 'la-avatar');
  avatar.append(svg(WOLF_ICON));
  const titles = el('div', 'la-titles');
  const title = el('strong', 'la-title', config.assistantName);
  const meta = el('span', 'la-meta');
  const dot = el('span', 'la-dot');
  const status = el('span', 'la-status', 'Not loaded');
  meta.append(dot, status);
  titles.append(title, meta);
  const ver = el('span', 'la-ver', `v${LA_VERSION}`);
  titles.append(ver);
  const close = el('button', 'la-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close assistant');
  close.append(svg(CLOSE_ICON, { stroke: true }));
  header.append(avatar, titles, close);

  // The transcript itself is not a live region: announcing every streamed
  // token is noise. Only finished answers are announced, via this element.
  const body = el('div', 'la-body');
  // role="log" implies aria-live="polite"; streamed tokens would then be read
  // out one by one and the finished answer read again by announce().
  body.setAttribute('role', 'log');
  body.setAttribute('aria-live', 'off');
  body.setAttribute('aria-label', `${config.assistantName} conversation`);
  const live = el('div', 'la-live');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');

  const form = el('form', 'la-form');
  const input = el('textarea', 'la-input');
  input.rows = 1;
  input.placeholder = config.greeting;
  input.setAttribute('aria-label', 'Ask a question about this site');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('enterkeyhint', 'send');
  input.disabled = true;
  const send = el('button', 'la-send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Send question');
  send.setAttribute('disabled', '');
  send.append(svg(SEND_ICON));
  form.append(input, send);

  panel.append(header, body, live, form);
  const root = el('div', 'la-root');
  root.append(launcher);
  document.body.append(root);

  // Borrow the host page's palette, and keep borrowing it: sites that offer a
  // light/dark toggle change colours long after the widget has mounted.
  const refreshTheme = () => {
    try {
      applyTheme(root, readPageTheme({ fallbackAccent: config.accent }));
    } catch { /* a themed widget is nice; an unthemed one still works */ }
  };
  refreshTheme();
  const stopThemeWatch = watchTheme(refreshTheme);

  const setStatus = (text, state = 'idle') => {
    status.textContent = text;
    dot.className = `la-dot la-dot-${state}`;
  };

  // scrollHeight is content plus padding; the border has to be added back or
  // every measurement lands two pixels short and the box creeps upward.
  const resizeInput = () => {
    input.style.height = 'auto';
    const border = input.offsetHeight - input.clientHeight;
    const wanted = input.scrollHeight + border;
    input.style.height = `${Math.min(wanted, COMPOSER_MAX_PX)}px`;
    // No scrollbar for a one-line message: only the capped box scrolls.
    input.style.overflowY = wanted > COMPOSER_MAX_PX ? 'auto' : 'hidden';
  };

  const syncComposer = () => {
    send.disabled = !input.value.trim() || asking || (!chat && !searchOnly);
    resizeInput();
  };

  const bubble = (kind, text) => {
    const wrap = el('div', `la-msg la-${kind}`);
    if (kind === 'assistant') {
      const mark = el('span', 'la-msg-avatar');
      mark.append(svg(WOLF_ICON));
      wrap.append(mark);
    }
    const card = el('div', 'la-bubble', text);
    const stamp = el('time', 'la-time', clock());
    const column = el('div', 'la-col');
    column.append(card, stamp);
    wrap.append(column);
    body.append(wrap);
    body.scrollTop = body.scrollHeight;
    return card;
  };

  // Quick replies: derived from the index, never from the model.
  const showChips = (items) => {
    body.querySelectorAll('.la-chips').forEach(node => node.remove());
    const usable = (items || []).filter(item => item && item.question);
    if (!usable.length) return;
    const row = el('div', 'la-chips');
    for (const item of usable) {
      const chip = el('button', 'la-chip', item.label);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        input.value = item.question;
        syncComposer();
        form.requestSubmit();
      });
      row.append(chip);
    }
    body.append(row);
    body.scrollTop = body.scrollHeight;
  };

  const showTyping = () => {
    const wrap = el('div', 'la-msg la-assistant la-typing-row');
    const mark = el('span', 'la-msg-avatar');
    mark.append(svg(WOLF_ICON));
    const card = el('div', 'la-bubble la-typing');
    card.setAttribute('aria-label', 'Answering');
    for (let i = 0; i < 3; i++) card.append(el('span', 'la-typing-dot'));
    wrap.append(mark, card);
    body.append(wrap);
    body.scrollTop = body.scrollHeight;
    return wrap;
  };

  const announce = (text) => { live.textContent = text; };

  const focusables = () => [...panel.querySelectorAll(FOCUSABLE)]
    .filter(node => node.getClientRects().length > 0);

  const hide = () => {
    panel.remove();
    document.body.classList.remove('la-open');
    document.documentElement.classList.remove('la-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  };

  const open = () => {
    refreshTheme();
    if (!panel.isConnected) root.append(panel);
    document.body.classList.add('la-open');
    document.documentElement.classList.add('la-open');
    launcher.setAttribute('aria-expanded', 'true');
    const readyMode = services.cacheState?.readyMode || '';
    // A stored mode only means the weights are probably cached; if the last
    // attempt failed its card is still on screen and nothing is loading.
    const failed = Boolean(body.querySelector('.la-error, .la-gpu'));
    const starting = loading || (readyMode && !failed);
    setStatus(chat || searchOnly ? (chatCpu(chat) ? 'CPU mode' : 'Online') : (starting ? 'Loading…' : 'Not loaded'),
      chat || searchOnly ? 'ready' : (starting ? 'loading' : 'idle'));
    if (services.error) {
      if (!body.childElementCount) bubble('assistant', services.error);
    } else if (!chat && !searchOnly && !loading && !body.querySelector('.la-progress, .la-error, .la-gpu')) {
      // The assistant installs itself: opening the panel starts the download,
      // with no second click to agree to. A mode in storage means the weights
      // are already here, so that load runs quietly instead of showing a
      // download card for something on disk.
      beginLoad({ quiet: Boolean(readyMode) });
    }
    // Close is the first focusable element in DOM order; focusing it makes
    // Enter close the panel a keyboard user just opened.
    const items = focusables();
    (input.disabled ? panel : input).focus();
  };

  const startSearchOnly = () => {
    searchOnly = true;
    setStatus('Online', 'ready');
    launcher.dataset.ready = 'true';
    body.replaceChildren();
    input.disabled = false;
    syncComposer();
    input.focus();
  };

  // How long a cached load may take before it earns a progress card. Reading
  // the model back out of browser storage takes a second or two; a real
  // download takes much longer than this.
  const QUIET_LOAD_MS = 2500;

  const beginLoad = async ({ quiet = false } = {}) => {
    if (loading || chat) return;
    loading = true;
    body.replaceChildren();
    setStatus('Loading…', 'loading');

    let row = null;
    let fill = null;
    let label = null;
    // The latest progress, painted whenever the card appears. A quiet load
    // receives progress events from the first cached read and must not turn
    // them into a download card.
    const last = { pct: 0, text: 'Preparing download…' };
    const showProgress = () => {
      if (!loading || row) return;
      row = el('div', 'la-msg la-assistant la-progress-row');
      const mark = el('span', 'la-msg-avatar');
      mark.append(svg(WOLF_ICON));
      const card = el('div', 'la-bubble la-progress');
      label = el('span', 'la-progress-text', `${last.text} ${last.pct}%`);
      const track = el('div', 'la-bar');
      fill = el('span');
      fill.style.width = `${last.pct}%`;
      track.append(fill);
      card.append(label, track);
      row.append(mark, card);
      body.append(row);
    };
    // A returning visitor sees the greeting at once; the bar only appears if
    // the engine is genuinely slow, so a cached model never looks like a
    // download.
    const timer = quiet ? setTimeout(showProgress, QUIET_LOAD_MS) : (showProgress(), null);

    try {
      chat = await services.loadChat({
        onProgress: ({ progress, text } = {}) => {
          last.pct = Math.max(0, Math.min(100, Math.round((Number(progress) || 0) * 100)));
          last.text = text || 'Downloading';
          if (!row && !quiet) showProgress();
          if (fill) fill.style.width = `${last.pct}%`;
          if (label) label.textContent = `${last.text} ${last.pct}%`;
        }
      });
      if (fill) fill.style.width = '100%';
      if (label) label.textContent = 'Ready offline';
      // The download card has done its job; the header now says Online, so a
      // finished progress bar would just sit in the transcript forever.
      row?.remove();
      const cpu = chatCpu(chat);
      // Remember how it loaded: the next page can start quietly instead of
      // showing a download card for weights the browser already has.
      services.cacheState?.markReady?.(cpu ? 'cpu' : 'gpu');
      // Say which engine actually loaded; a CPU fallback is a real, slower
      // engine and the header should not pretend otherwise.
      setStatus(cpu ? 'CPU mode' : 'Online', 'ready');
      launcher.dataset.ready = 'true';
      input.disabled = false;
      bubble('assistant', config.greeting);
      showChips(pageChips(services.retriever?.pages));
      syncComposer();
      input.focus();
    } catch (error) {
      clearTimeout(timer);
      chat = null;
      // The download card described work that is no longer happening; leaving
      // it above the error reads as "still downloading" forever.
      row?.remove();
      // The page index needs no model at all, so a failed download never
      // leaves the visitor with a dead panel: answer from the pages instead.
      if (services.retriever && services.embedder) {
        startSearchOnly();
        return;
      }
      setStatus('Could not load', 'error');
      const card = bubble('assistant', `The assistant could not load: ${error.message}`);
      card.classList.add('la-error');
      announce(card.textContent);
      const retry = el('button', 'la-retry', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => beginLoad());
      card.append(retry);
      syncComposer();
    } finally {
      clearTimeout(timer);
      loading = false;
    }
  };

  // Refusals list the closest titles as real links, never one run-on string.
  // The same list runs after a failed retry, so a dead-end turn still hands
  // the visitor somewhere useful instead of only saying no.
  const appendClosest = (card, passages) => {
    // Several passages often come from one page; naming that page once reads
    // better than listing it two or three times.
    const closest = groupSources(passages || []).slice(0, 3);
    if (!closest.length) return;
    card.classList.add('la-closest');
    card.append(document.createTextNode(' Closest topics: '));
    closest.forEach((p, i) => {
      if (i) card.append(document.createTextNode(', '));
      const href = safeHref(p.url);
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.textContent = sourceLabel(p.title);
        a.title = p.title;
        card.append(a);
      } else {
        card.append(document.createTextNode(sourceLabel(p.title)));
      }
    });
    card.append(document.createTextNode('.'));
  };

  const showRefusal = (passages) => {
    const message = "That isn't covered in the pages I've read.";
    const card = bubble('assistant', message);
    appendClosest(card, passages);
    announce(card.textContent);
  };

  // Two attempts, one answer. A clean retry wins; otherwise the better-grounded
  // readable attempt is shown if it clears a floor well above the invented
  // answer measured at 0.22. Loops and fence echoes are never shown.
  const RESCUE_MIN = 0.35;
  const pickAttempt = (first, second) => {
    if (!second.parsed.refused) return second;
    if (!first.parsed.refused) return first;
    const usable = [first, second].filter(a =>
      !['not-covered', 'empty', 'repetition', 'fence', 'invented'].includes(a.parsed.reason));
    usable.sort((a, b) => b.score - a.score);
    if (usable.length && usable[0].score >= RESCUE_MIN) return { ...usable[0], rescued: true };
    return second;
  };

  const submit = async (event) => {
    event?.preventDefault?.();
    const question = input.value.trim();
    if (!question || asking) return;
    if ((!chat && !searchOnly) || !services.retriever || !services.embedder) {
      if (services.error) bubble('assistant', services.error);
      return;
    }
    asking = true;
    input.value = '';
    syncComposer();
    body.querySelectorAll('.la-chips').forEach(node => node.remove());
    bubble('user', question);
    const typing = showTyping();
    setStatus('Thinking…', 'loading');

    try {
      // The index can answer "what is in this library" exactly; retrieved
      // index pages only made the model loop, so skip retrieval for it.
      // A named section ("tell me about emerging tech") is answered from the
      // index; a whole-library question falls back to the library overview.
      const overview = sectionOverview(question, services.retriever.pages, config.siteName)
        || libraryOverview(question, services.retriever.pages);
      if (overview) {
        typing.remove();
        const card = bubble('assistant', overview);
        announce(card.textContent);
        return;
      }
      let passages;
      try {
        const [vector] = await services.embedder.embed([question]);
        const result = services.retriever.search(vector, question);
        typing.remove();
        if (result.refused) {
          showRefusal(result.passages);
          return;
        }
        passages = result.passages;
      } catch (error) {
        typing.remove();
        const card = bubble('assistant', `Search failed: ${error.message}`);
        announce(card.textContent);
        return;
      }

      // One link, not a numbered row. Three pills reading "[2] Uncategorized"
      // and "[3] ..." plus a "+2 more" button were noise under every answer, and
      // the numbers matched nothing the reader saw. The
      // highest-ranked page the answer came from is the one worth a link; the
      // remaining pages ride along as "Related pages" below, whether or not the
      // answer passes validation.
      const buildLinks = () => {
        const sources = el('div', 'la-sources');
        sources.setAttribute('aria-label', 'Page used');
        const related = el('div', 'la-related');
        related.setAttribute('aria-label', 'Related pages');
        const primary = groupSources(passages)[0];
        if (primary) {
          const href = safeHref(primary.url);
          const node = href ? document.createElement('a') : document.createElement('span');
          if (href) {
            node.href = href;
            if (/^https?:/i.test(href)) {
              node.target = '_blank';
              node.rel = 'noopener';
            }
          }
          const title = stripSite(primary.title);
          node.textContent = sourceLabel(title);
          node.title = title;
          sources.append(node);
        }
        if (groupSources(passages).length > 1) {
          related.append(el('span', 'la-related-label', 'Related pages:'));
          const seen = new Set(primary ? [primary.url] : []);
          for (const p of groupSources(passages)) {
            if (seen.has(p.url)) continue;
            seen.add(p.url);
            const href = safeHref(p.url);
            const node = href ? document.createElement('a') : document.createElement('span');
            if (href) {
              node.href = href;
              if (/^https?:/i.test(href)) {
                node.target = '_blank';
                node.rel = 'noopener';
              }
            }
            const title = stripSite(p.title);
            node.textContent = sourceLabel(title);
            node.title = title;
            related.append(node);
            if (related.childElementCount >= 4) break;
          }
        }
        return { sources, related };
      };
      const { sources, related } = buildLinks();

      // Search-only mode quotes the best passage verbatim: no generation, so
      // nothing can be invented, and it works on any browser or phone. Among
      // near-equal matches the longest is the one with an explanation in it
      // (a short nav heading ranks highly but says nothing); relevance still
      // wins, so a clearly better page is never skipped for a longer one.
      const top = [...passages].slice(0, 3);
      const bestScore = Number(top[0]?.score) || 0;
      const near = top.filter(p => (Number(p.score) || 0) >= bestScore - 0.05);
      // A quotation has to say something. Extraction prepends the page label to
      // the text, so the "longest" passage was sometimes nothing but the title
      // ("Writing, Randy Barham dot com: Latest"), which read as gibberish
      // after a failed answer. Label echoes are removed
      // and a passage must carry real words before it may be quoted.
      const quotable = pickQuotable(near, passages);
      const quoteOf = (passage) => passageBody(passage)
        .split(/\s+/).slice(0, config.maxAnswerWords).join(' ');
      const sourceOf = (passage) => {
        const title = stripSite(passage?.title);
        const heading = stripSite(passage?.heading);
        return heading && heading !== title ? `${title}, ${heading}` : title;
      };
      if (searchOnly) {
        if (!quotable) {
          showRefusal(passages);
          return;
        }
        const card = bubble('assistant', `From “${sourceOf(quotable)}”: “${quoteOf(quotable)}”`);
        card.classList.add('la-answer');
        body.append(sources);
        if (related.childElementCount) body.append(related);
        announce(card.textContent);
        return;
      }

      // Answer, notice, and links are separate elements published once: a
      // placeholder may stand in the bubble during generation, but a finished
      // answer is never replaced by a different message afterwards.
      const answerRow = el('div', 'la-msg la-assistant');
      const answerMark = el('span', 'la-msg-avatar');
      answerMark.append(svg(WOLF_ICON));
      const card = el('div', 'la-bubble la-answer', '');
      const answer = el('div', 'la-answer-text', 'Writing…');
      const notice = el('div', 'la-answer-notice', '');
      card.append(answer, notice);
      const stamp = el('time', 'la-time', clock());
      const column = el('div', 'la-col');
      column.append(card, stamp);
      answerRow.append(answerMark, column);
      body.append(answerRow);
      body.scrollTop = body.scrollHeight;
      card.classList.add('la-streaming');
      let text = '';
      // The retry runs silently: a second answer streaming in and then being
      // replaced by a refusal reads as the assistant contradicting itself.
      // The compatibility engine gets the copy-the-notes prompt; the GPU model
      // is strong enough to paraphrase and is asked for its own words.
      const extract = chatCpu(chat);
      // A CPU engine reads the whole prompt before it writes a word, and it
      // reads it at a few hundred characters a second. Four short notes hold
      // the answer just as well as six long ones and halve the wait.
      const notes = extract ? passages.slice(0, 4) : passages;
      const ask = (temperature) => chat.ask(
        buildMessages(question, notes, {
          maxAnswerWords: config.maxAnswerWords, extract,
          passageChars: extract ? CPU_PASSAGE_CHARS : undefined
        }),
        {
          temperature,
          // Tokens are collected, never painted. A draft can name the wrong
          // person or ramble before the guard rejects it; showing it and then
          // replacing it puts the mistake in front of the visitor. Only the
          // verified answer reaches the bubble.
          onToken: (delta) => { text += delta; }
        }
      );
      // Titles are labels, not answers, but a small model recites them anyway.
      const titles = extract
        ? notes.flatMap(p => [p.title, String(p.title || '').split(` ${emDash} `)[0], p.heading])
        : [];
      const tidy = (raw) => (extract
        ? trimSentences(stripLabelEcho(cleanAnswer(raw, { question }), { question, titles }))
        : raw);
      const judge = (raw) => {
        const parsed = parseAnswer(tidy(raw), notes, { question });
        const clean = parsed.refused ? cleanAnswer(raw, { question }) : parsed.text;
        return { parsed, text: clean, score: parsed.refused ? groundingScore(clean, notes) : 1 };
      };

      let selected;
      let retries = 0;
      const devLog = (...parts) => {
        // Development only: state to the console, nothing written to storage.
        if (config.devMode === true || new URLSearchParams(location.search).has('la-dev')) {
          console.log('[local-assistant dev]', ...parts);
        }
      };
      devLog('ask', {
        backend: searchOnly ? 'search' : (chatCpu(chat) ? 'cpu' : 'gpu'),
        passages: (passages || []).map(p => p.id ?? p.slug ?? p.url ?? p.title),
        question
      });
      try {
        const returned = await ask(undefined);
        if (typeof returned === 'string' && returned.length > text.length) text = returned;
        const first = judge(text);
        selected = first;
        devLog('attempt 1', { raw: text, reason: first.parsed.reason, score: first.score });
        // Loops, echoed passages, and answers the guard could not verify all
        // benefit from one cold retry; an explicit NOT_COVERED would only repeat.
        if (first.parsed.refused && first.parsed.reason !== 'not-covered' && first.parsed.reason !== 'empty') {
          text = '';
          answer.textContent = 'Checking that against the pages…';
          const retried = await ask(0);
          if (typeof retried === 'string' && retried.length > text.length) text = retried;
          retries = 1;
          selected = pickAttempt(first, judge(text));
          devLog('attempt 2', { raw: text, why: selected.parsed.reason, score: selected.score });
        }
      } catch (error) {
        // Generation itself failed; retrieval was fine, so the honest answer is
        // a labelled excerpt or an admission, never "not covered".
        devLog('generation failed', { error: error.message, retries });
        card.classList.remove('la-streaming');
        if (quotable) {
          answer.textContent =
            `The assistant could not finish an answer, so here is the closest passage from the pages ${emDash} `
            + `${sourceOf(quotable)}: “${quoteOf(quotable)}”`;
        } else {
          answer.textContent = 'The assistant could not finish an answer. Please try asking again.';
        }
        notice.textContent = `Generation failed: ${error.message}`;
        body.append(sources);
        if (related.childElementCount) body.append(related);
        announce(answer.textContent);
        const failRow = card.closest('.la-msg');
        if (failRow) {
          const top = failRow.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
          body.scrollTop = Math.max(0, top - 8);
        }
        return;
      }

      card.classList.remove('la-streaming');
      const branch = finalBranch(selected, { quotable: Boolean(quotable) });
      // "Not in the pages" and "the model failed to answer safely" are
      // different facts; telling the visitor the wrong one erodes trust.
      if (branch.kind === 'answer') {
        notice.textContent = branch.why === 'rescued' ? 'Answer shown after an automatic retry.' : '';
        answer.textContent = selected.text;
      } else if (branch.kind === 'excerpt') {
        // The guard rejected both attempts, but the retrieval was relevant:
        // label the excerpt honestly instead of claiming the library is silent
        // or silently swallowing the turn.
        answer.textContent =
          `I could not verify an answer, so here is the closest passage from the pages ${emDash} `
          + `${sourceOf(quotable)}: “${quoteOf(quotable)}”`;
        notice.textContent = 'This passage was quoted from the page, not generated.';
      } else if (branch.kind === 'refusal') {
        answer.textContent = 'The pages I read do not contain an answer to that question.';
        // A refusal that names the closest pages is a way forward, not a wall.
        appendClosest(card, passages);
        body.append(related);
      } else {
        answer.textContent = quotable
          ? `The assistant could not finish a verified answer. Closest passage from the pages, ${sourceOf(quotable)}: “${quoteOf(quotable)}”`
          : 'The assistant could not finish a verified answer. Please try asking again.';
        notice.textContent = branch.why === 'generation-empty'
          ? 'Generation produced no text; what you see is a source excerpt, not an answer.'
          : `Generation issue ${emDash} the answer could not be verified.`;
      }
      // Links land after the answer is published, whatever the branch: the
      // reader saw text, so they see exactly which pages stand behind it.
      if (branch.kind === 'answer' || branch.kind === 'excerpt') {
        body.append(sources);
        if (related.childElementCount) body.append(related);
      }
      devLog('published', {
        branch: branch.kind, why: branch.why, retries,
        cleaned: answer.textContent, notice: notice.textContent
      });
      announce(answer.textContent);
      // Citations and follow-ups land below the answer; park the view at the
      // answer's first line instead of at the bottom of the citation list.
      const row = card.closest('.la-msg');
      if (row) {
        const top = row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
        body.scrollTop = Math.max(0, top - 8);
      }
    } finally {
      asking = false;
      typing.remove();
      setStatus(chat || searchOnly ? (chatCpu(chat) ? 'CPU mode' : 'Online') : 'Not loaded',
        chat || searchOnly ? 'ready' : 'idle');
      syncComposer();
    }
  };

  // Escape closes; Tab and Shift+Tab cycle inside the dialog.
  const onKeydown = (e) => {
    if (!panel.isConnected) return;
    if (e.key === 'Escape') {
      hide();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!panel.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Enter sends, Shift+Enter makes a new line; an IME composition must never
  // submit. The composer grows with the text up to three lines.
  const onComposerKeydown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (send.disabled) return;
    e.preventDefault();
    form.requestSubmit();
  };

  launcher.addEventListener('click', () => {
    if (panel.isConnected) hide();
    else open();
  });
  close.addEventListener('click', hide);
  form.addEventListener('submit', submit);
  input.addEventListener('input', syncComposer);
  input.addEventListener('keydown', onComposerKeydown);
  document.addEventListener('keydown', onKeydown);

  return {
    destroy() {
      document.removeEventListener('keydown', onKeydown);
      stopThemeWatch();
      document.body.classList.remove('la-open');
      document.documentElement.classList.remove('la-open');
      root.remove();
    },
    setState(next) { setStatus(next, 'idle'); }
  };
}
