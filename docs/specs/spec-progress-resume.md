# Spec: Progress & resume

> Created: 2026-09-26

Per-user playback progress for every time-based item: the player reports its
position, opening an item on any device resumes it automatically, the start page
shows a "Weiterschauen" row and started/finished items are marked in the video
grids. This spec carries no lifecycle state — acceptance is the spec merged on
the default branch with a milestone and issues, and all progress (in progress,
done, blocked) lives in the GitHub issues and milestone. A completed spec is
moved to `docs/specs/archive/`.

## Outcome

- [ ] A video paused or closed on device A at position *p* starts on device B
      (same user, any supported browser) at *p* ± 10 s without any extra click,
      and a toast "Fortgesetzt bei *m:ss*" with a "Von vorn" action is shown.
- [ ] While a video plays, its position is persisted at least every 10 s and
      immediately on pause, end, tab hide and page leave.
- [ ] The start page shows a "Weiterschauen" row of the user's in-progress
      movies and episodes (most recent first, 4 px amber progress bar, remaining
      time); the row is absent when there is nothing to continue.
- [ ] A video watched to ≥ 90 % leaves the row and shows a "Gesehen" badge on its
      movie card / episode row; a started one shows the 4 px bar there.
- [ ] Progress is strictly per user: no API call can read or change another
      user's progress; every progress route answers `401` without a session.
- [ ] Progress survives an item vanishing from `MEDIA_ROOT` and re-attaches when
      the same relative path reappears, even under a new index id.
- [ ] `public/js/lib/progress.js` exposes a media-element-agnostic client
      (`<video>` and `<audio>`) that Phase 5 reuses without modification.
- [ ] `npm run verify` is green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- Migration `003-progress.sql` and the repository `src/db/progress.js`.
- API: `GET/PUT/DELETE /api/progress/:id`, collection `GET /api/progress`
  (continue list and per-category state list) — contract below.
- Pure server rules (validation, finished rule, state derivation, query parsing)
  and the next-episode computation (if OPEN-2 = B).
- Frontend progress client `public/js/lib/progress.js` (API wrappers, playback
  tracker, time formatters) for P3's video player now and P5's audio player later.
- Player integration: auto-resume + resume toast on P3's player page.
- "Weiterschauen" row on the start page (movies + series only).
- Progress bar / "Gesehen" badge on P2's movie cards and episode rows.
- Removing an entry from the "Weiterschauen" row (if OPEN-1 = B).

### Out of scope

- Audio UI (music, audiobooks, a "Weiterhören" row) — Phase 5 reuses this API
  and client; the server rules already cover audio categories.
