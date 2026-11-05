import test from 'node:test';
import assert from 'node:assert/strict';
import { followUpChips, groupSources, pageChips, sourceLabel } from '../../src/suggest.js';

test('pageChips asks about the biggest pages, in order', () => {
  const chips = pageChips([
    { title: 'Bonds', url: '/bonds', chunks: 4 },
    { title: 'Evidence', url: '/evidence', chunks: 2 }
  ]);
  assert.deepEqual(chips.map(c => c.question), ['Tell me about Bonds', 'Tell me about Evidence']);
});

test('a title that is already a question stays a question', () => {
  assert.equal(pageChips([{ title: 'How do I file?' }])[0].question, 'How do I file?');
});

test('pageChips skips untitled and duplicate pages', () => {
  const chips = pageChips([
    { title: '  ' },
    { title: 'Bonds' },
    { title: 'bonds' },
    { title: 'Evidence' }
  ]);
  assert.deepEqual(chips.map(c => c.label), ['Bonds', 'Evidence']);
});

test('a long page title is clipped in the chip but not in the question', () => {
  const title = 'A very long page title about appealing a civil judgment in superior court';
  const [chip] = pageChips([{ title }]);
  assert.ok(chip.label.length <= 44);
  assert.ok(chip.label.endsWith('…'));
  assert.equal(chip.question, `Tell me about ${title}`);
});

test('followUpChips uses the sections the answer actually cited', () => {
  const chips = followUpChips([
    { heading: 'Appeal bond', title: 'Bonds' },
    { heading: 'Chain of custody', title: 'Evidence' },
    { heading: 'appeal bond', title: 'Bonds again' }
  ]);
  assert.deepEqual(chips.map(c => c.question), [
    'More about Appeal bond',
    'More about Chain of custody'
  ]);
});

test('a source chip shows the page name, not the whole breadcrumb', () => {
  const title = 'Cybersecurity > DFIR > Disk & Memory Forensics, Research Library';
  assert.equal(sourceLabel(title), 'Disk & Memory Forensics');
});

test('sourceLabel clips a long page name and keeps a plain title intact', () => {
  const long = `Legal > ${'Insurance and Records Law '.repeat(3)}, Site`;
  const clipped = sourceLabel(long);
  assert.ok(clipped.length <= 34);
  assert.ok(clipped.endsWith('…'));
  assert.equal(sourceLabel('Bonds'), 'Bonds');
  assert.equal(sourceLabel(undefined), '');
});

test('citations group to one chip per page and count the passages', () => {
  const groups = groupSources([
    { url: '/a', title: 'Bonds' },
    { url: '/b', title: 'Evidence' },
    { url: '/b', title: 'Evidence' },
    { url: '/b', title: 'Evidence' }
  ]);
  assert.deepEqual(groups.map(g => [g.index, g.url, g.count]), [
    [1, '/a', 1], [2, '/b', 3]
  ]);
  assert.deepEqual(groupSources([]), []);
});

test('chip lists never run empty-handed', () => {
  assert.deepEqual(pageChips([]), []);
  assert.deepEqual(pageChips(undefined), []);
  assert.deepEqual(followUpChips([{ heading: '' }]), []);
});
