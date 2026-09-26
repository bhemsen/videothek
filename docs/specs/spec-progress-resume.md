# Spec: Progress & resume

> Created: 2026-09-26

Per-user playback progress for every time-based item: the player reports its
position, opening an item on any device resumes it automatically, the start page
shows a "Weiterschauen" row (in-progress movies and episodes plus the next
episode of a finished one), and started/finished items are marked in the video
grids. This spec carries no lifecycle state — acceptance is the spec merged on
the default branch with a milestone and issues, and all progress (in progress,
done, blocked) lives in the GitHub issues and milestone. A completed spec is
moved to `docs/specs/archive/`.

## Outcome

- [ ] A video paused or closed on device A at position *p* starts on device B
      (same user, Chromium or Firefox) at *p* ± 10 s without any extra click,
      and a toast "Fortgesetzt bei *m:ss*" with a "Von vorn" action is shown.
- [ ] While a video plays, its position is persisted at least every 10 s and
      immediately on pause, end, tab hide and page leave.
- [ ] The start page `/` shows the heading "Start" and a "Weiterschauen" row of
      the user's in-progress movies and episodes (most recent first, 4 px
      primary bar, remaining time) plus a "Nächste Folge" card for the next
      episode after a finished one; without entries the row is absent and P1's
      home empty state ("Willkommen") is shown instead.
- [ ] Every in-progress card has a "×" that removes the item from the row for
      good (its progress is reset to "not started").
- [ ] A video watched to ≥ 90 % leaves the row and shows a "Gesehen" badge on its
      movie card / episode row; a started one shows the 4 px bar there.
- [ ] Progress is strictly per user: no API call can read or change another
      user's progress; every progress route answers `401` without a session.
- [ ] Progress survives an item vanishing from `MEDIA_ROOT` and re-attaches when
      the same relative path reappears, even under a new index id.
- [ ] `public/js/lib/progress.js` exposes a media-element-agnostic client
      (`<video>` and `<audio>`) that Phase 5 reuses without modification; the
      server rules already cover `music` and `audiobooks`.
- [ ] `npm run verify` is green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- Migration `003-progress.sql` and the repository `src/db/progress.js`.
- API: `GET/PUT/DELETE /api/progress/:id` and the collection
  `GET /api/progress` (continue view and state view) — contract below.
- Pure server rules (validation, finished rule, state derivation, query
  parsing, entry JSON) and the pure next-episode ("next up") computation.
- Frontend progress client `public/js/lib/progress.js` (API wrappers, playback
  tracker, time formatters) for P3's video player now and P5's audio player.
- Player integration: auto-resume + resume toast on P3's player page.
- Start page: P4 replaces P1's placeholder `public/js/home.js` and mounts the
  "Weiterschauen" row (movies + series only) with the home empty state.
- Removing an entry from the row ("×" → `DELETE /api/progress/:id`).
- Progress bar / "Gesehen" badge on P2's movie cards and episode rows.
- `docs/architecture.md` edits listed under "File ownership" (made by the
  implementing issue, not in this spec PR).

### Out of scope

- Audio UI (music, audiobooks, "Weiterhören") — Phase 5 reuses this API, the
  client and the `progress` table (H7: music tracks write progress rows too).
- Progress on series-level cards in the Serien grid (aggregate "3 of 10
  episodes") — no aggregate model in v1.
- A "watched / unwatched" toggle (H5 chose "×" only) and a separate
  "Als Nächstes" row (H6 chose the same row).
- Auto-play of the next episode at the end of playback (P3 player territory).
- Multi-device conflict resolution beyond last-write-wins (prior art: AVOID).
- Carrying progress across renames/moves of a file (identity = relative path).
- Garbage collection of progress rows for items that never reappear.
- Offline queueing/retry of failed reports (the next trigger retries).
- Video thumbnails/posters on cards (no image source for video in v1).
- Any new configuration value — all thresholds are code constants.

## Constraints

- Constitution applies unchanged: zero runtime deps, SQL only in `src/db/` via
  prepared statements with bound parameters, JSON errors `{ "error": "<code>" }`,
  JSDoc on every export, ≤ 60 lines/function, ≤ 300 lines/file (JS and CSS), a
  `test/` suite per new `src/` module with failure cases for auth, German UI
  copy, raw values only in `public/css/tokens.css`, no `innerHTML` with data,
  no `console.*` in `src/` (injected `log` only). P1's rule tests also cap
  every test file at 300 lines, hence the split of the API tests below.
- Only P1's `public/css/tokens.css` holds raw values: P4 CSS uses
  `--color-*`, `--space-*`, `--radius-*`, `--text-*`, `--weight-*`,
  `--shadow-*`, `--tap-min`, `--border-width`, `--focus-width`,
  `--focus-offset`; literal lengths only for breakpoints (768/1024 px), `%`,
  `fr`, `0`. The 4 px bar height is `--space-1`. CSP forbids `style=""`:
  dynamic widths are set with `el.style.setProperty('--progress', fraction)`.
- P4 edits other phases' files only as listed under "File ownership" (hook
  lines/attributes, one registration line).

### Data model (migration `003-progress.sql`)

```sql
CREATE TABLE progress (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rel_path         TEXT    NOT NULL,          -- = library_items.rel_path, never an FK
  position_seconds REAL    NOT NULL CHECK (position_seconds >= 0),
  duration_seconds REAL    NOT NULL CHECK (duration_seconds > 0),
  finished         INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
  updated_at       INTEGER NOT NULL,          -- epoch ms, server clock
  PRIMARY KEY (user_id, rel_path)
) STRICT;
CREATE INDEX progress_user_updated ON progress (user_id, updated_at DESC);
```

The file contains no `BEGIN`/`COMMIT` (P1's runner wraps each file in its own
transaction together with the `schema_migrations` insert). It references only
`users` (migration 001), so it applies whether or not 002, 004 or 005 were
applied before it (the runner applies every unapplied file ascending, gaps
allowed).

### Progress states (derived server-side, one source of truth)

