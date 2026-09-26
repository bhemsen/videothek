# Spec: Video streaming & player

> Created: 2026-09-26

Phase 3 makes every playable library item streamable over an authenticated,
range-capable `GET /media/:id` endpoint guarded against path escapes, and ships
the video player page (`/player.html?id=<id>`) with not-playable / error states
and a next-episode affordance for series. This spec carries no lifecycle state —
acceptance is the spec merged on the default branch with a milestone and issues,
and all progress lives in the GitHub issues and milestone. A completed spec is
moved to `docs/specs/archive/`.

## Outcome

- [ ] A logged-in user opens a playable movie or episode from the browse UI and it
      plays in Chromium and Firefox with native controls; seeking anywhere in the
      file works without the whole file being downloaded first.
- [ ] `GET /media/:id` answers `Range` requests with `206` + correct
      `Content-Range`, unsatisfiable ranges with `416` + `Content-Range: bytes */<size>`,
      no/ignored ranges with `200`; `HEAD` returns the same headers without a body.
- [ ] `/media/:id` streams any playable item of any category (video, audio,
      image) with the correct `Content-Type` — P5 and P6 reuse it unchanged.
- [ ] No request can read a file outside `MEDIA_ROOT` — including via `..`,
      absolute paths, NUL bytes or symlinks/junctions that resolve outside it; every
      such case, like every unknown/non-playable id, answers `404`.
- [ ] Without a valid session `/media/:id` answers `401` and streams nothing.
- [ ] A client that disconnects mid-stream, or stops reading for 60 s, releases
      its file handle; the process holds no more open media file descriptors after
      all players are closed than before.
- [ ] A non-playable item (e.g. MKV) opens the player page in the "Nicht
      abspielbar" state with its format named — no `<video>` is created.
- [ ] A playback failure is explained on the page: missing file ("Datei nicht
      gefunden") is distinguished from an unsupported codec ("Wiedergabe nicht
      möglich") and from a dropped connection; each offers a way back.
- [ ] For a series episode with a successor, a "Nächste Folge" button opens the
      next episode; "Zurück" returns to the page the user came from, not to the
      previous episode.
- [ ] On a desktop keyboard, Space/K, ←/→, F and M control playback when focus is
      not on a button or the video itself.
- [ ] Two concurrent 1080p direct-play streams play without stutter on the target
      Raspberry Pi 4 (vision success criterion "Weak hardware").

## Scope

### In scope

- Path guard `src/media/paths.js` (containment incl. symlink resolution).
- Range parser `src/http/range.js`, media type table `src/http/media-types.js`,
  streaming responder `src/http/stream.js`.
- Route `GET` + `HEAD /media/:id` in `src/api/media.js`
  (`registerMediaRoutes(router, deps)`), registered in `src/http/routes.js`.
- Extension of P2's `GET /api/library/items/:id` JSON by `ext` and `next`
  (see Prior decisions) — server-side, never derived in the frontend.
- Player page `public/player.html`, `public/js/player.js`,
  `public/css/player.css`, key map `public/js/lib/player-keys.js`.
- Tests for every new module; `docs/architecture.md` component map update.

### Out of scope

- Resume / progress reporting and "Weiterschauen" — Phase 4 hooks into
  `public/js/player.js`.
- Audio player UI (Phase 5), image lightbox and `/media/:id/thumb` (Phase 6).
- Subtitles — see OPEN-1.
- Transcoding/remuxing, custom player skin, playback speed, audio-track or
  quality selection, auto-play of the next episode, casting, downloads.
- ETag / conditional GET / `304` handling (prior art: AVOID).
- Changes to the scanner or compatibility table (Phase 2 owns `compat.js`).

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
reference only).

Layout rules the mockups illustrate:

- Focused page: no category nav, no app header. Top: secondary button "Zurück"
  (chevron SVG) + title block (muted overline, heading). Desktop: side by side;
  mobile: stacked.
- Stage: `<video controls playsinline preload="metadata">` on the `background`
  token, full content width, `max-height` so the whole video fits the viewport;
  mobile edge-to-edge. The controls in the mockups are illustrative — the real
  ones are the browser's native controls, never re-skinned.
