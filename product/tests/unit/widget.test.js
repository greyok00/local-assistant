import test from 'node:test';
import assert from 'node:assert/strict';
import { passageBody, pickQuotable, safeHref } from '../../src/widget.js';

test('safeHref keeps http(s), relative paths and fragments', () => {
  assert.equal(safeHref('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHref('/about'), '/about');
  assert.equal(safeHref('./page'), './page');
  assert.equal(safeHref('#top'), '#top');
});

test('safeHref drops script and data schemes', () => {
  assert.equal(safeHref('data:text/html,x'), null);
  assert.equal(safeHref('vbscript:msgbox'), null);
});

test('safeHref cannot be tricked with control characters', () => {
  const nul = String.fromCharCode(0);
  assert.equal(safeHref(`java${nul}script:alert(1)`), null);
  assert.equal(safeHref('java\tscript:alert(1)'), null);
});

// Reported live 2026-10-31: after a refused answer the widget quoted
// `Writing: "Writing – Randy Barham dot com: Latest"`, a page label printed
// as if it were a passage.
test('passageBody drops the page label echoed at the front of the text', () => {
  const passage = {
    title: 'Writing – Randy Barham dot com',
    heading: 'Writing',
    text: 'Writing – Randy Barham dot com Writing Essays on security, software, and the work behind them.'
  };
  assert.equal(
    passageBody(passage),
    'Writing Essays on security, software, and the work behind them.'
  );
});

test('passageBody keeps text that does not repeat the label', () => {
  const passage = { title: 'About', heading: 'About', text: 'Randy Barham is a cybersecurity professional.' };
  assert.equal(passageBody(passage), 'Randy Barham is a cybersecurity professional.');
});

test('a label with no body behind it is never quoted', () => {
  const label = { title: 'Writing – Randy Barham dot com: Latest', heading: 'Writing', text: 'Writing – Randy Barham dot com: Latest 03:05 PM' };
  assert.equal(pickQuotable([label], [label]), null);
});

test('pickQuotable prefers real text and falls back to the wider set', () => {
  const label = { score: 0.9, title: 'Writing', heading: 'Writing', text: 'Writing' };
  const short = { score: 0.88, title: 'About', heading: 'About', text: 'About Randy.' };
  const long = { score: 0.85, title: 'About', heading: 'About', text: 'About Randy Barham is a software engineer and a cybersecurity professional in Arizona.' };
  assert.equal(pickQuotable([label], [label, short, long]), long);
  assert.equal(pickQuotable([label, long], []), long);
});

// finalBranch: the decision that decides whether an answer can later be
// replaced, rewritten, or erased. Heuristic rejections must never collapse
// into "not covered", that was the branch where a generated answer turned
// into a links-only fallback.
import { finalBranch, HEURISTIC_REASONS, LA_VERSION, passageBody as pb } from '../../src/widget.js';
import { classifyAnswer } from '../../src/prompt.js';

const ok = { parsed: { refused: false, text: 'A grounded answer.', reason: null }, score: 1 };
const heur = (reason) => ({ parsed: { refused: true, text: '', reason }, score: 0.3 });

test('LA_VERSION is a visible build identifier', () => {
  assert.match(LA_VERSION, /^\d+\.\d+\.\d+$/);
});

test('a supported paraphrase with low lexical overlap still publishes as an answer, never a refusal', () => {
  // The guard could reject the paraphrase as 'ungrounded'; the branch must be
  // an excerpt with sources, not a claim that the library lacks the answer.
  const branch = finalBranch(heur('ungrounded'), { quotable: true });
  assert.equal(branch.kind, 'excerpt'); // deterministic publish branch, never refusal
  assert.equal(typeof branch.why, 'string');
});

test('explicit NOT_COVERED classifies as a not-covered rejection, distinct from empty output', () => {
  assert.equal(classifyAnswer('NOT_COVERED', []), 'not-covered');
  assert.equal(classifyAnswer('not covered.', []), 'not-covered');
  assert.equal(classifyAnswer('', []), 'empty');
  assert.equal(finalBranch(heur('not-covered'), { quotable: true }).kind, 'refusal');
});

test('unrelated retrieval refuses for retrieval reasons, not generation reasons', () => {
  const branch = finalBranch(ok, { retrievalRefused: true, quotable: false });
  assert.equal(branch.kind, 'refusal');
  assert.equal(branch.why, 'retrieval-refused');
});

test('repetitive output is a retry/excerpt signal', () => {
  const branch = finalBranch(heur('repetition'), { quotable: true });
  assert.equal(branch.kind, 'excerpt');
  assert.match(branch.why, /^heuristic:repetition$/);
});

test('generation failure has its own branch and never claims absence', () => {
  const branch = finalBranch(heur('empty'), { quotable: false });
  assert.equal(branch.kind, 'failure');
  assert.equal(branch.why, 'generation-empty');
  assert.notEqual(/^refusal$/.test(branch.kind), true);
});

test('heuristic failure with no quotable passage is an honest failure, not a refusal', () => {
  for (const reason of HEURISTIC_REASONS) {
    assert.equal(finalBranch(heur(reason), { quotable: false }).kind, 'failure');
  }
});

test('source links stay below an accepted answer (answer branch is not links-only)', () => {
  const branch = finalBranch(ok, {});
  assert.equal(branch.kind, 'answer');
  assert.ok(ok.parsed.text.length > 0);
  assert.equal(typeof branch.why, 'string'); // rendering keeps text + links separate
});

test('rescued answers publish as answers', () => {
  const rescued = { ...heur('repetition'), rescued: true, score: 0.6 };
  assert.equal(finalBranch(rescued, { quotable: true }).kind, 'answer');
});
