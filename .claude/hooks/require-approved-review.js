// PreToolUse hook (Bash|PowerShell): blocks every merge route unless the PR carries a
// visible `VERDICT: APPROVE` review comment for its current head. The only accepted drift is a
// single merge-of-main commit (second parent already in the base branch). Fails closed: any
// merge invocation it cannot parse or verify is denied.
// Dev tooling for the Claude Code harness — not part of the app (not under src/).
import { execFileSync } from 'node:child_process';

const MERGE_RE = /\bgh(?:\.exe)?\s+pr\s+merge\b/g;
const OPS = /&&|\|\||[;|&<>()\n`]/;
const NO_VALUE_FLAGS = new Set(['--squash', '-s', '--merge', '-m', '--rebase', '-r',
  '--delete-branch', '-d', '--auto', '--disable-auto']);
const SHA_RE = /Reviewed head:\s*\**\s*([0-9a-f]{40})\b/i;

/**
 * Normalises a shell command for matching: joins continued lines, drops quotes.
 * @param {string} command Raw command line.
 * @returns {string} Normalised text.
 */
function normalize(command) {
  return command.replace(/\\\r?\n/g, ' ').replace(/["']/g, '');
}

/**
 * Parses the arguments of one `gh pr merge` invocation (fail closed).
 * @param {string[]} tokens Tokens up to the next shell operator.
 * @returns {{ target: number } | { error: string }} PR number or rejection reason.
 */
function parseMergeArgs(tokens) {
  /** @type {number | null} */
  let target = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (NO_VALUE_FLAGS.has(t) || t.startsWith('--match-head-commit=')) continue;
    if (t === '--match-head-commit') { i += 1; continue; }
    if (t.startsWith('-')) return { error: `unsupported flag ${t}` };
    if (target !== null) return { error: 'more than one PR selector' };
    const url = /^https?:\/\/\S+\/pull\/(\d+)\/?$/.exec(t);
    if (/^\d+$/.test(t)) target = Number(t);
    else if (url) target = Number(url[1]);
    else return { error: `PR selector "${t}" is not a literal PR number or /pull/N URL` };
  }
  return target === null ? { error: '`gh pr merge` needs an explicit PR number' } : { target };
}

/**
 * Finds every `gh pr merge` invocation in a command.
 * @param {string} command Full command line.
 * @returns {Array<{ target: number } | { error: string }>} One entry per invocation.
 */
export function mergeTargets(command) {
  const text = normalize(command);
  const found = [];
  for (const m of text.matchAll(MERGE_RE)) {
    const segment = text.slice((m.index ?? 0) + m[0].length).split(OPS)[0];
    const parsed = parseMergeArgs(segment.trim().split(/\s+/).filter(Boolean));
    found.push(/\bGH_(REPO|HOST)=/.test(text) ? { error: 'GH_REPO/GH_HOST overrides are not allowed with a merge' } : parsed);
  }
  return found;
}

/**
 * Detects merge routes other than `gh pr merge`.
 * @param {string} command Full command line.
 * @returns {string | null} Rejection reason or null.
 */
export function otherMergeRoute(command) {
  const t = normalize(command);
  if (/\bgh(?:\.exe)?\s+api\b/.test(t) && /\/pulls\/\d+\/merge\b|mergePullRequest|\/merges\b/.test(t)) {
    return 'merging through `gh api` is not allowed';
  }
  if (/\bgit\s+push\b/.test(t) && /[\s:+](refs\/heads\/)?(main|master)(\s|$)/.test(t)) {
    return 'pushing to the base branch is not allowed';
  }
  return null;
}

/**
 * Reads the verdict of a review comment (tolerates Markdown decoration).
 * @param {string} body Comment body.
 * @returns {'APPROVE' | 'REQUEST_CHANGES' | null} Verdict or null.
 */
export function verdictOf(body) {
  const first = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const m = /^[\W_]*VERDICT:[\s*_]*(APPROVE|REQUEST_CHANGES)\b/i.exec(first);
  return m ? /** @type {'APPROVE' | 'REQUEST_CHANGES'} */ (m[1].toUpperCase()) : null;
}

/**
 * Pure merge-gate decision.
 * @param {{ headRefOid: string, comments: Array<{ body: string }> }} pr PR head and comments.
 * @param {{ parents: string[], message: string, secondParentInBase: boolean } | null} headCommit
 *   Head commit details (null when not yet fetched).
 * @returns {{ allow: boolean, reason: string, needsCommit?: boolean }} Decision.
 */
export function decide(pr, headCommit) {
  const last = pr.comments.filter((c) => verdictOf(c.body)).at(-1);
  if (!last) return { allow: false, reason: 'no VERDICT review comment on the PR' };
  if (verdictOf(last.body) !== 'APPROVE') return { allow: false, reason: 'the latest VERDICT is not APPROVE' };
  const reviewed = SHA_RE.exec(last.body)?.[1]?.toLowerCase();
  if (!reviewed) return { allow: false, reason: 'the APPROVE comment names no full "Reviewed head" sha' };
  const head = pr.headRefOid.toLowerCase();
  if (reviewed === head) return { allow: true, reason: 'approved at the current head' };
  if (!headCommit) return { allow: false, reason: 'head differs from the reviewed head', needsCommit: true };
  const ok = headCommit.parents.length === 2
    && headCommit.parents[0].toLowerCase() === reviewed
    && /^Merge /.test(headCommit.message)
    && headCommit.secondParentInBase;
  return ok
    ? { allow: true, reason: 'approved head plus one merge-of-main commit' }
    : { allow: false, reason: `head ${head.slice(0, 7)} is neither the reviewed head ${reviewed.slice(0, 7)} nor one merge-of-main commit on top of it` };
}

/**
 * @param {string[]} args gh arguments.
 * @returns {any} Parsed JSON output (throws on error or after 20 s).
 */
function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }));
}

/**
 * Resolves the gate for one PR via the GitHub CLI.
 * @param {number} n PR number.
 * @returns {{ allow: boolean, reason: string }} Decision.
 */
function checkPr(n) {
  const pr = gh(['pr', 'view', String(n), '--json', 'headRefOid,baseRefName,comments']);
  const first = decide(pr, null);
  if (!first.needsCommit) return first;
  const c = gh(['api', `repos/{owner}/{repo}/commits/${pr.headRefOid}`]);
  const parents = c.parents.map((/** @type {{ sha: string }} */ p) => p.sha);
  let secondParentInBase = false;
  if (parents.length === 2) {
    const cmp = gh(['api', `repos/{owner}/{repo}/compare/${parents[1]}...${pr.baseRefName}`]);
    secondParentInBase = cmp.status === 'identical' || cmp.status === 'ahead';
  }
  return decide(pr, { parents, message: c.commit.message, secondParentInBase });
}

/**
 * Evaluates one tool payload.
 * @param {any} input PreToolUse payload.
 * @param {(n: number) => { allow: boolean, reason: string }} check PR checker.
 * @returns {string | null} Deny reason or null to let the call proceed.
 */
export function evaluate(input, check) {
  if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') return null;
  const command = String(input.tool_input?.command ?? '');
  const other = otherMergeRoute(command);
  if (other) return other;
  for (const t of mergeTargets(command)) {
    if ('error' in t) return t.error;
    const result = check(t.target);
    if (!result.allow) return `PR #${t.target}: ${result.reason}`;
  }
  return null;
}

/** @param {string} reason Deny reason shown to the agent. */
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Merge gate: ${reason}. Merges need a fresh-context reviewer's "VERDICT: APPROVE" comment with "Reviewed head: <sha>" for the current PR head, and a plain \`gh pr merge <number> --squash --delete-branch\`. Do not work around this gate.`,
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
      const reason = evaluate(JSON.parse(raw || '{}'), checkPr);
      if (reason) deny(reason);
    } catch (err) {
      deny(`could not verify the merge (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    }
  });
}

if (import.meta.main) main();
