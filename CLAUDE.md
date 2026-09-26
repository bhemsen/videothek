# Videothek

Dependency-free, self-hosted media streaming for one household (Node.js 24,
vanilla frontend). Media is read directly from `MEDIA_ROOT`.

## Always in context

@docs/vision.md
@docs/constitution.md

## On-demand references (NOT loaded permanently — read when relevant)

- `docs/prior-art.md` — prior art per concern, tagged by roadmap phase
- `docs/architecture.md` — components, boundaries, flows, where new code goes
- `docs/roadmap.md` — sequenced phases, spec + milestone links
- `docs/workflow.md` — loop contract: repo, board IDs, commands, gates, tracks
- `docs/design.md` — design tokens, Google Stitch handoff, component rules
- `docs/release.md` — SemVer release contract for `/loopkit:ship`

## Commands

- Bootstrap: see `docs/workflow.md` (`npm ci` + `.env`)
- Verify (per-iteration gate): `npm run verify`
- Start: `npm start` (reads `.env` via `--env-file-if-exists`)

## Autonomy grant

Within the loopkit skills (`/loopkit:plan`, `/loopkit:implement`,
`/loopkit:design`, `/loopkit:roadmap`, `/loopkit:ship`) the following are
explicitly granted for this project and override stricter global user rules
(including "ask before push/PR"): autonomous commits, pushes, PR creation and
merges, dependency installs via the Bootstrap command, and `.env` edits. Hard
limits are enforced by the deny rules in `.claude/settings.json`. Outside the
loopkit skills the global rules apply unchanged.

# Compact Instructions

Preserve only: the active milestone target (number + title) and the current
unblocked issue frontier (issue numbers), plus any unresolved blocker or
open question awaiting the human. Both milestone and frontier are re-derivable
from GitHub — drop tool output, file dumps and finished-issue detail.