- Below the stage (series only, when a successor exists): secondary button
  "Nächste Folge: S01E03 · Sturmflut" (skip SVG); right-aligned on desktop,
  full width on mobile. Desktop with a hover-capable pointer additionally shows
  the muted hint line "Tastatur: Leertaste Wiedergabe/Pause · ←/→ 10 Sekunden ·
  F Vollbild · M Ton aus".
- Error states replace the `<video>` with a centred panel on the `secondary`
  surface (radius `lg`): destructive icon, optional "Nicht abspielbar" badge,
  heading, muted body, primary button "Zurück zur Übersicht" (plus the state's
  secondary action). All states use the same panel; only copy/actions differ.

State copy (German UI, exact):

| State | Trigger | Badge | Heading | Body | Actions |
|---|---|---|---|---|---|
| Loading | item fetch pending | — | — | stage shows muted "Lädt …" | — |
| Playing | item playable | — | — | — | "Nächste Folge: …" if `next` |
| Not found | item API `404`, invalid `id`, or category not movie/series | — | Titel nicht gefunden | Dieser Titel ist nicht (mehr) in der Bibliothek. | Zurück zur Übersicht |
| Load failed | item API network error / `5xx` | — | Titel konnte nicht geladen werden | Bitte prüfe die Verbindung und versuche es erneut. | Erneut versuchen, Zurück zur Übersicht |
| Not playable | `playable` false | Nicht abspielbar | Dieses Video kann nicht abgespielt werden | Das Format {EXT} kann der Browser nicht direkt wiedergeben. Die Datei bleibt unverändert in der Bibliothek. | Zurück zur Übersicht; "Nächste Folge: …" if `next` |
| File missing | `<video>` error + `HEAD /media/:id` → `404` | — | Datei nicht gefunden | Die Datei wurde verschoben oder gelöscht. Die Bibliothek aktualisiert sich automatisch. | Erneut versuchen, Zurück zur Übersicht |
| Codec | `<video>` error code 3/4 + `HEAD` → `2xx` | Nicht abspielbar | Wiedergabe nicht möglich | Der Browser kann diese Datei nicht wiedergeben – vermutlich ein nicht unterstützter Codec (z. B. HEVC). | Zurück zur Übersicht; "Nächste Folge: …" if `next` |
| Connection lost | `<video>` error code 2, or `HEAD` fails | — | Verbindung unterbrochen | Die Übertragung wurde unterbrochen. | Erneut versuchen, Zurück zur Übersicht |

`{EXT}` = the item's `ext` upper-cased (e.g. `MKV`).

## Constraints

- Constitution applies in full; the load-bearing rules here: zero runtime deps;
  media root read-only (files opened with flag `'r'` only); path containment with
  `404` on violation; `fs.createReadStream`-style streaming with `Range`
  (206/416), never a full read into memory; auth on every route except
  `/login`, static assets, `/healthz`; ≤ 60 lines/function, ≤ 300 lines/file;
  JSDoc on every export; a test per new `src/` module with failure cases for
  range, path and auth; no `innerHTML` with data; German UI copy.
- Architecture boundary: only `src/media/paths.js` turns an item's stored
  relative path into a filesystem path; clients reference media by id only.
- Depends on Phase 1 (router with `:param` patterns and arbitrary methods incl.
  `HEAD`, `requireUser`, JSON error helper, static serving of `public/`,
  `tokens.css`/`base.css`, 401→login helper in `public/js/lib/`) and Phase 2
  (`library_items`, item lookup by id in `src/db/`, `GET /api/library/items/:id`,
  `compat.js`, browse UI).
- No new configuration value: `MEDIA_ROOT` comes from `src/config.js`; the idle
  timeout is a module constant.

## Prior art