| State | Condition | Effect |
|---|---|---|
| `none` | no row, or `finished = 0` and position < 30 s | start at 0, no toast, no bar, not listed |
| `in_progress` | `finished = 0` and position ≥ 30 s | auto-resume + toast, bar, in "Weiterschauen" |
| `finished` | `finished = 1` | start at 0, no toast, "Gesehen" badge, not listed |
| `next_up` | only as a continue-view entry (see "Next up") | "Nächste Folge" pill, start at 0 |

Write rule for `PUT`, evaluated in this order:

1. **Finished rule first:** categories `movies`, `series` → finished iff
   position ≥ 0.9 × duration; categories `music`, `audiobooks` → finished iff
   duration − position ≤ 30 s. Finished → upsert with `finished = 1`.
2. **Finished guard:** otherwise, if an existing row has `finished = 1` and the
   new position is < 30 s, the row is left untouched (peeking into a watched
   item keeps "Gesehen") and the response is the unchanged entry.
3. Otherwise upsert with `finished = 0` (a write ≥ 30 s on a finished row is a
   re-watch and flips it back to `in_progress`; a write < 30 s on an unfinished
   or missing row stores state `none`).

Consequences, intended: a video shorter than 33.3 s can never be
`in_progress` (30 s is already ≥ 90 %); an audio item of ≤ 30 s is finished by
its first report.

Constants live in `src/api/progress-rules.js`: `START_THRESHOLD_S = 30`,
`VIDEO_FINISHED_RATIO = 0.9`, `AUDIO_END_WINDOW_S = 30`,
`MAX_DURATION_S = 604800`. Repository queries receive the threshold as a bound
parameter; `src/db/` never hard-codes it.

### API contract (`src/api/progress.js`, `registerProgressRoutes(router, deps)`)

