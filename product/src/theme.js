// The widget borrows the host page's palette instead of forcing its own.
// Everything here is derived from three readings, page background, page text,
// and the page's accent token, so a warm paper site gets a warm paper panel
// and a dark site gets a dark one. The configured accent is only a fallback for
// pages that expose no colour of their own.

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const DARK_INK = { r: 22, g: 24, b: 29, a: 1 };
const WHITE_HEX = '#ffffff';
const DARK_INK_HEX = '#16181d';

export const DEFAULT_ACCENT = '#e8622c';

// Design tokens common enough to trust when a page publishes them. The first
// match wins, so the more specific names come before generic link colours.
const ACCENT_PROPERTIES = [
  '--el-accent', '--accent', '--accent-color', '--color-accent',
  '--brand', '--brand-color', '--primary', '--primary-color',
  '--color-primary', '--theme-accent', '--link-color'
];

// A page that names its panel colour already has the answer; use it verbatim
// rather than inventing a lift off the background.
const SURFACE_PROPERTIES = [
  '--el-panel', '--surface', '--panel', '--panel-bg', '--card-bg',
  '--surface-1', '--color-surface'
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function channel(value) {
  const text = String(value).trim();
  const number = text.endsWith('%') ? parseFloat(text) / 100 * 255 : parseFloat(text);
  return Number.isFinite(number) ? clamp(Math.round(number), 0, 255) : null;
}

/** Accepts '#rgb', '#rrggbb(aa)', 'rgb()/rgba()' in comma or space syntax. */
export function parseColor(value) {
  if (value && typeof value === 'object') {
    const r = channel(value.r); const g = channel(value.g); const b = channel(value.b);
    if (r === null || g === null || b === null) return null;
    const a = Number.isFinite(value.a) ? clamp(value.a, 0, 1) : 1;
    return { r, g, b, a };
  }
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    const expand = (h) => parseInt(h.length === 1 ? h + h : h, 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]), g: expand(digits[1]), b: expand(digits[2]),
        a: digits.length === 4 ? expand(digits[3]) / 255 : 1
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)), g: expand(digits.slice(2, 4)), b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1
      };
    }
    return null;
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!rgb) return null;
  const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map(channel);
  const alpha = parts.length > 3
    ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]))
    : 1;
  if (r === null || g === null || b === null || !Number.isFinite(alpha)) return null;
  return { r, g, b, a: clamp(alpha, 0, 1) };
}

export const toHex = ({ r, g, b }) =>
  `#${[r, g, b].map(n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('')}`;

/** t is the share of b: mix(a, b, 0) is a, mix(a, b, 1) is b. */
export function mix(a, b, t) {
  const w = clamp(t, 0, 1);
  return {
    r: a.r + (b.r - a.r) * w,
    g: a.g + (b.g - a.g) * w,
    b: a.b + (b.b - a.b) * w,
    a: 1
  };
}

