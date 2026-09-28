import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mergeTargets, otherMergeRoute, verdictOf, decide, evaluate,
} from '../../.claude/hooks/require-approved-review.js';

const HOOK = fileURLToPath(new URL('../../.claude/hooks/require-approved-review.js', import.meta.url));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const M = 'c'.repeat(40);
/** @param {string} sha @returns {{ body: string }} */
const approve = (sha) => ({ body: `VERDICT: APPROVE\nReviewed head: ${sha}\n...` });
/** @param {string} sha @returns {{ body: string }} */
const changes = (sha) => ({ body: `VERDICT: REQUEST_CHANGES\nReviewed head: ${sha}` });
/** @param {string} command @returns {any} */
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const allowAll = () => ({ allow: true, reason: 'ok' });

test('mergeTargets finds every invocation, also in chains and odd spellings', () => {
  assert.deepEqual(mergeTargets('gh pr merge 183 --squash --delete-branch'), [{ target: 183 }]);
  assert.deepEqual(mergeTargets('(cd C:/x && gh pr merge 42 --squash)'), [{ target: 42 }]);
  assert.deepEqual(mergeTargets('gh pr merge 169 --squash && gh pr merge 167 --squash'), [{ target: 169 }, { target: 167 }]);
  assert.deepEqual(mergeTargets('gh pr merge 167&&echo x'), [{ target: 167 }]);
  assert.deepEqual(mergeTargets('gh "pr" merge 5'), [{ target: 5 }]);
  assert.deepEqual(mergeTargets('"C:/Program Files/GitHub CLI/gh.exe" pr merge 6 -s'), [{ target: 6 }]);
  assert.deepEqual(mergeTargets('gh pr merge \\\n 7 --squash'), [{ target: 7 }]);
  assert.deepEqual(mergeTargets('gh pr merge https://github.com/o/r/pull/99 --squash'), [{ target: 99 }]);
  assert.deepEqual(mergeTargets('gh pr merge 8 --match-head-commit abc --squash'), [{ target: 8 }]);
});

test('mergeTargets rejects selectors it cannot verify', () => {
  for (const cmd of ['gh pr merge feat/x', 'gh pr merge $PR', 'gh pr merge "$PR" --squash',
    'for n in 1 2; do gh pr merge $n; done', 'gh pr merge --squash', 'gh pr merge 5 6']) {
    const [r] = mergeTargets(cmd);
    assert.ok(r && 'error' in r, cmd);
  }
});

test('mergeTargets rejects flags with values and repo overrides', () => {
  for (const cmd of ['gh pr merge -R o/r 5', 'gh pr merge --repo o/r 5', 'gh pr merge 5 --admin',
    'gh pr merge 5 -t subject', 'gh pr merge 5 --body-file x', 'GH_REPO=o/r gh pr merge 5']) {
    const [r] = mergeTargets(cmd);
    assert.ok(r && 'error' in r, cmd);
  }
});

test('mergeTargets ignores unrelated commands', () => {
  assert.deepEqual(mergeTargets('gh pr view 12 --json state'), []);
  assert.deepEqual(mergeTargets('npm run verify'), []);
});

test('otherMergeRoute blocks API merges and pushes to main', () => {
  assert.ok(otherMergeRoute('gh api -X PUT repos/o/r/pulls/5/merge'));
  assert.ok(otherMergeRoute('gh api graphql -f query="mutation { mergePullRequest(...) }"'));
  assert.ok(otherMergeRoute('git push origin HEAD:main'));
  assert.ok(otherMergeRoute('git push origin main'));
  assert.equal(otherMergeRoute('git push -u origin feat/12-main-page'), null);
  assert.equal(otherMergeRoute('gh api repos/o/r/pulls/5'), null);
});

test('verdictOf tolerates Markdown decoration', () => {
  assert.equal(verdictOf('**VERDICT: REQUEST_CHANGES**\nx'), 'REQUEST_CHANGES');
  assert.equal(verdictOf('## VERDICT: APPROVE'), 'APPROVE');
  assert.equal(verdictOf('lgtm'), null);
});

test('decide: latest verdict wins, approval must name the current head', () => {
  assert.equal(decide({ headRefOid: A, comments: [{ body: 'lgtm' }] }, null).allow, false);
  assert.equal(decide({ headRefOid: A, comments: [approve(A), changes(A)] }, null).allow, false);
  assert.equal(decide({ headRefOid: A, comments: [approve(A), { body: '**VERDICT: REQUEST_CHANGES**' }] }, null).allow, false);
  assert.equal(decide({ headRefOid: A, comments: [changes(B), approve(A)] }, null).allow, true);
  assert.equal(decide({ headRefOid: A, comments: [{ body: 'VERDICT: APPROVE' }] }, null).allow, false);
  assert.equal(decide({ headRefOid: M, comments: [approve(A)] }, null).needsCommit, true);
});

test('decide accepts only one merge-of-main commit whose second parent is in the base', () => {
  const pr = { headRefOid: M, comments: [approve(A)] };
  const merge = { parents: [A, B], message: "Merge remote-tracking branch 'origin/main'" };
  assert.equal(decide(pr, { ...merge, secondParentInBase: true }).allow, true);
  assert.equal(decide(pr, { ...merge, secondParentInBase: false }).allow, false);
  assert.equal(decide(pr, { parents: [A], message: 'fix: more', secondParentInBase: false }).allow, false);
  assert.equal(decide(pr, { parents: [B, A], message: 'Merge x', secondParentInBase: true }).allow, false);
});

test('evaluate checks every merge in a chain and covers PowerShell', () => {
  const seen = /** @type {number[]} */ ([]);
  const check = (/** @type {number} */ n) => { seen.push(n); return n === 167 ? { allow: false, reason: 'no' } : allowAll(); };
  assert.match(String(evaluate(bash('gh pr merge 169 --squash && gh pr merge 167 --squash'), check)), /#167/);
  assert.deepEqual(seen, [169, 167]);
  assert.ok(evaluate({ tool_name: 'PowerShell', tool_input: { command: 'gh pr merge feat/x' } }, allowAll));
  assert.equal(evaluate({ tool_name: 'Read', tool_input: {} }, allowAll), null);
  assert.equal(evaluate(bash('gh pr merge 5 --squash'), allowAll), null);
});

/** @param {any} payload @returns {{ status: number | null, stdout: string }} */
function runHook(payload) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout };
}

test('the hook process runs main() and denies unverifiable merges without network', () => {
  const r = runHook(bash('gh pr merge feat/some-branch --squash'));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"permissionDecision":"deny"/);
});

test('the hook process stays silent for ordinary commands', () => {
  const r = runHook(bash('npm run verify'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