All routes are wrapped in P1's `requireUser`; the user is always
`ctx.user.id` (no user id in any URL). `:id` is a P2 index id: anything not
matching `^[1-9][0-9]{0,15}$` or not a safe integer, or not present in
`library_items` (P2's `getItemById(db, id)` returns `null`) →
`404 {"error":"not_found"}`. `updated_at` is written from `deps.now()`
(epoch ms), never from a client value.

| Route | Request | Success | Errors |
|---|---|---|---|
| `GET /api/progress/:id` | — | `200` entry; no row → `{ itemId, position: 0, duration: null, state: "none", updatedAt: null }` | 401, 404 |
| `PUT /api/progress/:id` | JSON `{ "position": number, "duration": number }` | `200` entry after the write rule | 400 `invalid_progress`, 400 `not_resumable`, 401, 404, P1 codes (400 `invalid_json`, 403 `forbidden_origin`, 413 `payload_too_large`, 415 `unsupported_media_type`) |
| `DELETE /api/progress/:id` | no body | `204` (`sendNoContent`) whether or not a row existed (resets to `none`) | 401, 404, 403 `forbidden_origin` |
| `GET /api/progress` | query `category`, `view`, `limit` | `200 { "items": [entry…] }` | 400 `invalid_query`, 401 |

- **Entry JSON:** `{ "itemId": number, "position": number, "duration":
  number|null, "state": "none"|"in_progress"|"finished"|"next_up",
  "updatedAt": string|null }` — `updatedAt` is ISO-8601 UTC
  (`new Date(ms).toISOString()`). In the `continue` view every entry also
  carries `"item"` = `toItemJson(row)` (P2's serializer on the full
  `library_items` row the repository selects alongside the progress columns).
- **`PUT` processing order:** id syntax (404) → P1 `readJson(req)` (its codes)
  → item lookup (404) → resumable check: category `images` (including H9's
  videos under `Bilder/`) or `playable = 0` → `400 not_resumable` → body
  validation → write rule. A missing body (`readJson` → `undefined`) or a
  non-object body → `400 invalid_json` (P1 convention for handlers that
  require a body). Validation: `position` and `duration` are `typeof number`
  and `Number.isFinite` (no coercion); `0 < duration ≤ 604800`;
  `position ≥ 0`; `position > duration` is clamped to `duration`; unknown
  fields ignored; any violation → `400 invalid_progress`.
- **`DELETE`:** needs no resumable check (nothing to protect); P1's mutation
  guard applies (same-origin `Origin`; no body, so no content-type check).
- **`GET /api/progress` query** (`parseProgressQuery(searchParams)`):
  `category` = comma list of P2 category ids, duplicates ignored, default
  `movies,series,music,audiobooks`; empty value, an unknown id or `images` →
  400. `view` = `continue` (default) | `all`, anything else → 400. `limit` only
  with `view=continue`: integer string 1–50, default 20; any `limit` with
  `view=all` → 400. Unknown parameters are ignored. All failures →
  `400 invalid_query`.
- **`continue` view:** the user's `in_progress` rows whose `rel_path` is present
  in `library_items` with `playable = 1` and a requested category, plus
  `next_up` entries when `series` is requested; merged, ordered by
  `updatedAt` desc then `itemId` desc, `limit` applied after merging.
- **`all` view** (grid decoration): every `in_progress` and `finished` entry of
  present, playable items of the requested categories, no `item`, no limit.
- Variable category lists are bound as one JSON array parameter
  (`category IN (SELECT value FROM json_each(?))`) — no SQL string building.

### Next up (`src/api/progress-next-up.js`)

`computeNextUp(rows, { getNext, getState })` → `next_up` entries, pure with
injected lookups. `rows` = the user's progress rows joined to present
`library_items` rows of category `series` (`listSeriesProgressRows`). Per
series (`series_id`):

1. Ignore rows in state `none`; *L* = the remaining row with the highest
   `updated_at` (ties: higher item id). No such row → nothing.
2. *L* `in_progress` → nothing (the series is already listed via *L*).
3. *L* `finished` → *N* = `getNext(L)`, i.e. P3's `getNextEpisode(db, row)`
   from `src/db/episodes.js` — the one ordering rule of `next` (same
   `series_id`, smallest `(season, episode, rel_path)` greater than
   `(L.season, coalesce(L.episode_end, L.episode), L.rel_path)`; unnumbered
   episodes are neither source nor target). *N* is emitted only if it exists, is
   `playable`, and its own state (`getState(N.rel_path)`) is `none`.
4. Result per series: `{ row: N, updatedAt: L.updated_at }` (epoch ms);
   `src/api/progress.js` turns it into the entry `{ itemId: N.id,
   position: 0, duration: null, state: "next_up", updatedAt: <ISO>,
   item: toItemJson(N) }`, so the pure module imports nothing from P2/P3.

So the last episode of a season continues with the next season's first, and
the finale yields nothing.

### Repository (`src/db/progress.js`)

All SQL for `progress`; every function takes `db` first:
`getProgressRow(db, userId, relPath)` → row | null;
`upsertProgress(db, { userId, relPath, positionSeconds, durationSeconds,
finished, updatedAt })` (`INSERT … ON CONFLICT(user_id, rel_path) DO UPDATE`);
`deleteProgress(db, userId, relPath)` → boolean;
`listContinueRows(db, { userId, categories, startThreshold, limit })`;
`listStateRows(db, { userId, categories, startThreshold })`;
`listSeriesProgressRows(db, userId)`. Joined rows expose the full
`library_items` row plus `position_seconds`, `duration_seconds`, `finished`,
`updated_at` under non-colliding aliases.

### Frontend client (`public/js/lib/progress.js`)

- Transport through P1's `request(method, path, { json, keepalive,
  redirectOn401 })` from `public/js/lib/api.js`:
  `getProgress(itemId)` → entry (GET, default 401 redirect);
  `saveProgress(itemId, { position, duration })` → `PUT` with
  `{ json, keepalive: true, redirectOn401: false }` — used for every report
  including `pagehide`, never `navigator.sendBeacon`;
  `removeProgress(itemId)` (DELETE); `listProgress({ category, view, limit })`
  → `items` array (`category` accepts an array or comma string).
- `trackPlayback(media, itemId, { entry, onResume, resume = true })` →
  `{ stop(): Promise<void> }` for any `HTMLMediaElement`:
  1. `entry` omitted → fetched with `getProgress`; a failed fetch counts as
     state `none`.
  2. Resume (only when `resume` is true, `entry.state === 'in_progress'` and
     `entry.position > 0`): on metadata (`loadedmetadata`, or immediately when
     `readyState ≥ HAVE_METADATA`) set `currentTime = entry.position`, unless
     `entry.position ≥ media.duration` (then no seek). On the following
     `seeked`, call `onResume?.(entry.position)` once and arm reporting. If the
     element is emptied before the seek lands, the seek is repeated on the next
     `loadedmetadata`. `resume: false` never seeks and never calls `onResume`.
  3. Reporting is armed after the resume seek, or on metadata when there is
     nothing to resume, and only while `media.duration` is finite and > 0 — an
     early `timeupdate`/`pause` can never overwrite the stored position with 0.
  4. Reports: every 10 s while playing (interval started on `playing`, cleared
     on `pause`/`ended`/`emptied`/`error`) and immediately on `pause`, `ended`,
     `document` `visibilitychange` → hidden, `window` `pagehide`, and `stop()`.
     A report is skipped when `|currentTime − lastSent| < 1 s`; `lastSent`
     starts at the loaded position (or 0), so opening and leaving writes
     nothing. Payload `{ position: media.currentTime, duration: media.duration }`.
  5. `emptied` disarms reporting until the next `playing` event (covers P3's
     "Erneut versuchen" source reload, which seeks back itself).
  6. A failed report is dropped with `console.warn` and does not advance
     `lastSent`, so the next trigger retries. `stop()` sends a final report,
     detaches every listener and timer, and resolves when that report settled
     (P5 calls it before every queue switch).
  - Callers that decide the start position themselves (P5) pass the entry
    normalised to that start: `{ state: start > 0 ? 'in_progress' : 'none',
    position: start }` and never set the initial `currentTime` themselves.
- `formatClock(s)` → `12:34` / `1:02:03` (seconds floored);
  `formatRemaining(s)` → `Noch 24 Min.` / `Noch 1 Std. 52 Min.` /
  `Noch 2 Std.` (minutes rounded up, minimum 1, a zero minute part omitted).
- No DOM or `window` access at import time; the module is unit-tested under
  `node:test` with a fake media element, stubbed `globalThis.fetch`,
  `document`/`window` event targets and `mock.timers`.

### UI behaviour

Every P4 UI module injects its own stylesheet once
(`<link rel="stylesheet" href="/css/<component>.css">` appended to
`document.head` if not present) so no other phase's HTML file is edited;
DOM is built with P1's `el(tag, attrs, ...children)` (`public/js/lib/dom.js`);
icons beyond P1's set are defined in the P4 module itself with P1's
`createIcon(paths)` (`public/js/lib/icons.js` is never edited); text only via
`textContent`. Off-token shades in the Stitch exports map to tokens: muted
text = `--color-muted`, card/toast surfaces = `--color-secondary`, borders =
`--color-border`, hover/active = P1's derived state tokens.

- **Resume toast** (`public/js/lib/resume-toast.js`,
  `showResumeToast({ media, position })` → `{ hide() }`): host = the media
  element's parent, given class `resume-toast-host` (`position: relative`);
  the toast is inserted right after the media element. It hides itself on the
  media's `emptied` event.
  Content: rotate icon (`--color-primary`), "Fortgesetzt bei 12:34"
  (`formatClock`), secondary button "Von vorn" (sets `currentTime = 0`, hides
  the toast, focus → the media element), icon button "×"
  (`aria-label="Hinweis schließen"`). Every button ≥ `--tap-min`. The toast is
  `role="status"`, inserted empty and filled in the next animation frame so
  screen readers announce it once; it never takes focus; Escape inside it
  closes it (focus → media element). Auto-hide after 8 s; the timer pauses
  while the pointer is over the toast or focus is inside it and restarts with
  a full 8 s on leave/blur. ≥ 768 px: absolutely positioned in the host,
  horizontally centred, its bottom edge `--space-16` above the video's bottom
  edge (clears the native control bar) — the module sets
  `--resume-toast-top` = `video.offsetTop + video.offsetHeight` (px, via
  `setProperty`, updated by a `ResizeObserver` on the video) and CSS applies
  `top: var(--resume-toast-top)`, `left: 50%` and
  `transform: translate(-50%, calc(-100% - var(--space-16)))`; this works
  whether or not P3 wraps the video. < 768 px: in normal flow directly below
  the video, above P3's "Nächste Folge" button. Surface `--color-secondary`, `--border-width` border
  `--color-border`, radius `md`, `--shadow-md`. Hidden in fullscreen (accepted).
- **Player hook** (P4 edit of P3's `public/js/player.js`, confined to P3's
  seam): `getProgress(id)` starts in parallel with P3's `loadItem(id)`; P3's
  single `startPlayback(video, item)` call runs only after both settled
  (autoplay never starts audibly at 0 before the seek), and only on P3's
  playable path; a failed progress fetch yields
  `{ state: 'none', position: 0 }` ("play from 0, no toast", never a player
  error state); right after `startPlayback` the hook calls
  `trackPlayback(video, item.id, { entry, onResume: (p) =>
  showResumeToast({ media: video, position: p }) })`. Non-playable and error
  states start no tracker. P3's "Erneut versuchen" reloads the source of the
  same `<video>` element and seeks back itself; the tracker sees `emptied` and
  re-arms on the next `playing`.
- **Home page** (`public/js/home.js`, replaces P1's placeholder; P1's
  `public/index.html`, `public/css/home.css` and `public/js/placeholder.js`
  are not edited): renders exactly P1's home structure —
  `mountShell({ active: null })`, `<h1>Start</h1>`, the rows slot
  `<section class="home-rows" aria-label="Übersicht">`, then P1's empty state
  (`createEmptyState({ title: 'Willkommen', text: 'Wähle eine Kategorie, um
  loszulegen.' })`) — and then calls `mountContinueRow(slot)`. The empty state
  carries `hidden` whenever the slot has at least one child (P1's rule): it is
  hidden once the row is mounted and shown again when the last card is removed
  or when there are no entries / the request fails.
- **"Weiterschauen" row** (`public/js/lib/continue-row.js`,
  `mountContinueRow(container)` → `Promise<boolean>` = row mounted): requests
  `listProgress({ category: ['movies', 'series'], view: 'continue' })` (limit
  default 20). Section with H2 "Weiterschauen" and a `<ul>` horizontal scroller
  (scroll-snap, `scroll-padding` = the 16 px page gutter `--space-4`, cards
  start inside the gutter). Card `<li data-item-id>` = sibling pair of
  `<a href="/player?id=<itemId>">` (16:9 `--color-secondary` placeholder tile
  with film icon, 4 px `--color-primary` bar of width position/duration,
  visually hidden "Zu 45 % gesehen", title one line + ellipsis, muted meta) and,
  for `in_progress` only, a `<button aria-label="Aus Weiterschauen entfernen">`
  "×" (≥ `--tap-min`, positioned over the tile's top-right corner, never
  nested in the link). Title = `item.seriesTitle` for episodes, else
  `item.title`. Meta (`cardMeta(entry)`, exported, pure): episodes
  `S1 · F3 · Noch 24 Min.` (season 0 → `Special · F3`; the `S · F` part omitted
  when season or episode is null), movies `Noch 1 Std. 52 Min.`; `next_up`
  cards: pill "Nächste Folge" (`--color-primary` text and border) instead of
  the bar, meta `S2 · F5`, no "×". Left/Right arrow keys move focus between
  card links and scroll the focused card into view; Tab visits link and "×"
  in DOM order. "×" → `removeProgress(id)`; on `204` the card is removed and
  focus moves to the next card's link, else the previous one, else (row now
  empty) the row section is removed from the slot, the empty state is
  un-hidden and focus goes to the page's H1 (`tabindex="-1"`); on failure the card stays and the row's `role="status"`
  line reads "Entfernen fehlgeschlagen. Bitte erneut versuchen.".
- **Grid decoration** (`public/js/lib/progress-badges.js`):
  `decorateProgress(root, entries)` (idempotent: removes earlier P4
  decorations first) and `decorateProgressFor(root, category)` → `Promise<void>`
  (`listProgress({ category, view: 'all' })`, then `decorateProgress`; any
  failure leaves the page undecorated). For each `[data-item-id]` under `root`
  with an entry, the host is its `[data-progress-host]` descendant or the
  element itself (class `progress-host` → `position: relative`,
  `overflow: hidden`). `in_progress` → 4 px `--color-primary` bar along the
  host's bottom edge + visually hidden "Zu 45 % gesehen"; `finished` → pill
  top right: check SVG in `--color-accent`, text "Gesehen" in
  `--color-foreground` 12 px semibold, `--color-background` fill,
  `--border-width` `--color-border` border; `none` → nothing. Series cards
  (`data-series-id`) are never decorated. Hooks: P2's `public/js/movies.js`
  calls `decorateProgressFor(grid, 'movies')` and `public/js/series-detail.js`
  `decorateProgressFor(list, 'series')` after every render; P2's
  `public/js/lib/media-card.js` puts `data-progress-host` on the movie card's
  tile element (episode rows use the row itself).

### File ownership (P4)

New: `src/db/migrations/003-progress.sql`, `src/db/progress.js`,
`src/api/progress-rules.js`, `src/api/progress-next-up.js`,
`src/api/progress.js`, `public/js/lib/progress.js`,
`public/js/lib/resume-toast.js`, `public/js/lib/continue-row.js`,
`public/js/lib/progress-badges.js`, `public/css/resume-toast.css`,
`public/css/continue-row.css`, `public/css/progress-badges.css`,
`test/db/progress.test.js`, `test/api/progress-rules.test.js`,
`test/api/progress-next-up.test.js`, `test/api/progress.test.js`
(per-item routes), `test/api/progress-list.test.js` (collection route),
`test/public/progress-client.test.js`, `test/public/continue-row.test.js`.
Replaced (owning-phase-replaces rule): `public/js/home.js` (P1 placeholder).
Edited (minimal hooks only): `src/http/routes.js` (one
`registerProgressRoutes(router, deps)` line), `public/js/player.js` (P3),
`public/js/movies.js`, `public/js/series-detail.js`,
`public/js/lib/media-card.js` (P2; one call / one attribute each),
`docs/architecture.md` — Key flow 4 rewritten (identity `(user, rel_path)`,
keepalive `PUT` every ~10 s and on pause/ended/hidden/`pagehide`, continue list
= `in_progress` rows + next-up, start page mount) and one Boundaries line
("progress is keyed by `(user_id, rel_path)` and never references
`library_items` by id"); made by the progress-API issue.

### Cross-phase contract P4 relies on

- **P1:** `openDatabase(dataDir)` + `migrate(db, dir?)` (all unapplied files
  ascending, gaps allowed, one transaction per file, `foreign_keys = ON`);
  `users(id INTEGER PRIMARY KEY)`; handler `(req, res, ctx)` with
  `ctx = { user, params, url }`; `requireUser(handler)` from
  `src/http/guards.js`; `sendJson(res, status, body)`,
  `sendError(res, status, code)`, `sendNoContent(res)`, `readJson(req)`
  (→ `undefined` without a body; 415 only when a body is present) from
  `src/http/respond.js`; P1's `test/route-auth.test.js` covers the 401 of
  every registered route automatically; `registerRoutes(router, deps)` in
  `src/http/routes.js` with `deps = { config, db, log, now }` (`now()` → epoch
  ms); mutation guard = same-origin `Origin` + JSON content type when a body is
  present (a same-origin keepalive `fetch` with JSON passes); `/api/*`
  `Cache-Control: no-store`; `test/helpers/app.js`
  `startTestApp({ mediaRoot?, now?, ...extra })` → `{ baseUrl, db, config,
  deps, createUser(name, pw, role), login(name, pw) → cookie, close() }`;
  frontend
  `request(method, path, { json, keepalive, redirectOn401 = true })` →
  `{ status, data }` throwing `ApiError { status, code }` (no DOM access at
  import; network failure → `ApiError { status: 0, code: 'network' }`) from
  `public/js/lib/api.js`; `mountShell({ active })` → `{ main, setActive, me }`
  from `public/js/lib/shell.js`; `el(tag, attrs, ...children)` and
  `createEmptyState({ title, text })` from `public/js/lib/dom.js`;
  `createIcon(paths, { viewBox })` from `public/js/lib/icons.js`; tokens as
  listed in Constraints; the home structure (`.home-rows` slot, "Willkommen"
  empty state hidden while the slot has children); page URLs `/`, `/movies`,
  `/series`, `/player?id=`.
- **P2:** `CATEGORIES` (`movies`, `series`, `music`, `audiobooks`, `images`)
  from `src/library/categories.js`; `getItemById(db, id)` → full
  `library_items` row incl. `rel_path` | null from `src/db/library-queries.js`;
  `toItemJson(row)` from `src/api/library-json.js`; `library_items` with
  `rel_path` UNIQUE, `category`, `playable`, `series_id`, `season`, `episode`,
  AUTOINCREMENT ids and hard deletes; `data-item-id` on movie card and episode
  row roots, `data-series-id` on series cards; pages `public/js/movies.js`,
  `public/js/series-detail.js`, shared `public/js/lib/media-card.js`.
- **P3:** `getNextEpisode(db, row)` → `LibraryItemRow | null` from
  `src/db/episodes.js` (the function behind the single-item `next` field);
  player page `/player?id=<id>` with the seam in `public/js/player.js`:
  `loadItem(id)` and exactly one `startPlayback(video, item)` call (tracks,
  `src`, `play()`), never repeated by retry; "Erneut versuchen" reloads the
  same `<video>` element and seeks back itself (emits `emptied`).

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
  P3's `next` (reused for "Nächste Folge") is built on.
- [Detecting new files without restart (Phase 2)](../prior-art.md#detecting-new-files-without-restart-phase-2)
  — mounts that drop out (USB/SMB) make whole subtrees vanish and reappear;
  the reason progress must not be keyed by the index id.

## Design

Produced with Google Stitch (project `videothek`, working reference only);
the committed exports are the durable design:

- Start page with "Weiterschauen" row:
  `docs/design/assets/progress-resume/home-continue-desktop.png`,
  `docs/design/assets/progress-resume/home-continue-mobile.png`
  (+ `.html` layout references).
- Player with resume toast:
  `docs/design/assets/progress-resume/player-resume-desktop.png`,
  `docs/design/assets/progress-resume/player-resume-mobile.png`
  (+ `.html` layout references).

Notes for the implementer — where an export and this spec differ, the spec
wins:

- The home exports show a "Filme" grid below the row and an active "Filme" nav
  entry: both are illustrative only (they double as the grid-decoration
  mockup). The real home page has H1 "Start", the row, no grid and no active
  nav entry.
- Both mobile PNGs are 390 px renders (2x) of the exported Stitch HTML. The
  exported HTML is a layout reference only and never copied
  (`player-resume-mobile.html` loads Tailwind from a CDN).
- The player chrome (back button, title block, "Nächste Folge" button, native
  controls) is P3's design; only the toast is P4's.
- `next_up` cards carry no "×" (the mobile HTML shows one); every "×" has a
  44 × 44 px hit area; the mobile row starts inside the 16 px gutter.
- "Gesehen" uses foreground text with an accent check (the mobile export's
  accent text is superseded); off-token shades (e.g. `#787f8d` meta text,
  4.1:1 on the card surface) map to `--color-muted`.
- Movie posters and video thumbnails are flat placeholders.

## Human prerequisites

none — nothing blocks implementation (all machine tests use generated data).
QA-only (milestone QA gate, not a blocker): the real sample media P3's QA
already requires (a playable H.264/AAC MP4 movie of ≥ 15 min and a series with
≥ 2 consecutive playable episodes) plus Chromium and Firefox on the QA machine;
the second test account is created through `/admin` during QA.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Progress identity is `(user_id, rel_path)`; the API addresses items by index id and the server resolves id → `rel_path` | P2 uses `AUTOINCREMENT` + hard delete: a vanished and reappearing file gets a new id, and a rebuilt index (constitution: rebuildable at any time) reassigns every id. Progress is non-derivable, so it needs the stable natural key (`rel_path` is UNIQUE). Deviates from prior art's item-id column on purpose. | 2026-09-26 |
| No FK from `progress.rel_path` to `library_items`; FK `user_id → users(id) ON DELETE CASCADE` | Rows must outlive their item (architecture flow 1); they must not outlive their user (P1's delete dialog warns that progress is lost). | 2026-09-26 |
| Migration 003, `STRICT`, references only `users`, no transaction statements | Cross-phase D12: each migration depends only on what it references; runner applies gaps; STRICT rejects type drift. | 2026-09-26 |
| `position_seconds`/`duration_seconds` `REAL`, `updated_at` epoch ms in the DB; API `updatedAt` ISO-8601 string | Media `currentTime` is a double; D4: DB stores INTEGER epoch ms, API exposes ISO `…At` strings. | 2026-09-26 |
| Finished = ≥ 90 % for `movies`/`series`; remaining ≤ 30 s for `music`/`audiobooks` | Jellyfin's default `MaxResumePct` is 90 (credits count as watched). A percentage is wrong for multi-hour audiobooks, so audio uses an absolute end window; P5 inherits it (H7: music too). | 2026-09-26 |
| Write rule order: finished rule first; the < 30 s guard only protects an existing finished row; < 30 s writes otherwise store state `none` | D11. Accidental opens must not create "Weiterschauen" entries or erase "Gesehen"; applying the finished rule first keeps very short items finishable. | 2026-09-26 |
| State derivation only on the server (`state` field); thresholds are constants in `progress-rules.js`, passed to SQL as bound parameters | One rule set for player, row and grids; `src/db/` stays free of business constants. | 2026-09-26 |
| `continue` and `all` views list only present, `playable` items | A card must always lead to something playable; it also keeps the "Gesehen" pill from colliding with P2's "Nicht abspielbar" badge. | 2026-09-26 |
| `limit` with `view=all` → `400 invalid_query`; unknown query parameters ignored | Explicit contract instead of a silently ignored parameter. | 2026-09-26 |
| Variable category lists bound as one JSON array (`json_each(?)`) | Constitution: prepared statements only, no string-built SQL; JSON is built into Node 24's SQLite. | 2026-09-26 |
| Transport: `fetch` keepalive `PUT` with JSON through P1's `request(…, { keepalive: true, redirectOn401: false })`; no `navigator.sendBeacon` | D4/D5: P1's guard is same-origin `Origin` + JSON content type, which a same-origin keepalive fetch satisfies; `sendBeacon` can only `POST` non-JSON bodies. A 401 on a background report must not yank the user to the login page. Keepalive fetch: Chromium, Safari, Firefox ≥ 133. | 2026-09-26 |
| Report every 10 s while playing plus on `pause`, `ended`, `visibilitychange`→hidden, `pagehide` | Architecture flow 4 (~10 s); a crash loses ≤ 10 s — the vision's ±10 s criterion; `visibilitychange` covers mobile tabs killed without `pagehide`. | 2026-09-26 |
| Reporting armed only after the resume seek landed and while `duration` is finite | Prevents an early `timeupdate`/`pause` overwriting the stored position with 0; unknown durations are never stored. | 2026-09-26 |
| `trackPlayback(media, id, { entry, onResume, resume = true })`; callers that pick the start pass a normalised entry and let the tracker seek | D11: one seek owner avoids P5's start position being overridden by an auto-resume. | 2026-09-26 |
| Invalid input → `400 invalid_progress`; `position > duration` clamped | Browsers report `currentTime` marginally beyond `duration`; NaN/Infinity/negative/strings are client bugs. | 2026-09-26 |
| Images (incl. H9 videos under `Bilder/`) and non-playable items → `400 not_resumable` on `PUT`; `GET` answers the stored or `none` state | Nothing to resume; keeps garbage rows out without special-casing reads. | 2026-09-26 |
| Auto-resume with a dismissible toast ("Fortgesetzt bei …" + "Von vorn"), exact stored position | Vision: pick up exactly where they left off; a prompt costs a click on every playback and is awkward on TV remotes; "Von vorn" is the undo. | 2026-09-26 |
| Toast: centred, `--space-16` above the video's bottom edge on ≥ 768 px (positioned from the video's box, independent of P3's wrapper markup), in flow below the video on phones; 8 s auto-hide paused on hover/focus | Matches the desktop export and never covers native controls; P3's stage is the `<video>` itself, so the toast cannot rely on a wrapper; WCAG 2.2.1 (timing adjustable). | 2026-09-26 |
| `PUT` without a body or with a non-object body → `400 invalid_json`; field violations → `400 invalid_progress` | P1's convention for handlers that require a body (`readJson` → `undefined`). | 2026-09-26 |
| Player hook confined to P3's `loadItem`/`startPlayback` seam; retry keeps the same element | P3's spec defines the seam for P4; `emptied` + re-arm on `playing` covers the retry without editing P3's retry code. | 2026-09-26 |
| Home `/` = P1's `index.html` with P4's replacement `home.js` reproducing P1's structure (H1 "Start", `.home-rows` slot, "Willkommen" empty state hidden while the slot has children) and mounting the row into the slot; no active nav entry | Cross-phase D2 and P1's home contract (owning-phase-replaces rule; P4 never edits `placeholder.js`, `index.html` or `home.css`). P1's copy stays true with or without a row; a failed row request also shows it — progress is an enhancement. | 2026-09-26 |
| "Weiterschauen" requests `category=movies,series`, max 20, most recent first | D11 (video-only row); P5 owns audio entry points and reuses the endpoint (e.g. `category=music&limit=1`). | 2026-09-26 |
| Grids get progress through `GET /api/progress?view=all&category=…`, not by joining progress into `/api/library/*` | Architecture: `src/library/` knows nothing about users; library responses stay user-agnostic; no P4 edit of P2's server files. | 2026-09-26 |
| Decoration hooks: one `decorateProgressFor` call in `movies.js` and `series-detail.js`, one `data-progress-host` attribute in `media-card.js` | The bar must sit on the tile, not below the title; a single attribute is the smallest stable hook into P2's markup. | 2026-09-26 |
| P4 components inject their own stylesheet `<link>` | No P4 edit of HTML files owned by P1/P2/P3; CSP `style-src 'self'` allows linked sheets. | 2026-09-26 |
| One CSS file and one JS module per UI component; extra icons defined in the P4 module via P1's `createIcon` | Parallel issues (toast, row, badges) never edit the same file; P1's contract: `icons.js` is never edited by later phases. | 2026-09-26 |
| Two devices playing the same item: last write wins | Prior art (audiobookshelf) — multi-device conflict resolution explicitly AVOIDed. | 2026-09-26 |
| Progress rows are never garbage-collected; rename/move = new identity | Architecture keeps rows for vanished items; rows are ~100 bytes; rename tracking would need content hashing. | 2026-09-26 |
| Human decision at spec-acceptance gate (H5): "×" (44 px, sibling of the card link) on in-progress cards → body-less `DELETE /api/progress/:id` resets to `none`; next-up cards have no "×" | An abandoned movie would otherwise stay in the row until 20 newer items push it out; a watched toggle adds UI to P2's pages for little household value. | 2026-09-26 |
| Human decision at spec-acceptance gate (H6): "Nächste Folge" entry in the same row, computed server-side with P3's `next` ordering (`getNextEpisode` from `src/db/episodes.js`), `none` rows ignored when choosing the latest episode | Finishing an episode is when a household wants to continue a series; one row keeps the start page simple; one ordering rule avoids drift from P3's button. | 2026-09-26 |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (`npm run verify`):

- [ ] Verify passes; `npm ls --omit=dev --all` lists no packages; every new
      `src/` module has its test file.
- [ ] `test/db/progress.test.js`: migration 003 applies on a DB at 001 and on
      one whose `schema_migrations` already records a higher version (gap);
      re-running the runner is a no-op; upsert is last-write-wins; deleting a
      `library_items` row keeps the progress row, which re-attaches when the
      same `rel_path` is re-inserted under a new id; deleting a user deletes
      their rows; list queries honour categories, threshold, playable and
      presence.
- [ ] `test/api/progress-rules.test.js`: NaN, ±Infinity, negative, string,
      missing, `null` body, `duration` 0 or > 604 800 rejected;
      `position > duration` clamped; 90 % (video) and 30 s (audio) finished
      boundaries and the 30 s start threshold hold on both sides; write-rule
      order (finished first, guard only for finished rows, 20 s video,
      25 s audio); query parsing incl. `limit` with `view=all`, `images`,
      empty and unknown categories; every category id used exists in P2's
      `CATEGORIES`; `updatedAt` is ISO.
- [ ] `test/api/progress-next-up.test.js`: finished S01E03 → S01E04; last
      episode of a season → S02E01; finale, started or non-playable successor,
      unnumbered episode, in-progress latest episode → nothing; a newer `none`
      row does not hide a finished latest episode; `updatedAt` = *L*'s.
- [ ] `test/api/progress.test.js` (via `startTestApp`): every route `401`
      without a session (also covered by P1's route-auth test); malformed and
      unknown ids → `404`; image (incl. a video under `images`) and
      non-playable → `400 not_resumable`; body-less `PUT` → `400 invalid_json`;
      user B can neither read nor change user A's progress; `PUT` with a
      foreign `Origin` → `403`; body-less `DELETE` → `204` twice.
- [ ] `test/api/progress-list.test.js`: bad query → `400 invalid_query`;
      continue view excludes
      finished, < 30 s, non-playable and vanished items, includes `next_up`
      only when `series` is requested, orders by `updatedAt` desc and honours
      `limit` after merging; entries carry `item` only in the continue view.
- [ ] `test/public/progress-client.test.js` (fake media element, stubbed
      `fetch`, `mock.timers`): no report before the resume seek lands;
      `onResume` once; no seek when `resume: false` or position ≥ duration;
      reports every 10 s while playing and on `pause`, `ended`,
      `visibilitychange`→hidden and `pagehide`; < 1 s moves skipped; every
      report is a keepalive `PUT` with a JSON body and no 401 redirect;
      `emptied` disarms until `playing`; a failed report is retried on the
      next trigger; `stop()` flushes and detaches; `formatClock` /
      `formatRemaining` cover < 1 min, < 1 h, ≥ 1 h and whole hours.
- [ ] `test/public/continue-row.test.js`: `cardMeta` for movie, episode,
      special, unnumbered episode and `next_up`.

Human QA (Chromium + Firefox, real sample media per Human prerequisites,
phone 390 px and desktop 1440 px, compared with the design exports):

- [ ] Play a movie in Chromium to ~12:34, pause, close the tab. Open it in
      Firefox as the same user: playback starts at 12:34 ± 10 s and the toast
      "Fortgesetzt bei 12:34" appears centred above the controls (below the
      video on the phone); "Von vorn" jumps to 0:00; the toast disappears after
      ~8 s (not while hovered/focused) or on "×".
- [ ] Play, then close the tab without pausing; reopen: resumes within ±10 s.
      Play, then kill the browser process; reopen: resumes within ±10 s.
- [ ] DevTools network: while playing one `PUT /api/progress/:id` about every
      10 s, none while paused, one on pause and one on tab close; no request to
      any external host.
- [ ] Start page: H1 "Start", the movie first in "Weiterschauen" with a
      proportional 4 px orange bar and "Noch … Min."; an episode shows
      `S1 · F3 · Noch … Min.`; a new user sees the "Willkommen" empty state and
      no row; no nav entry is active.
- [ ] Seek a movie past 90 % and stop: it leaves the row; its movie card shows
      "Gesehen"; reopening starts at 0:00 without toast. Open it and close
      within 20 s: "Gesehen" remains.
- [ ] Movie grid and episode list: started items show the bar, finished items
      "Gesehen", untouched items nothing.
- [ ] "×" on a card removes it and focus moves to the neighbouring card; after
      reload it stays removed and the grid card has no bar; removing the last
      card brings back the "Willkommen" empty state.
- [ ] Finish S01E03 of a series: "Nächste Folge" S01E04 appears in the row
      without "×"; opening it starts at 0:00.
- [ ] Log in as a second user: none of the first user's progress is visible.
- [ ] Move a started file out of `MEDIA_ROOT`: after the rescan it is gone from
      the row; move it back: it reappears with the same position.
- [ ] Keyboard only: Tab reaches the toast's "Von vorn" and "×" and the row's
      cards and "×"; Left/Right move between row cards; focus ring visible
      everywhere; a screen reader announces the toast once.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| P1's mutation guard rejects the keepalive `PUT` | The client goes through P1's `request`; an API test runs a guarded `PUT` through the real app. |
| Firefox < 133 ignores `keepalive`; mobile browsers skip `pagehide` | The 10 s timer and the `visibilitychange`→hidden report bound the loss to ≤ 10 s. |
| Early media events overwrite the stored position with 0 | Reporting armed only after the resume seek; covered by a client unit test. |
| P2/P3 merged names differ from the consumed contract (`getItemById`, `toItemJson`, `getNextEpisode`, `loadItem`/`startPlayback`, `data-item-id`) | Contract fixed in the cross-phase decisions; the consuming issue reads the merged code first and adapts names, never semantics or ownership. |
| `routes.js` / P2 page scripts edited in parallel | One appended line / one call / one attribute per edit; a rebase resolves the trivial conflict. |
| Browsers report slightly different durations for the same file | Rules use the duration of the latest write; the thresholds are coarse enough. |
| SD-card wear on a Pi from frequent writes | One small upsert per active stream every 10 s (WAL) is negligible. |
| Resume toast hidden while the video is fullscreen | Accepted — resuming still happens; the toast is informational. |
| A short flash of unstyled content from injected stylesheets | Components render only after their data arrived; the sheet is requested on import, before that. |

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
- 2026-09-26: Auto-resume + toast chosen over a resume prompt.
- 2026-09-26: The prior-art note that audiobookshelf's sync interval was not
  read from source still holds; the 10 s interval comes from architecture flow 4.
- 2026-09-26: cross-phase consolidation — page URLs per D1: player at
  `/player?id=<id>`, home at `/`, category pages `/movies`, `/series`.
- 2026-09-26: cross-phase consolidation — home per D2: P4 replaces P1's
  placeholder `public/js/home.js`, mounts the row from
  `public/js/lib/continue-row.js`, leaves `placeholder.js` alone; home exports'
  grid and active "Filme" entry annotated as illustrative.
- 2026-09-26: cross-phase consolidation — category ids plural per D3
  (`movies`, `series`, `music`, `audiobooks`, `images`), imported from P2's
  `CATEGORIES`.
- 2026-09-26: cross-phase consolidation — P1 server and frontend contracts per
  D4/D5: `registerProgressRoutes(router, deps)`, `ctx.user`, `deps.now()`,
  ISO `updatedAt` (settles the review's epoch-ms vs ISO conflict in favour of
  P1's convention), `request(…, { keepalive, redirectOn401: false })` for
  reports, tokens only from `tokens.css`, `setProperty` for dynamic widths.
- 2026-09-26: cross-phase consolidation — progress per D11: keyed by
  `(user_id, rel_path)` with the updated rationale (AUTOINCREMENT + hard
  delete, rebuilt index reassigns ids); `trackPlayback` gains `resume`;
  normalised entries for callers that pick the start; finished rule first;
  next-up ignores `none` rows; the row requests `category=movies,series`.
- 2026-09-26: cross-phase consolidation — migration 003 per D12 (STRICT,
  depends only on 001, no transaction statements); architecture edits listed
  in scope per D13 and made by the progress-API issue.
- 2026-09-26: cross-phase consolidation — next-up reuses P3's exported
  `getNextEpisode(db, row)` from `src/db/episodes.js` per D10 (`next` stays in
  the single-item response); the player hook uses P3's `loadItem` /
  `startPlayback` seam.
- 2026-09-26: cross-phase consolidation — aligned with P1's consolidated spec:
  home keeps P1's "Willkommen" empty state and `.home-rows` slot (the draft's
  own empty-state copy is dropped), body-less `PUT` → `invalid_json`,
  `sendNoContent`, `el` / `createEmptyState` / `createIcon` helpers,
  `startTestApp({ now, ...extra })`, 300-line cap on test files.
- 2026-09-26: cross-phase consolidation — H7 (music writes progress rows) needs
  no P4 change: the audio finished rule and `GET /api/progress?category=music`
  already serve it; H9 videos under `Bilder/` are `not_resumable`.
- 2026-09-26: gate decision — H5: "×" on in-progress continue cards →
  body-less `DELETE /api/progress/:id` (reset to `none`); no "×" on next-up
  cards.
- 2026-09-26: gate decision — H6: "Nächste Folge" entry in the same row,
  computed server-side with P3's `next` ordering, ignoring `none` rows.
- 2026-09-26: pre-mortem settlements — write-rule order and short-item
  consequences; `PUT` check order; `DELETE` idempotent without resumable check;
  continue/all views limited to present playable items; `limit` with
  `view=all` rejected; `json_each` binding for category lists; toast bottom
  inset and hover/focus-paused auto-hide; focus handling after "×";
  stylesheet injection instead of HTML edits; `data-progress-host` hook;
  "Gesehen" pill colours and off-token export shades mapped to tokens; toast
  positioned from the video's box; seek skipped when the stored position ≥ duration; retry of
  a seek interrupted by `emptied`.
