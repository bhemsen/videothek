import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTarget, decide } from '../../.claude/hooks/require-approved-review.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
/** @param {string} sha @returns {{ body: string }} */
const approve = (sha) => ({ body: `VERDICT: APPROVE\nReviewed head: ${sha}\n...` });
/** @param {string} sha @returns {{ body: string }} */
const changes = (sha) => ({ body: `VERDICT: REQUEST_CHANGES\nReviewed head: ${sha}` });

test('mergeTarget finds the PR number in plain and compound commands', () => {
  assert.equal(mergeTarget('gh pr merge 183 --squash --delete-branch'), 183);
  assert.equal(mergeTarget('(cd C:/x && gh pr merge 42 --squash)'), 42);
  assert.equal(mergeTarget('gh pr merge --squash --delete-branch 7'), 7);
  assert.equal(mergeTarget('gh pr merge https://github.com/o/r/pull/99 --squash'), 99);
});

test('mergeTarget ignores prose and other commands', () => {
  assert.equal(mergeTarget('git commit -m "chore(settings): allow gh pr merge for the workflow"'), null);
  assert.equal(mergeTarget('gh pr view 12 --json state'), null);
  assert.equal(mergeTarget('npm run verify'), null);
});

test('mergeTarget flags merges without an explicit number', () => {
  assert.equal(mergeTarget('gh pr merge --squash'), 'missing');
  assert.equal(mergeTarget('gh pr merge && echo done'), 'missing');
});

test('decide denies without any VERDICT comment', () => {
  const d = decide({ headRefOid: A, comments: [{ body: 'lgtm' }] }, null);
  assert.equal(d.allow, false);
});

test('decide denies when the latest verdict is REQUEST_CHANGES', () => {
  const d = decide({ headRefOid: A, comments: [approve(A), changes(A)] }, null);
  assert.equal(d.allow, false);
});

test('decide allows an approval for the current head', () => {
  assert.equal(decide({ headRefOid: A, comments: [changes(B), approve(A)] }, null).allow, true);
});

test('decide denies an approval without a Reviewed head line', () => {
  assert.equal(decide({ headRefOid: A, comments: [{ body: 'VERDICT: APPROVE' }] }, null).allow, false);
});

test('decide asks for commit details when the head moved', () => {
  const d = decide({ headRefOid: M, comments: [approve(A)] }, null);
  assert.equal(d.allow, false);
  assert.equal(d.needsCommit, true);
});

test('decide accepts exactly one merge-of-main commit on the reviewed head', () => {
  const pr = { headRefOid: M, comments: [approve(A)] };
  assert.equal(decide(pr, { parents: [A, B], message: "Merge remote-tracking branch 'origin/main'" }).allow, true);
});

test('decide rejects new work pushed after the approval', () => {
  const pr = { headRefOid: M, comments: [approve(A)] };
  assert.equal(decide(pr, { parents: [A], message: 'fix: more changes' }).allow, false);
  assert.equal(decide(pr, { parents: [B, A], message: 'Merge branch x' }).allow, false);
});