- [HTTP range streaming (Phase 3)](../prior-art.md#http-range-streaming-phase-3) —
  `pillarjs/send` + `jshttp/range-parser` are the precedent for range semantics
  (read at source, see Decision log); ETag/conditional-GET machinery is AVOIDed.
- [Direct-play compatibility detection (Phase 2)](../prior-art.md#direct-play-compatibility-detection-phase-2) —
  defines which extensions are playable and therefore which need a MIME entry;
  explains why an extension-based "playable" MP4 can still fail at runtime (HEVC)
  → the "Codec" error state.
- [Library model and naming conventions (Phase 2)](../prior-art.md#library-model-and-naming-conventions-phase-2) —
  season/episode numbering (`Season 00` specials) that the next-episode order
  builds on.

## Human prerequisites

None block implementation (all tests use generated temp files). For the
milestone QA gate only:

- [ ] A `MEDIA_ROOT` with real sample media (fixtures are synthetic and not
      decodable): ≥ 1 movie as MP4 H.264/AAC (ideally 1080p), ≥ 1 series with ≥ 2
      consecutive episodes, ≥ 1 MKV, and — if available — 1 HEVC-in-MP4 file for
      the "Codec" state.
- [ ] Access to the Raspberry Pi 4 (4 GB) deployment for the two-stream check, or
      explicit acceptance of the dev-machine substitute in Verification.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| **Path guard** `resolveMediaPath(mediaRoot, relPath) → Promise<string \| null>`: reject empty, absolute (POSIX or drive/UNC), NUL-containing, or any `..` segment (split on `/` and `\`) up front; then `fs.promises.realpath` of both root and `path.resolve(root, relPath)`; contained iff `path.relative(realRoot, real)` is non-empty, not `..`, does not start with `..` + `path.sep`, and is not absolute. Any error (ENOENT, EACCES, invalid arg) → `null`. Stateless, per request. | Constitution: "resolved and verified to lie inside `MEDIA_ROOT`". Realpath catches symlink/junction escapes; `path.relative` avoids the prefix bug (`/media` vs `/media-evil`) and is case-insensitive on win32; `realpath` (native) returns canonical case on Windows, so no manual case folding. Per-request realpath of the root is negligible and survives remounts. | 2026-09-26 |
| Symlinks/junctions whose target lies outside `MEDIA_ROOT` are not served (`404`); links inside the root are followed. A second disk must be bind-mounted under `MEDIA_ROOT`, not symlinked. | Constitution containment rule; vision: one host, one disk. | 2026-09-26 |
| Violations answer `404 {"error":"not_found"}` — never `403` — identical to unknown ids. | Constitution ("violation -> `404`"); no existence oracle. | 2026-09-26 |
| `:id` must match `^[1-9][0-9]{0,15}$` and be a safe integer, else `404`; ids are the only client input, so URL-encoded separators/`..` never reach the filesystem. The player page validates `?id=` with the same pattern before any request. | Architecture: clients reference media by id only. | 2026-09-26 |
| `/media/:id` serves only `playable` items; non-playable → `404 {"error":"not_playable"}`. | Contract: "streams ANY playable item"; vision: offline downloads out of scope. | 2026-09-26 |
| **Range semantics** (GET only), following `send`/`range-parser`: header not starting with `bytes=` → ignore (200). Single spec `a-b` → end clamped to `size-1`; `a-` → to end; `-n` → last `n` bytes (`n ≥ size` → whole file as `206`). Satisfiable → `206`, `Content-Range: bytes a-b/size`, `Content-Length: b-a+1`. `a ≥ size`, `a > b`, `-0`, or any range on an empty file → `416`, `Content-Range: bytes */size`, body `{"error":"range_not_satisfiable"}`. Non-digit / empty specs (`bytes=abc`, `bytes=-`) → ignore (200). More than one range-spec (comma) → ignore (200 full). Whitespace around a spec is trimmed. Digit strings beyond `Number.MAX_SAFE_INTEGER`: as start → `416`; as end → clamped; as suffix → whole file. | Precedent read at source (`range-parser` returns -1 → 416, -2 → full response; `send` treats multiple ranges as a regular response). RFC 9110 §14.2 allows ignoring Range; browsers' media elements never send multi-range, so `multipart/byteranges` is dead weight. | 2026-09-26 |
| `HEAD` supported with the same headers as a `200` GET (full `Content-Length`, no `Content-Range`), no body, no read stream; `Range` on `HEAD` is ignored. | RFC 9110 §14.2: range handling is defined for GET only. The player uses `HEAD` to tell "file missing" from "codec unsupported". | 2026-09-26 |
| **No validators:** no `ETag`, no `Last-Modified`, no `304`; any `If-Range` header → ignore `Range` and send `200` full. Headers on 200/206: `Content-Type`, `Content-Length`, `Accept-Ranges: bytes`, `Cache-Control: private, no-cache`, `X-Content-Type-Options: nosniff`. | Prior art AVOIDs conditional-GET machinery; with no validators issued, an `If-Range` can never match (RFC 9110 §13.1.5; `send` behaves the same). `private` because content is behind auth; `no-cache` so a file replaced under the same path/id is never served stale. | 2026-09-26 |
| **Media types** in `src/http/media-types.js` (`mediaTypeFor(ext)`): `mp4 m4v → video/mp4`, `webm → video/webm`, `ogv → video/ogg`, `mp3 → audio/mpeg`, `m4a m4b → audio/mp4`, `aac → audio/aac`, `flac → audio/flac`, `ogg oga opus → audio/ogg`, `weba → audio/webm`, `wav → audio/wav`, `jpg jpeg → image/jpeg`, `png → image/png`, `gif → image/gif`, `webp → image/webp`, `avif → image/avif`; unknown → `application/octet-stream`. No `svg`. A test asserts every extension P2's `compat.js` marks playable has a non-fallback entry. | One table for all categories because `/media/:id` serves all of them; the consistency test prevents drift between "playable" and "servable". SVG is script-capable same-origin content. | 2026-09-26 |
| **Streaming mechanics:** `fs.promises.open(path, 'r')` → `handle.stat()` (not a file → `404`) → decide status → `handle.createReadStream({ start, end })` piped with `stream.pipeline` into the response; default 64 KiB `highWaterMark`. `sendMedia(req, res, opts)` returns a promise that settles when the response is finished or aborted (`{ aborted }`), and accepts an injectable `openFile` for tests. Open/stat failures before headers → `404`; read errors after headers → destroy the response. Client aborts (`ERR_STREAM_PREMATURE_CLOSE`) are not logged. | Opening before `writeHead` makes "file vanished" a clean `404` and keeps size and stream consistent; `pipeline` gives backpressure and destroys the source (closing the handle) on client disconnect — the Pi-memory requirement. The promise + injectable open make handle release testable. | 2026-09-26 |
| **Idle timeout:** a media response with no socket activity for 60 s (`MEDIA_IDLE_TIMEOUT_MS`, overridable per call for tests) is destroyed; the timer must not outlive the response. | Paused browsers stop reading and would otherwise pin a descriptor indefinitely (sleeping devices never close). Precedent: nginx `send_timeout` defaults to 60 s, so browsers routinely resume with a fresh range request. | 2026-09-26 |
| Error bodies on `/media/*` are JSON `{"error": "<code>"}` (`not_found`, `not_playable`, `range_not_satisfiable`; `401` from P1's `requireUser`). `/media/*` is not a page route: unauthenticated requests get `401`, never a redirect. | Constitution error format; a redirect to an HTML login page is useless as a media source. | 2026-09-26 |
| **Item JSON extension** (P2's `GET /api/library/items/:id`): add `ext` (lower-case extension without dot) if P2 does not already expose it, and `next` = `{ id, title, season, episode }` or `null`. Field naming follows P2's JSON convention. Implemented as a prepared-statement repository function in P2's library repository module. | Global rule: missing interface data is added in the backend, never reconstructed in the frontend. One fetch serves both title and next-episode label. | 2026-09-26 |
| **Next episode** = within the same series grouping key (P2), the item with the smallest `(season, episode, rel_path)` greater than the current one; items with `NULL` season or episode are neither a source nor a target (their `next` is `null`). Non-playable successors are not skipped. Movies and other categories: `null`. No auto-advance; on `ended` the button receives focus. | Specials (`Season 00`) sort first per the Jellyfin convention; not skipping keeps a missing episode visible (the target page shows "Nicht abspielbar" and its own "Nächste Folge"). Browsers block audible autoplay on a fresh page load (Firefox by default), so auto-advance would be unreliable. | 2026-09-26 |
| "Nächste Folge" navigates with `location.replace()`. "Zurück" / "Zurück zur Übersicht": `history.back()` if `document.referrer` is same-origin, else navigate to `/`. | `replace` keeps the browse page as the history predecessor so "Zurück" never walks back through episodes; direct/bookmarked opens still have a way out. | 2026-09-26 |
| Player URL is `/player.html?id=<id>` (static page; data only via authenticated APIs). A `401` from the item API goes through P1's login-redirect helper. | Constitution: static assets are unauthenticated, data is not. Works with plain static serving. | 2026-09-26 |
| Page handles categories movie and series only; any other category renders "Titel nicht gefunden". Autoplay: call `video.play()` after setting `src`; a rejected promise is ignored (user presses play). Title: movies → overline "Film", heading = title; episodes → overline = series title, heading `SxxEyy · <title>` (two-digit, when both numbers are known, else title). `document.title` = heading + " – Videothek". All text via `textContent`. | Audio has its own player (P5), images their lightbox (P6). | 2026-09-26 |
| **Playback error handling:** on the `<video>` `error` event (code 1 = aborted is ignored) the page sends `HEAD /media/:id`: `401` → login helper; `404` → "Datei nicht gefunden"; `2xx` → by `MediaError.code` (3/4 → "Wiedergabe nicht möglich", 2 → "Verbindung unterbrochen"); `HEAD` network failure → "Verbindung unterbrochen". "Erneut versuchen" reloads the source and seeks back to the last known `currentTime`. | A `404` on a media source surfaces as `MEDIA_ERR_SRC_NOT_SUPPORTED` in browsers, indistinguishable from a codec problem without asking the server. | 2026-09-26 |
| **Keyboard** (`public/js/lib/player-keys.js`, pure `keyAction(descriptor)` → `'toggle' \| 'back' \| 'forward' \| 'fullscreen' \| 'mute' \| null`): Space/`k` toggle, ArrowLeft/ArrowRight ∓/± 10 s (clamped to `[0, duration]`), `f` fullscreen toggle on the stage, `m` mute. Ignored when Ctrl/Alt/Meta is held or the event target is the `<video>`, a button, link or form field; handled keys call `preventDefault()`. Escape is not bound. | Skipping the focused `<video>` avoids double handling with the browsers' own native-control shortcuts; skipping buttons keeps Enter/Space/arrow focus navigation working for TV remotes; Escape stays the native fullscreen exit. The descriptor (not a DOM event) keeps the module testable under `node:test`. | 2026-09-26 |
| Focus: in any error state the primary action receives focus on render; in the playing state no focus is forced. Error panels are announced via an `aria-live="polite"` region; the `<video>` gets `aria-label` = heading. | design.md: full keyboard/remote navigation, WCAG 2.1 AA. | 2026-09-26 |
| Tests generate their own temp media trees and byte-pattern files (no committed fixtures in this phase); symlink cases use `fs.symlink(..., 'junction')` for directories (no admin rights needed on Windows, plain symlink on Linux) and skip file-symlink cases on `EPERM`. | Range assertions need known bytes; fixtures must never be real media; the dev machine is Windows, the target Linux. | 2026-09-26 |
| OPEN-1 — Subtitle sidecar files (`.vtt`, `.srt` next to a video): in this phase or later? Options: A) out of v1, seed as its own roadmap phase; B) `.vtt` sidecars only, discovered at request time and exposed as `<track>` via `/media/:id/subtitles/:n`; C) B plus on-the-fly `.srt`→`.vtt` conversion. Recommendation: **A** — not in the vision's scope list, touches the Phase 2 index model (sidecars are not library items), and keeps this phase tight. | resolved at the spec-acceptance gate | — |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (per PR and at milestone end):

- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no packages.
- [ ] `test/http/range.test.js` covers every row of the range decision: `0-99`,
      `a-`, `-500`, suffix > size, end > size, `a = size`, `a > b`, `-0`, empty
      file, `bytes=abc`, `bytes=-`, `items=0-1`, multi-range, whitespace,
      oversized digit strings.
- [ ] `test/http/stream.test.js` (real `node:http` server on port 0, generated
      byte-pattern file): bodies byte-exact for 200/206; headers as decided; `416`
      carries `Content-Range: bytes */size`; `HEAD` (with and without `Range`) has
      full `Content-Length` and no body; `If-Range` → 200; missing file and
      directory → 404 JSON; client abort after the first chunk settles
      `sendMedia` with `aborted: true` and the injected handle is closed within
      1 s; a paused client with an injected short idle timeout is disconnected and
      its handle closed; two concurrent full downloads of a ≥ 32 MiB sparse file
      both complete byte-exact.
- [ ] `test/media/paths.test.js`: inside path resolves; `..`, nested `..`,
      absolute POSIX/Windows paths, NUL, empty path, missing file → `null`;
      junction to an outside directory → `null`; junction to an inside directory →
      resolves; sibling-prefix directory (`media` vs `media-evil`) → `null`;
      `MEDIA_ROOT` itself behind a junction works; on win32 a differently-cased
      root still resolves.
- [ ] `test/api/media.test.js`: no session → 401 and no body bytes of the file;
      `abc`, `0`, `01`, 17-digit ids → 404; unknown id → 404; non-playable → 404
      `not_playable`; indexed item whose file was deleted → 404; happy 200/206/416
      through the route; `Content-Type` from the media-type table.
- [ ] Item API test: `next` across episodes and seasons, last episode → `null`,
      movie → `null`, episode without numbers → `null`; `ext` lower-case.
- [ ] `test/public/player-keys.test.js`: each key maps as decided; modifiers,
      `VIDEO`/`BUTTON`/`A`/`INPUT` targets → `null`.

Human QA (milestone gate; `npm start` against the QA `MEDIA_ROOT`, Chromium and
Firefox, desktop and a phone-width viewport):

- [ ] Movie MP4 plays; seeking to 90 % starts within a few seconds (DevTools
      network shows `206` responses, not a full download).
- [ ] Episode page shows series overline, `S01E02 · Titel`, and "Nächste Folge";
      clicking it opens E03; "Zurück" then returns to the series page, not to E02.
      On `ended`, the button has focus and Enter opens the next episode.
- [ ] MKV item → "Nicht abspielbar" panel naming `MKV`; no network request to
      `/media/`.
- [ ] Delete/rename a playing file's source, then seek → "Datei nicht gefunden";
      HEVC-in-MP4 (if available) → "Wiedergabe nicht möglich".
- [ ] `/player.html?id=999999` → "Titel nicht gefunden"; after logging out, a
      direct `curl /media/<id>` → `401`.
- [ ] Keyboard: Space, K, ←/→, F, M work with focus on the page; Tab reaches
      "Zurück", the video controls and "Nächste Folge" with a visible amber focus
      ring; Space on a focused button activates the button, not playback.
- [ ] Screens match the committed mockups (tokens only, German copy, targets
      ≥ 44 px).
- [ ] Performance on the Pi 4: idle RSS < 100 MB; two different 1080p MP4s play
      simultaneously in two browsers for 5 min with seeks, without stutter; after
      closing both, open descriptors (`ls /proc/<pid>/fd | wc -l`) return to the
      pre-test baseline within 60 s and RSS returns near idle. Substitute if no Pi:
      the same descriptor check on the dev machine with two concurrent
      `curl --limit-rate 3M` downloads of a large file, one aborted mid-way.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| File handle / memory leak from aborted or paused clients on the Pi | `pipeline` + handle-owned stream (auto-close), 60 s idle timeout, abort and idle tests asserting handle closure, descriptor-count QA check. |
| Symlink tests cannot run on Windows without privileges | Directory junctions need no rights and map to symlinks on Linux; file-symlink cases skip on `EPERM`. |
| Extension says "playable" but codec is not (HEVC in MP4) | Runtime "Codec" state via `HEAD` disambiguation; compat table stays P2's concern. |
| Double handling of keys between page shortcuts and native controls | Page handler ignores events targeted at the `<video>`; handled keys `preventDefault()`. |
| Chrome/Firefox reject the idle-timeout disconnect instead of re-requesting | Precedent: nginx closes idle sends after 60 s by default and browsers recover with a new range request; QA pauses a video > 60 s and resumes. |
| P2's item JSON lacks fields the page needs | Added server-side in the item-API issue (`ext`, `next`); never reconstructed client-side. |
| Library item ids are reused after deletions, so a stale `/media/:id` could hit a different file | `Cache-Control: no-cache` prevents stale cached bodies; id stability itself is P2's responsibility (see cross-phase note). |

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
  downscaled to 1280 × 1024.
