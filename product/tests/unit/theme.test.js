import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contrast, deriveTheme, luminance, mix, parseColor, readableInk, toHex
} from '../../src/theme.js';

const color = (value) => parseColor(value);
const hex = (theme) => [theme.accent, theme.onAccent, theme.surface, theme.body, theme.text, theme.muted, theme.border, theme.bubble];

test('parseColor reads hex, rgb(), rgba() and transparency', () => {
  assert.deepEqual(parseColor('#c8342a'), { r: 200, g: 52, b: 42, a: 1 });
  assert.deepEqual(parseColor('#FFF'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('rgb(13, 16, 21)'), { r: 13, g: 16, b: 21, a: 1 });
  assert.deepEqual(parseColor('rgba(13 16 21 / 0.4)'), { r: 13, g: 16, b: 21, a: 0.4 });
  assert.deepEqual(parseColor('rgb(50% 0% 0%)'), { r: 128, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('transparent').a, 0);
  assert.equal(parseColor('not a color'), null);
  assert.equal(parseColor(''), null);
});

test('contrast matches the WCAG extremes', () => {
  assert.equal(Math.round(contrast(color('#000'), color('#fff'))), 21);
  assert.equal(Math.round(contrast(color('#777'), color('#777'))), 1);
  assert.equal(readableInk(color('#ffffff')), '#16181d');
  assert.equal(readableInk(color('#0d1015')), '#ffffff');
});

test('mix walks from one colour to the other', () => {
  assert.equal(toHex(mix(color('#000'), color('#fff'), 0)), '#000000');
  assert.equal(toHex(mix(color('#000'), color('#fff'), 1)), '#ffffff');
  assert.equal(toHex(mix(color('#000'), color('#fff'), 0.5)), '#808080');
});

test('a warm paper page keeps its paper background and vermilion accent', () => {
  const theme = deriveTheme({ background: '#f7f2e7', text: '#171310', accent: '#c8342a' });
  assert.equal(theme.mode, 'light');
  assert.equal(theme.surface, '#f7f2e7');
  assert.equal(theme.accent, '#c8342a');
  assert.equal(theme.text, '#171310');
  assert.ok(contrast(color(theme.accent), color(theme.onAccent)) >= 4.5);
  assert.ok(contrast(color(theme.text), color(theme.body)) >= 4.5);
  assert.ok(contrast(color(theme.muted), color(theme.body)) >= 4.5);
});

test('a dark page gets a lifted surface and a recessed transcript', () => {
  const theme = deriveTheme({ background: '#0d1015', text: '#dde6f0', accent: '#ffb000' });
  assert.equal(theme.mode, 'dark');
  assert.ok(luminance(color(theme.surface)) > luminance(color('#0d1015')));
  assert.ok(luminance(color(theme.body)) < luminance(color('#0d1015')));
  assert.equal(theme.accent, '#ffb000');
  assert.equal(theme.onAccent, '#16181d');
  assert.ok(contrast(color(theme.text), color(theme.body)) >= 4.5);
});

test('a panel colour named by the page is used verbatim', () => {
  const theme = deriveTheme({
    background: '#16130f', surface: '#1e1a15', text: '#f2ece0', accent: '#e2632f'
  });
  assert.equal(theme.surface, '#1e1a15');
  assert.equal(theme.mode, 'dark');
  assert.equal(theme.accent, '#e2632f');
});

test('an accent that would vanish into the page falls back to the configured one', () => {
  const theme = deriveTheme({ background: '#ffffff', text: '#111111', accent: '#ffffff', fallbackAccent: '#1f3a5f' });
  assert.equal(theme.accent, '#1f3a5f');
});

test('a mid-grey accent is nudged until its label is legible', () => {
  const theme = deriveTheme({ background: '#ffffff', text: '#111111', accent: '#808080' });
  assert.ok(contrast(color(theme.accent), color(theme.onAccent)) >= 4.5);
});

test('unreadable page text is replaced, everything returned is a hex colour', () => {
  const theme = deriveTheme({ background: '#ffffff', text: '#ffff00', accent: '#123456' });
  assert.ok(contrast(color(theme.text), color(theme.surface)) >= 4.5);
  for (const value of hex(theme)) assert.match(value, /^#[0-9a-f]{6}$/);
});

test('a page with no colours at all still yields the default palette', () => {
  const theme = deriveTheme({});
  assert.equal(theme.mode, 'light');
  assert.equal(theme.accent, '#e8622c');
  assert.match(theme.surface, /^#[0-9a-f]{6}$/);
});