- Progress on series-level cards in the Serien grid (aggregate "3 of 10
  episodes") — no aggregate model in v1.
- Auto-play of the next episode at the end of playback (P3 player territory).
- Multi-device conflict resolution beyond last-write-wins (prior art: AVOID).
- Carrying progress across renames/moves of a file (identity = relative path).
- Garbage collection of progress rows for items that never reappear (rows are
  ~100 bytes; kept per architecture).
- Offline queueing/retry of failed reports (next tick retries implicitly).
- Any new configuration value — all thresholds are code constants.

## Constraints

- Constitution applies unchanged: zero runtime deps, SQL only in `src/db/` via
  prepared statements, JSON errors `{ "error": "<code>" }`, JSDoc on every
  export, ≤ 60 lines/function, ≤ 300 lines/file, a `test/` suite per new `src/`
  module with failure cases for auth, German UI copy, tokens only via
  `public/css/tokens.css`, no `innerHTML` with unescaped data.
- Builds on P1 (`src/db/index.js` + migration runner, `requireUser`, JSON/error
  helpers, CSRF/mutation guard, `routes.js`), P2 (`library_items`, item JSON
  serializer, category ids, series season/episode fields, movie grid + episode
  list pages) and P3 (player page, `/media/:id`). Where this spec names a P1–P3
  artifact it means that phase's actual implementation; see "Cross-phase
  contract" below for what P4 relies on.
- P6 runs in parallel: P4 owns only the files listed under "File ownership";
  the single shared edit is one registration line in `src/http/routes.js`.

### Data model (migration `003-progress.sql`)

```sql
CREATE TABLE progress (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rel_path         TEXT    NOT NULL,          -- = library_items.rel_path, no FK
  position_seconds REAL    NOT NULL CHECK (position_seconds >= 0),
  duration_seconds REAL    NOT NULL CHECK (duration_seconds > 0),
  finished         INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
  updated_at       INTEGER NOT NULL,          -- Unix epoch milliseconds
  PRIMARY KEY (user_id, rel_path)
) STRICT;
CREATE INDEX progress_user_updated ON progress (user_id, updated_at DESC);
```

### Progress states (derived server-side, one source of truth)

| State | Condition | Effect |
|---|---|---|
| `none` | no row, or `finished = 0` and position < 30 s | start at 0, no toast, no bar, not listed |
| `in_progress` | `finished = 0` and position ≥ 30 s | auto-resume + toast, bar, in "Weiterschauen" |
| `finished` | `finished = 1` | start at 0, no toast, "Gesehen" badge, not listed |
| `next_up` | only as a continue-list entry (OPEN-2 = B) | "Nächste Folge" pill, start at 0 |

Finished rule, applied on every write: categories `movie`, `series` →
position ≥ 90 % of duration; all other resumable categories (`music`,
`audiobook`) → duration − position ≤ 30 s. A write whose position is < 30 s
never overwrites a `finished` row (peeking into a watched item keeps
"Gesehen"); any write ≥ 30 s that is not finished flips it back to
`in_progress` (re-watch).

### API contract

All routes use `requireUser`; the user is always the session user (no user id
in any URL). `:id` is a P2 index id; anything not matching `^[1-9][0-9]{0,15}$`
or not present in `library_items` → `404 {"error":"not_found"}`.

| Route | Request | Success | Errors |
|---|---|---|---|
| `GET /api/progress/:id` | — | `200` entry (state `none` with `position: 0, duration: null, updatedAt: null` when no row) | 401, 404 |
| `PUT /api/progress/:id` | JSON `{ "position": number, "duration": number }` | `200` entry after the write | 400 `invalid_progress`, 400 `not_resumable`, 401, 404, P1 guard codes |
| `DELETE /api/progress/:id` (OPEN-1 = B) | — | `204` (idempotent) | 401, 404, P1 guard codes |
| `GET /api/progress` | query `category`, `view`, `limit` | `200 { "items": [entry…] }` | 400 `invalid_query`, 401 |

- Entry: `{ "itemId", "position", "duration", "state", "updatedAt" }`; in the
  `continue` view each entry also carries `"item"` = P2's item JSON (same
  serializer as `/api/library/items/:id`; the repository selects the full
  `library_items` row alongside the progress columns so the serializer gets its
  native row shape). `updatedAt` is the server clock (`Date.now()`) at write
  time, never a client value.
- Id → item resolution (`rel_path`, `category`, `playable`) reuses P2's by-id
  lookup when exported, otherwise a prepared statement in `src/db/progress.js`.
  A `PUT` below 30 s on an item without a row does create a row (state `none`).
- `PUT` validation: body is a JSON object; `position` and `duration` are
  `number` and `Number.isFinite` (no string coercion); `duration > 0` and
  ≤ 604 800 (7 days); `position ≥ 0`; `position > duration` is clamped to
  `duration`; unknown fields ignored. Violations → `400 invalid_progress`.
  Item not `playable` or category `image` → `400 not_resumable`. Malformed
  JSON, wrong content type and oversized bodies are answered by P1's JSON body
  helper with its codes.
- `GET /api/progress` query: `category` = comma list of P2 category ids,
  default all resumable (`movie,series,music,audiobook`), unknown or `image` →
  400; `view` = `continue` (default) | `all`; `limit` (continue only) = integer
  1–50, default 20. `continue` = `in_progress` entries (+ `next_up` entries
  when OPEN-2 = B and `series` is among the categories) ordered by `updatedAt`
  desc, limit applied after merging. `all` = every
  `in_progress` and `finished` entry of present items, no limit (for grid
  decoration). Rows whose `rel_path` is not in `library_items` never appear.

### Next episode (only if OPEN-2 = B)

