// PreToolUse hook (Bash): blocks `gh pr merge <n>` unless the PR carries a visible
// `VERDICT: APPROVE` review comment for its current head. The only accepted drift is a
// single merge-of-main commit on top of the reviewed head. Fails closed on lookup errors.
// Dev tooling for the Claude Code harness — not part of the app (not under src/).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MERGE_RE = /\bgh\s+pr\s+merge\b/;
const SHA_RE = /Reviewed head:\s*([0-9a-f]{40})/i;

/**
 * Finds the PR a `gh pr merge` invocation targets.
 * @param {string} command Full shell command line.
 * @returns {number | 'missing' | null} PR number, 'missing' when merging without an explicit
 *   number, or null when the command is not a `gh pr merge` call (e.g. the phrase inside a message).
 */
export function mergeTarget(command) {
  const match = MERGE_RE.exec(command);
  if (!match) return null;
  const rest = command.slice(match.index + match[0].length).trim().split(/\s+/).filter(Boolean);
  for (const raw of rest) {
    const token = raw.replace(/^["']|["';)]+$/g, '');
    if (/^\d+$/.test(token)) return Number(token);
    const url = /\/pull\/(\d+)/.exec(token);
    if (url) return Number(url[1]);
    if (token.startsWith('-')) continue;
    if (/^(&&|\|\||;|\|)$/.test(token)) break;
    return null; // a plain word follows: prose such as "allow gh pr merge for …", not a command
  }
  return 'missing';
}

/**
 * Pure merge-gate decision.
 * @param {{ headRefOid: string, comments: Array<{ body: string }> }} pr PR head and comments.
 * @param {{ parents: string[], message: string } | null} headCommit Head commit details, or null
 *   when not needed/available.
 * @returns {{ allow: boolean, reason: string, needsCommit?: boolean }} Decision.
 */
export function decide(pr, headCommit) {
  const verdicts = pr.comments.filter((c) => c.body.trimStart().startsWith('VERDICT:'));
  const last = verdicts.at(-1);
  if (!last) return { allow: false, reason: 'no VERDICT review comment on the PR' };
  if (!last.body.trimStart().startsWith('VERDICT: APPROVE')) {
    return { allow: false, reason: 'the latest VERDICT review comment is not APPROVE' };
  }
  const reviewed = SHA_RE.exec(last.body)?.[1]?.toLowerCase();
  if (!reviewed) return { allow: false, reason: 'the APPROVE comment names no "Reviewed head"' };
  const head = pr.headRefOid.toLowerCase();
  if (reviewed === head) return { allow: true, reason: 'approved at the current head' };
  if (!headCommit) return { allow: false, reason: 'head differs from the reviewed head', needsCommit: true };
  const isMergeOfMain = headCommit.parents.length === 2
    && headCommit.parents[0].toLowerCase() === reviewed
    && /^Merge /.test(headCommit.message);
  return isMergeOfMain
    ? { allow: true, reason: 'approved head plus one merge-of-main commit' }
    : { allow: false, reason: `head ${head.slice(0, 7)} is not the reviewed head ${reviewed.slice(0, 7)} (or one merge-of-main commit on top)` };
}

/**
 * @param {string[]} args gh arguments.
 * @returns {any} Parsed JSON output.
 */
function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

/**
 * Resolves the gate for one PR via the GitHub CLI.
 * @param {number} n PR number.
 * @returns {{ allow: boolean, reason: string }} Decision.
 */
function checkPr(n) {
  const pr = gh(['pr', 'view', String(n), '--json', 'headRefOid,comments']);
  const first = decide(pr, null);
  if (!first.needsCommit) return first;
  const c = gh(['api', `repos/{owner}/{repo}/commits/${pr.headRefOid}`]);
  return decide(pr, { parents: c.parents.map((/** @type {{sha:string}} */ p) => p.sha), message: c.commit.message });
}

/** @param {string} reason Deny reason shown to the agent. */
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Merge gate: ${reason}. A fresh-context reviewer must post a "VERDICT: APPROVE" comment with "Reviewed head: <sha>" for the current PR head first. Do not work around this gate.`,
    },
  }));
}

/** Hook entry: reads the PreToolUse payload from stdin. */
function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw || '{}');
      if (input.tool_name !== 'Bash') return;
      const target = mergeTarget(String(input.tool_input?.command ?? ''));
      if (target === null) return;
      if (target === 'missing') return deny('`gh pr merge` needs an explicit PR number');
      const result = checkPr(target);
      if (!result.allow) deny(`PR #${target}: ${result.reason}`);
    } catch (err) {
      deny(`could not verify the review (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
