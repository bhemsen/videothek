// PreToolUse hook (any tool with a string `command`, e.g. Bash, PowerShell, Monitor): blocks merges
// unless the PR carries a visible `VERDICT: APPROVE` review comment for its current head and the
// merge pins that head with --match-head-commit. The only accepted drift between review and head is
// one merge-of-main commit whose second parent is already in the base branch. Fails closed: a merge
// invocation it cannot parse or verify is denied.
// Scope: a guard against agents skipping the review step — text scanning cannot stop deliberate
// evasion (aliases, scripts, direct API clients); pair it with branch protection on the base branch.
// Dev tooling for the Claude Code harness — not part of the app (not under src/).
import { execFileSync } from 'node:child_process';

const DEADLINE_MS = 50000;
const SEGMENT_OPS = /&&|\|\||[;|&()\n{}]/;
const NO_VALUE_FLAGS = new Set(['--squash', '-s', '--merge', '-m', '--rebase', '-r',
  '--delete-branch', '-d', '--disable-auto']);
const SHA_RE = /Reviewed head:\s*\**\s*([0-9a-f]{40})\b/i;

/**
 * Normalises a command line the way a shell would read it for our purposes.
 * @param {string} command Raw command line.
 * @returns {string} Text with continuations joined, quotes and redirections removed.
 */
export function normalize(command) {
  return command
    .replace(/\\\r?\n|`\r?\n/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/\d*(>>|>&|<&|>|<)\s*[^\s;&|()]*/g, ' ');
}

/**
 * @param {string} text Normalised command text.
 * @returns {string[][]} Token lists, one per simple command.
 */
function segments(text) {
  return text.split(SEGMENT_OPS).map((s) => s.trim().split(/\s+/).filter(Boolean)).filter((t) => t.length);
}

/** @param {string} token @returns {boolean} Whether the token invokes the GitHub CLI (also `x=gh`). */
const isGh = (token) => /(^|[\\/=])gh(\.exe)?$/i.test(token);
/** @param {string} token @returns {boolean} Whether the token invokes git (also `x=git`). */
const isGit = (token) => /(^|[\\/=])git(\.exe)?$/i.test(token);

/**
 * Classifies a `gh …` invocation. Only the exact `gh pr merge` shape is parsed; any flag before or
 * right after `pr` makes a later `merge` token a denial, because gh lets such flags take values.
 * @param {string[]} rest Lower-cased tokens after `gh`.
 * @returns {'merge' | 'flagged-merge' | 'other'} Classification.
 */
function classifyGh(rest) {
  const mergeAfter = (/** @type {number} */ i) => rest.slice(i).includes('merge');
  if (rest[0] === 'pr') {
    if (rest[1] === 'merge') return 'merge';
    if (rest[1] && !rest[1].startsWith('-')) return 'other';
    return mergeAfter(1) ? 'flagged-merge' : 'other';
  }
  if (rest[0]?.startsWith('-')) {
    const p = rest.indexOf('pr');
    return p >= 0 && mergeAfter(p + 1) ? 'flagged-merge' : 'other';
  }
  return 'other';
}

/**
 * Parses the arguments after `gh pr merge` (fail closed).
 * @param {string[]} args Tokens after `merge`.
 * @returns {{ target: number, pin: string | null } | { error: string }} Selector and pinned head.
 */
function parseMergeArgs(args) {
  /** @type {number | null} */
  let target = null;
  /** @type {string | null} */
  let pin = null;
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (NO_VALUE_FLAGS.has(t)) continue;
    if (t === '--match-head-commit') { pin = args[i + 1] ?? ''; i += 1; continue; }
    if (t.startsWith('--match-head-commit=')) { pin = t.slice(20); continue; }
    if (t.startsWith('-')) return { error: `unsupported flag ${t}` };
    if (target !== null) return { error: 'more than one PR selector' };
    const url = /^https?:\/\/\S+\/pull\/(\d+)\/?$/.exec(t);
    if (/^\d+$/.test(t)) target = Number(t);
    else if (url) target = Number(url[1]);
    else return { error: `PR selector "${t}" is not a literal PR number or /pull/N URL` };
  }
  return target === null ? { error: '`gh pr merge` needs an explicit PR number' } : { target, pin };
}

/**
 * Finds every PR merge invocation in a command.
 * @param {string} command Full command line.
 * @returns {Array<{ target: number, pin: string | null } | { error: string }>} One entry per invocation.
 */
export function mergeTargets(command) {
  const text = normalize(command);
  /** @type {Array<{ target: number, pin: string | null } | { error: string }>} */
  const found = [];
  for (const tokens of segments(text)) {
    tokens.forEach((token, g) => {
      if (!isGh(token)) return;
      const kind = classifyGh(tokens.slice(g + 1).map((t) => t.toLowerCase()));
      if (kind === 'other') return;
      if (kind === 'flagged-merge') { found.push({ error: 'flags before or between gh, pr and merge are not allowed' }); return; }
      if (/\bGH_(REPO|HOST)=/i.test(text)) { found.push({ error: 'GH_REPO/GH_HOST overrides are not allowed with a merge' }); return; }
      found.push(parseMergeArgs(tokens.slice(g + 3)));
    });
  }
  return found;
}

/**
 * Detects merge routes other than `gh pr merge`.
 * @param {string} command Full command line.
 * @returns {string | null} Rejection reason or null.
 */
export function otherMergeRoute(command) {
  const text = normalize(command);
  const mergeApi = /\/pulls\/.*\/merge(?![\w-])|mergepullrequest|mergebranch|\/merges\b/i.test(text);
  for (const tokens of segments(text)) {
    const lower = tokens.map((t) => t.toLowerCase());
    if (mergeApi && tokens.some(isGh) && lower.includes('api')) return 'merging through `gh api` is not allowed';
    const git = lower.findIndex(isGit);
    const push = lower.indexOf('push', git + 1);
    if (git >= 0 && push > git && lower.slice(push + 1).some((t) => /^\+?((head|[^:]+):)?(refs\/heads\/)?(main|master)$/.test(t))) {
      return 'pushing to the base branch is not allowed';
    }
  }
  return null;
}

/**
 * Reads the verdict of a review comment: the first line (anywhere in the body) starting with
 * `VERDICT:` makes the comment a verdict.
 * @param {string} body Comment body.
 * @returns {string | null} Upper-case verdict word(s) or null when the comment is no verdict.
 */
export function verdictOf(body) {
  const line = body.split('\n').map((l) => l.trim()).find((l) => /^[\W_]*VERDICT[\W_]*[:-]/i.test(l));
  const m = line ? /^[\W_]*VERDICT[\W_]*[:-](.*)$/i.exec(line) : null;
  return m ? m[1].replace(/^[\s*_`:-]+|[\s*_`]+$/g, '').toUpperCase() : null;
}

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * @param {{ authorAssociation?: string }} comment PR comment.
 * @returns {boolean} Whether the author may cast a review verdict (public repo: others may not).
 */
const trusted = (comment) => TRUSTED.has(String(comment.authorAssociation ?? '').toUpperCase());

/**
 * Pure merge-gate decision.
 * @param {{ headRefOid: string, comments: Array<{ body: string, authorAssociation?: string }> }} pr
 *   PR head and comments (only verdicts from OWNER/MEMBER/COLLABORATOR count).
 * @param {{ parents: string[], message: string, secondParentInBase: boolean } | null} headCommit
 *   Head commit details (null when not yet fetched).
 * @returns {{ allow: boolean, reason: string, needsCommit?: boolean }} Decision.
 */
export function decide(pr, headCommit) {
  const last = pr.comments.filter((c) => trusted(c) && verdictOf(c.body) !== null).at(-1);
  if (!last) return { allow: false, reason: 'no VERDICT review comment from a repository collaborator on the PR' };
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
 * Checks one parsed merge against the PR state.
 * @param {{ target: number, pin: string | null }} t Parsed merge.
 * @param {(n: number) => { head: string, decision: { allow: boolean, reason: string } }} lookup PR lookup.
 * @returns {string | null} Deny reason or null.
 */
export function checkMerge(t, lookup) {
  const { head, decision } = lookup(t.target);
  if (!decision.allow) return `PR #${t.target}: ${decision.reason}`;
  if (!t.pin) return `PR #${t.target}: pin the reviewed state with --match-head-commit ${head}`;
  if (t.pin.toLowerCase() !== head.toLowerCase()) return `PR #${t.target}: --match-head-commit ${t.pin.slice(0, 7)} is not the current head ${head.slice(0, 7)}`;
  return null;
}

/**
 * Evaluates one tool payload.
 * @param {any} input PreToolUse payload.
 * @param {(n: number) => { head: string, decision: { allow: boolean, reason: string } }} lookup PR lookup.
 * @returns {string | null} Deny reason or null to let the call proceed.
 */
export function evaluate(input, lookup) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return null;
  const other = otherMergeRoute(command);
  if (other) return other;
  for (const t of mergeTargets(command)) {
    if ('error' in t) return t.error;
    const reason = checkMerge(t, lookup);
    if (reason) return reason;
  }
  return null;
}

