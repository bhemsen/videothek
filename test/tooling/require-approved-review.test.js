import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  mergeTargets, otherMergeRoute, verdictOf, decide, checkMerge, evaluate,
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
/** @param {string} cmd @returns {Array<any>} */
const targets = (cmd) => mergeTargets(cmd).map((t) => ('error' in t ? 'error' : t.target));
const okLookup = () => ({ head: A, decision: { allow: true, reason: 'ok' } });

test('mergeTargets finds every invocation, also in chains and odd spellings', () => {
  assert.deepEqual(targets('gh pr merge 183 --squash --delete-branch'), [183]);
  assert.deepEqual(targets('(cd C:/x && gh pr merge 42 --squash)'), [42]);
  assert.deepEqual(targets('gh pr merge 169 --squash && gh pr merge 167 --squash'), [169, 167]);
  assert.deepEqual(targets('gh pr merge 167&&echo x'), [167]);
  assert.deepEqual(targets('gh "pr" merge 5'), [5]);
  assert.deepEqual(targets('"C:/Program Files/GitHub CLI/gh.exe" pr merge 6 -s'), [6]);
  assert.deepEqual(targets('GH pr merge 9'), [9]);
  assert.deepEqual(targets('gh.EXE pr MERGE 10'), [10]);
  assert.deepEqual(targets('gh pr merge \\\n 7 --squash'), [7]);
  assert.deepEqual(targets('gh pr `\n merge 11'), [11]);
  assert.deepEqual(targets('gh pr merge https://github.com/o/r/pull/99 --squash'), [99]);
});

test('merges written as assignments are recognised', () => {
  assert.deepEqual(targets('$r=gh pr merge 167 --squash'), [167]);
  assert.deepEqual(targets('out=`gh pr merge 167 --squash`'), [167]);
  assert.ok(otherMergeRoute('$r=gh api -X PUT repos/o/r/pulls/5/merge'));
  assert.ok(otherMergeRoute('$r=git push origin main'));
});

test('flags before or between gh, pr and merge deny (gh lets them take values)', () => {
  for (const cmd of ['gh --subject x pr merge 167 --squash', 'gh -t x pr merge 167', 'gh --body-file f pr merge 167',
    'gh pr --subject x merge 167', 'gh pr -b x merge 167', 'gh pr -A e merge 167',
    `gh pr --match-head-commit ${A} merge 167`, 'gh -R o/r pr merge 5']) {
    assert.deepEqual(targets(cmd), ['error'], cmd);
  }
});

test('every gh token in a segment is checked', () => {
  assert.deepEqual(targets('t=gh gh pr merge 167'), [167]);
  assert.deepEqual(targets('GH_CONFIG_DIR=C:/x/gh gh pr merge 167'), [167]);
  assert.ok(otherMergeRoute('gh -X PUT api repos/o/r/pulls/167/merge'));
  assert.ok(otherMergeRoute('gh --method PUT api repos/o/r/pulls/167/merge'));
});

test('other gh pr subcommands that merely mention "merge" are not merges', () => {
  assert.deepEqual(targets('gh pr comment 5 --body "ready to merge"'), []);
  assert.deepEqual(targets('gh pr create --title "fix: merge gate" --body-file x'), []);
  assert.deepEqual(targets('gh pr list --search "merge gate"'), []);
  assert.deepEqual(targets('gh pr view 5 --json mergeable'), []);
});

test('redirections are read like the shell reads them', () => {
  assert.deepEqual(targets('gh pr merge 169>/dev/null 167'), [167]);
  assert.deepEqual(targets('gh pr merge 12 --squash --delete-branch 2>&1'), [12]);
  assert.deepEqual(targets('gh pr merge 13 > out.txt'), [13]);
});

test('mergeTargets rejects selectors and flags it cannot verify', () => {
  for (const cmd of ['gh pr merge feat/x', 'gh pr merge $PR', 'gh pr merge "$PR" --squash',
    'for n in 1 2; do gh pr merge $n; done', 'gh pr merge --squash', 'gh pr merge 5 6',
    'gh pr -R o/r merge 5', 'gh pr merge -R o/r 5', 'gh pr merge --repo o/r 5', 'gh pr merge 5 --admin',
    'gh pr merge 5 -t subject', 'gh pr merge 5 --body-file x', 'GH_REPO=o/r gh pr merge 5',
    'gh pr merge 5 --auto', 'gh -R o/r pr merge 5']) {
    assert.deepEqual(targets(cmd), ['error'], cmd);
  }
});