function linear(value) {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(color) {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

export function contrast(a, b) {
  const one = luminance(a);
  const two = luminance(b);
  const [lighter, darker] = one >= two ? [one, two] : [two, one];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Black or white, whichever is more legible on `background`. */
export function readableInk(background) {
  return contrast(background, DARK_INK) >= contrast(background, WHITE) ? DARK_INK_HEX : WHITE_HEX;
}

// Push a colour toward the legible ink until it clears the contrast floor.
function withContrast(color, background, minimum) {
  if (contrast(color, background) >= minimum) return color;
  const target = parseColor(readableInk(background));
  let candidate = color;
  for (let step = 1; step <= 10; step++) {
    candidate = mix(color, target, step / 10);
    if (contrast(candidate, background) >= minimum) return candidate;
  }
  return target;
}

// A mid-grey accent cannot carry label text at 4.5:1 in either direction, so
// nudge it toward the end that the label ink comes from.
function fitAccent(accent) {
  const onAccent = readableInk(accent);
  if (contrast(accent, parseColor(onAccent)) >= 4.5) return { accent, onAccent };
  const target = parseColor(onAccent === WHITE_HEX ? DARK_INK_HEX : WHITE_HEX);
  for (let step = 1; step <= 10; step++) {
    const candidate = mix(accent, target, step / 10);
    if (contrast(candidate, parseColor(onAccent)) >= 4.5) return { accent: candidate, onAccent };
  }
  return { accent: target, onAccent };
}

/**
 * Turn three page colours into the widget's palette. `text` and `accent` are
 * optional; when the page does not provide a usable one, readable defaults are
 * chosen against the detected background.
 */
export function deriveTheme({ background, text, accent, surface: pageSurface, fallbackAccent = DEFAULT_ACCENT } = {}) {
  const bg = parseColor(background) || { ...WHITE };
  const declaredSurface = parseColor(pageSurface);
  // The panel sits on the page background; when the page names its own panel
  // colour use that, otherwise lift a little off a dark page so the widget
  // reads as a surface rather than a hole.
  const base = declaredSurface && declaredSurface.a >= 0.5 ? declaredSurface : bg;
  const mode = luminance(base) < 0.35 ? 'dark' : 'light';
  const surface = declaredSurface && declaredSurface.a >= 0.5
    ? declaredSurface
    : (mode === 'dark' ? mix(bg, WHITE, 0.06) : bg);

  const pageText = parseColor(text);
  const ink = pageText && pageText.a > 0.5 && contrast(pageText, surface) >= 4.5
    ? pageText
    : parseColor(readableInk(surface));

  // The transcript behind the answers is a touch recessed from the panel.
  const body = mode === 'dark' ? mix(surface, BLACK, 0.5) : mix(surface, ink, 0.035);
  const bodyText = contrast(ink, body) >= 4.5 ? ink : parseColor(readableInk(body));

  // A page accent only helps if it is visible against the page: a white token
  // on a white page would make the launcher disappear. Fall back to the
  // configured accent, then to plain legibility.
  let chosen = parseColor(accent);
  if (!chosen || contrast(chosen, surface) < 1.3) chosen = parseColor(fallbackAccent);
  if (!chosen || contrast(chosen, surface) < 1.3) chosen = parseColor(readableInk(surface));
  if (!chosen) chosen = parseColor(DEFAULT_ACCENT);
  const fitted = fitAccent(chosen);

  const muted = withContrast(mix(bodyText, body, 0.55), body, 4.5);
  const border = mix(bodyText, surface, 0.86);
  const bubble = mix(bodyText, body, 0.91);

  return {
    mode,
    accent: toHex(fitted.accent),
    onAccent: fitted.onAccent,
    surface: toHex(surface),
    body: toHex(body),
    text: toHex(bodyText),
    muted: toHex(muted),
    border: toHex(border),
    bubble: toHex(bubble)
  };
}

// getComputedStyle usually serialises to rgb(), but a page may also publish a
// named colour or a colour space token. Canvas normalises what we can parse.
function computedColor(value) {
  const parsed = parseColor(value);
  if (parsed) return parsed;
  const text = String(value ?? '').trim();
  if (!text || typeof CSS === 'undefined' || !CSS.supports?.('color', text)) return null;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return null;
  context.fillStyle = '#010203';
  context.fillStyle = text;
  if (context.fillStyle === '#010203' && text.toLowerCase() !== '#010203') return null;
  return parseColor(context.fillStyle);
}

const opaque = (value) => {
  const color = computedColor(value);
  return color && color.a >= 0.5 ? color : null;
};

function declaredAccent(styles) {
  for (const name of ACCENT_PROPERTIES) {
    const color = computedColor(styles.getPropertyValue(name).trim());
    if (color && color.a > 0.4) return color;
  }
  return null;
}

function declaredSurface(styles) {
  for (const name of SURFACE_PROPERTIES) {
    const color = computedColor(styles.getPropertyValue(name).trim());
    if (color && color.a >= 0.5) return color;
  }
  return null;
}

function pageAccent(rootStyles, bodyStyles) {
  const declared = (bodyStyles && declaredAccent(bodyStyles)) || declaredAccent(rootStyles);
  if (declared) return declared;
  const meta = document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
  const color = computedColor(meta);
  return color && color.a > 0.4 ? color : null;
}

/** Read the host page's current colours. Safe to call on every re-render. */
export function readPageTheme({ fallbackAccent = DEFAULT_ACCENT } = {}) {
  if (typeof document === 'undefined' || !document.body) {
    return deriveTheme({ accent: fallbackAccent, fallbackAccent });
  }
  const rootStyles = getComputedStyle(document.documentElement);
  const bodyStyles = getComputedStyle(document.body);
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  const background =
    opaque(bodyStyles.backgroundColor) ||
    opaque(rootStyles.backgroundColor) ||
    computedColor(dark ? '#111318' : '#ffffff');
  const text = bodyStyles.color || rootStyles.color;
  return deriveTheme({
    background,
    text,
    accent: pageAccent(rootStyles, bodyStyles),
    surface: declaredSurface(bodyStyles) || declaredSurface(rootStyles),
    fallbackAccent
  });
}

/** Put the derived palette on the widget root as CSS custom properties. */
export function applyTheme(root, theme) {
  const vars = {
    '--la-accent': theme.accent,
    '--la-on-accent': theme.onAccent,
    '--la-surface': theme.surface,
    '--la-body': theme.body,
    '--la-text': theme.text,
    '--la-muted': theme.muted,
    '--la-border': theme.border,
    '--la-bubble': theme.bubble
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  // Lets form controls and scrollbars match the page rather than the OS.
  root.style.colorScheme = theme.mode;
}

/**
 * Re-read the page when its theme changes: a `data-theme` or class flip on
 * <html>/<body>, a stylesheet swapped in <head>, or the OS scheme changing.
 * Returns a cleanup function.
 */
export function watchTheme(onChange) {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; onChange(); });
  };
  const attributes = ['class', 'style', 'data-theme', 'data-bs-theme', 'data-color-mode'];
  const observer = new MutationObserver(schedule);
  if (document.documentElement) {
    observer.observe(document.documentElement, { attributes: true, attributeFilter: attributes });
  }
  if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: attributes });
  if (document.head) {
    observer.observe(document.head, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'media', 'disabled', 'rel']
    });
  }
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  media?.addEventListener?.('change', schedule);
  // Stylesheets and web fonts can land after mount; one late re-read catches a
  // palette that only exists once they have.
  const late = [600, 2000].map(ms => setTimeout(schedule, ms));
  return () => {
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
    media?.removeEventListener?.('change', schedule);
    late.forEach(clearTimeout);
  };
}
