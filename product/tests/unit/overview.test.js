import test from 'node:test';
import assert from 'node:assert/strict';
import { isLibraryQuestion, libraryOverview, sectionOverview } from '../../src/overview.js';

const pages = [
  { url: '/', title: 'Home' },
  { url: '/index.html', title: 'Index' },
  { url: '/cybersecurity/offensive-security/a.html', title: 'A' },
  { url: '/cybersecurity/b.html', title: 'B' },
  { url: '/digital-forensics/windows-security/c.html', title: 'C' },
  { url: '/standards/nist/index.html', title: 'NIST' }
];

test('library meta questions are recognised', () => {
  assert.equal(isLibraryQuestion('what all is in this library'), true);
  assert.equal(isLibraryQuestion("what's this library about?"), true);
  assert.equal(isLibraryQuestion('how many articles are here'), true);
  assert.equal(isLibraryQuestion('What is chain of custody?'), false);
});

test('overview counts articles and sections, skipping index pages', () => {
  const text = libraryOverview('what all is in this library', pages);
  assert.match(text, /3 indexed articles/);
  assert.match(text, /2 sections/);
  assert.match(text, /Cybersecurity \(2\)/);
  assert.match(text, /Digital Forensics \(1\)/);
  assert.doesNotMatch(text, /Index/);
});

test('a non-meta question returns an empty string', () => {
  assert.equal(libraryOverview('How does BitLocker work?', pages), '');
});

test('an empty index returns an empty string rather than a broken count', () => {
  assert.equal(libraryOverview('what all is in this library', []), '');
});

const libraryPages = [
  { url: '/cybersecurity/emerging-tech/quantum.html', title: 'Quantum Computing Risks' },
  { url: '/cybersecurity/emerging-tech/ai-models.html', title: 'AI Model Threats' },
  { url: '/cybersecurity/emerging-tech/iot.html', title: 'IoT Attack Surface' },
  { url: '/cybersecurity/emerging-tech/index.html', title: 'Emerging Tech' },
  { url: '/cybersecurity/threat-analysis/actors.html', title: 'Threat Actors' },
  { url: '/security-operations/network-analysis/ids.html', title: 'IDS Tuning' },
  { url: '/security-operations/network-analysis/pcap.html', title: 'PCAP Analysis' }
];

test('a named section is answered from the index, not six chunks', () => {
  const answer = sectionOverview('tell me about emerging tech', libraryPages);
  assert.match(answer, /^Emerging Tech covers 3 pages in this library:/);
  assert.match(answer, /Quantum Computing Risks/);
  // The section index page names the section; it is not an article in it.
  assert.doesNotMatch(answer, /; Emerging Tech\b/);
});

test('the longest matching section wins over its domain', () => {
  const answer = sectionOverview('tell me about security operations', libraryPages);
  assert.match(answer, /^Security Operations covers 2 pages/);
  assert.match(answer, /IDS Tuning/);
});

test('a specific topic question still goes to retrieval', () => {
  assert.equal(sectionOverview('what is an appeal bond', libraryPages), '');
  assert.equal(sectionOverview('explain chain of custody', libraryPages), '');
});

test('a question naming no section is left to the model', () => {
  assert.equal(sectionOverview('tell me about zero trust', libraryPages), '');
  assert.equal(sectionOverview('tell me about emerging tech', []), '');
});

test('a section with one page is not worth a listing', () => {
  const one = [{ url: '/standards/nist-frameworks/csf.html', title: 'CSF' }];
  assert.equal(sectionOverview('tell me about nist frameworks', one), '');
});

test('the site-name suffix is stripped from listed titles', () => {
  const pages = [
    { url: '/cybersecurity/emerging-tech/a.html', title: 'Article A, Reference Library' },
    { url: '/cybersecurity/emerging-tech/b.html', title: 'Article B, Reference Library' }
  ];
  const answer = sectionOverview('tell me about emerging tech', pages, 'Reference Library');
  assert.match(answer, /Article A; Article B\./);
  assert.doesNotMatch(answer, /Reference Library/);
});

test('a course-code family is listed as a family', () => {
  const courses = [
    { url: '/coursework/ctch605/a.html', title: 'Composing an Applied Project, Reference Library' },
    { url: '/coursework/ctch605/b.html', title: 'Research Methods, Reference Library' },
    { url: '/coursework/ctch625/c.html', title: 'Network Protocols, Reference Library' },
    { url: '/coursework/dfcs605/d.html', title: 'Digital Evidence, Reference Library' }
  ];
  const answer = sectionOverview('tell me about the ctch classes', courses, 'Reference Library');
  assert.match(answer, /^CTCH coursework covers 3 pages/);
  assert.match(answer, /Composing an Applied Project/);
  assert.doesNotMatch(answer, /Digital Evidence/);
});
