# Spec: Video streaming & player

> Created: 2026-09-26

Phase 3 makes every playable library item streamable over an authenticated,
range-capable `GET /media/:id` endpoint guarded against path escapes, serves
WebVTT subtitle sidecars, and ships the video player page (`/player?id=<id>`)
with not-playable / error states and a next-episode affordance for series. This
spec carries no lifecycle state — acceptance is the spec merged on the default
branch with a milestone and issues, and all progress lives in the GitHub issues
and milestone. A completed spec is moved to `docs/specs/archive/`.

## Outcome

- [ ] A logged-in user opens a playable movie or episode from the browse UI
      (P2's cards and episode rows link to `/player?id=<id>`) and it plays in
      Chromium and Firefox with native controls; seeking anywhere in the file
      works without the whole file being downloaded first.
- [ ] `GET /media/:id` answers `Range` requests with `206` + correct
      `Content-Range`, unsatisfiable ranges with `416` + `Content-Range: bytes */<size>`,
      no/ignored ranges with `200`; `HEAD` returns the same headers as a `200`
      without a body.
- [ ] `/media/:id` streams any playable item of any category (video, audio,
      image — including videos indexed under `images`) with the `Content-Type`
      from P2's compatibility table; P5 and P6 reuse the route and
      `sendMedia` unchanged.
- [ ] No request can read a file outside `MEDIA_ROOT` — including via `..`,
      absolute paths, NUL bytes or symlinks/junctions that resolve outside it;
      every such case, like every unknown/non-playable id, answers `404`.
- [ ] Without a valid session `/media/*` answers `401` JSON and streams nothing;
      `/player` redirects to `/login?next=…`.
- [ ] A client that disconnects mid-stream, or consumes nothing for 60 s,
      releases its file handle; the process holds no more open media file
      descriptors after all players are closed than before.
- [ ] A movie or episode with `.vtt` sidecars (`<basename>.vtt`,
      `<basename>.<lang>.vtt`) offers them in the browser's native subtitle
      menu, none switched on by default.
- [ ] A non-playable item (e.g. MKV) opens the player page in the "Nicht
      abspielbar" state with its format named — no `<video>` is created and no
      `/media/` request is made.
- [ ] A playback failure is explained on the page: missing file ("Datei nicht
      gefunden") is distinguished from an unsupported codec ("Wiedergabe nicht
      möglich") and from a dropped connection ("Verbindung unterbrochen"); each
      offers a way back, and "Erneut versuchen" resumes on the same `<video>`
      element near the previous position with its subtitle tracks intact.
- [ ] For a series episode with a successor, a "Nächste Folge" button opens the
      next episode; "Zurück" returns to the page the user came from, not to the
      previous episode.
- [ ] On a desktop keyboard, Space/K, ←/→, F and M control playback when focus is
      not on a button, link, form field or the video itself.
- [ ] Two concurrent 1080p direct-play streams play without stutter on the
      Raspberry Pi 4 target (vision success criterion "Weak hardware"; checked at
      milestone QA — see Human prerequisites).

## Scope

### In scope

New files (each with its test; test paths in Verification):

- `src/http/range.js` — `parseRange(header, size)`.
- `src/http/media-types.js` — `mediaTypeFor(ext)`, a thin lookup over P2's
  `src/library/parsers/compat.js` (no second table).
- `src/http/stream.js` — `sendMedia(req, res, opts)`.
- `src/media/paths.js` — `resolveMediaPath(mediaRoot, relPath)`.
- `src/media/subtitles.js` — `listSubtitles(mediaRoot, row)` and
  `SUBTITLE_CONTENT_TYPE`.
- `src/db/episodes.js` — `getNextEpisode(db, row)` (also used by P4).
- `src/api/item-detail.js` — `toItemDetailJson({ db, mediaRoot }, row)`.
- `src/api/media.js` — `registerMediaRoutes(router, deps)`: `GET /media/:id`
  and `GET /media/:id/subtitles/:n` (HEAD via P1's GET fallback).
- `public/player.html`, `public/js/player.js`, `public/js/player-panel.js`,
  `public/js/player-icons.js`, `public/css/player.css`,
  `public/js/lib/player-keys.js`, `public/js/lib/player-format.js`,
  `public/js/lib/player-stage.js`.

Frontend imports from other phases (read-only): P1 `public/js/lib/api.js`
(`request`, `toLogin`), `public/js/lib/dom.js` (`el`), `public/js/lib/icons.js`
(`createIcon`), `public/css/tokens.css`, `public/css/base.css`; P2
`public/js/lib/library-format.js` (`episodeCode`).

Edits to files owned by other phases (minimal, one line or one section):

- `src/http/routes.js` (P1) — one line `registerMediaRoutes(router, deps)`.
- `src/api/library.js` (P2) — the `GET /api/library/items/:id` handler responds
  with `await toItemDetailJson({ db, mediaRoot: config.mediaRoot }, row)`
  instead of `toItemJson(row)`; nothing else in the file changes.
- `docs/architecture.md` (D13), made by the media-route issue: component map —
  the "Streaming" row becomes three rows (`src/http/range.js`,
  `src/http/media-types.js`, `src/http/stream.js`), the "Path guard" row names
  `src/media/paths.js` + `src/media/subtitles.js`, new rows
  `src/db/episodes.js` (next-episode order) and `src/api/media.js`
  (`/media/:id`, `/media/:id/subtitles/:n`); Key flow 3 (Stream) gains the
  `HEAD` disambiguation, the subtitle route and the 60 s idle timeout.
- `docs/prior-art.md` (made in this spec PR, not by an issue): ADOPT entries
  for nginx `send_timeout` (under "HTTP range streaming (Phase 3)") and a new
  concern "Subtitle sidecars (Phase 3)" with Jellyfin's external-subtitle
  naming.

### Out of scope

- Resume / progress reporting and "Weiterschauen" — Phase 4 hooks into
  `public/js/player.js` (seam defined below).
- Audio player UI and `/media/:id/cover` (Phase 5), image lightbox and
  `/media/:id/thumb` (Phase 6).
- `.srt` or any other subtitle format, subtitle conversion, styling or
  default-on tracks; indexing subtitle files.
- Transcoding/remuxing, custom player skin, playback speed, audio-track or
  quality selection, auto-play of the next episode, casting, downloads.
- ETag / conditional GET / `304` handling (prior art: AVOID).
- Changes to the scanner or compatibility table (Phase 2 owns `compat.js`,
  including every MIME type).
- Browse-page links to the player — P2's movie cards and episode rows already
  link to `/player?id=<id>` and P4's continue row does the same; P3 edits no P2
  page.

## Design

Produced with Google Stitch (design system `Videothek`), exported and committed
— the PNGs are the durable design; the HTML files are layout references only
(they load Tailwind from a CDN and must never be copied).

| Screen | Mobile (390 px, 2x) | Desktop (1280 px) |
|---|---|---|
| Player, series episode with next-episode button | `docs/design/assets/video-streaming/player-mobile.png` | `docs/design/assets/video-streaming/player-desktop.png` |
| Error state "Nicht abspielbar" (movie) | `docs/design/assets/video-streaming/error-mobile.png` | `docs/design/assets/video-streaming/error-desktop.png` |

Reference HTML: `player-mobile.html`, `player-desktop.html`, `error-mobile.html`,
`error-desktop.html` in the same folder. Stitch project `videothek`, screens
"Video Player – Desktop/Mobile", "Player Fehler – Desktop/Mobile" (working
reference only). Off-token shades in the Stitch exports map to tokens or to
P1's derived state tokens (`--color-{primary,secondary}-{hover,active}`); no
other colour is introduced.

Layout rules (they override the exports where they differ). Literal sizes
below name the design scale; in CSS they are always the tokens: 48 px icon →
`--space-12`; text 12/14/20/24 px → `--text-xs`/`--text-sm`/`--text-lg`/
`--text-xl`; 1 px borders → `--border-width`; 2 px focus ring/offset →
`--focus-width`/`--focus-offset`; 44 px → `--tap-min`. No `px` literal is
written outside `tokens.css` (P1's machine-checked rule).

- Focused page: no category nav, no app shell (`mountShell` is not called).
  Top: secondary button "Zurück" (chevron SVG) + title block (overline 14 px
  `muted` semibold, heading 24 px bold). The overline is rendered exactly as
  text ("Film", or the series title) — no `text-transform`; the "FILM" of the
  error export is illustrative. ≥ 768 px: button and title block side by side;
  below: stacked. The heading is the page's `<h1>` while an item is loaded.
  Without an item (loading, "Titel nicht gefunden", "Titel konnte nicht
  geladen werden") the title block is `hidden`, the error panel's heading is
  the `<h1>`, and `document.title` = that heading + " – Videothek" (loading:
  the static `<title>Videothek</title>` of `player.html`).
- Page frame: `max-width: var(--content-max)`, centred, inline padding
  `var(--space-4)` (< 768 px) / `var(--space-6)` (≥ 768 px), block gap
  `var(--space-6)`.
- Stage: `<video controls playsinline preload="metadata">` on the `background`
  token, `width: 100%`, `max-height: 80dvh`, radius `md` on ≥ 768 px; below
  768 px edge-to-edge (`margin-inline: calc(-1 * var(--space-4))`, no radius).
  The controls in the mockups are illustrative — the real ones are the
  browser's native controls, never re-skinned.
- Below the stage (series only, when `next` is not `null`): secondary button
  "Nächste Folge: S01E03 · Sturmflut" (skip SVG); right-aligned on ≥ 768 px,
  full width below. Under `@media (hover: hover) and (pointer: fine)` the page
  additionally shows the muted 12 px hint line "Tastatur: Leertaste
  Wiedergabe/Pause · ←/→ 10 Sekunden · F Vollbild · M Ton aus".
- The page creates exactly one `<video>` element per page load, only on the
  playable path (just before `startPlayback`), and keeps that same element
  for the page's lifetime. The loading state precedes it (no element yet).
  Playback error states detach it from the stage (`video.remove()`), never
  discard or recreate it, and show the error panel in its place; the
  below-stage "Nächste Folge" button is shown only while the video is
  attached (in error states `next` appears as a panel action where the table
  says so). Error panel: centred, on the
  `secondary` surface, radius `lg`, `shadow-md`, padding `var(--space-8)`,
  `width: 100%` with `max-width: calc(var(--space-16) * 7.5)` (480 px, tokens
  only); content centred: destructive
  icon (48 px), optional "Nicht abspielbar" pill badge (12 px semibold,
  `destructive` text, 1 px `destructive` border, radius `full`, ban icon),
  heading 20 px semibold (`<h2>`, or `<h1>` when no item is loaded — same
  style), muted body 14 px, then the actions. On ≥ 768 px the
  panel sits inside a stage box with 1 px `border`, radius `lg` and
  `aspect-ratio: 16 / 9`; below 768 px the panel follows the title block
  directly.
- Actions: DOM order = primary "Zurück zur Übersicht" first, then the state's
  secondary action; ≥ 768 px in one centred row (gap `var(--space-3)`), below
  768 px stacked full width with the primary on top. Every button ≥ 44 px
  (`--tap-min`), focus ring 2 px `primary` with 2 px offset (P1 base styles).

State copy (German UI, exact):

| State | Trigger | Badge | Heading | Body | Actions |
|---|---|---|---|---|---|
| Loading | item fetch pending | — | — | stage shows muted "Lädt …" | — |
| Playing | item playable | — | — | — | "Nächste Folge: …" if `next` |
| Not found | invalid `id`, item API `404`, or category not `movies`/`series` | — | Titel nicht gefunden | Dieser Titel ist nicht (mehr) in der Bibliothek. | Zurück zur Übersicht |
| Load failed | item API network error or any status other than 2xx/401/404 | — | Titel konnte nicht geladen werden | Bitte prüfe die Verbindung und versuche es erneut. | Zurück zur Übersicht, Erneut versuchen |
| Not playable | `playable` false | Nicht abspielbar | Dieses Video kann nicht abgespielt werden | Das Format {EXT} kann der Browser nicht direkt wiedergeben. Die Datei bleibt unverändert in der Bibliothek. | Zurück zur Übersicht; "Nächste Folge: …" if `next` |
| File missing | `<video>` error + `HEAD /media/:id` → `404` | — | Datei nicht gefunden | Die Datei wurde verschoben oder gelöscht. Die Bibliothek aktualisiert sich automatisch. | Zurück zur Übersicht, Erneut versuchen |
| Codec | `<video>` error code 3/4 (or any code other than 1/2) + `HEAD` → `2xx` | Nicht abspielbar | Wiedergabe nicht möglich | Der Browser kann diese Datei nicht wiedergeben – vermutlich ein nicht unterstützter Codec (z. B. HEVC). | Zurück zur Übersicht; "Nächste Folge: …" if `next` |
| Connection lost | `<video>` error code 2 + `HEAD` → `2xx`, or `HEAD` fails / answers anything but 2xx/401/404 | — | Verbindung unterbrochen | Die Übertragung wurde unterbrochen. | Zurück zur Übersicht, Erneut versuchen |

`{EXT}` = the item's `ext` upper-cased (e.g. `MKV`).

## Constraints

- Constitution applies in full; the load-bearing rules here, verbatim where
  quoted: "Media is streamed with `fs.createReadStream` and honours `Range`
  (206/416); no media file is read fully into memory."; "Every filesystem path
  derived from a request is resolved and verified to lie inside `MEDIA_ROOT`
  before access; violation -> `404`."; "Every route except `/login`, static
  assets and `/healthz` requires a valid session."; media root read-only (files
  opened with flag `'r'` only); ≤ 60 lines/function, ≤ 300 lines/file; JSDoc on
  every export; a test per new `src/` module with failure cases for range, path
  and auth; no `innerHTML` with data; German UI copy; no `process.env` outside
  `src/config.js`; no `console.*` in `src/` modules (P1 injected `log`).
- Architecture boundaries: only `src/media/paths.js` (and
  `src/media/subtitles.js`, which calls it for every candidate) turns an item's
  stored relative path into a filesystem path; clients reference media by id
  only; `src/api/` knows nothing about file formats (Content-Type comes from
  `sendMedia` via `mediaTypeFor`; subtitle naming, the "only video items have
  subtitles" rule and `SUBTITLE_CONTENT_TYPE` live in `src/media/subtitles.js`
  and are passed through by the route); SQL only in `src/db/`.
- P1 contract used verbatim (D4/D5): handlers `handler(req, res, ctx)` with
  `ctx = { user, params, url }`; `register<X>Routes(router, deps)` with
  `deps = { config, db, log, now, ...extra }`; `config.mediaRoot`; router
  `add(method, pattern, handler)` with whole-segment `:param` matching
  (`/media/:id` ≠ `/media/:id/subtitles/:n` ≠ P6's `/media/:id/thumb`), `405` +
  `Allow`, and `HEAD` running the `GET` handler with `req.method === 'HEAD'`;
  `requireUser(handler)` from `src/http/guards.js` (`401 {"error":"unauthorized"}`
  on any path, never a redirect); `sendError(res, status, code)` from
  `src/http/respond.js`; `test/helpers/app.js` `startTestApp`; frontend
  `request(method, path, { json, keepalive, redirectOn401 = true })` →
  `{ status, data }` throwing `ApiError { status, code }`, and `toLogin()` from
  `public/js/lib/api.js`; `public/css/tokens.css` + `public/css/base.css`
  (never edited here); CSP without inline styles — dynamic values only via
  `el.style.setProperty`; page rule `GET /<name>` → `public/<name>.html`,
  session-gated with `302 /login?next=…`, direct `*.html` → 404.
- P2 contract used verbatim: `library_items` columns (`id`, `rel_path`, `dir`,
  `category`, `kind`, `ext`, `title`, `series_id`, `series_title`, `season`,
  `episode`, `episode_end`, `playable`, …); `CATEGORIES` ids `movies`, `series`,
  `music`, `audiobooks`, `images` (D3); `getItemById(db, id)` from
  `src/db/library-queries.js` (full row incl. `rel_path`, or `undefined`);
  `toItemJson(row)` from `src/api/library-json.js` (already includes `ext`,
  `seriesTitle`, `season`, `episode`, `episodeEnd`); `EXTENSIONS`
  (ext → `{ kind, playable, mime }`) and `isPlayableExtension(ext)` from
  `src/library/parsers/compat.js`; frontend `episodeCode({ season, episode,
  episodeEnd })` from `public/js/lib/library-format.js` (`S01E06`,
  `S01E01-E02`, `E06`, `E06-E07`, `null` when the episode is unknown).
- No new configuration value: the idle timeout is a module constant.

## Prior art

- [HTTP range streaming (Phase 3)](../prior-art.md#http-range-streaming-phase-3) —
  `pillarjs/send` + `jshttp/range-parser` are the precedent for range semantics
  (read at source, see Decision log); ETag/conditional-GET machinery is AVOIDed;
  nginx `send_timeout` (default 60 s between two writes) is the precedent for
  the idle timeout (entry added by this PR).
- [Subtitle sidecars (Phase 3)](../prior-art.md#subtitle-sidecars-phase-3) —
  Jellyfin's external-subtitle naming `<video name>.<lang>.<ext>` is the
  precedent for the `.vtt` sidecar pattern; its flag suffixes (`default`,
  `forced`, `sdh`) are AVOIDed (entry added by this PR).
- [Direct-play compatibility detection (Phase 2)](../prior-art.md#direct-play-compatibility-detection-phase-2) —
  defines which extensions are playable and therefore servable; explains why an
  extension-based "playable" MP4 can still fail at runtime (HEVC) → the "Codec"
  error state.
- [Library model and naming conventions (Phase 2)](../prior-art.md#library-model-and-naming-conventions-phase-2) —
  season/episode numbering (`Season 00` specials) that the next-episode order
  builds on.

## Human prerequisites

None block implementation — every test generates its own temp files. For the
milestone QA gate only (QA-only):

- [ ] A QA `MEDIA_ROOT` with real, decodable media (the committed fixtures are
      synthetic and not decodable): ≥ 1 movie as MP4 H.264/AAC, ideally 1080p,
      with a hand-written WebVTT sidecar `<basename>.de.vtt` next to it; ≥ 1
      series with ≥ 2 consecutive episodes; ≥ 1 MKV; and — if available — 1
      HEVC-in-MP4 file for the "Codec" state (without it that single QA line is
      skipped). The implement loop may point `.env` at it (autonomy grant).
- [ ] Access to the Raspberry Pi 4 (4 GB) deployment with two different 1080p
      MP4s for the two-stream and descriptor check.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| **Path guard** `resolveMediaPath(mediaRoot, relPath) → Promise<string \| null>`: reject up front an empty `relPath`, one containing NUL, an absolute one (POSIX `/…`, `\…`, drive `X:` incl. drive-relative `X:foo`, UNC), and any `..` segment (split on `/` and `\`); then `fs.promises.realpath` of both `mediaRoot` and `path.resolve(mediaRoot, relPath)`; contained iff `path.relative(realRoot, real)` is non-empty, not `..`, does not start with `..` + `path.sep`, and is not absolute. Any error (ENOENT, EACCES, ENOTDIR, invalid argument) → `null`. Stateless, per request. | Constitution: "resolved and verified to lie inside `MEDIA_ROOT`". Realpath catches symlink/junction escapes; `path.relative` avoids the prefix bug (`/media` vs `/media-evil`) and is case-insensitive on win32; native `realpath` returns canonical case on Windows, so no manual case folding. Per-request realpath of the root is negligible and survives remounts. | 2026-09-26 |
| Symlinks/junctions whose target lies outside `MEDIA_ROOT` are not served (`404`); links inside the root are followed by the guard (P2 never indexes symlinks, so this is defence in depth). A second disk must be bind-mounted under `MEDIA_ROOT`, not symlinked. The guard→open gap (TOCTOU) is accepted: `MEDIA_ROOT` is written only by the household admin. | Constitution containment rule; vision: one host, one disk. | 2026-09-26 |
| Violations answer `404 {"error":"not_found"}` — never `403` — identical to unknown ids. | Constitution ("violation -> `404`"); no existence oracle. | 2026-09-26 |
| `:id` must match `^[1-9][0-9]{0,15}$` and be `Number.isSafeInteger`, else `404 not_found`; `:n` (subtitle index) must match `^(0\|[1-9][0-9]{0,2})$`, else `404 not_found`. The query string of every `/media/*` route is ignored. The player page validates `?id=` with the id pattern before any request. | Architecture: clients reference media by id only, so URL-encoded separators/`..` never reach the filesystem; ignoring the query lets P6 append cache-busters harmlessly. | 2026-09-26 |
| `/media/:id` serves only items whose row has `playable = 1`, whatever the category (movies, series, music, audiobooks, images incl. `kind: video` items under `images`); non-playable → `404 {"error":"not_playable"}`; unknown id → `404 not_found`. | Contract "streams ANY playable item"; H9 indexes videos under `images` with playability from compat; vision: offline downloads out of scope. | 2026-09-26 |
| **Range semantics** (`parseRange(header, size)` → `{ type: 'none' }` \| `{ type: 'range', start, end }` \| `{ type: 'unsatisfiable' }`, GET only), following `send`/`range-parser`: missing header or not starting with `bytes=` → `none` (200). Single spec `a-b` → end clamped to `size-1`; `a-` → to end; `-n` → last `n` bytes (`n ≥ size` → whole file as `206`). Satisfiable → `206`, `Content-Range: bytes a-b/size`, `Content-Length: b-a+1`. `a ≥ size`, `a > b`, `-0`, or any range on an empty file → `unsatisfiable` → `416`, `Content-Range: bytes */size`, body `{"error":"range_not_satisfiable"}`. Non-digit / empty specs (`bytes=abc`, `bytes=-`, `bytes=`) → `none`. More than one range-spec (comma) → `none` (200 full). Whitespace around the spec is trimmed. Digit strings beyond `Number.MAX_SAFE_INTEGER`: as start → `unsatisfiable`; as end → clamped; as suffix → whole file. | Precedent read at source (`range-parser` returns -1 → 416, -2 → full response; `send` treats multiple ranges as a regular response). RFC 9110 §14.2 allows ignoring Range; browsers' media elements never send multi-range, so `multipart/byteranges` is dead weight. | 2026-09-26 |
| `HEAD` supported with the same headers as a `200` GET (full `Content-Length`, no `Content-Range`), no body, no read stream; `Range` on `HEAD` is ignored. Implemented in `sendMedia` (P1's router runs the GET handler for HEAD). | RFC 9110 §14.2: range handling is defined for GET only. The player uses `HEAD` to tell "file missing" from "codec unsupported". | 2026-09-26 |
| **No validators:** no `ETag`, no `Last-Modified`, no `304`; any `If-Range` header → ignore `Range` and send `200` full. Headers on 200/206: `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, `Cache-Control` (default `private, no-cache`), `X-Content-Type-Options: nosniff`. `/media/:id` always uses the default, for images too (P6 originals are re-fetched when reopened; only P5's cover and P6's thumb pass a longer `cacheControl`). | Prior art AVOIDs conditional-GET machinery; with no validators issued an `If-Range` never matches (RFC 9110 §13.1.5; `send` behaves the same). `private` because content is behind auth; `no-cache` because a file replaced in place keeps its id (P2 upserts by `rel_path`), so immutable caching of `/media/:id` would serve stale bytes; LAN bandwidth is cheap and the lightbox preloads only neighbours. | 2026-09-26 |
| **Media types** — `mediaTypeFor(ext)` in `src/http/media-types.js` lower-cases `ext` and returns `EXTENSIONS[ext].mime` from P2's `compat.js`, else `application/octet-stream`; it holds no table of its own. Every MIME type (incl. `image/bmp`, `jfif → image/jpeg`) is P2's; SVG is never served (non-playable → `404`). A test asserts every `ext` with `isPlayableExtension(ext) === true` gets a non-fallback type. | Cross-phase consolidation D9 (single owner = P2 `compat.js`); the test prevents drift between "playable" and "servable". | 2026-09-26 |
| **`sendMedia(req, res, { path, contentType?, cacheControl = 'private, no-cache', idleTimeoutMs = MEDIA_IDLE_TIMEOUT_MS, slice?, openFile? })` → `Promise<{ status: number, aborted: boolean, error: Error \| null }>`** in `src/http/stream.js`. `path` is an already-guarded absolute path. `contentType` defaults to `mediaTypeFor(extname(path))`. `slice = { offset, length }` makes the served entity bytes `[offset, offset+length)` of the file (all range maths relative to the slice; `offset+length > file size` → `404`) — used by P6's thumb route (`/media/:id/thumb`); P5's embedded covers may use it as well (P5 owns that choice). `openFile(path)` (default `fs.promises.open(path, 'r')`) is a test seam. The promise settles when the response has finished or closed. | Cross-phase consolidation D10 (signature, Content-Type inside `sendMedia`, `cacheControl` for P5/P6); `slice` lets P6 serve the EXIF thumbnail window of an original, and any byte window "via the same range logic" (D10), without a second streaming implementation; the returned status/error lets routes log without `sendMedia` needing a logger. | 2026-09-26 |
| **Streaming mechanics:** `handle = await openFile(path)` → `handle.stat()` (not a regular file → `404`) → decide status → for a body `fs.createReadStream(path, { fd: handle, start, end })` (default 64 KiB `highWaterMark`, `autoClose` on) piped with `stream.pipeline` into the response. On every path that creates no read stream (HEAD, 416, 404 after open, errors) the handle is closed explicitly before settling. Open/stat failures before headers → `404 not_found`; read errors after headers → destroy the response. `ERR_STREAM_PREMATURE_CLOSE` (client abort) settles with `aborted: true, error: null`. | Constitution wording verbatim (D10); opening before `writeHead` makes "file vanished" a clean `404` and keeps size and stream consistent; `pipeline` gives backpressure and destroys the stream (closing the handle) on client disconnect — the Pi-memory requirement. | 2026-09-26 |
| **Idle timeout:** `MEDIA_IDLE_TIMEOUT_MS = 60_000` (module constant). A timer (`unref()`ed) is armed when the body starts and re-armed on every chunk the read stream emits; when it fires the response is destroyed (settles `aborted: true`). It is cleared on `close` of the response; socket timeouts are never touched (they belong to P1's keep-alive handling). | A paused browser stops reading, so the stream stops emitting chunks and would otherwise pin a descriptor indefinitely (sleeping devices never close). Precedent: nginx `send_timeout` defaults to 60 s "between two successive write operations" (prior art "HTTP range streaming"), and browsers resume with a fresh range request. An own timer avoids clobbering the keep-alive socket timeout Node sets after each response. | 2026-09-26 |
| Error bodies on `/media/*` are JSON `{"error": "<code>"}` via P1 `sendError`: `not_found`, `not_playable`, `range_not_satisfiable`; `401 unauthorized` from `requireUser`. `/media/*` is not a page route: unauthenticated requests get `401`, never a redirect. The media route logs via `deps.log`: `media_stream_error { id, code }` when `sendMedia` settles with an `error` whose code is not `ENOENT`/`ENOTDIR`/`EISDIR`; no log for 404s or aborts. | Constitution error format; D4 logging via the injected `log`; a redirect to an HTML login page is useless as a media source; expected misses must not flood the Pi's SD card. | 2026-09-26 |
| **Item detail JSON:** only the single-item response `GET /api/library/items/:id` (P2's route) is extended — through `toItemDetailJson({ db, mediaRoot }, row)` in `src/api/item-detail.js` = `{ ...toItemJson(row), next, subtitles }`. `next` = `{ id, title, season, episode, episodeEnd }` of `getNextEpisode(db, row)` or `null`; `subtitles` = `[{ index, lang, label }]` from `listSubtitles(mediaRoot, row)` (`[]` for non-video items or on any error). List responses are unchanged. `ext` is already part of P2's item JSON. | D10 ("`next` only in the single-item response") and H4; global rule: missing interface data is added in the backend, never reconstructed in the frontend; one fetch serves title, next-episode label and tracks; a single-line edit keeps P2's file conflict-free. | 2026-09-26 |
| **Next episode** — `getNextEpisode(db, row) → LibraryItemRow \| null` in `src/db/episodes.js` (one prepared statement, row-value comparison): if `row.series_id`, `row.season` or `row.episode` is `NULL` → `null`. The chain is P2's series-detail order restricted to numbered episodes: candidates are rows with the same `series_id`, non-NULL `season` and `episode`, and in the same group as `row` — regular seasons (`season ≥ 1`) form one chain, specials (`season = 0`) their own chain; within a group rows are ordered by P2's detail keys `(season, episode, coalesce(episode_end, -1), sort_title, id)` (`-1` reproduces SQLite's NULLs-first for `episode_end`), and `next` is the first candidate whose key tuple is strictly greater than `row`'s. So `next` is the next numbered row of the same group as displayed on the series page: last episode of S01 → first of S02; the last regular episode → `null` (never into Specials); S00E01 → S00E02; the last special → `null`; unnumbered rows ("Weitere Folgen", NULL episode) are never `next` and have none. Non-playable successors are not skipped. Movies and other categories: `null`. No auto-advance; on `ended` the "Nächste Folge" button receives focus. P4 uses the same function for its next-up entries (D11/H6) — there is no second ordering rule. | Aligns with P2's display order (review: the earlier `rel_path`/Specials-first order contradicted the series page), so the button names the row the user sees below the current one. Specials are optional extras (making-ofs); chaining the finale into them would park a permanent next-up card on the home page (H5: next-up cards have no "×"), hence separate chains — the only deliberate difference from the page, and it removes links rather than reordering. Double episodes follow P2's keys (an `S01E01-E02` file continues with `E03` unless a separate `E02` file exists, which then comes first as on the page). Not skipping keeps a missing episode visible (the target page shows "Nicht abspielbar" and its own "Nächste Folge"). Browsers block audible autoplay on a fresh page load (Firefox by default), so auto-advance would be unreliable. | 2026-09-26 |
| **Subtitle sidecars** — `listSubtitles(mediaRoot, row) → Promise<Array<{ index, lang, label, path }>>` in `src/media/subtitles.js`, `row` = a `library_items` row (uses `kind` and `rel_path`): `row.kind !== 'video'` → `[]`; resolve the item via `resolveMediaPath(mediaRoot, row.rel_path)` (null → `[]`), `readdir` its directory `withFileTypes` (error → `[]`); candidates are regular files (`isFile()`, so symlinks are skipped) whose NFC name ends in `.vtt` (case-insensitive) and whose stem equals the video's basename (name without its last extension) or is `<basename>.<middle>` — compared case-insensitively after NFC, `middle` non-empty and ≤ 64 characters. `lang` = `middle.toLowerCase()` when `middle` matches `^[a-z]{2,3}$` (i), else `null`; `label` = `middle` as written, or `null` for the bare `<basename>.vtt` (Jellyfin flag suffixes such as `.de.forced` are not interpreted: `lang` null, label `de.forced`). Sorted by NFC file name (code-unit order); `index` = position in that order (0-based); each `path` has passed `resolveMediaPath` (dir-relative `rel_path` + name). The module also exports `SUBTITLE_CONTENT_TYPE = 'text/vtt; charset=utf-8'`. Discovery runs per request; nothing is indexed or cached. The server emits no German text. | Human decision at spec-acceptance gate (H4 = B): `.vtt` sidecars only, not in compat `EXTENSIONS`, discovered on request; Jellyfin's `<name>.<lang>.<ext>` precedent (prior art "Subtitle sidecars"); taking the row keeps the kind rule and the content type out of `src/api/` (architecture: `src/api/` knows nothing about file formats — review); per-request discovery is always fresh without touching P2's scanner; code-unit order is deterministic across OSes. An index can shift if a sidecar is added between the item fetch and the track request — accepted (reload fixes it). | 2026-09-26 |
| **Subtitle route** `GET /media/:id/subtitles/:n` (in `src/api/media.js`, `requireUser`): id/`n` patterns as above; item unknown → `404 not_found`; `n ≥ listSubtitles(config.mediaRoot, row).length` (always the case for non-video items) → `404 not_found`; else `sendMedia` with `contentType: SUBTITLE_CONTENT_TYPE` (imported from `src/media/subtitles.js`) and the default `cacheControl` (`private, no-cache`). The item need not be playable. No `.srt` conversion; files are served byte-for-byte (WebVTT mandates UTF-8). | H4: path guard, auth, whole-segment route, `private, no-cache`; the CSP's `media-src 'self'` covers `<track>` loads; the route carries no format knowledge (review). | 2026-09-26 |
| **Player tracks:** for each `subtitles` entry the page appends `<track kind="subtitles" src="/media/<id>/subtitles/<index>" srclang="<lang or und>" label="<label>">` before setting `src`; no `default` attribute (none on by default); the browser's native track menu is the only UI. Label (in `player-format.js`): `lang` → `new Intl.DisplayNames(['de'], { type: 'language' }).of(lang)` (on a throw or an unchanged code: the code upper-cased), else `label`, else "Untertitel"; repeated labels get " (2)", " (3)", … | H4: `<track kind="subtitles" srclang label>` per entry, none default-on, native menu; German label text belongs to the frontend (server stays language-neutral like P2's code fallback). | 2026-09-26 |
| "Nächste Folge" navigates with `location.replace('/player?id=<next.id>')`. "Zurück" and "Zurück zur Übersicht": `history.back()` only if `document.referrer` is same-origin (its `URL.origin` equals `location.origin`), its `pathname` is not `/login`, **and** `history.length > 1`; else `location.assign('/')`. The decision is the pure `backTarget({ referrer, origin, historyLength }) → 'back' \| 'home'` in `public/js/lib/player-format.js` (an empty or unparsable referrer → `'home'`). | D10; `replace` keeps the browse page as the history predecessor so "Zurück" never walks back through episodes; P1's `Referrer-Policy: same-origin` keeps the referrer; direct/bookmarked opens in a fresh tab still have a way out. Excluding `/login` (review): a bookmarked player opened while logged out arrives via `/login?next=…`, and going back there would 302 straight back to the player — a loop; this stays within D10's intent (back only to a real previous page). | 2026-09-26 |
| Player URL is `/player?id=<id>` served from `public/player.html` by P1's page rule (session-gated: `302 /login?next=%2Fplayer%3Fid%3D<id>`); data only via authenticated APIs. A `401` from the item API goes through `request`'s default `redirectOn401` (`toLogin()`); a `401` from the `HEAD` probe calls `toLogin()`. | Cross-phase consolidation D1 (P1 page rule; direct `*.html` → 404). | 2026-09-26 |
| Page handles categories `movies` and `series` only (the `CATEGORIES` ids, D3); any other category — incl. videos under `images` (H9, played inline in P6's lightbox) — renders "Titel nicht gefunden". Autoplay: `video.play()` after setting `src`; a rejected promise is ignored (the user presses play). Title: movies → overline "Film", heading = title; episodes → overline = `seriesTitle`, heading = `<code> · <display title>` when `code = episodeCode({ season, episode, episodeEnd })` (P2's `public/js/lib/library-format.js`, imported, not copied) is non-null, else the display title; display title = "Folge <episode>" — or "Folgen <episode>–<episodeEnd>" (en dash) for a double episode — when the title equals `code` case-insensitively (P2's code fallback), else the title. Examples: `S01E02 · Geheimnisse`, `S01E01-E02 · Folgen 1–2`, `E06 · Folge 6`. The same format builds the "Nächste Folge: <code> · <display title>" label from `next`. `document.title` = heading + " – Videothek". All text via `textContent`. | D10/H9: player movies/series only; reusing P2's `episodeCode` and its "Folge N" / "Folgen a–b" rule keeps the player identical to P2's episode rows (review: double-episode fallback). | 2026-09-26 |
| **Playback error handling:** the page records the last known position on every `timeupdate` (`lastTime = video.currentTime`, initially 0). On the `<video>` `error` event (`MediaError.code` 1 = aborted is ignored) the page detaches the element (`video.remove()`) and sends `fetch('/media/<id>', { method: 'HEAD', cache: 'no-store' })`: `401` → `toLogin()`; `404` → "Datei nicht gefunden"; `2xx` → code 2 → "Verbindung unterbrochen", any other code → "Wiedergabe nicht möglich"; network failure or any other status → "Verbindung unterbrochen". "Erneut versuchen" in the three playback states calls `retry(lastTime)` of the stage from `public/js/lib/player-stage.js`: it re-attaches **the same** `<video>` element (with its `<track>` children) to the stage, calls `video.load()` (the `src` attribute is left unchanged, never re-set), on the next `loadedmetadata` (once) sets `currentTime = lastTime` when `lastTime > 0`, then calls `video.play()` (rejection ignored). In "Titel konnte nicht geladen werden" it calls `location.reload()`. | A `404` on a media source surfaces as `MEDIA_ERR_SRC_NOT_SUPPORTED`, indistinguishable from a codec problem without asking the server. Keeping the one element keeps P4's `trackPlayback` bound and the subtitle tracks attached (`startPlayback` is never re-run); `load()` is the explicit form of the load algorithm and emits `emptied`, which P4's tracker uses to disarm until the next `playing` (D11). `lastTime` survives the error even when the element resets `currentTime`. | 2026-09-26 |
| **P4 seam in `public/js/player.js`:** the item is loaded by `loadItem(id)`; on the playable path the page creates its single `<video>` element (see Design) and playback is started by exactly one call of `startPlayback(video, item)` (append tracks, set `src`, `play()`), made once after the item has loaded and never again (retry does not call it and reuses the same element). P4 edits only this file: it fetches the progress entry in parallel with `loadItem`, delays `startPlayback` until both settle and calls `trackPlayback(video, item.id, { entry, onResume })` right after it. | D11 (P4 hooks into P3's player, `trackPlayback` performs the seek); a named single entry point and one element per page load keep P4's edit small and its listeners valid across retries (review BLOCKING). | 2026-09-26 |
| **Keyboard** (`public/js/lib/player-keys.js`, pure `keyAction({ key, ctrlKey, altKey, metaKey, tagName, isContentEditable })` → `'toggle' \| 'back' \| 'forward' \| 'fullscreen' \| 'mute' \| null`): `' '` and `k`/`K` toggle, `ArrowLeft`/`ArrowRight` ∓/± 10 s (clamped to `[0, duration]`), `f`/`F` fullscreen toggle of the `<video>` element (`requestFullscreen` / `document.exitFullscreen`), `m`/`M` mute toggle. `null` when Ctrl/Alt/Meta is held, `tagName` is `VIDEO`, `BUTTON`, `A`, `INPUT`, `SELECT` or `TEXTAREA`, or `isContentEditable`. The page's single `keydown` listener on `document` acts only while the page's video element is connected (`video.isConnected` — false before playback starts and while an error state has detached it) and calls `preventDefault()` for handled keys. Escape is not bound. | Skipping the focused `<video>` avoids double handling with the browsers' own native-control shortcuts; skipping buttons keeps Enter/Space/arrow focus navigation working for TV remotes; fullscreen on the video keeps native controls and subtitles; Escape stays the native fullscreen exit. The descriptor (not a DOM event) keeps the module testable under `node:test`. | 2026-09-26 |
| Focus: in any error state the primary action receives focus on render; in the playing state no focus is forced; on `ended` "Nächste Folge" (if present) is focused. Loading text and error panels live in a container with `aria-live="polite"`; the `<video>` gets `aria-label` = heading. | design.md: full keyboard/remote navigation, WCAG 2.1 AA. | 2026-09-26 |
| Item-less states (loading, "Titel nicht gefunden", "Titel konnte nicht geladen werden"): the title block is `hidden`, the error panel's heading is the page's `<h1>`, `document.title` = panel heading + " – Videothek" (loading keeps the static `<title>Videothek</title>`); with an item the title-block heading is the `<h1>` and the panel heading an `<h2>`. | Review: the title block had no defined content without an item; one `<h1>` per page and a meaningful tab title without inventing an empty overline. | 2026-09-26 |
| Literal sizes in the layout rules are design-scale names; CSS uses only tokens: 48 px icon → `--space-12`, text 12/14/20/24 px → `--text-xs`/`--text-sm`/`--text-lg`/`--text-xl`, 1 px → `--border-width`, 2 px focus → `--focus-width`/`--focus-offset`, 44 px → `--tap-min`; the 480 px panel cap is `calc(var(--space-16) * 7.5)`. | D5 (literal lengths outside `tokens.css` only for breakpoints, `%`, `vh/dvh`, `fr`, `0`) and P1's machine-checked px rule (review). | 2026-09-26 |
| Frontend split to respect ≤ 300 lines/file: `public/js/player.js` (entry: id validation, `loadItem`, video creation, `startPlayback`, error probe, navigation, key listener), `public/js/player-panel.js` (loading/error panel DOM per state), `public/js/player-icons.js` (chevron, skip, film-off, ban icons built with P1's `createIcon(paths)`), pure `public/js/lib/player-format.js` (`headingFor`, `overlineFor`, `episodeTitleFor`, `nextLabel`, `subtitleLabels`, `errorStateFor({ headStatus, mediaErrorCode })`, `backTarget`; imports `episodeCode` from P2's `library-format.js`), `public/js/lib/player-keys.js`, and `public/js/lib/player-stage.js` (`createStage(host, video)` → `{ detach(), retry(position) }`, DOM-duck-typed: uses only `host.append`, `video.remove`, `video.load`, `video.play`, `video.addEventListener`, `video.currentTime`, so it runs under `node:test` with fakes). DOM is built with P1's `el` from `dom.js`; P1's `api.js`, `dom.js` and `icons.js` are imported and never edited; no P1 `icon(name)` entry is needed. | Keeps the page testable (pure helpers and the retry contract under `node:test`) and every file owned by one issue; the stage module machine-checks the single-element retry that P4 depends on. | 2026-09-26 |
| Tests generate their own temp media trees and byte-pattern files inline (no committed fixtures, no shared helper in this phase); symlink cases use `fs.symlink(target, link, 'junction')` for directories (no admin rights on Windows, plain symlink on Linux) and `t.skip` file-symlink cases on `EPERM`. | Range assertions need known bytes; fixtures must never be real media; the dev machine is Windows, the target Linux; no shared helper means no cross-issue file conflicts. | 2026-09-26 |
| Browse-to-player links are not P3 work: P2's playable movie cards and episode rows are `<a href="/player?id=<id>">`, P4's continue cards link the same URL. | Resolves review BLOCKING 1: P2's spec already owns the links on the D1 URL. | 2026-09-26 |
| Human decision at spec-acceptance gate (H4 = B): `.vtt` sidecars only, now, in P3 — discovered on request, exposed as `subtitles` in the single-item JSON and streamed by `GET /media/:id/subtitles/:n`; no `.srt` conversion. | Recorded gate decision; supersedes the review's recommendation A. | 2026-09-26 |
| Cross-phase consolidation (D9): P3 owns no extension or MIME table — `mediaTypeFor` reads P2's `compat.js`; `bmp`/`jfif` and every other image row are P2's. | Single owner avoids drift between P2, P3 and P6. | 2026-09-26 |
| Cross-phase consolidation (D10): `fs.createReadStream(realPath, { fd: handle, start, end })`; `sendMedia` signature with `cacheControl`; routes `/media/:id` (P3), `/media/:id/thumb` (P6), `/media/:id/cover` (P5); `next` only in the single-item response and `getNextEpisode` exported for P4; "Zurück" rule with `history.length > 1`. | Binding cross-phase decision. | 2026-09-26 |
| Cross-phase consolidation (H9): `/media/:id` streams playable videos under category `images` like any other playable item; the player page stays movies/series-only. | Binding cross-phase decision. | 2026-09-26 |
| Milestone QA runs the two-stream check on the Pi 4 (mandatory, QA-only prerequisite); the dev-machine descriptor check (Windows: `Get-Process -Id <pid>` `HandleCount`; Linux: `/proc/<pid>/fd`) is run in addition, not as a substitute. | Vision "Weak hardware" is a Pi criterion; matches P2's mandatory Pi QA line (D8); the dev check catches handle leaks on the platform the tests run on. | 2026-09-26 |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (per PR and at milestone end):

- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no packages; P1's
      constitution/frontend rule tests pass (no `console.*`, no `innerHTML`, no
      raw hex, no file > 300 lines).
- [ ] `test/http/range.test.js` covers every row of the range decision: `0-99`,
      `a-`, `-500`, suffix > size, end > size, `a = size`, `a > b`, `-0`, empty
      file, missing header, `bytes=abc`, `bytes=-`, `bytes=`, `items=0-1`,
      multi-range, whitespace, oversized digit strings (start, end, suffix).
- [ ] `test/http/media-types.test.js`: `mediaTypeFor('mp4')` = `video/mp4`,
      upper-case input works, unknown → `application/octet-stream`, and every
      `ext` with `isPlayableExtension(ext) === true` gets a non-fallback type.
- [ ] `test/http/stream.test.js` (real `node:http` server on port 0, generated
      byte-pattern file): bodies byte-exact for 200/206; headers as decided
      (incl. `cacheControl` override and explicit `contentType`); `416` carries
      `Content-Range: bytes */size`; `HEAD` (with and without `Range`) has full
      `Content-Length` and no body; `If-Range` → 200; `slice` serves exactly
      the window and ranges within it, a slice past EOF → 404; missing file and
      directory → 404 JSON; the injected handle is closed for 200, 206, 416,
      HEAD and directory-404; client abort after the first chunk settles with
      `aborted: true` and the handle is closed within 1 s; a paused client with
      an injected short `idleTimeoutMs` is disconnected and its handle closed;
      two concurrent full downloads of a 32 MiB pattern file both complete
      byte-exact (hash compare).
- [ ] `test/media/paths.test.js`: inside path resolves; `..`, nested `..`,
      absolute POSIX/Windows/UNC and drive-relative paths, NUL, empty path,
      missing file → `null`; junction to an outside directory → `null`; junction
      to an inside directory → resolves; sibling-prefix directory (`media` vs
      `media-evil`) → `null`; `MEDIA_ROOT` itself behind a junction works; on
      win32 a differently-cased root still resolves.
- [ ] `test/media/subtitles.test.js`: `<base>.vtt`, `<base>.de.vtt`,
      `<base>.Deutsch.vtt`, `<BASE>.EN.VTT` found with the decided `lang`/`label`
      and order; another video's `.vtt`, `.srt`, a directory named `<base>.vtt`,
      a `middle` > 64 chars and a symlinked `.vtt` (skip on `EPERM`) ignored;
      `<base>.de.forced.vtt` → `lang` null, label `de.forced`; a row with
      `kind` `audio`/`image`, a missing directory or an item outside the root
      → `[]`; `SUBTITLE_CONTENT_TYPE` = `text/vtt; charset=utf-8`.
- [ ] `test/db/episodes.test.js` (migrated temp DB): next across episodes and
      seasons (last of S01 → first of S02), last regular episode → `null` even
      when specials exist, S00E01 → S00E02, last special → `null`, double
      episode `E01-E02` → `E03`, `E01-E02` with a separate `E02` file → that
      `E02` (P2 order: `episode_end` NULL first), two files of one episode
      ordered by `sort_title` then `id`, an unnumbered row (NULL episode) is
      never `next` and gets `null`, NULL season → `null`, movie → `null`,
      non-playable successor returned.
- [ ] `test/api/item-detail.test.js`: `next` shape and `null` cases; `subtitles`
      list for a video with sidecars, `[]` for audio/image items; through
      `startTestApp`, `GET /api/library/items/:id` carries `next` and
      `subtitles` while `GET /api/library/movies` items do not.
- [ ] `test/api/media.test.js` (through `startTestApp`): no session → 401 JSON
      and no file bytes for `/media/:id` and `/media/:id/subtitles/0`; `abc`,
      `0`, `01`, 17-digit ids → 404; unknown id → 404; non-playable → 404
      `not_playable`; indexed item whose file was deleted → 404; happy
      200/206/416/HEAD through the route; `Content-Type` from compat; a playable
      `images` video streams; subtitle route: 200 `text/vtt; charset=utf-8`,
      `n` out of range / `01` / non-video item → 404; `POST /media/1` → 405.
- [ ] `test/public/player-keys.test.js`: each key maps as decided incl. upper
      case; modifiers, `VIDEO`/`BUTTON`/`A`/`INPUT`/`SELECT`/`TEXTAREA`
      targets and content-editable → `null`.
- [ ] `test/public/player-format.test.js`: heading/overline for movie, episode,
      episode without numbers, code-fallback title → "Folge N", double
      episode (`S01E01-E02 · Folgen 1–2` when the title is the code, else
      `S01E01-E02 · <title>`), season unknown (`E06 · Folge 6`); next label;
      `backTarget`: same-origin referrer + length 2 → `back`, length 1 →
      `home`, cross-origin → `home`, empty/unparsable referrer → `home`,
      same-origin `/login?next=…` referrer → `home`; subtitle labels (`de` → "Deutsch", free label, none →
      "Untertitel", duplicates numbered); `errorStateFor` for 404, 2xx × codes
      2/3/4, network failure, 500.
- [ ] `test/public/player-stage.test.js` (fake host/video objects with
      `EventTarget`): `detach()` removes the video; `retry(42)` re-appends the
      **same** video object, calls `load()` once and never assigns `src`,
      sets `currentTime = 42` on the first `loadedmetadata` only, then calls
      `play()`; `retry(0)` does not seek; a rejected `play()` is swallowed.

Human QA (milestone gate; `npm start` against the QA `MEDIA_ROOT`, Chromium and
Firefox, desktop and a 390 px phone viewport):

- [ ] Movie MP4 plays; seeking to 90 % starts within a few seconds (DevTools
      network shows `206` responses, not a full download).
- [ ] The movie with `<basename>.de.vtt` shows "Deutsch" in the native subtitle
      menu, off by default; switching it on shows the cues.
- [ ] Episode page shows the series overline, `S01E02 · Titel`, and "Nächste
      Folge"; clicking it opens E03; "Zurück" then returns to the series page,
      not to E02. On `ended`, the button has focus and Enter opens the next
      episode.
- [ ] MKV item (P2 renders unplayable cards/rows as non-links: open
      `/player?id=<id>` with the id from the card's `data-item-id` in DevTools
      or from `GET /api/library/movies`) → "Nicht abspielbar" panel naming
      `MKV`; no network request to `/media/`.
- [ ] Retry keeps the element: play the `.de.vtt` movie with subtitles on,
      stop the server for ~10 s and seek → "Verbindung unterbrochen"; start the
      server, "Erneut versuchen" → playback resumes near the previous position
      and the subtitle menu still lists "Deutsch" (DevTools: the same
      `<video>` node, no second one created).
- [ ] Delete/rename a playing file's source, then seek → "Datei nicht gefunden";
      HEVC-in-MP4 (if provided) → "Wiedergabe nicht möglich".
- [ ] Pause a playing video for > 90 s, then resume: playback continues in both
      Chromium and Firefox (a new `206` request appears; no error panel).
- [ ] `/player?id=999999` → "Titel nicht gefunden"; `/player.html?id=1` → 404;
      after logging out, `/player?id=1` redirects to `/login?next=…` and
      `curl -i http://<host>:<port>/media/<id>` → `401`, while
      `curl -i -b "vt_session=<cookie>" -H "Range: bytes=0-99" …/media/<id>` →
      `206`.
- [ ] Keyboard: Space, K, ←/→, F, M work with focus on the page; Tab reaches
      "Zurück", the video controls and "Nächste Folge" with a visible primary
      (orange) focus ring; Space on a focused button activates the button, not
      playback.
- [ ] Screens match the committed mockups under the layout rules above (tokens
      only, German copy, targets ≥ 44 px, error actions stacked on the phone).
- [ ] Pi 4: idle RSS < 100 MB; two different 1080p MP4s play simultaneously in
      two browsers for 5 min with seeks, without stutter; after closing both,
      open descriptors (`ls /proc/<pid>/fd | wc -l`) return to the pre-test
      baseline within 60 s and RSS returns near idle.
- [ ] Dev machine: two concurrent `curl -b "vt_session=<cookie>" --limit-rate 3M -o NUL …/media/<id>`
      downloads of a large file, one aborted mid-way; afterwards the process
      handle count (Windows PowerShell: `(Get-Process -Id <pid>).HandleCount`;
      Linux: `ls /proc/<pid>/fd | wc -l`) returns to the baseline within 60 s.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| File handle / memory leak from aborted or paused clients on the Pi | `pipeline` + `autoClose` on the handle-backed stream, explicit close on every non-stream path, 60 s idle timer, tests asserting handle closure per status, descriptor-count QA on Pi and dev machine. |
| Symlink tests cannot run on Windows without privileges | Directory junctions need no rights and map to symlinks on Linux; file-symlink cases skip on `EPERM`. |
| Extension says "playable" but codec is not (HEVC in MP4 whose sniff failed) | Runtime "Codec" state via `HEAD` disambiguation; compat table and sniffer stay P2's concern. |
| Double handling of keys between page shortcuts and native controls | Page handler ignores events targeted at the `<video>`; handled keys `preventDefault()`. |
| Chrome/Firefox surface the idle-timeout disconnect as an error instead of re-requesting | Precedent: nginx closes idle sends after 60 s by default and browsers recover with a new range request; QA pauses > 90 s and resumes in both browsers; if one fails, "Erneut versuchen" seeks back. |
| A file is replaced in place (same `rel_path`, same id) while cached | `Cache-Control: private, no-cache` on `/media/:id`; ids themselves are never reused (P2 `AUTOINCREMENT`). |
| Subtitle index shifts when sidecars change between item fetch and track load | Accepted edge case; a page reload re-lists; routes 404 cleanly when out of range. |
| A retry that recreates the `<video>` would detach P4's tracker and drop the subtitle tracks | One element per page load; retry via `player-stage.js` (`load()` on the same node), machine-tested with fakes and checked in QA. |
| Non-UTF-8 `.vtt` files show garbled text | WebVTT mandates UTF-8; files are served byte-for-byte with `charset=utf-8`; no conversion (out of scope). |
| Parallel phases edit `src/http/routes.js`, `src/api/library.js`, `docs/architecture.md`, `public/js/player.js` | One line / one section each; P4's player edit is confined to the `loadItem`/`startPlayback` seam. |

## Decision log

- 2026-09-26: Range semantics hardened against `jshttp/range-parser` and
  `pillarjs/send` source (read-only): unsatisfiable (`start > end` after
  clamping, incl. `-0` and empty files) → `416` with `bytes */size`; malformed →
  ignore; multiple ranges → regular `200`; `If-Range` without our validators →
  full response. We deviate in one point: `send` coalesces overlapping multi-ranges
  into one `206`; we ignore every multi-range header (browsers never send one).
- 2026-09-26: Idle timeout set to 60 s after nginx's `send_timeout` default
  (https://nginx.org/en/docs/http/ngx_http_core_module.html#send_timeout).
- 2026-09-26: Next-episode affordance put in scope as a button only (no
  auto-advance, no countdown); data comes from a server-side `next` field.
- 2026-09-26: Player page omits the category nav (design.md Player component:
  title + back action above the stage).
- 2026-09-26: Design produced in Stitch; mobile exports cropped to the 390 px
  content column (Stitch rendered them on a desktop canvas), desktop exports
  downscaled to 1280 × 1024; re-exported with primary `#ff7a1a`.
- 2026-09-26: cross-phase consolidation — player URL `/player?id=<id>` via P1's
  page rule (D1); category ids plural from `CATEGORIES` (D3); P1 server and
  frontend contracts used verbatim (D4, D5).
- 2026-09-26: cross-phase consolidation — `mediaTypeFor` is a thin lookup over
  P2's `compat.js`; P3's own MIME table and its `bmp`/`jfif` question are gone
  (D9).
- 2026-09-26: cross-phase consolidation — streaming uses
  `fs.createReadStream(realPath, { fd: handle, start, end })` (resolves review
  BLOCKING 2), `sendMedia` takes `contentType?`/`cacheControl` and derives the
  type itself, `next` lives only in the single-item response, the next-episode
  repository function is `getNextEpisode` in P3's own `src/db/episodes.js`
  (exported for P4 instead of living in P2's repository module), and "Zurück"
  requires a same-origin referrer and `history.length > 1` (D10).
- 2026-09-26: cross-phase consolidation — P4 integrates through the
  `loadItem`/`startPlayback` seam and `trackPlayback` performs the resume seek
  (D11); `docs/architecture.md` edits listed in scope and made by the
  media-route issue (D13); `/media/:id` serves playable `images` videos while
  the player stays movies/series-only (H9).
- 2026-09-26: gate decision — H4: `.vtt` sidecars only, now, in P3
  (`subtitles` in the single-item JSON, `GET /media/:id/subtitles/:n`,
  `<track>` per entry, none default-on). Supersedes the review's
  recommendation A; OPEN-1 removed.
- 2026-09-26: review resolutions — browse links owned by P2 (BLOCKING 1);
  media-types test, handle-close assertions for 416/HEAD/dir-404, idle-timeout
  QA (> 90 s pause, both browsers), Windows `HandleCount` and cookie `curl`
  QA steps added; `/media/:id` keeps `no-cache` for images; P1/P2 assumptions
  replaced by the exact contracts in Constraints.
- 2026-09-26: pre-mortem — added `sendMedia` `slice` option (P5 embedded
  covers), returned `{ status, aborted, error }` so routes log via
  `deps.log`; idle timer re-armed per read chunk instead of socket timeouts
  (Node reuses the socket timeout for keep-alive); fullscreen targets the
  `<video>`; overline rendered as written (no upper-casing); error actions
  ordered primary-first and stacked on phones; `document` key listener only
  while a video exists; `HEAD` statuses other than 2xx/401/404 map to
  "Verbindung unterbrochen"; "Erneut versuchen" in the load-failed state
  reloads the page; double episodes continue after `episode_end`; frontend
  split into page-private modules; Pi QA mandatory with the dev-machine check
  in addition.
- 2026-09-26: acceptance-review resolutions — the page creates exactly one
  `<video>` per page load and keeps it; error states detach it, "Erneut
  versuchen" re-attaches the same element (tracks intact), calls `load()`,
  seeks back on `loadedmetadata` and plays; the key listener acts only while
  `video.isConnected`; the retry contract lives in the new, machine-tested
  `public/js/lib/player-stage.js` (resolves BLOCKING; matches P4's player-hook
  assumption).
- 2026-09-26: acceptance-review resolutions — next-episode order aligned with
  P2's series-detail order (`season, episode, episode_end NULLs first,
  sort_title, id`); regular seasons and specials form separate chains, so a
  finale never leads into Specials and Specials no longer come first. P2
  needs no change (display order unaffected); P4 inherits it through
  `getNextEpisode` (H6 "P3's `next` ordering" still holds).
- 2026-09-26: acceptance-review resolutions — `slice` rationale names P6's
  thumb route (P5 currently builds its own `src/http/slice.js`; reusing
  `sendMedia({ slice })` is available and flagged to P5, whose spec owns that
  choice); `listSubtitles` takes the row and `SUBTITLE_CONTENT_TYPE` is
  exported from `src/media/subtitles.js`, so `src/api/media.js` holds no
  format knowledge; prior-art entries for nginx `send_timeout` and Jellyfin
  external subtitles added to `docs/prior-art.md` (sources:
  https://nginx.org/en/docs/http/ngx_http_core_module.html#send_timeout ,
  https://jellyfin.org/docs/general/server/media/movies/ section "External
  Subtitles and Audio Tracks", both read 2026-09-26).
- 2026-09-26: acceptance-review resolutions — "Zurück" also requires the
  referrer's pathname ≠ `/login` (avoids the login → player loop; within
  D10's intent); episode headings reuse P2's `episodeCode` and show
  "Folgen a–b" for a double-episode code fallback; literal sizes mapped to
  tokens once in Design; item-less states hide the title block and make the
  panel heading the `<h1>`/`document.title`; the MKV QA line says how to
  reach a non-linked item; retry QA line added.
- 2026-09-26: implementation (#39, `src/http/range.js`) — oversized digit
  strings (start/end/suffix beyond `Number.MAX_SAFE_INTEGER`) are detected via
  `BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER)` rather than `Number()`
  parsing, which would silently round instead of flagging the value; the
  regex `^(\d*)-(\d*)$` on the trimmed single spec doubles as the syntax
  check (both groups empty, e.g. `bytes=-` or `bytes=`, falls through to
  `none` alongside non-digit specs like `bytes=abc`), so no separate
  digits-only validation was needed.
- 2026-09-26: implementation (#44, `src/db/episodes.js`) — `getNextEpisode`
  is one prepared statement using a SQLite row-value comparison
  (`(season, episode, coalesce(episode_end, -1), sort_title, id) > (?, ?, ?,
  ?, ?)`) against `row`'s own tuple, so ordering and "strictly greater" are
  both expressed by SQLite itself rather than re-implemented in JS; the
  regular/specials chain split is a single `CASE WHEN ? = 1 THEN season = 0
  ELSE season >= 1 END` guard driven by one bound `isSpecial` flag computed
  from `row.season === 0`, rather than two branches with separate SQL text.