test('mergeTargets captures the --match-head-commit pin', () => {
  assert.deepEqual(mergeTargets(`gh pr merge 8 --squash --match-head-commit ${A}`), [{ target: 8, pin: A }]);
  assert.deepEqual(mergeTargets(`gh pr merge 8 --match-head-commit=${A}`), [{ target: 8, pin: A }]);
});

test('mergeTargets ignores unrelated commands', () => {
  assert.deepEqual(targets('gh pr view 12 --json state'), []);
  assert.deepEqual(targets('npm run verify'), []);
  assert.deepEqual(targets('git push -u origin feat/x && gh pr create --base main --title t'), []);
});

test('otherMergeRoute blocks API merges and pushes to main', () => {
  assert.ok(otherMergeRoute('gh api -X PUT repos/o/r/pulls/5/merge'));
  assert.ok(otherMergeRoute('GH api -X PUT repos/o/r/pulls/5/merge'));
  assert.ok(otherMergeRoute('gh api graphql -f query="mutation { mergePullRequest(input: {}) { x } }"'));
  assert.ok(otherMergeRoute('git push origin HEAD:main'));
  assert.ok(otherMergeRoute('git -C C:/repo push origin main'));
  assert.ok(otherMergeRoute('(cd x && git push origin main;)'));
  assert.equal(otherMergeRoute('git push -u origin feat/12-main-page'), null);
  assert.equal(otherMergeRoute('git fetch origin main && git merge origin/main && git push'), null);
  assert.equal(otherMergeRoute('git push -u origin feat/x && gh pr create --base main'), null);
  assert.equal(otherMergeRoute('gh api repos/o/r/pulls/5'), null);
});

test('verdictOf treats any VERDICT line as a verdict', () => {
  assert.equal(verdictOf('**VERDICT: REQUEST_CHANGES**\nx'), 'REQUEST_CHANGES');
  assert.equal(verdictOf('## VERDICT: APPROVE'), 'APPROVE');
  assert.equal(verdictOf('VERDICT: REQUEST CHANGES'), 'REQUEST CHANGES');
  assert.equal(verdictOf('VERDICT: REJECT'), 'REJECT');
  assert.equal(verdictOf('Follow-up review\n\nVERDICT: REQUEST_CHANGES\nReviewed head: x'), 'REQUEST_CHANGES');
  assert.equal(verdictOf('lgtm'), null);
});

test('decide: latest verdict wins, only exact APPROVE for the current head passes', () => {
  assert.equal(decide({ headRefOid: A, comments: [{ body: 'lgtm' }] }, null).allow, false);
  assert.equal(decide({ headRefOid: A, comments: [approve(A), changes(A)] }, null).allow, false);
  assert.equal(decide({ headRefOid: A, comments: [approve(A), { body: 'VERDICT: REQUEST CHANGES' }] }, null).allow, false);
  assert.equal(decide({ headRefOid: A, comments: [approve(A), { body: 'VERDICT: REJECT' }] }, null).allow, false);
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

test('checkMerge requires the pin to equal the current head', () => {
  assert.match(String(checkMerge({ target: 5, pin: null }, okLookup)), /--match-head-commit/);
  assert.match(String(checkMerge({ target: 5, pin: B }, okLookup)), /not the current head/);
  assert.equal(checkMerge({ target: 5, pin: A }, okLookup), null);
});

test('evaluate gates every tool with a command string and every merge in a chain', () => {
  const seen = /** @type {number[]} */ ([]);
  const lookup = (/** @type {number} */ n) => { seen.push(n); return { head: A, decision: { allow: n !== 167, reason: 'no' } }; };
  const cmd = `gh pr merge 169 --match-head-commit ${A} && gh pr merge 167 --match-head-commit ${A}`;
  assert.match(String(evaluate(bash(cmd), lookup)), /#167/);
  assert.deepEqual(seen, [169, 167]);
  assert.ok(evaluate({ tool_name: 'PowerShell', tool_input: { command: 'gh pr merge feat/x' } }, okLookup));
  assert.ok(evaluate({ tool_name: 'Monitor', tool_input: { command: 'gh pr merge feat/x' } }, okLookup));
  assert.equal(evaluate({ tool_name: 'Read', tool_input: { file_path: 'x' } }, okLookup), null);
  assert.equal(evaluate(bash(`gh pr merge 5 --squash --match-head-commit ${A}`), okLookup), null);
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