/**
 * Builds a GitHub lookup that shares one overall deadline across all calls.
 * @param {number} deadline Epoch ms after which lookups fail.
 * @returns {(n: number) => { head: string, decision: { allow: boolean, reason: string } }} Lookup.
 */
function githubLookup(deadline) {
  /** @param {string[]} args @returns {any} */
  const gh = (args) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('verification deadline exceeded');
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }));
  };
  return (n) => {
    const pr = gh(['pr', 'view', String(n), '--json', 'headRefOid,baseRefName,comments']);
    let decision = decide(pr, null);
    if (decision.needsCommit) {
      const c = gh(['api', `repos/{owner}/{repo}/commits/${pr.headRefOid}`]);
      const parents = c.parents.map((/** @type {{ sha: string }} */ p) => p.sha);
      let secondParentInBase = false;
      if (parents.length === 2) {
        const cmp = gh(['api', `repos/{owner}/{repo}/compare/${parents[1]}...${pr.baseRefName}`]);
        secondParentInBase = cmp.status === 'identical' || cmp.status === 'ahead';
      }
      decision = decide(pr, { parents, message: c.commit.message, secondParentInBase });
    }
    return { head: pr.headRefOid, decision };
  };
}

/** @param {string} reason Deny reason shown to the agent. */
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Merge gate: ${reason}. Merges need a fresh-context reviewer's "VERDICT: APPROVE" comment with "Reviewed head: <sha>" for the current PR head and the plain form \`gh pr merge <number> --squash --delete-branch --match-head-commit <head sha>\`. Do not work around this gate.`,
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
      const reason = evaluate(JSON.parse(raw || '{}'), githubLookup(Date.now() + DEADLINE_MS));
      if (reason) deny(reason);
    } catch (err) {
      deny(`could not verify the merge (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    }
  });
}

const entry = (process.argv[1] ?? '').replace(/\\/g, '/').toLowerCase();
if (import.meta.main ?? entry.endsWith('/require-approved-review.js')) main();