`src/api/progress-next-up.js`, a pure function with the lookups injected. For
each series (P2's series grouping key) with at least one progress row of the
user among its present episodes, take the most recently updated row *L*:
`in_progress` → nothing (the series is already listed via *L*); `none` →
nothing; `finished` → *N* = the successor of *L* **exactly as P3 defines
`next`** (same series, smallest `(season, episode, rel_path)` greater than *L*;
episodes without numbers are neither source nor target), obtained through P3's
next-episode repository function — never a second ordering rule. *N* becomes a
`next_up` entry (`position: 0`, `duration: null`, `updatedAt` = *L*'s) only if
it is playable and its own state is `none`. So the last episode of a season
continues with the next season's first, and the finale yields nothing.

### Frontend client (`public/js/lib/progress.js`)

- `getProgress(itemId)`, `saveProgress(itemId, {position, duration})`,
  `removeProgress(itemId)`, `listProgress({category, view, limit})` — thin
  `fetch` wrappers; `saveProgress` always uses
  `fetch(url, { method: 'PUT', keepalive: true, headers: {'Content-Type': 'application/json'} … })`
  through P1's shared request helper if P1 provides one (so its CSRF marker is
  added), never `navigator.sendBeacon`.
- `trackPlayback(media, itemId, { entry, onResume })` → `{ stop(): Promise<void> }`
  for any `HTMLMediaElement`:
  1. use the pre-fetched `entry` (or fetch it when omitted); on `in_progress`,
     once metadata is available (`loadedmetadata`, or immediately if
     `readyState ≥ HAVE_METADATA`) set `currentTime = position` and call
     `onResume(position)` once the seek lands;
  2. arm reporting only after that seek (or immediately when there is nothing
     to resume) and only while `duration` is finite — so an early `timeupdate`
     or `pause` can never overwrite the stored position with 0;
  3. report every 10 s while playing (timer started on `playing`, cleared on
     `pause`/`ended`/`emptied`/`error`) and immediately on `pause`, `ended`,
     `visibilitychange` → hidden and `pagehide`; skip a report when the position
     moved < 1 s since the last sent one (baseline = the position loaded at
     start, so merely opening and leaving an item writes nothing);
  4. `emptied` disarms reporting until the next `playing` event (covers P3's
     "Erneut versuchen" source reload, which seeks back itself);
  5. failed reports are dropped silently (`console.warn`), the next trigger
     retries; `stop()` sends a final report and detaches all listeners (P5 calls
     it before switching queue items).
- `formatClock(s)` → `12:34` / `1:02:03` (seconds floored); `formatRemaining(s)` →
  `Noch 24 Min.` / `Noch 1 Std. 52 Min.` / `Noch 2 Std.` (minutes rounded up,
  minimum 1, a zero minute part omitted).
- No DOM access at import time, so the module is unit-testable under
  `node:test` with a fake media element, fake `fetch` and mock timers.

### UI behaviour

- **Resume toast** (`public/js/lib/resume-toast.js`): "Fortgesetzt bei 12:34",
  secondary button "Von vorn" (seeks to 0, hides toast), icon button "×"
  (`aria-label="Hinweis schließen"`); `role="status"`, `aria-live="polite"`,
  does not steal focus, Escape closes it when focused, auto-hides after 8 s.
  ≥ 768 px: overlays the lower video stage but never the native control bar;
  below 768 px: directly below the video, above P3's "Nächste Folge" button.
  Not shown for `none`/`finished`. Integration in P3's `public/js/player.js`:
  the item and its progress entry are fetched in parallel and `src` is set only
  after both settle (so autoplay never starts audibly at 0 before the seek);
  the entry is passed to `trackPlayback`; a failed progress fetch means "play
  from 0, no toast", never a player error state.
- **"Weiterschauen" row** (`public/js/lib/continue-row.js`): mounted at the top
  of the main content of the page served at `/` (per P1's shell design that is
  the Filme view; if `/` redirects, the redirect target) and nowhere else;
  requests
  `GET /api/progress?category=movie,series` (limit 20); hidden when empty or when
  the request fails. Card = 16:9 placeholder (no video thumbnails in v1), 4 px
  amber bar = position/duration, title (series title for episodes, movie title
  otherwise, one line + ellipsis), muted meta (`S1 · F3 · Noch 24 Min.` /
  `Noch 1 Std. 52 Min.`; the `S · F` part is omitted when P2 has no numbers for
  the episode); the card links to `/player.html?id=<id>` (P3).
  Horizontal scroll with scroll-snap (and `scroll-padding` matching the 16 px
  gutter); Left/Right arrow keys move focus between cards, the focused card is
  scrolled into view. OPEN-1 = B: always-visible "×" icon button per
  `in_progress` card (`aria-label="Aus Weiterschauen entfernen"`, 44 × 44 px
  target) → `DELETE`, card removed, row hidden when empty. OPEN-2 = B:
  `next_up` cards show the pill "Nächste Folge" instead of a bar, meta
  `S2 · F5`, and have no "×".
- **Grid decoration** (`public/js/lib/progress-badges.js`): P2's movie grid and
  episode list call `decorateProgress(root, entries)` after rendering, with one
  `GET /api/progress?view=all&category=movie|series` per page. `in_progress` →
  4 px amber bar on the thumbnail/row bottom plus visually hidden text
  "Zu 45 % gesehen"; `finished` → badge with check SVG and "Gesehen"; `none` →
  nothing. A failed request leaves the page undecorated (progress is an
  enhancement).
- Styles live in one CSS file per component (`public/css/resume-toast.css`,
  `continue-row.css`, `progress-badges.css`) using only token custom
  properties; inline SVG icons only.

### File ownership (P4)

New: `src/db/migrations/003-progress.sql`, `src/db/progress.js`,
`src/api/progress-rules.js`, `src/api/progress.js`,
`src/api/progress-next-up.js` (OPEN-2 = B), `public/js/lib/progress.js`,
`public/js/lib/resume-toast.js`, `public/js/lib/continue-row.js`,
`public/js/lib/progress-badges.js`, the three CSS files above, and
`test/db/progress.test.js`, `test/api/progress-rules.test.js`,
`test/api/progress.test.js`, `test/api/progress-next-up.test.js`,
`test/public/progress-client.test.js`.
Edited (minimal hooks only): `src/http/routes.js` (one registration line),
P3's player page script, the start page and its script, P2's movie grid and
episode list scripts, `docs/architecture.md` (Key flow 4).

### Cross-phase contract P4 relies on

- P1: migration runner discovers `src/db/migrations/NNN-*.sql` by listing (no
  hardcoded list); `PRAGMA foreign_keys = ON` on every connection; table
  `users(id INTEGER PRIMARY KEY)`; a documented CSRF/mutation guard for `PUT`/
  `DELETE` on `/api/*` that a same-origin `fetch(..., {keepalive: true})` with
  JSON body can satisfy (e.g. JSON content type, `Origin` check or custom
  header); a start page at `/`.
- P2: category ids `movie`, `series`, `music`, `audiobook`, `image` (P4 imports
  P2's constants, never re-spells them); `library_items.rel_path` UNIQUE; an
  exported item serializer; per-episode season and episode numbers plus a
  series grouping key; every media card and episode row root carries
  `data-item-id="<id>"`.
- P3 (per its spec draft): player page `/player.html?id=<id>` with script
  `public/js/player.js` (P4 hooks in there), autoplay via `video.play()` after
  setting `src`, "Erneut versuchen" reload that seeks back itself, and the
  item-JSON field `next` backed by a next-episode repository function in P2's
  library repository module (reused for `next_up`).

## Prior art

- [Playback progress and resume (Phase 4)](../prior-art.md#playback-progress-and-resume-phase-4)
  — audiobookshelf's per-(user, item) row with position, duration, finished,
  updated_at; periodic + pause/end/page-hide reporting; last write wins. Adopted,
  with the item key replaced by the relative path (see Prior decisions).
- [Minimal auth, sessions and embedded DB (Phase 1)](../prior-art.md#minimal-auth-sessions-and-embedded-db-phase-1)
  — `node:sqlite` `DatabaseSync`, session cookie `SameSite=Lax`: the basis for
  the per-user scoping and for the CSRF reasoning behind the transport choice.
- [Library model and naming conventions (Phase 2)](../prior-art.md#library-model-and-naming-conventions-phase-2)
  — `Season NN` / `SxxEyy` conventions behind the season/episode order that
  P3's `next` field (reused for "Nächste Folge") is built on.
- [Detecting new files without restart (Phase 2)](../prior-art.md#detecting-new-files-without-restart-phase-2)
  — mounts that drop out (USB/SMB) make whole subtrees vanish and reappear;
  the reason progress must not be keyed by the index id.

## Design

Produced with Google Stitch (project `videothek`, working reference only);
the committed exports are the durable design:

- Start page with "Weiterschauen" row and decorated movie grid:
  `docs/design/assets/progress-resume/home-continue-desktop.png`,
  `docs/design/assets/progress-resume/home-continue-mobile.png`
  (+ `.html` layout references).
- Player with resume toast:
  `docs/design/assets/progress-resume/player-resume-desktop.png`,
  `docs/design/assets/progress-resume/player-resume-mobile.png`
  (+ `.html` layout references).

Notes for the implementer: both mobile PNGs are 390 px renders (2x) of the
exported Stitch HTML — Stitch's own screenshots rendered mobile HTML on a
desktop canvas. Exported HTML is a layout reference only and is never copied
(`player-resume-mobile.html` even loads Tailwind from a CDN). The player page
chrome (back button, title block, "Nächste Folge" button, native controls) is
P3's design; only the toast is P4's. Where an export and this spec differ, the
spec wins: `next_up` cards carry no "×" (the mobile HTML shows one); every "×"
has a 44 × 44 px hit area even where the export draws it smaller; the "×" and
the "Nächste Folge" card exist only if OPEN-1 / OPEN-2 resolve to B; movie
posters and video thumbnails are flat placeholders (no image source exists for
video in v1).

## Human prerequisites

none

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Progress identity is `(user_id, rel_path)`; the API still addresses items by index id and the server resolves id → `rel_path` | Constitution: the library index is rebuildable at any time and progress is non-derivable; architecture: rows for vanished items are kept because the item may reappear. A reappearing item gets a new `INTEGER PRIMARY KEY` (and SQLite may reuse ids, misattributing progress). `rel_path` is the stable natural key (UNIQUE in `library_items`). Deviates from prior art's item-id column on purpose. | 2026-09-26 |
| No FK from `progress.rel_path` to `library_items`; FK `user_id → users(id) ON DELETE CASCADE` | Rows must outlive their item; they must not outlive their user. | 2026-09-26 |
| `position_seconds`/`duration_seconds` as `REAL`, `updated_at` as epoch ms, table `STRICT` | Media `currentTime` is a double; ms matches `Date.now()`; STRICT (SQLite ≥ 3.37, bundled 3.53) rejects type drift. | 2026-09-26 |
| Finished = ≥ 90 % for `movie`/`series`; remaining ≤ 30 s for audio categories | Jellyfin's default `MaxResumePct` is 90 (credits count as watched). A percentage is wrong for multi-hour audiobooks (90 % of 10 h leaves 1 h), so audio uses an absolute end window; P5 inherits it. | 2026-09-26 |
| Positions < 30 s count as "not started" and never downgrade a finished row | Accidental opens must not create "Weiterschauen" entries or erase "Gesehen"; replaces Jellyfin's 5 % / 300 s minimums with one absolute rule so short items stay resumable. | 2026-09-26 |
| State derivation lives only on the server (`state` field) | One rule set for player, row and grids; the client never re-implements thresholds. | 2026-09-26 |
| Transport: `fetch(…, {method:'PUT', keepalive:true})` with JSON for every report, including `pagehide`; no `navigator.sendBeacon` | `sendBeacon` can only `POST`, and a JSON-typed body is not CORS-safelisted, so it would force a POST/`text/plain` exception into P1's mutation guard. Keepalive fetch keeps `PUT` + JSON + any header P1 requires and outlives the page; it is supported by Chromium and Safari and by Firefox since 133 (2024-11-26), covering the constitution's Chromium + Firefox targets. | 2026-09-26 |
| Report every 10 s while playing plus immediately on `pause`, `ended`, `visibilitychange`→hidden, `pagehide` | Architecture flow 4 (~10 s). Explicit stops are exact; a crash loses ≤ 10 s — the vision's ±10 s resume criterion. `visibilitychange` covers mobile tabs that are backgrounded and killed without `pagehide`. | 2026-09-26 |
| Reporting is armed only after the resume seek has landed and `duration` is finite | Prevents the classic race where an early `timeupdate`/`pause` overwrites the stored position with 0; live/unknown durations are never stored. | 2026-09-26 |
| Invalid input → `400 invalid_progress`; `position > duration` is clamped, not rejected | Browsers report `currentTime` marginally beyond `duration` at the end; rejecting would lose the final "finished" write. NaN/Infinity/negative/strings are client bugs and are rejected. | 2026-09-26 |
| Images and non-playable items → `400 not_resumable` on write; `GET` answers state `none` | Nothing to resume; keeps garbage rows out without special-casing reads. | 2026-09-26 |
| Auto-resume with a dismissible toast ("Fortgesetzt bei …" + "Von vorn"), not a blocking prompt | Vision: "pick up … exactly where they left off"; a prompt costs a click before every playback and is awkward on TV remotes; "Von vorn" is the undo. | 2026-09-26 |
| Resume at the exact stored position (no rewind offset) | Keeps the ±10 s criterion trivially true and the rule simple. | 2026-09-26 |
| "Weiterschauen" row shows `movie` + `series` only, max 20, most recent first, hidden when empty; lives on the start page only | This phase is video; P5 owns audio UI and can reuse the endpoint with `category=audiobook`. An empty-state box would be noise. | 2026-09-26 |
| Grids get progress through a separate `GET /api/progress?view=all&category=…`, not by joining progress into `/api/library/*` | Architecture boundary: `src/library/` knows nothing about users; library responses stay user-agnostic; no P4 edit of P2's server files (P6 runs in parallel). | 2026-09-26 |
| Two devices playing the same item: last write wins | Prior art (audiobookshelf) — multi-device conflict resolution explicitly AVOIDed. | 2026-09-26 |
| Progress rows are never garbage-collected; rename/move = new identity | Architecture keeps rows for vanished items; rows are ~100 bytes; rename tracking would need content hashing. | 2026-09-26 |
| One CSS file and one JS module per UI component | Parallel issues (toast, row, badges) never edit the same file. | 2026-09-26 |
| OPEN-1 — Manual control over progress: A) none — the row cleans itself via the finished rule and the 20-item limit; B) "×" on "Weiterschauen" cards → `DELETE /api/progress/:id` (resets the item to `none`); C) full "Als gesehen / ungesehen markieren" toggle on cards and episode rows. **Recommended: B** — an abandoned movie otherwise sits in the row until 20 newer items push it out; C adds UI to P2's pages and a client-set `finished` flag for little household value. | resolved at the spec-acceptance gate | — |
| OPEN-2 — Next episode after a finished one: A) out — a finished episode simply leaves the row; B) the row shows a "Nächste Folge" entry for the following episode (same row, computed server-side with P3's `next` definition); C) a separate "Als Nächstes" row as in Jellyfin. **Recommended: B** — finishing an episode is exactly when a household wants to continue a series; one row keeps the start page simple. Costs one extra issue and depends on P2 exposing season/episode numbers. | resolved at the spec-acceptance gate | — |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (`npm run verify`):

- [ ] Verify passes; `npm ls --omit=dev --all` lists no packages.
- [ ] Migration 003 applies on a DB migrated to 002; re-running the runner is a no-op.
- [ ] Repository: upsert is last-write-wins; a < 30 s write leaves a finished row
      untouched; deleting a `library_items` row keeps the progress row, which
      re-attaches when the same `rel_path` is re-inserted under a new id;
      deleting a user deletes their rows.
- [ ] Rules: NaN, ±Infinity, negative, string, missing, `duration` 0 or > 7 days
      are rejected; `position > duration` is clamped; 90 % (video) and 30 s
      (audio) finished boundaries and the 30 s start threshold hold on both sides.
- [ ] API: every progress route answers `401` without a session; malformed and
      unknown ids → `404`; image / non-playable → `400 not_resumable`; bad
      query → `400 invalid_query`; user B can neither read nor change user A's
      progress; the continue view excludes finished, < 30 s and vanished items,
      orders by `updatedAt` desc and honours `limit`; mutations failing P1's
      guard are rejected.
- [ ] Client: with a fake media element and mock timers, no report is sent
      before the resume seek lands; reports fire every 10 s while playing and on
      `pause`, `ended`, `visibilitychange`→hidden and `pagehide`; every report
      is a keepalive `PUT` with a JSON body; `stop()` flushes and detaches;
      `formatClock` / `formatRemaining` cover < 1 h, ≥ 1 h and < 1 min.
- [ ] (OPEN-2 = B) Next-up: a finished S01E03 yields S01E04 as `next_up`; the
      last episode of a season yields S02E01; the series finale, a started or
      non-playable successor, an unnumbered episode, or an in-progress latest
      episode yield nothing; the successor always equals P3's `next`.

Human QA (Chromium + Firefox, `test/fixtures/media/` or a real `MEDIA_ROOT`,
mobile 390 px and desktop 1440 px, compared with the design exports):

- [ ] Play a movie in Chromium to ~12:34, pause, close the tab. Open it in
      Firefox as the same user: playback starts at 12:34 ± 10 s and the toast
      "Fortgesetzt bei 12:34" appears; "Von vorn" jumps to 0:00; the toast
      disappears after ~8 s or on "×".
- [ ] Play, then close the tab without pausing; reopen: resumes within ±10 s.
      Play, then kill the browser process; reopen: resumes within ±10 s.
- [ ] DevTools network: while playing one `PUT /api/progress/:id` about every
      10 s, none while paused, one on pause and one on tab close; no request to
      any external host.
- [ ] Start page: the movie appears first in "Weiterschauen" with a proportional
      4 px amber bar and "Noch … Min."; an episode shows `S1 · F3 · Noch … Min.`;
      a new user sees no row at all.
- [ ] Seek a movie past 90 % and stop: it leaves the row; its movie card shows
      "Gesehen"; reopening starts at 0:00 without toast. Open it and close
      within 20 s: "Gesehen" remains.
- [ ] Movie grid and episode list: started items show the bar, finished items
      "Gesehen", untouched items nothing.
- [ ] (OPEN-1 = B) "×" on a card removes it; after reload it stays removed and
      the grid card has no bar.
- [ ] (OPEN-2 = B) Finish S01E03 of a series: "Nächste Folge" S01E04 appears in
      the row; opening it starts at 0:00.
- [ ] Log in as a second user: none of the first user's progress is visible.
- [ ] Move a started file out of `MEDIA_ROOT`: after the rescan it is gone from
      the row; move it back: it reappears with the same position.
- [ ] Keyboard only: Tab reaches the toast's "Von vorn" and "×" and the row's
      cards and "×"; Left/Right move between row cards; focus ring visible
      everywhere; screen reader announces the toast once.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| P1's CSRF/mutation guard rejects the keepalive `PUT` | The client goes through P1's request helper; keepalive fetch supports any method and header, so every header/content-type/Origin scheme is satisfiable. An API test runs a guarded `PUT` through the real guard. |
| Firefox < 133 ignores `keepalive`; mobile browsers skip `pagehide` | The 10 s timer and the `visibilitychange`→hidden report bound the loss to ≤ 10 s. |
| Early media events overwrite the stored position with 0 | Reporting is armed only after the resume seek; covered by a client unit test. |
| P2 lacks season/episode numbers, the item serializer or `data-item-id` | Listed in the cross-phase contract; if missing, the affected P4 issue adds the minimal hook in P2's file (attribute/export only) and records it in the Decision log. |
| `routes.js` edited in parallel by P4 and P6 | One appended line each; a rebase resolves the trivial conflict. |
| Browsers report slightly different durations for the same file | Rules use the duration of the latest write; the 90 %/30 s thresholds are coarse enough. |
| SD-card wear on a Pi from frequent writes | One small upsert per active stream every 10 s (WAL) is negligible. |
| Resume toast hidden while the video is fullscreen | Accepted — resuming still happens; the toast is informational. |

## Decision log

- 2026-09-26: Keyed progress by `rel_path` instead of the prior-art item id —
  an unmounted media disk makes the scanner delete all rows; on remount every
  item gets a new id and id-keyed progress would be lost or misattributed.
- 2026-09-26: Finished threshold 90 % for video from Jellyfin's
  `ServerConfiguration` defaults (`MaxResumePct` 90, `MinResumePct` 5,
  `MinResumeDurationSeconds` 300; source:
  https://typescript-sdk.jellyfin.org/interfaces/generated-client.ServerConfiguration.html,
  secondary source, not read from Jellyfin's C# code). Only the 90 % maximum
  is adopted; the minimums are replaced by the 30 s rule.
- 2026-09-26: `sendBeacon` rejected in favour of keepalive `fetch`; Firefox
  support since 133 per
  https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/133.
- 2026-09-26: Auto-resume + toast chosen over a resume prompt (see Prior
  decisions).
- 2026-09-26: The prior-art note that audiobookshelf's sync interval was not
  read from source still holds; the 10 s interval comes from architecture flow 4.
- 2026-09-26: Aligned with the P3 spec draft (`docs/specs/spec-video-streaming.md`
  on `docs/video-streaming`): player URL, hook file `public/js/player.js`,
  autoplay → progress fetched before `src` is set, "Erneut versuchen" reload →
  `emptied` disarm, and "Nächste Folge" reuses P3's `next` ordering instead of
  defining a second one.
