# Spec: Music & audiobooks

> Created: 2026-09-26

Makes every audio file under the music and audiobook category folders browsable
and playable in the browser: minimal in-house ID3v2 + FLAC tag readers,
folder-convention parsers, a post-scan audio metadata pass (migration 004),
cover art, an audio section on `/music` and `/audiobooks` with a persistent
bottom-bar player and album/book queue, and cross-device resume for music
tracks and audiobook files on top of the Phase 4 progress API. This spec
carries no lifecycle state — acceptance is the spec merged on the default
branch with a milestone and issues, and all progress lives in the GitHub issues
and milestone. A completed spec is moved to `docs/specs/archive/`.

## Outcome

- [ ] An MP3 or FLAC file copied into `Musik/<Artist>/<Album>/` appears in the
      Musik section inside its album, with title, artist, album, album artist,
      track/disc order, year and duration taken from its tags — without a
      restart, within the Phase 2 freshness bounds (≤ 10 s with a working
      watcher, at the latest after the periodic rescan).
- [ ] Every `library_items` row of category `music` or `audiobooks` gets an
      `audio_meta` row and appears: files without readable tags (untagged
      MP3/FLAC, and all M4A/M4B, Ogg/Opus, AAC, WAV, …) are grouped and ordered
      by the folder/filename conventions below; files the Phase 2 compatibility
      table marks as not playable are listed with a "Nicht abspielbar" badge
      and are never queued.
- [ ] Album and book covers are shown from a folder image, a sidecar image or
      the embedded picture via `GET /media/:id/cover`; items without any cover
      show the placeholder, never a broken-image icon.
- [ ] Musik: "Weiterhören" card + artist sections with album cards → album
      detail with track list; "Alle abspielen" or a track click plays the album
      as a queue in the persistent bottom bar (play/pause, previous/next, seek,
      auto-advance). Moving between `/music`, `/music?album=<id>`,
      `/audiobooks` and `/audiobooks?book=<id>` — including through the
      category nav — never interrupts playback.
- [ ] Hörbücher: book grid with per-book progress and a "Weiterhören" row →
      book detail with per-file progress; "Fortsetzen" starts the book at the
      last file and position — also on a second device, within ±10 s of where
      it was stopped on the first (vision success criterion "Resume").
- [ ] Musik "Weiterhören": the user's most recently updated in-progress music
      track (a Phase 4 progress row) is offered on any device and resumes
      within ±10 s of its stop position.
- [ ] The metadata pass never reads more than 256 KiB of any audio file and
      never loads picture payloads while scanning; the service still meets the
      vision's idle-RSS criterion.
- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

Every file this phase creates or edits (each owned by exactly one issue):

- Tag readers: `src/library/tags/id3v2.js` (ID3v2.3 + ID3v2.4),
  `src/library/tags/mpeg.js` (MP3 duration), `src/library/tags/flac.js`
  (STREAMINFO, VORBIS_COMMENT, PICTURE) and the central tag→field mapping
  `src/library/tags/index.js` (the only module that opens audio files for tag
  reading).
- Folder-convention parsers `src/library/parsers/music.js` and
  `src/library/parsers/audiobook.js` (pure).
- Metadata pass `src/library/audio-meta.js`; migration
  `src/db/migrations/004-audio-meta.sql`; repositories
  `src/db/audio-meta-repo.js` (audio_meta + joined `library_items` reads) and
  `src/db/audio-progress.js` (read-only joins onto Phase 4's `progress`).
- Group assembly `src/library/audio-groups.js` (pure).
- API: `src/api/music.js` (`registerMusicRoutes`), `src/api/audiobooks.js`
  (`registerAudiobookRoutes`), pure resume derivation
  `src/api/audiobook-resume.js`.
- Covers: lookup `src/library/cover.js`, route module `src/api/cover.js`
  (`registerCoverRoutes`, `GET /media/:id/cover`; folder images and embedded
  slices both served through Phase 3's `sendMedia` — no own streaming code).
- Shared-file edits (one line each): `src/http/routes.js` (three
  registrations: music, audiobooks, cover), `src/server.js` (one
  `onScanComplete` registration).
- Frontend: `public/music.html` and `public/audiobooks.html` (replace Phase 1's
  placeholders), `public/js/audio/app.js`, `public/js/audio/routes.js`,
  `public/js/audio/queue.js`, `public/js/audio/player.js`,
  `public/js/audio/player-bar.js`, `public/js/audio/media-session.js`,
  `public/js/audio/format.js`, `public/js/audio/audio-api.js`,
  `public/js/audio/icons.js`, `public/js/audio/cover-img.js`,
  `public/js/audio/views/music-overview.js`, `public/js/audio/views/album.js`,
  `public/js/audio/views/audiobook-grid.js`,
  `public/js/audio/views/audiobook-detail.js`, `public/css/audio.css`,
  `public/css/audio-music.css`, `public/css/audio-books.css`.
- Tests mirroring every module: `test/library/tags/{id3v2,mpeg,flac,index}.test.js`,
  `test/library/parsers/{music,audiobook}.test.js`,
  `test/library/{audio-meta,audio-groups,cover}.test.js`,
  `test/db/{audio-meta-repo,audio-progress}.test.js`,
  `test/api/{music,audiobooks,audiobook-resume,cover}.test.js`,
  `test/public/{audio-routes,audio-queue,audio-player,audio-format,audio-cover-img}.test.js`.
- Test helpers and fixtures: `test/helpers/mp3-fixture.js`,
  `test/helpers/flac-fixture.js`, `test/helpers/make-audio-fixtures.js`,
  `test/helpers/make-audio-fixtures.test.js`, committed tree
  `test/fixtures/media/Musik/**` and `test/fixtures/media/Hörbücher/**`.
- Docs: `docs/architecture.md` — component-map rows (audio metadata pass,
  audio grouping, cover lookup + cover route, audio section frontend), a note
  under "Where new code goes" declaring the audio section's file layout
  (`public/music.html` + `public/audiobooks.html` share `public/js/audio/` and
  `public/css/audio*.css` instead of `public/js/<page>.js`) and its custom
  control bar over a hidden `<audio>` (deviation from design.md's "native
  controls" Player line), a new key flow "Audio metadata" plus an addition to
  key flow 4 (music and audiobook files report progress like video) — made by
  the metadata-pass issue. `docs/prior-art.md` — new concerns "Audio artwork resolution
  (Phase 5)" and "Audiobook directory structure (Phase 5)" — made in this spec
  PR. This spec file.

### Out of scope

- Tags in M4A/M4B/MP4 atoms, Ogg/Opus Vorbis comments, ID3v1, ID3v2.2, APE,
  WAV/AIFF chunks — those files play and are listed via folder/filename
  fallback (roadmap row and prior art name ID3v2 + FLAC only).
- Chapter markers inside a single file (ID3 `CHAP`, MP4 chapter tracks): a
  single-file book is one entry in the file list.
- Gapless playback, crossfade, shuffle, repeat, playlists, playback speed,
  sleep timer, volume control, lyrics, ReplayGain, genres, multi-artist/role
  modelling, search/filter, A–Z index, page-level keyboard shortcuts.
- Audiobook series grouping (`Author/Series/Book` works, the series folder is
  ignored for display).
- Playback continuing while navigating to Filme, Serien, Bilder, the start page
  or admin pages (H8: leaving the audio section is a page load and stops
  playback; resume via "Weiterhören"/"Fortsetzen").
- Server-side cover resizing or caching, online cover/metadata lookups,
  transcoding (vision/constitution).
- Audio items in Phase 4's "Weiterschauen" row (it requests
  `category=movies,series`, D11) and any edit of Phase 4 files.
- Edits to Phase 1's nav module, `placeholder.js`, `tokens.css` or the Phase 2
  scanner/watcher/categories.

## Constraints

- Constitution applies unchanged: zero runtime dependencies, read-only
  `MEDIA_ROOT` (files opened with flag `'r'` only), path guard on every
  request-derived path, `fs.createReadStream` for media bytes with `Range`,
  prepared statements only, max 60 lines/function and 300 lines/file (JS and
  CSS), JSDoc on every export, a test file per new `src/` module, failure-case
  tests for path containment, range and auth, German UI copy, no `innerHTML`
  with data, no outbound calls, config only through `src/config.js`.
- Architecture boundaries: `src/library/` knows nothing about HTTP or users;
  `src/api/` knows nothing about file formats; `src/db/` is the only place with
  SQL; clients reference media and groups by index id, never by path;
  `public/` never imports server modules. Frontend modules import each other by
  **relative** paths (`../lib/progress.js`) so `node:test` can load them, and
  touch no DOM at import time.
- Phase 1 contract (D4/D5), used verbatim: handler `(req, res, ctx)` with
  `ctx = { user, params, url }`; route modules export
  `register<X>Routes(router, deps)` with `deps = { config, db, log, now }`;
  `requireUser` from `src/http/guards.js`; `sendJson`/`sendError` from
  `src/http/respond.js`; router whole-segment matching (`/media/:id` ≠
  `/media/:id/cover`), HEAD runs the GET handler with `req.method === 'HEAD'`;
  API JSON camelCase, timestamps ISO-8601 strings named `…At`, errors strictly
  `{ "error": "<code>" }`, `/api/*` `Cache-Control: no-store`; logging only via
  the injected `log` (`log.info|warn|error(event, fields)`), never `console.*`;
  `test/helpers/app.js` `startTestApp({ mediaRoot })`. Frontend:
  `public/js/lib/api.js` `request(method, path, { json, keepalive,
  redirectOn401 = true }) → { status, data }` (throws `ApiError { status,
  code }`) and `toLogin()`; `public/js/lib/shell.js`
  `mountShell({ active }) → { main, setActive(id) }`; `public/js/lib/dom.js`
  element builder; tokens from `public/css/tokens.css` (incl. `--grid-min`,
  `--row-min`, `--tap-min`, `--focus-width`, `--focus-offset`,
  `--border-width`, `--bar-height-mobile`); CSP forbids `style=""`, dynamic
  values go through `el.style.setProperty`; literal lengths outside
  `tokens.css` only for breakpoints 768/1024, `%`, `vh/dvh`, `fr`, `0`.
- Phase 2 contract (D3/D6/D9): category ids `music`, `audiobooks` from
  `CATEGORIES` in `src/library/categories.js`; top-level folder aliases
  (`Musik`/`Music`, `Hörbücher`/`Hoerbuecher`/`Audiobooks`, NFC,
  case-insensitive) — the first `rel_path` segment is always the category
  folder; `library_items` (`id` AUTOINCREMENT, `rel_path`, `dir`, `category`,
  `kind`, `ext`, `playable`, `size`, `mtime_ms`, …, STRICT); only extensions
  from `src/library/parsers/compat.js` `EXTENSIONS` (`{ kind, playable, mime }`)
  are indexed, so music/audiobooks rows are always `kind = 'audio'` — playable:
  mp3, m4a, m4b, aac, flac, ogg, oga, opus, weba, wav (m4a/m4b by sniff);
  listed not playable: wma, ape, aif, aiff, mka, wv, dsf, dff, ac3, dts, amr,
  mid, midi. `startLibrary()` returns `{ onScanComplete(listener) →
  unsubscribe, requestFull(), stop(), status() }`; the listener fires once
  after every completed run with `{ kind, stats, completedAt }`, is not
  awaited, and a throw/rejection is logged by Phase 2.
- Phase 3 contract (D10): `resolveMediaPath(mediaRoot, relPath) →
  Promise<string | null>` from `src/media/paths.js`; `sendMedia(req, res,
  { path, contentType?, cacheControl = 'private, no-cache', idleTimeoutMs =
  MEDIA_IDLE_TIMEOUT_MS, slice?: { offset, length }, openFile? }) →
  Promise<{ status, aborted, error }>` from `src/http/stream.js` (`path`
  already guarded; Content-Type derived from compat via `mediaTypeFor` when
  omitted; `slice` makes the entity bytes `[offset, offset + length)` with all
  range maths — 206/416/200, HEAD, `If-Range` — relative to the slice and
  `offset + length >` file size → 404; open `'r'`, `fs.createReadStream(path,
  { fd: handle, start, end })`, `stream.pipeline`, 60 s idle timeout and the
  `Content-Type`/`Content-Length`/`Accept-Ranges`/`Cache-Control`/`nosniff`
  headers all live there); `GET /media/:id` streams playable items only and
  rejects ids that are not safe integers. P5 imports neither `src/http/range.js`
  nor any other streaming internals.
- Phase 4 contract (D11): table `progress(user_id, rel_path,
  position_seconds, duration_seconds, finished, updated_at)` keyed by
  `(user_id, rel_path)`; audio finished rule = remaining ≤ 30 s, applied
  server-side on every `PUT`; a row with `finished = 0` and position < 30 s is
  state `none`; `src/api/progress-rules.js` exports `START_THRESHOLD_S = 30`,
  which P5's `src/api/` modules import and pass to `src/db/audio-progress.js`
  as a bound parameter (no literal 30 in P5 SQL or resume code);
  `public/js/lib/progress.js` exports
  `trackPlayback(media, id, { entry, onResume, resume = true }) → { stop():
  Promise<void> }` and `formatClock(s)`, `formatRemaining(s)`.
- Raspberry Pi 4 target: bounded reads per file, files processed sequentially
  with async I/O, no whole-file reads, no in-memory picture buffering.

### Migration 004 schema (`src/db/migrations/004-audio-meta.sql`)

```sql
CREATE TABLE audio_meta (
  item_id          INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  meta_version     INTEGER NOT NULL,  -- AUDIO_META_VERSION when written
  source_mtime_ms  INTEGER NOT NULL,  -- library_items.mtime_ms when read
  source_size      INTEGER NOT NULL,  -- library_items.size when read
  group_key        TEXT    NOT NULL,  -- rel path of the album/book dir, or of the file (single-file book)
  group_title      TEXT,              -- folder-derived album/book title; NULL = pseudo-album
  group_artist     TEXT,              -- folder-derived artist/author; NULL = unknown
  title            TEXT    NOT NULL,  -- resolved track/file title (tag, else cleaned filename)
  track_no         INTEGER,           -- resolved (tag, else filename number)
  disc_no          INTEGER NOT NULL,  -- resolved (tag, else disc folder, else 1)
  tag_artist       TEXT,
  tag_album_artist TEXT,
  tag_album        TEXT,
  tag_year         INTEGER,
  duration_ms      INTEGER,           -- NULL = unknown
  tag_format       TEXT CHECK (tag_format IN ('id3v2', 'flac'))  -- NULL = no tag read
) STRICT;
CREATE INDEX audio_meta_group ON audio_meta (group_key);
```

The file contains no transaction statements (D12). Metadata only: no user
data lives in 004 (H7).

## Design

Committed Stitch exports (layout references; the implementer builds with
vanilla HTML/CSS and `public/css/tokens.css` only — exported HTML loads a CSS
CDN and is never served or copied, see `docs/design.md`):

| Screen | Mobile | Desktop |
|---|---|---|
| Musik overview (artist sections, "Weiterhören" card) | `docs/design/assets/music-audiobooks/music-overview-mobile.png` | `docs/design/assets/music-audiobooks/music-overview-desktop.png` |
| Album detail + playing bar | `docs/design/assets/music-audiobooks/music-album-mobile.png` | `docs/design/assets/music-audiobooks/music-album-desktop.png` |
| Hörbücher grid | `docs/design/assets/music-audiobooks/audiobook-grid-mobile.png` | `docs/design/assets/music-audiobooks/audiobook-grid-desktop.png` |
| Book detail + playing bar (audiobook mode) | `docs/design/assets/music-audiobooks/audiobook-detail-mobile.png` | `docs/design/assets/music-audiobooks/audiobook-detail-desktop.png` |

Exported HTML sits next to each PNG. Working reference only: Stitch project
`videothek`, screens titled `P5 …` (the exported "P5 Hörbücher Übersicht –
mobile" is `9aee9956…`; an older duplicate "P5 Hörbuch Detail – mobile"
`0b1b56bc…` is stale). All exports show the `primary` token `#ff7a1a`.

Where a PNG and this spec disagree, the spec wins:

- Off-token shades in the exports map to tokens or to the derived state tokens
  in `tokens.css` (hover/active); only token custom properties are used.
- The Hörbücher grid exports lack the "Weiterhören" row (specified below); the
  desktop bars show a volume control (out of scope); bar controls per mode
  follow the "Bar layout" decision.
- Non-playable rows use `muted` text plus the badge — never reduced opacity
  (contrast stays AA).
- Adopted from the exports: a `muted` count next to each Musik artist heading
  ("2 Alben", singular "1 Album") and next to the Hörbücher page heading
  ("8 Hörbücher", singular "1 Hörbuch"; count of all books).
- The "Fortsetzen" pill inside the Musik "Weiterhören" card is kept as a
  non-interactive `<span>` styled like a primary button inside the card's
  single `<button>` — no nested interactive element; the whole card is the
  target.
- The "15"/"30" numerals inside the skip glyphs are illegible at export size:
  the buttons show the arrow glyph plus a visible text label "15" / "30" at
  `--text-sm`, weight semibold.
- The seek slider's visual track is thin, but its hit area is ≥ `--tap-min`
  high.
- Nav, header and account menu are Phase 1's shell; the active nav entry comes
  from `setActive`.

## Prior art

- [Music and audiobook tag reading (Phase 5)](../prior-art.md#music-and-audiobook-tag-reading-phase-5)
  — central tag→field mapping table, fast scan separated from deeper analysis,
  in-house minimal ID3v2 + FLAC parsers; drives the reader/mapping split and
  the post-scan metadata pass.
- [Audio artwork resolution (Phase 5)](../prior-art.md#audio-artwork-resolution-phase-5)
  — Navidrome's default `CoverArtPriority` (`cover.*, folder.*, front.*,
  embedded, external`) minus `external`; drives the cover lookup order.
- [Audiobook directory structure (Phase 5)](../prior-art.md#audiobook-directory-structure-phase-5)
  — Audiobookshelf's `{Author}/{Book}`, `{Author}/{Series}/{Book}`,
  single-file books and `CD|Disc|Disk` subfolders; drives both path parsers.
- [Playback progress and resume (Phase 4)](../prior-art.md#playback-progress-and-resume-phase-4)
  — one progress row per (user, item), last write wins; music tracks and
  audiobook files reuse it, book resume is derived.
- [HTTP range streaming (Phase 3)](../prior-art.md#http-range-streaming-phase-3)
  — audio playback reuses `GET /media/:id`; folder covers and embedded cover
  slices are both served by Phase 3's `sendMedia` (its `slice` option).
- [Direct-play compatibility detection (Phase 2)](../prior-art.md#direct-play-compatibility-detection-phase-2)
  — the `playable` flag decides what is queued.
- [Library model and naming conventions (Phase 2)](../prior-art.md#library-model-and-naming-conventions-phase-2)
  — same "small in-house regex set, no provider machinery" stance for the
  audio folder conventions.

## Human prerequisites

none — nothing blocks implementation; every test and the QA walk run against
generated/committed synthetic fixtures (`MEDIA_ROOT=test/fixtures/media`).
QA-only, optional:

- [ ] (QA-only) Access to the Raspberry Pi 4 target for the idle-RSS line in
      Verification — or the human accepts the dev-machine substitute named
      there at milestone QA.
- [ ] (QA-only) A smoke test against a real music/audiobook library.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| **Music folder convention:** `Musik/<Artist>/<Album>/[<Disc folder>/]<NN> <Title>.<ext>`. A *disc folder* is a directory whose name matches `^(cd\|disc\|disk)\s*(\d+)$` (case-insensitive). Let `dirs` = the path segments between the category folder and the file; if the last one is a disc folder it is removed once (rollup) and its number becomes the folder disc. **Group (album) = the remaining directory**, `group_key` = its full rel path (the category folder itself when `dirs` is empty). Depth = remaining `dirs` count: depth ≥ 2 → real album, `group_title` = last dir, `group_artist` = first dir under the category folder; depth 1 → pseudo-album of loose tracks, `group_title` NULL, `group_artist` = that folder; depth 0 → pseudo-album of the root, both NULL. | Folder identity never splits compilations and never merges same-named albums of different artists — both failure modes of tag-based grouping. The first-segment artist rule covers `Artist/Year/Album` layouts (review finding). Disc folders follow Audiobookshelf. | 2026-09-26 |
| **Filename cleaning (both parsers):** stem = filename without the last extension; if it matches `^(\d{1,3})[\s._-]+(.+)$` the number is the filename track number and the rest (leading `[\s._-]+` trimmed) the title; if the stem contains no space, `_` becomes a space; empty result → the raw stem. All display strings are NFC-normalised; `group_key` keeps the exact on-disk form. P2's `cleanName` is **not** used. | `cleanName` strips release tokens such as "Deutsch", "AAC" or "Multi" that are legitimate song and book titles. | 2026-09-26 |
| **Music precedence — tags win for display, path wins for grouping.** Per track: title = tag title ?? cleaned filename; track = tag ?? filename number; disc = tag ?? folder disc ?? 1. Per real album (depth ≥ 2, first member in play order): title = its `tag_album` ?? `group_title`; artist = its `tag_album_artist` ?? the `tag_artist` if non-null and identical on every member ?? `group_artist` ?? null; year = first non-null `tag_year` in play order. Pseudo-albums ignore tags for group display: title null, artist = `group_artist`. | Navidrome precedent (tags are the music source of truth). Pseudo-albums mix unrelated files, so a first-track album tag would mislabel the group. | 2026-09-26 |
| **Unknown names travel as `null`; the UI renders German fallbacks**: album title null → "Einzeltitel"; artist null → "Unbekannter Interpret"; author null → "Unbekannter Autor". | Server stays free of German strings (same rule as Phase 2's episode-code fallback). | 2026-09-26 |
| **Audiobook folder convention:** `Hörbücher/<Author>/<Book>/[<Disc folder>/]<files>` (multi-file) or `Hörbücher/<Author>/<Book>.<ext>` / `Hörbücher/<Book>.<ext>` (single-file). Same disc rollup and depth as music: depth ≥ 2 → **book = remaining directory** (`group_key` = its rel path, `group_title` = last dir, `group_artist` = first dir); depth ≤ 1 → **the file alone is the book** (`group_key` = the file's rel path, `group_title` = cleaned stem without number stripping, `group_artist` = the folder at depth 1, else NULL). `Author/Series/Book/…` works (book = `Book`, author = `Author`). A multi-file book without an author folder appears as single-file books — documented convention. | Mirrors Audiobookshelf's structure and single-file-book rule; a depth rule is deterministic without reading tags. | 2026-09-26 |
| **Audiobook precedence — folder wins for book title/author, tags win for file titles.** Book title = `group_title`, author = `group_artist`; file title = tag title ?? cleaned filename. | Deliberate deviation from Audiobookshelf's default (tags over folder): our grouping requires curated Author/Book folders, while CD-rip audiobook tags often carry disc suffixes or the narrator as artist. | 2026-09-26 |
| **Play order within a group:** `disc_no` asc, then `track_no` asc (NULL after numbered), then filename via `new Intl.Collator('de', { numeric: true, sensitivity: 'base' })`, then `id`. Artist sections, albums without year and books use the same collator; albums within an artist by year asc (NULL last), then title (NULL last); artist section `null` last; books by title, then author. | Audiobookshelf sorts by disc and track; the collator gives natural order for untagged sets. | 2026-09-26 |
| **Group ids:** a group is addressed by the id of its first member in play order (`id`); `coverId` = the first **playable** member in play order, else `id`. Every group endpoint accepts **any** member id and resolves the group via `group_key`. No group table, no paths in URLs. | Architecture: clients reference by index id. A bookmark survives added tracks; it 404s only when that very file is removed. | 2026-09-26 |
| **Every music/audiobooks item gets an `audio_meta` row** (D9): tag reading only for `mp3` (ID3v2 + MPEG duration) and `flac` (FLAC metadata, leading ID3v2 skipped); every other extension gets a path-only row (`tag_format` NULL, `duration_ms` NULL). Playability is always `library_items.playable`, never stored or re-decided here. | D9 cross-phase consolidation; Phase 2 already restricts these categories to audio extensions, so no extension filter is needed in P5. | 2026-09-26 |
| **Tag formats: ID3v2.3/2.4 and FLAC metadata only**; M4A/M4B atoms, Ogg comments, ID3v1, ID3v2.2 and APE are out. | Roadmap row "ID3v2/FLAC tag readers"; prior-art verdict "in-house minimal ID3v2 + FLAC parsers". | 2026-09-26 |
| **Fields read:** ID3v2 frames `TIT2`, `TPE1`, `TPE2`, `TALB`, `TRCK`, `TPOS`, `TDRC` (2.4) / `TYER` (2.3), `APIC`. FLAC Vorbis keys (case-insensitive) `TITLE`, `ARTIST`, `ALBUMARTIST` / `ALBUM ARTIST` / `ALBUM_ARTIST`, `ALBUM`, `TRACKNUMBER`, `DISCNUMBER`, `DATE` / `YEAR`, and `PICTURE` blocks. Text encodings 0 (ISO-8859-1), 1 (UTF-16 with BOM), 2 (UTF-16BE), 3 (UTF-8); first value of `\0`-separated multi-values; `"n/total"` → `n`; non-numeric track/disc → null; year = first four digits; trim; empty → null. Pictures: prefer type 3 (front cover), else the first; only `image/jpeg`, `image/png`, `image/webp` (`image/jpg` → `image/jpeg`); length ≤ 10 MiB. | Prior art: one central tag→field mapping; exactly the fields the views show. | 2026-09-26 |
| **ID3v2 robustness:** header `ID3` + major version 3 or 4; synchsafe tag size; skip the extended header; v2.3 whole-tag unsynchronisation → de-unsync the read buffer (pictures in unsynchronised tags/frames are ignored); v2.4 frame sizes synchsafe with fallback to plain big-endian when the synchsafe reading yields an invalid next frame id (iTunes bug); compressed/encrypted frames skipped; the walk stops at padding (`\0` id), an invalid id, or a size past the tag end. Readers never throw on malformed input — they return what they parsed, or `null`. | Real-world tag corpora contain these defects; one bad file must never abort the pass. | 2026-09-26 |
| **Duration without decoding:** FLAC = `total_samples / sample_rate` (null when total samples is 0). MP3 = first valid MPEG frame header (MPEG-1/2/2.5 Layer III) within 64 KiB after the ID3v2 tag; `Xing`/`Info` header with frames flag → `frames × samples_per_frame / sample_rate`; else `VBRI` → same formula; else CBR `(file_size − audio_start) × 8 / bitrate`. Other formats and failures → NULL; the API then uses the user's Phase 4 row `duration_seconds`, else the UI shows `–:–`. | Exact for FLAC and Xing-tagged MP3, cheap estimate otherwise; no decoding, no child process. | 2026-09-26 |
| **Read budget:** readers work on `readAt(position, length) → Promise<Buffer>` (short buffer at EOF). Per file at most **256 KiB** in total; ID3v2 frames are walked in chunks of ≤ 64 KiB, bodies larger than the chunk are skipped by offset — for `APIC` only the first 512 body bytes are read to locate the image data; FLAC blocks other than STREAMINFO/VORBIS_COMMENT/PICTURE are skipped by offset, a VORBIS_COMMENT > 64 KiB is skipped, a PICTURE block is read only up to 4 KiB. Budget exhaustion ends parsing with the partial result. | Covers are often 0.5–5 MB inside the tag; the budget bounds I/O without losing frames after the picture. | 2026-09-26 |
| **Reader interfaces:** `readId3v2(readAt) → Promise<{ version, fields: Record<string,string>, picture: PictureRef \| null, tagEnd: number } \| null>` (fields keyed by frame id; `tagEnd` = 0 when no tag); `readMpegDurationMs(readAt, audioStart, fileSize) → Promise<number \| null>`; `readFlac(readAt, fileSize) → Promise<{ fields: Record<string,string>, picture: PictureRef \| null, durationMs: number \| null } \| null>` (fields keyed by upper-cased Vorbis key; skips a leading ID3v2 tag by its header without importing `id3v2.js`); `PictureRef = { offset, length, mime }` in absolute file bytes. `src/library/tags/index.js`: `readAudioTags(absPath, { ext, size }) → Promise<AudioTags>` (`AudioTags = { title, artist, albumArtist, album, trackNo, discNo, year, durationMs, format: 'id3v2' \| 'flac' \| null }`, all nullable; budgeted file-backed `readAt`, handle closed in `finally`; rejects only on open/read I/O errors) and `readPictureRef(absPath, { ext }) → Promise<PictureRef \| null>` (never rejects: I/O errors → null). | Lets the ID3v2, FLAC and mapping issues be built and tested in parallel against buffer-backed fakes. | 2026-09-26 |
| **Parser interfaces:** `parseMusicPath(relPath) → { groupKey, groupTitle, groupArtist, fileTitle, fileTrackNo, folderDiscNo }` and `parseAudiobookPath(relPath) → { groupKey, groupTitle, groupArtist, fileTitle, fileTrackNo, folderDiscNo }` (nullable where the rules above say so; `groupTitle` of a book is never null). Pure, no I/O. | Contract between the parser, pass and group issues. | 2026-09-26 |
| **Scan hook = Phase 2's `onScanComplete` (D6), not an enricher module.** `src/library/audio-meta.js` exports `AUDIO_META_VERSION` (integer, starts at 1) and `createAudioMetaPass({ db, mediaRoot, log, readTags = readAudioTags, resolvePath = resolveMediaPath }) → { refreshAudioMeta(event?): Promise<void>, idle(): Promise<void> }`. `src/server.js` gets exactly one line: `library.onScanComplete(createAudioMetaPass({ db, mediaRoot: config.mediaRoot, log }).refreshAudioMeta)` (`library` = the value returned by `startLibrary()`). `scanner.js`/`watcher.js` are not edited. | D6 cross-phase consolidation — it supersedes the review's BLOCKING-1 (per-batch enrichers): a listener gives backfill of pre-existing rows, retry after failure and never blocks the scan queue (freshness ≤ 10 s). | 2026-09-26 |
| **Pass algorithm:** single-flight — a call while a run is active marks one coalesced rerun and returns the active promise. A run selects (`listStaleAudioItems`) every `library_items` row with category in (`music`, `audiobooks`) whose `audio_meta` row is missing or differs in `meta_version`, `source_size` (vs `size`) or `source_mtime_ms` (vs `mtime_ms`), ordered by id; per item, sequentially: parser by category → `resolvePath(mediaRoot, rel_path)` (null → skip, no row; the next scan removes the item) → `readTags` (rejection → log `audio_meta_read_failed { relPath }`, no tag content, and continue with empty tags) → resolve fields per the precedence rows → `upsertAudioMeta` with the item's `size`/`mtime_ms` as read in the select. An FK violation (item deleted mid-pass) skips that item. Shutdown: the run checks `db.isOpen` before each item and in its error handler; when it is `false` the run (and any coalesced rerun) ends quietly — no log line, no rerun. Any other DB error ends the run with `audio_meta_pass_failed { error }` (the next completed scan retries). A run that processed ≥ 1 item logs `audio_meta_pass { processed, failed, durationMs }`. No orphan-delete code: `ON DELETE CASCADE` cleans rows (D6), and a category change is impossible for an unchanged `rel_path`. Phase 2's rows are never modified. | D6 listener contract; staleness by (version, size, mtime) makes unchanged files free on every later run; a file whose tags fail still appears; bumping `AUDIO_META_VERSION` re-derives every row once after a parser change. | 2026-09-26 |
| **Freshness and visibility:** audio views inner-join `audio_meta`, so a new file appears once its row is written — the pass runs right after the watcher's path reconcile, within the 10 s budget. | Keeps views free of half-parsed items; D6's non-awaited listener keeps the scan queue free. | 2026-09-26 |
| **Repository functions:** `src/db/audio-meta-repo.js`: `listStaleAudioItems(db, metaVersion)`, `upsertAudioMeta(db, row)` (`INSERT … ON CONFLICT(item_id) DO UPDATE`), `listAudioRows(db, category)` and `listGroupRows(db, groupKey)` / `getAudioRow(db, itemId)` returning joined rows `{ id, relPath, dir, category, ext, playable, groupKey, groupTitle, groupArtist, title, trackNo, discNo, tagArtist, tagAlbumArtist, tagAlbum, tagYear, durationMs }` (camelCase mapping in the repo). `src/db/audio-progress.js`: `listAudioProgress(db, userId, category)` → `[{ itemId, position, duration, finished, updatedAt }]` (join `progress.rel_path = library_items.rel_path`, epoch ms) and `getLatestMusicResume(db, { userId, startThreshold })` → the row with max `updated_at` (tie → higher item id) among the user's music rows with `finished = 0 AND position_seconds >= :startThreshold AND library_items.playable = 1` that have an `audio_meta` row, as `{ itemId, groupKey, position, duration, updatedAt } \| null`. `startThreshold` is a bound parameter supplied by the caller: `src/api/music.js` passes `START_THRESHOLD_S` imported from Phase 4's `src/api/progress-rules.js`; `src/db/` contains no literal `30` for the threshold. | SQL stays in `src/db/`; splitting the progress join off lets the metadata issues proceed before Phase 4's table exists. The threshold parameter follows Phase 4's repository rule (one constant, never a SQL literal — spec-progress-resume "Repository"); `playable = 1` matches Phase 4's continue view and keeps a track that became non-playable from being offered. | 2026-09-26 |
| **Group assembly (`src/library/audio-groups.js`, pure):** `playOrder(rows)`, `buildAlbums(rows) → [{ id, coverId, groupKey, title, artist, year, members }]`, `buildArtistSections(albums) → [{ name, albums }]`, `buildBooks(rows) → [{ id, coverId, groupKey, title, author, members }]`; totals = sum of known member durations, `null` when none is known. | One implementation of the precedence and order rules for both APIs. | 2026-09-26 |
| **Music resume = Phase 4 rows (H7).** Music tracks report through `trackPlayback` exactly like audiobook files (server-side audio finished rule: last 30 s). The Musik "Weiterhören" card = `getLatestMusicResume` (the user's latest `in_progress`, playable music row). A track-row click starts at 0 (entry normalised, D11). The resume `start` travels on the queue item itself (`items[i].start`), so if `createQueue` ever skips a start item, the next item keeps its own start (0 for music) and a position is never applied to another track. No `music_session` table, no session endpoints. | Human decision at spec-acceptance gate (H7); one resume store (vision USP). | 2026-09-26 |
| **API (all behind `requireUser`, JSON; `:id` must match `^[1-9][0-9]{0,15}$` **and** `Number.isSafeInteger(Number(id))` — same rule as Phases 3 and 6; 404 `not_found` for any id that is not a member of the endpoint's category with an `audio_meta` row; durations/positions in seconds, `null` when unknown):** `GET /api/music` → `{ resume: { trackId, albumId, title, artist, albumTitle, coverId, position, duration, updatedAt } \| null, artists: [{ name, albums: [{ id, title, year, trackCount, coverId }] }] }` (`artist` = track `tag_artist` ?? album artist; `duration` = meta ?? row). `GET /api/music/albums/:id` → `{ id, title, artist, year, coverId, duration, discCount, tracks: [{ id, title, artist, trackNo, discNo, duration, playable, ext }] }` (tracks in play order; `trackCount`/tracks include non-playable). `GET /api/audiobooks` → `{ books: [{ id, title, author, coverId, fileCount, duration, state, fraction, lastPlayedAt }] }`. `GET /api/audiobooks/:id` → `{ id, title, author, coverId, fileCount, duration, state, fraction, lastPlayedAt, resume: { itemId, position } \| null, files: [{ id, title, trackNo, discNo, duration, playable, ext, progress: { position, duration, finished } \| null }] }`. `state` ∈ `new`, `in_progress`, `finished`; `fraction` 0–1 or null. | Two modules (`src/api/music.js`, `src/api/audiobooks.js`, review: split allowed) so API and views are built in parallel; shapes fixed here. | 2026-09-26 |
| **Audiobook resume (`src/api/audiobook-resume.js`, pure `deriveBookProgress(files, rows)`, `files` in play order `[{ id, playable, duration }]`):** only *counted* rows matter — `finished` or position ≥ `START_THRESHOLD_S` (imported from Phase 4's `src/api/progress-rules.js`, 30 s; the module hard-codes no 30; Phase 4's `none` rows are ignored, D11); per-file `progress` is null for uncounted rows. Only playable files take part — rows of non-playable files are ignored for state, *L*, resume and `fraction`, and their per-file `progress` is null. No counted rows on playable files → `new`, resume the first playable file at 0. All playable files finished → `finished`, resume first playable at 0. Otherwise `in_progress`: latest counted row *L* **among playable files** (max `updatedAt`, tie → later in play order); *L* unfinished → resume *L* at its position; *L* finished → the next playable file after *L* that is not finished (at its counted position, else 0); none after *L* → the first unfinished playable file from the start (same position rule). `fraction` = Σ (finished ? d : counted ? min(position, d) : 0) ÷ Σ d over playable files with a known duration *d* (meta, else the row's `duration`); null when Σ d = 0. `lastPlayedAt` = max `updatedAt` of counted rows (ISO) or null. No playable file → `resume: null`, `state: 'new'`. `finished` is Phase 4's stored flag, never recomputed. | Phase 4 stores one row per (user, `rel_path`); multi-file books resume at "last file + position" without a book-level table; ignoring sub-30 s rows matches Phase 4's `none` state. | 2026-09-26 |
| **Start positions (D11):** P5 never sets an initial `currentTime`; for every queue item it passes `trackPlayback(audio, itemId, { entry })` with `entry = { state: start > 0 ? 'in_progress' : 'none', position: start }` and lets `trackPlayback` seek. Decided `start`: music track → 0, except the Musik "Weiterhören" card → its `position`; audiobook file → its `progress.position` when that progress is unfinished, else 0 — for "Fortsetzen" the `resume.position`, for "Von vorn hören" 0 for the first file (later files in that queue use the same per-file rule). | Resolves review BLOCKING-3 per D11. | 2026-09-26 |
| **Queue (`public/js/audio/queue.js`, pure):** `createQueue(items, { startIndex = 0 })` keeps only `playable` items (a non-playable start item → the next playable one); API `current()`, `index()`, `advance()` → next item or `null` at the end, `back(currentTimeS)` → `{ item, restart }` (`currentTimeS > 3` or first item → restart current, else the previous item), `jump(itemId)` → item or `null`. A queue is one album or one book. | Standard player behaviour; pure so it is unit-tested. | 2026-09-26 |
| **Player (`public/js/audio/player.js`):** `createAudioPlayer({ audio, track = trackPlayback, headMedia = defaultHeadMedia })` — `audio` is the one `HTMLAudioElement`; `track` is Phase 4's `trackPlayback` (test seam); `headMedia(id) → Promise<number>` returns the HTTP status of `fetch('/media/<id>', { method: 'HEAD', credentials: 'same-origin' })` and resolves `0` on a network error (never rejects) — the default is that `fetch` call, tests inject a stub — → `{ playQueue(items, { startIndex, mode: 'music' \| 'audiobook', groupId }), toggle(), next(), previous(), seekBy(seconds), seekTo(seconds), state() → { item, groupId, mode, playing, error } \| null, onChange(listener) → unsubscribe }`. Queue items: `{ id, title, subtitle, groupTitle, coverId, duration, playable, start }`. One persistent `<audio preload="metadata">` is reused. When **no** previous handle exists (the first play of the page), `playQueue` sets `src = /media/<id>`, creates the handle and calls `play()` synchronously inside the caller's click task — no `await` before `play()`, and every caller has its queue data loaded before the click (see Views: resume-album prefetch), so iOS Safari's transient user activation is never spent on a network wait. Every later switch (advance, previous/next, new queue, row click) first waits for `stop()` of the previous handle, bounded: `await Promise.race([prev.stop(), delay(1000)])` — this relies on Phase 4's `stop()` doing, **synchronously inside the call and before its first `await`**, (a) dispatching its final report (payload read from the element) and (b) detaching every listener and timer; only the network settle is awaited. So when the 1 s cap wins, the old handle can no longer react to the new `src` (no "repeat seek on next `loadedmetadata`", no report under the old item id), and the cap only stops a slow LAN from delaying auto-advance. The player issue checks the merged Phase 4 `progress.js` for this order; if it detaches only after an await, that is a Phase 4 defect fixed in `progress.js` by a `fix:` issue — P5 adds no workaround. Then the player sets `src`, creates the new handle and calls `play()` (a rejected promise leaves the bar paused; the element was unlocked by the first gesture, so later programmatic `play()` is allowed). `ended` → `advance()`; queue end → stop, bar stays visible with the last item. An `error` event (code ≠ 1) → `HEAD /media/<id>`: 401 → `toLogin()`; otherwise the bar shows "Titel konnte nicht abgespielt werden" (`role="status"`, 5 s) and advances. Leaving the section is a page load; `trackPlayback`'s `pagehide` report saves the position. | Reusing the element keeps the autoplay unlock from the first gesture across auto-advance; a synchronous first `play()` keeps the gesture valid on iOS Safari (review); the 1 s cap bounds the keepalive PUT round trip on a slow network (review); the HEAD check mirrors Phase 3's error disambiguation for the expired-session case. | 2026-09-26 |
| **Audio section URLs (H8 = D14):** `public/music.html` and `public/audiobooks.html` replace Phase 1's placeholders; both have Phase 1's placeholder head/body skeleton plus `audio.css`, `audio-music.css`, `audio-books.css` and load the one module `public/js/audio/app.js` instead of `placeholder.js`; they differ only in `<title>` (`Musik · Videothek` / `Hörbücher · Videothek`, Phase 1's `{Seite} · Videothek` form). The `<body>` carries **no** `data-category` attribute (that hook belongs to `placeholder.js`): `app.js` derives the section from `location.pathname` alone, because `pushState` moves between `/music` and `/audiobooks` without a reload and a static attribute would go stale. Routes (`public/js/audio/routes.js`, pure `parseAudioUrl(pathname, search) → { section: 'music' \| 'audiobooks', view: 'overview' \| 'album' \| 'grid' \| 'book', id }` and `audioUrl(route)`): `/music`, `/music?album=<id>`, `/audiobooks`, `/audiobooks?book=<id>`; an invalid id → the section overview via `replaceState`. `app.js` intercepts clicks on `a[href]` whose URL is same-origin with pathname `/music` or `/audiobooks` (primary button, no modifier key, no `target`/`download`) — this covers Phase 1's two nav links and all in-section links — then `pushState` (skipped when the URL is unchanged), renders the view, calls `setActive(section)` and scrolls to top (`history.scrollRestoration = 'manual'`); `popstate` renders from `location`. No nav edits, no redirect stubs. `document.title` = view heading + " · Videothek". | Human decision at spec-acceptance gate (H8); the query-string URLs survive Phase 1's `/login?next=` round trip, which a hash would not (review BLOCKING-4). | 2026-09-26 |
| **View contract:** each `public/js/audio/views/*.js` exports `render({ container, id, player, navigate }) → Promise<{ title: string, dispose?: () => void }>`; `app.js` owns `container` (inside the shell's `main`), calls `dispose` before the next view and never re-creates the player. The shell issue ships the four view modules and two view CSS files as minimal stubs (heading only / comment only); the view issues replace them. | Lets the shell, music views and audiobook views be built in parallel without touching each other's files. | 2026-09-26 |
| **Views:** Musik overview = "Weiterhören" card when `resume` is set (cover, title, "artist · album", progress bar of height `var(--space-1)` in `primary` = position/duration, meta `formatRemaining`, a non-interactive "Fortsetzen" pill `<span>`; the card is one `<button>` that plays the album queue from that track at `position` and navigates to the album). **Resume-album prefetch:** when `resume` is set, the view fetches `GET /api/music/albums/<albumId>` in parallel with rendering and shows the card only once that album has loaded (album request fails → no card, the rest of the page renders), so the click handler calls `playQueue` synchronously with data in hand. Artist sections (`<h2>` name + `muted` "n Alben"/"1 Album") each with a grid of 1:1 album cards (`<a href="/music?album=<id>">`, cover `loading="lazy"`, title, year muted). Album detail = back link "‹ Musik", cover, title, artist, meta "2019 · 12 Titel · 48 Min." (year omitted when null, "1 Titel" singular), primary "Alle abspielen", track rows with "CD n" sub-headings only when `discCount` > 1. Hörbücher grid = page heading "Hörbücher" + `muted` "n Hörbücher"/"1 Hörbuch" (all books) + "Weiterhören" row (books with `state = 'in_progress'`, `lastPlayedAt` desc, max 20, horizontally scrollable, hidden when empty) + all books as 1:1 cards (`<a href="/audiobooks?book=<id>">`): title, author, `primary` bar of height `var(--space-1)` + "34 %" when in progress, "Gehört" when finished, else "n Dateien · 7 Std. 12 Min.". Book detail = back link "‹ Hörbücher", cover, overline "Hörbuch", title, author, "n Dateien · Dauer", overall bar + "34 % gehört" (when fraction non-null), primary button "Abspielen" (`new`) / "Fortsetzen · <file title> – <m:ss>" (`in_progress`) / "Von vorn hören" (`finished`), secondary "Von vorn hören" when in progress, file rows with per-file bar and "Gehört" for finished files. Book-card clicks open the detail; playback always starts from a button. All bars (card, overall, per-file) use height `var(--space-1)` — no literal lengths (D5). | design.md components (media card, grid/list, progress wherever started); committed exports (counts and the "Fortsetzen" pill adopted, review); the prefetch keeps the first `play()` inside the click's user activation on iOS Safari (review). | 2026-09-26 |
| **Rows:** playable track/file rows are full-width `<button type="button">` (≥ `--row-min`, number `font-mono` muted, title, duration right); the playing row gets `aria-current="true"`, `primary` text and an equaliser glyph instead of the number. Track click → album queue from that track at 0; file click → book queue from that file at its start rule. Non-playable rows are non-focusable `<div>`s with `muted` text and the `destructive` "Nicht abspielbar" badge. | design.md: ≥ 48 px rows, keyboard reachable; no opacity dimming (AA). | 2026-09-26 |
| **Grid (H3):** album and book grids use `grid-template-columns: repeat(auto-fill, minmax(min(var(--grid-min), calc(50% - var(--space-2))), 1fr))`, gap `var(--space-4)`. | Human decision at spec-acceptance gate (H3) — always ≥ 2 columns on phones; `--space-2` (8 px) replaces H3's literal. | 2026-09-26 |
| **Bar layout (`public/js/audio/player-bar.js` + `audio.css`):** `<section class="audio-bar" aria-label="Audioplayer">` on `secondary`, fixed at the bottom, `hidden` until the first `playQueue`. Contents: cover (48 px token-sized square via `--space-12`), title + subtitle (one line, ellipsis; music: artist, audiobook: "book · author"), controls, seek `<input type="range" aria-label="Position">` with elapsed/total (`formatClock`, `–:–`). Music mode: previous, play/pause, next. Audiobook mode: previous, "15 s zurück", play/pause, "30 s vor", next — below 768 px only 15 s zurück / play-pause / 30 s vor (previous/next file stay reachable via the file list). All controls are `<button>`s ≥ `--tap-min` with German `aria-label`s: "Wiedergabe"/"Pause", "Vorheriger Titel", "Nächster Titel", "15 Sekunden zurück", "30 Sekunden vor". Below 768 px the bar sits directly above Phase 1's bottom nav at `bottom: calc(var(--bar-height-mobile) + env(safe-area-inset-bottom))` — the same sum Phase 1 pads `main` with, since the nav occupies the inset — and needs no inset padding of its own; ≥ 768 px (no bottom nav) at `bottom: 0` with `padding-bottom: env(safe-area-inset-bottom)`. A spacer element after the view container gets the bar's measured height via `ResizeObserver` → `el.style.setProperty('height', …)`, so the last row is never hidden. No page-level keyboard shortcuts. | design.md: persistent bottom bar on `secondary`, ≥ 44 px targets; D5 (CSSOM for dynamic values, only 768/1024 breakpoint literals — replaces the draft's 600 px). | 2026-09-26 |
| **Media Session (`public/js/audio/media-session.js`, `bindMediaSession(player)`, no-op without `navigator.mediaSession`):** metadata title, artist (music: track artist; audiobook: author ?? book title), album (album/book title), artwork `[{ src: '/media/<coverId>/cover' }]`; handlers play, pause, previoustrack, nexttrack, seekbackward (15 s), seekforward (30 s), seekto; `setPositionState` on `durationchange`, `seeked`, `play`, `pause` (inside `try`, skipped for non-finite durations). The artwork URL is always set (every group has a `coverId`); when it 404s the browser shows its own default artwork — lock screens have no broken-image state, so no placeholder is generated for Media Session. | Built-in API giving lock-screen and hardware-key control. | 2026-09-26 |
| **Cover images (`public/js/audio/cover-img.js`, `coverImg({ coverId, kind: 'album' \| 'book', alt = '', lazy = false }) → HTMLElement`):** returns a square wrapper holding `<img src="/media/<coverId>/cover" alt decoding="async">` (`loading="lazy"` when `lazy`). On the image's `error` event (a 404 or any load failure) — or immediately when `coverId` is null — the `<img>` is removed and replaced by a placeholder: `surface` background with a centred `muted` glyph from `icons.js` (music note for `album`, book for `book`, as in the exports), `aria-hidden="true"` (the title next to it names the item). A broken-image icon is never shown. Used by album/book cards, the album/book detail header, the Musik "Weiterhören" card and the bar cover (the bar re-creates it on every item change). | Outcome "items without any cover show the placeholder, never a broken-image icon"; one module so every cover surface behaves the same (review). | 2026-09-26 |
| **German formatting (`public/js/audio/format.js`):** `formatDuration(s)` = P4's `formatClock` or `–:–` for null; `formatTotal(s)` → `48 Min.` / `7 Std. 12 Min.` / `7 Std.` (minutes rounded, minimum `1 Min.`), `–:–` for null; `formatPercent(f)` → `34 %` (floored, `Math.floor(f * 100)`). | Consistent German copy; reuses Phase 4's clock format. | 2026-09-26 |
| **States and copy:** loading shows only the heading; empty Musik "Keine Musik gefunden." + "Lege Musik im Ordner „Musik“ ab, z. B. „Musik/Interpret/Album/01 Titel.mp3“."; empty Hörbücher "Keine Hörbücher gefunden." + "Lege Hörbücher im Ordner „Hörbücher“ ab, z. B. „Hörbücher/Autor/Titel/01.mp3“."; request error "Die Bibliothek konnte nicht geladen werden." + button "Erneut versuchen"; API 404 "Album nicht gefunden." / "Hörbuch nicht gefunden." + link back to the section. No first-scan state: lists fill as the pass writes rows. `401` → Phase 1's `request` redirects to login. | Mirrors Phase 2's copy; the audio API does not expose scan status. | 2026-09-26 |
| **Cover lookup (`src/library/cover.js`, `findCover({ mediaRoot, row, resolvePath, readPicture }) → { kind: 'file', path } \| { kind: 'slice', path, offset, length, mime } \| null`):** (1) real album/book directory (depth ≥ 2): folder images named `cover`, `folder`, `front` (that priority) with extension `jpg`, `jpeg`, `png`, `webp` (that priority), case-insensitive — first in the item's own `dir` when it is a disc folder, then in `group_key`; pseudo-albums and single-file books instead a sidecar `<audio stem>.{jpg,jpeg,png,webp}` in the item's `dir`. Each directory is resolved with `resolvePath` **before** `readdir`; only regular-file `Dirent`s count (symlinks are skipped); the chosen file is resolved again with `resolvePath`. (2) the embedded picture of that item (`readPictureRef`). (3) null. Nothing is cached server-side. | Navidrome's default priority minus `external`; guarding the directory before listing it (review) and skipping symlinks keeps every byte inside `MEDIA_ROOT`. On-demand lookup is correct when a cover file is added without the audio file changing. | 2026-09-26 |
| **Cover route `GET /media/:id/cover`** (`src/api/cover.js`, `registerCoverRoutes(router, deps)` — `deps` may carry an optional `readPicture` (default `readPictureRef`) as a test seam, D4's `...extra` —, `requireUser` → 401 JSON, whole-segment route, HEAD via the GET handler): id not matching the pattern or not a safe integer, not a music/audiobooks item, without `audio_meta`, or no cover → 404 `{ "error": "not_found" }`. A file → `await sendMedia(req, res, { path, cacheControl: 'private, max-age=86400' })` (Content-Type derived by `sendMedia` from compat: jpg/jpeg/png/webp are compat image types, and Phase 3's `mediaTypeFor` lower-cases the extension — spec-video-streaming "Media types" — so `Cover.JPG` is served as `image/jpeg`; `findCover` returns the on-disk name unchanged); a slice → `await sendMedia(req, res, { path, contentType: mime, cacheControl: 'private, max-age=86400', slice: { offset, length } })`. The route logs `cover_stream_error { id, code }` when `sendMedia` settles with an `error` whose code is not `ENOENT`/`ENOTDIR`/`EISDIR` (Phase 3's media-route rule); no log for 404s or aborts. Covers of non-playable items are served too. | D10: cover route owned by P5, cache header via `sendMedia`'s `cacheControl`. | 2026-09-26 |
| **Embedded cover slices = Phase 3's `sendMedia` `slice` option — no P5 streaming code.** Phase 3 defines `slice: { offset, length }` explicitly "for P5's embedded covers" (range maths relative to the slice, slice past EOF → 404, HEAD, idle timeout, headers, `fs.createReadStream` with `fd`). P5 owns no `src/http/` module; the slice behaviour is verified at route level in `test/api/cover.test.js`. The draft's `src/http/slice.js`/`sendSlice` and `test/http/slice.test.js` are dropped. | D10 "P5 serves embedded cover slices via the same range logic" — one streaming implementation, not two; resolves the spec-acceptance review's blocking finding (duplicated streaming code, P3's `slice` left unused, misquoted signature). | 2026-09-26 |
| **Fixtures:** `test/helpers/mp3-fixture.js` (ID3v2.3/2.4 builder incl. encodings, unsync, extended header, APIC; silent, browser-decodable MPEG-1 Layer III CBR frames — 32 kHz, 32 kbit/s, mono, all-zero side info — with optional Xing/VBRI header) and `test/helpers/flac-fixture.js` (STREAMINFO, VORBIS_COMMENT, PICTURE, optional minimal ID3v2 prefix built inline; silent frames with CONSTANT subframes and correct CRC-8/CRC-16). `test/helpers/make-audio-fixtures.js` (CLI `node test/helpers/make-audio-fixtures.js <mediaRoot>`, deterministic) writes the committed tree: `Musik/Die Beispiele/Unterwegs/` (3 tagged MP3s of 120 s each, embedded cover), `Musik/Die Beispiele/Doppelalbum/CD 1|CD 2/` with folder `cover.png`, `Musik/Unbekannt/Ohne Tags/` (untagged, filename numbers), `Musik/Klangwerk/Flac Album/` (FLAC, `cover.jpg` absent, embedded PICTURE), `Musik/Klangwerk/Flac Album/04 Bonus (Live).wma` (dummy bytes, not playable), a loose `Musik/Einzeltrack.mp3`; every other music track 60 s; `Hörbücher/Jules Beispiel/Die Reise/` (≥ 3 MP3 files of ≥ 180 s each), `Hörbücher/Jules Beispiel/Kurzgeschichte.mp3` (single file, embedded cover), `Hörbücher/Anna Autorin/Langes Buch/CD 1|CD 2/`. The PNG is generated with `node:zlib` (`deflateSync`, `crc32`). Committed tree ≤ 10 MiB. **Bulk mode** `node test/helpers/make-audio-fixtures.js --bulk <n> <dir>` (deterministic, not committed) writes `n` ID3v2.4-tagged CBR MP3s of 2 s under `<dir>/Musik/Bulk Interpret <a>/Album <b>/<NN> Titel <NN>.mp3` — 10 tracks per album, 10 albums per artist, the first track of every album with a 256 KiB embedded APIC (exercises the read budget). **Unicode paths:** the generator writes every path component NFC-normalised; the committed tree keeps the canonical `Hörbücher/` folder (it is the NFC test case) and is committed in NFC (macOS: `core.precomposeunicode = true`, git's default there); the regeneration test compares relative paths after `normalize('NFC')` and asserts every committed path under `test/fixtures/media` equals its NFC form. | Synthetic files only, never real media; ≥ 180 s files keep a 1:00 position outside the "last 30 s" finished window, so the ±10 s resume check is meaningful; likewise the 120 s `Unterwegs` tracks keep a 0:40 music position inside the counted window (≥ 30 s played, > 30 s remaining). The bulk mode gives the idle-RSS QA line an exact command (P6 precedent `--bulk`); NFC rules keep the byte-for-byte check stable across OSes (review). | 2026-09-26 |
| **Test seeding:** DB/API tests migrate a temp DB (001, 002, 004, plus 003 where progress is read), insert `library_items`/`audio_meta`/`progress` rows with prepared statements, and use `startTestApp({ mediaRoot })` with a temp tree; no test depends on the scanner. | Keeps API/repo issues independent of the scanner and watcher. | 2026-09-26 |
| **Frontend file layout (declared deviation):** the two pages `public/music.html` and `public/audiobooks.html` share one module tree `public/js/audio/` (entry `app.js`) and `public/css/audio.css`, `audio-music.css`, `audio-books.css`, instead of Phase 1's per-page `public/js/<page>.js` / `public/css/<page>.css` convention; recorded in `docs/architecture.md` by the metadata-pass issue. | One shell and one persistent player must serve both pages (D14/H8); per-page entry modules would duplicate it and break playback continuity across `pushState` navigation. | 2026-09-26 |
| **Custom control bar over a hidden `<audio>` (declared deviation from design.md's Player line "native `<video>`/`<audio>` controls"):** the `<audio>` element has no `controls` attribute; the bar's own buttons, seek slider and time labels drive it. Video (Phase 3) keeps native controls. Recorded in `docs/architecture.md`. | Native audio controls offer no previous/next or 15/30 s skip and cannot show the queue's title/cover; the bar must stay visible and stable across view changes. | 2026-09-26 |
| **Docs edits:** `docs/prior-art.md` gets the two Phase 5 concerns in this spec PR; `docs/architecture.md` component map and key flows are edited by the metadata-pass issue (D13). The Subsonic play-queue reference is dropped. | D13; H7 removed the music-session design the Subsonic reference supported. | 2026-09-26 |
| **Migration 004 / `audio-meta-repo.js` (#63) implementation notes:** `listStaleAudioItems` returns raw snake_case `library_items` rows (the same `LibraryItemRow` shape as `library-repo.js`'s `getItemsByDir`) via a `LEFT JOIN audio_meta` staleness filter — it feeds the internal metadata pass, not the API, so no camelCase mapping. `listAudioRows`/`listGroupRows`/`getAudioRow` share one `INNER JOIN` projection that aliases columns to camelCase directly in SQL and converts `playable` from its stored 0/1 to a real boolean in JS (SQLite has no boolean type). `upsertAudioMeta`'s input mirrors the table's snake_case columns verbatim, matching `upsertItem`'s convention. Since migration 003 (issue #51) is not yet merged, its "004 applies … with and without 003" test builds two temp migration dirs — one with only 001/002/004, one that adds a synthetic minimal `progress` table standing in for 003 — instead of depending on the real file. | Keeps the pass/API boundary consistent with the existing `library-repo.js` conventions; unblocks the 003/004 independence test without a merge-order dependency on #51. | 2026-09-26 |
| **`src/db/audio-progress.js` (#67) implementation notes:** both queries alias columns to camelCase directly in SQL (`listAudioRows`'s convention), and both spread the `node:sqlite` row into a plain object before returning it — the driver hands back a null-prototype object, which fails `assert.deepEqual`/`assert/strict` (a strict `deepStrictEqual`) for callers and tests that compare a full row shape; `audio-meta-repo.js`'s joined reads avoid the same trap only incidentally, via `toAudioRow`'s spread for the unrelated `playable` boolean conversion. `listAudioProgress` applies no `finished`/threshold/playable filter (only category + presence via the join) since its only caller-to-be, the audiobook resume derivation (#69, `deriveBookProgress`), needs uncounted rows too to compute `state`/`fraction` itself; `getLatestMusicResume` is the only function with the threshold/playable/`finished=0`/`audio_meta`-presence filter, matching the "Repository functions" row exactly. `startThreshold` is received as a plain parameter, never imported from `src/api/progress-rules.js` here — that import belongs to the API layer (#68), keeping this module's only dependency on migrations 002–004. | Prevents a null-prototype/plain-object mismatch that is easy to miss (`assert.deepEqual` under `node:assert/strict` is strict); keeping `listAudioProgress` filter-free matches its stated per-file/counted-row consumer without duplicating `getLatestMusicResume`'s WHERE clause. | 2026-09-27 |
| **`src/api/music.js` (#68) implementation notes:** `discCount` = the number of *distinct* `discNo` values among an album's members (`new Set(...).size`), not the max disc number — equivalent given the disc-folder parser's 1..n numbering, but correct even if a disc were ever skipped. The per-track `duration` fallback (`GET /api/music/albums/:id` tracks, and the resume object) is one shared `resolveDurationSeconds(durationMs, fallbackSeconds)`: `audio_meta.duration_ms` converted to seconds when known, else the caller's fallback seconds, else `null`; for album-detail tracks the fallback is *this user's own* `listAudioProgress(db, userId, 'music')` row for that item (looked up once per request via a `Map<itemId, row>`, never a per-track query), for the resume object it is the same `getLatestMusicResume` row's own `duration` — both per the "Duration without decoding" decision's "else the API uses the user's Phase 4 row `duration_seconds`" clause. The album/book *total* `duration` never uses this fallback — it stays `buildAlbums`'s meta-only `durationMs` sum (`null` when no member has one), per the "Group assembly" decision. | Keeps one duration-resolution rule instead of two near-duplicates; per-request batching of the progress lookup avoids N+1 queries on an album's track list. | 2026-09-27 |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (`npm run verify`):

- [ ] `npm run verify` passes; `npm ls --omit=dev --all` shows no packages;
      every new `src/` module has its test file.
- [ ] ID3v2 reader: v2.3 and v2.4 tags with each text encoding (incl. `Ärzte`
      in ISO-8859-1 and UTF-16), multi-value frames, `n/total`, extended
      header, v2.3 unsynchronisation, v2.4 non-synchsafe frame sizes, APIC
      front-cover preference and offset → correct fields and `PictureRef`.
- [ ] MPEG duration: Xing, VBRI and CBR fixtures within ±1 s of the built
      duration; garbage after the tag → `null`, no throw.
- [ ] FLAC reader: exact duration from STREAMINFO; Vorbis keys
      case-insensitive incl. album-artist variants; PICTURE type 3 preferred;
      leading ID3v2 skipped.
- [ ] Robustness: truncated tags, sizes past EOF, zero-size frames and random
      bytes never throw and never loop; a fixture with a 5 MiB APIC is parsed
      with ≤ 256 KiB read (instrumented `readAt`), frames after the picture
      still found.
- [ ] Mapping: `readAudioTags` dispatches by extension, returns all-null tags
      for `m4a`/`ogg`/`wav`, closes the handle on success and on error.
- [ ] Parsers: table tests for music and audiobook paths (disc-folder rollup,
      loose tracks at depth 1 and 0, `Artist/Year/Album`, single-file books in
      an author folder and the root, `Author/Series/Book`, filename number
      stripping, underscore rule, NFC display strings, alias folders `Music/`
      and `Hoerbuecher/`).
- [ ] Migration 004 applies on a DB at 002 whether or not 003 is applied
      (it references only 002's `library_items`); deleting a `library_items`
      row cascades to `audio_meta`.
- [ ] Metadata pass: new, changed (size/mtime), version-bumped, unchanged (not
      re-read), non-mp3/flac (path-only row) and non-playable items; a
      rejecting reader still yields a fallback row and one log line without
      tag content; an item deleted mid-pass is skipped; concurrent calls run
      once more, never in parallel; a closed DB (`db.isOpen === false`) ends
      the run with no log line and no rerun.
- [ ] Groups: precedence (tags vs folder, album-artist fallback chain,
      pseudo-albums ignore tags), play order (disc, track, natural filename),
      album/artist/book ordering, `id` vs `coverId`, totals with unknown
      durations.
- [ ] API: every endpoint answers 401 without a session; malformed, unsafe
      (`9007199254740993`), unknown, wrong-category and meta-less ids → 404
      `not_found`; any member id
      resolves the same group; shapes exactly as specified; `resume` null for
      a new user, set from the latest in-progress music row, ignoring
      finished, < 30 s and non-playable rows; user B never sees user A's
      progress.
- [ ] Threshold binding (`test/db/audio-progress.test.js`): a music row at
      40 s is returned by `getLatestMusicResume` with `startThreshold: 30`
      and not with `startThreshold: 45`, proving the threshold is a bound
      parameter; `src/api/music.js` passes `START_THRESHOLD_S`
      (`test/api/music.test.js`: a 29 s music row is not offered, a 30 s row
      is).
- [ ] Resume function: new / in-progress / latest finished → next /
      no successor → first unfinished / all finished / no playable file;
      sub-30 s rows ignored (29 s ignored, 30 s counted — boundary taken from
      `START_THRESHOLD_S`); an unfinished row on a file that became
      non-playable never becomes *L* and its `progress` is null; fraction
      with unknown durations.
- [ ] Cover (`test/library/cover.test.js` for lookup order,
      `test/api/cover.test.js` for the route through the real `sendMedia`):
      folder image beats embedded; `cover` beats `folder` beats
      `front`; disc-folder then group lookup; sidecar for single-file books and
      pseudo-albums; embedded slice bytes equal the source image and
      `Content-Length` matches; `Range` on the slice → 206/416 relative to the
      slice; HEAD without body; a `readPicture` stub (injected via
      `deps.readPicture`) returning a ref past EOF → 404 through `sendMedia`'s
      slice check; a folder image `Cover.JPG` → `Content-Type: image/jpeg`;
      unsafe id → 404; no cover → 404; unauthenticated → 401; a cover
      file that is a symlink out of `MEDIA_ROOT` → not used (404 when nothing
      else exists); `Cache-Control: private, max-age=86400`.
- [ ] Frontend pure modules: `parseAudioUrl`/`audioUrl` round trips and
      invalid ids; queue (3 s rule both sides, advance, end, non-playable
      skipped, `jump`); player with a fake element and fake `track`: the first
      `playQueue` calls `play()` synchronously (before any microtask), every
      later switch waits for `stop()` but at most 1 s (`mock.timers`) — with
      a fake `stop()` that never resolves, the next item's `src` is set and
      its handle created after 1 s, and the old fake handle receives no
      further calls; entry normalised per the start rules; error → `headMedia`
      stub 401 → `toLogin` called, other status → status message and advance;
      German duration/percent formatting.
- [ ] Cover placeholder (`test/public/audio-cover-img.test.js`, fake DOM
      element builder): `coverId` null → placeholder glyph immediately; an
      `error` event on the `<img>` → the `<img>` is replaced by the album or
      book glyph; no `<img>` without `src` is ever left in the wrapper.
- [ ] Fixture generator: regenerating into a temp dir reproduces the committed
      tree byte for byte (paths compared after NFC); every committed path is
      NFC; `--bulk 20 <tmp>` writes 20 tracks in 2 albums, one with a 256 KiB
      APIC.

Human QA (UI check per `docs/workflow.md`, Chromium and Firefox,
`MEDIA_ROOT=test/fixtures/media`, desktop 1440 px and a ≤ 400 px viewport,
compared with the exports):

- [ ] Musik shows artist sections alphabetically ("Unbekannter Interpret"
      last); album cards show folder or embedded covers, the untagged album
      the placeholder and filename-derived titles; the loose track appears as
      "Einzeltitel"; nav "Musik" is active; two columns on the phone.
- [ ] Album detail: tracks in disc/track order, "CD 1"/"CD 2" headings on the
      double album only, the `.wma` row in muted text with "Nicht abspielbar"
      and not focusable.
- [ ] "Alle abspielen" plays; the bar shows cover, title, artist; pause, seek,
      next, previous (both sides of the 3 s rule) work; the playing row is
      highlighted; the album advances on its own.
- [ ] While music plays, clicking nav "Hörbücher", opening a book, pressing
      browser back and clicking nav "Musik" never interrupts the sound; the
      active nav entry follows; reloading `/music?album=<id>` reopens the
      album; opening it logged out returns there after login.
- [ ] Keyboard only: every bar control and row is reachable with Tab, has a
      visible `primary` focus ring, and works with Enter/Space; the seek
      slider moves with arrow keys.
- [ ] Hörbücher: "Die Reise" played to ~1:00 of its second file, stopped (tab
      closed), then opened in a second browser (other profile, same user)
      shows the progress on the card and in "Weiterhören"; "Fortsetzen" starts
      file 2 within ±10 s of 1:00.
- [ ] Finishing a book file advances to the next file; the finished file shows
      "Gehört"; the book percentage grows.
- [ ] Musik "Weiterhören": an `Unterwegs` track stopped at ~0:40 on browser A is offered on
      browser B and resumes within ±10 s; a track-row click starts at 0:00.
- [ ] Copying a new tagged MP3 into a fixture album (in a scratch copy of the
      tree) shows it in the album without restart (≤ 10 s with watcher).
- [ ] Phone viewport: the bar sits above the bottom nav, the last row is not
      hidden behind it; audiobook mode shows 15 s zurück / play-pause /
      30 s vor; lock-screen / media-key controls (Media Session) work where the
      browser supports them.
- [ ] Leaving to Filme stops playback; returning via "Fortsetzen" /
      "Weiterhören" resumes within ±10 s.
- [ ] The browser console shows no CSP violation on any audio view; DevTools
      shows no request to an external host.
- [ ] Idle RSS: `node test/helpers/make-audio-fixtures.js <tmp>/media` and
      `node test/helpers/make-audio-fixtures.js --bulk 2000 <tmp>/media`, start
      with `MEDIA_ROOT=<tmp>/media`, wait for the `audio_meta_pass` log line;
      the process RSS is
      < 100 MB on the Pi 4 — or, if the human accepts the substitute, on the
      dev machine — noted in the QA comment.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Non-conformant tags (iTunes v2.4 sizes, broken encodings, bogus sizes) crash or hang the pass | Robustness rules; readers never throw; loop guards on zero/oversized frames; per-file fallback row; fuzz-style tests with truncated and random buffers. |
| Initial pass over a large library (10 000+ files on a USB HDD) takes minutes | Sequential async I/O keeps the server responsive; items appear progressively; unchanged files are free on every later run; the pass logs count and duration. |
| Query-time grouping of all audio rows gets slow on the Pi | One indexed query per request plus in-JS grouping; if a request exceeds ~200 ms on the 2 000-track benchmark, the API issue caches the grouped result in memory keyed by the pass's completed-run counter (no schema change). |
| Every skipped song ≥ 30 s leaves an in-progress music row (H7) | Accepted at the gate; the card shows only the latest one, and "Weiterschauen" filters to video (D11). |
| Synthetic silent MP3/FLAC fixtures are rejected by a browser decoder | Standard frame layout (zero side info = digital silence; FLAC CONSTANT subframes with valid CRCs); the fixture issue verifies playback in Chromium and Firefox before merge. |
| Auto-advance blocked by autoplay policy, or suspended on a locked phone; the first `play()` losing iOS Safari's transient user activation behind a network wait | One persistent `<audio>` unlocked by the initial click; the first `play()` runs synchronously in the click with prefetched data (resume-album prefetch); later switches wait for `stop()` at most 1 s; Media Session handlers; iOS background behaviour checked at QA and documented if limited. |
| Sibling-phase export names drift (P2's `startLibrary` variable in `server.js`, P4's `progress.js` helper names) | Semantics are fixed by D4–D11; an issue adapts only the imported name to the merged code, never the behaviour, and records it in the Decision log. |
| Pass still running during shutdown hits a closed DB | The run checks `db.isOpen` and ends quietly (no error-level line, same as Phase 6); the index is derived and the next start re-runs stale rows. |

## Decision log

- 2026-09-26: Music grouping by directory, display by tags (Navidrome-style
  tags-first display, folder identity against split/merged albums).
- 2026-09-26: Audiobooks folder-first for book title/author — deliberate
  deviation from Audiobookshelf's default metadata priority because our
  grouping requires curated Author/Book folders.
- 2026-09-26: Disc folders `CD|Disc|Disk <n>` adopted from Audiobookshelf's
  directory-structure docs for both music and audiobooks.
- 2026-09-26: Cover priority folder → embedded adopted from Navidrome's default
  `CoverArtPriority`, minus the external step (no outbound calls).
- 2026-09-26: M4A/Ogg tags out, per roadmap row and prior-art verdict; files
  still listed and playable.
- 2026-09-26: cross-phase consolidation — scan hook is P2's `onScanComplete`
  (D6); review BLOCKING-1 (enrichers) superseded; no orphan delete (FK
  cascade); `AUDIO_META_VERSION` + `meta_version` column for re-derivation;
  `src/server.js` gets one registration line.
- 2026-09-26: cross-phase consolidation — every music/audiobooks item gets an
  `audio_meta` row; compat (P2) is the single owner of extensions,
  playability and MIME (D9); review BLOCKING-2 resolved.
- 2026-09-26: cross-phase consolidation — start positions via entry
  normalisation, `trackPlayback` seeks, P5 never sets initial `currentTime`
  (D11); review BLOCKING-3 resolved.
- 2026-09-26: cross-phase consolidation — audio section on `/music` and
  `/audiobooks` with `pushState` and `setActive`, no nav edits, no redirect
  stubs, `/audio` dropped (D1, D14); review BLOCKING-4 resolved.
- 2026-09-26: cross-phase consolidation — cover route in `src/api/cover.js`
  with `Cache-Control` through `sendMedia`'s `cacheControl`; embedded slices
  through `sendMedia`'s `slice` option (D10, see the review-resolution entry
  below).
- 2026-09-26: cross-phase consolidation — migration 004 STRICT, no
  transaction statements, depends only on 002 (D12); architecture edits listed
  in scope (D13); category ids `music`/`audiobooks` (D3); P1 server/frontend
  contracts used verbatim (D4, D5).
- 2026-09-26: gate decision — H7: music resume = B; music tracks write Phase 4
  progress rows, the Musik "Weiterhören" card is the latest `in_progress`
  music row, track clicks start at 0; `music_session`, its endpoints and its
  issue dropped; review BLOCKING-5 moot. OPEN-1 removed.
- 2026-09-26: gate decision — H8: player persistence = A on the Phase 1 URLs
  exactly as D14. OPEN-2 removed.
- 2026-09-26: gate decision — H3: phone grid always ≥ 2 columns via the
  `min(var(--grid-min), calc(50% - …))` rule, applied to album and book grids.
- 2026-09-26: Pre-mortem — breakpoint 768 px replaces the draft's 600 px
  (D5 literal rule); unknown names are `null` in JSON and rendered in German
  by the UI; P2's `cleanName` not used for audio titles; pseudo-albums ignore
  tags for group display; `coverId` = first playable member; book derivation
  ignores Phase 4 `none` rows; symlinked cover files skipped; the directory is
  guarded before `readdir`; bar spacer via `ResizeObserver`; no page-level
  keyboard shortcuts; no first-scan state; frontend imports are relative;
  API split into `music.js` and `audiobooks.js`, progress joins into
  `src/db/audio-progress.js`, so the metadata issues do not wait for Phase 4.
- 2026-09-26: Review non-blocking findings applied — off-token shade note,
  muted text instead of opacity, seek hit area ≥ 44 px, legible 15/30 labels,
  STRICT tables, idle-RSS QA line, external references added to
  `docs/prior-art.md` in this PR; the Subsonic `savePlayQueue` reference is
  dropped because H7 removed the music session.
- 2026-09-26: spec-acceptance review resolutions (blocking) — embedded cover
  slices are served by Phase 3's `sendMedia(req, res, { path, contentType,
  cacheControl, slice: { offset, length } })`; `src/http/slice.js`,
  `sendSlice` and `test/http/slice.test.js` dropped; the Phase 3 contract in
  Constraints quotes P3's full signature (`idleTimeoutMs`, `slice`,
  `openFile`, returned `{ status, aborted, error }`); slice behaviour (bytes,
  206/416 relative to the slice, HEAD, past-EOF → 404) tested at route level
  in `test/api/cover.test.js`. D10 ("same range logic") wins over the draft's
  own-file rationale: one streaming implementation.
- 2026-09-26: spec-acceptance review resolutions (non-blocking) — declared
  deviations: shared `public/js/audio/` + `audio*.css` for both pages, custom
  control bar over a hidden `<audio>` (both recorded in `docs/architecture.md`);
  the pass ends quietly on `db.isOpen === false` (Phase 6 alignment); ids must
  also be safe integers (Phases 3/6); progress bars `var(--space-1)` (D5);
  first `play()` synchronous with a resume-album prefetch, later switches wait
  for `stop()` at most 1 s; `--bulk <n> <dir>` fixture mode and an exact
  idle-RSS command; export counts ("2 Alben", "8 Hörbücher") adopted and the
  "Fortsetzen" pill kept as a non-interactive label inside the card button;
  test-seeding wording "001, 002, 004, plus 003"; fixture paths committed and
  compared in NFC, canonical `Hörbücher/` kept.
- 2026-09-26: pre-mortem — the Musik "Weiterhören" QA check at 0:40 was
  impossible with 60 s tracks (remaining 20 s = finished under the audio
  rule); the `Unterwegs` fixture tracks are 120 s.
- 2026-09-26: cross-phase consolidation — the music resume threshold is a
  bound parameter: `getLatestMusicResume(db, { userId, startThreshold })`
  with `src/api/music.js` passing Phase 4's `START_THRESHOLD_S`, and
  `deriveBookProgress` imports `START_THRESHOLD_S` for its "counted" rule;
  no literal 30 in P5 SQL or resume code. Resolves the second
  spec-acceptance review's blocking finding (conflict with Phase 4's
  repository rule); threshold-binding tests added to Verification.
- 2026-09-26: second spec-acceptance review, non-blocking findings applied —
  cover verification reworded (PictureRefs are never stored: a
  `deps.readPicture` stub returns a ref past EOF → 404 via `sendMedia`'s
  slice check); the player's 1 s switch cap relies on Phase 4's `stop()`
  dispatching its report and detaching listeners/timers synchronously before
  its first await (recorded as an assumption, verified by the player issue,
  a deviation is fixed in Phase 4's module, never worked around), plus a
  never-resolving `stop()` test; `cover-img.js` behaviour decided
  (placeholder glyph on error or null id, used by every cover surface; Media
  Session artwork falls back to the browser default); `headMedia(id) →
  Promise<number>` semantics and default fixed; audio pages carry no
  `data-category` and use Phase 1's `{Seite} · Videothek` title form (the
  draft's " – Videothek" aligned); `getLatestMusicResume` requires
  `playable = 1` and the resume `start` travels on the queue item; *L* is
  chosen among playable files only; bar offset below 768 px includes
  `env(safe-area-inset-bottom)` like Phase 1's `main` padding; upper-case
  cover extensions rely on Phase 3's lower-casing `mediaTypeFor`.
- 2026-09-26: implementation (#60, `src/library/tags/flac.js`) — `readFlac`
  returns Vorbis fields as raw, trimmed strings keyed by the upper-cased tag
  key exactly as found (e.g. a literal `ALBUM ARTIST` key survives with its
  space); numeric/`"n/total"`/year normalisation from the "Fields read" row is
  left to the future `src/library/tags/index.js` mapping (out of this issue's
  files), matching the Reader interfaces row's `Record<string, string>` type.
  A repeated Vorbis key keeps its first non-empty value, including across a
  malformed file's repeated VORBIS_COMMENT blocks (mirrors ID3's multi-value
  rule without assuming FLAC's `\0`-separation). Each STREAMINFO/
  VORBIS_COMMENT/PICTURE content read is additionally clamped to the bytes
  left in the budget (on top of its own per-type cap), so total I/O honours
  the 256 KiB row exactly bar the handful of fixed 4-byte block-header reads
  already in flight when the budget crosses zero. PICTURE selection tracks
  the first type-3 and the first non-type-3
  block separately and prefers the former, so ordering never matters. The
  fixture builder (`test/helpers/flac-fixture.js`) writes real, correctly
  CRC'd (CRC-8/CRC-16, poly `0x07`/`0x8005`) CONSTANT-subframe frames using
  the "value from STREAMINFO" codes for sample rate and bit depth and the
  16-bit-follows block-size code, restricted to mono/stereo and
  `bitsPerSample` a multiple of 8 — sufficient for this issue's silent test
  fixtures and for reuse by the later `make-audio-fixtures.js` issue.
- 2026-09-26: issue #61 implementation — `parseMusicPath`/`parseAudiobookPath`
  are fully self-contained (each duplicates its own small `cleanFileName` /
  `discFolderNumber` helpers rather than importing a shared module), since the
  issue's Files list fixes exactly the parser + test file pairs and no shared
  helper file is listed; the category folder segment (`relPath.split('/')[0]`)
  is never matched by name, so alias handling (`Musik`/`Music`,
  `Hörbücher`/`Hoerbuecher`) needs no special-casing in the parsers. The
  "empty result → the raw stem" filename-cleaning rule is reachable only via a
  numbered stem whose captured title is pure whitespace (e.g. `"12  .mp3"`,
  covered by a test) — genuine empty captures cannot occur because
  `(.+)` requires at least one character.
- 2026-09-26: `src/library/audio-groups.js` (#62) — the "Group assembly" row
  names no total-duration field, so `buildAlbums`/`buildBooks` add
  `durationMs` to each group object (sum of known member `durationMs`, `null`
  when none is known) alongside `{ id, coverId, groupKey, title, artist/
  author, members }`, since #68/#69 need one summed total and this module is
  "one implementation ... for both APIs". Pseudo-albums (`groupTitle` null)
  also get `year: null` — "ignore tags for group display" is read to cover
  the tag-derived year like it covers title/artist, not just the two fields
  the row names explicitly.
- 2026-09-27: issue #71 implementation (`public/js/audio/{queue,player,format}.js`)
  — verified the Phase 4 `progress.js` merged on main: `stopTracker` sets
  `stopped`, clears the interval and removes every listener before calling
  `report()` (unawaited), so `stop()` dispatches its report and detaches
  listeners/timers synchronously before its first await exactly as this
  issue requires; no Phase 4 fix needed. `createQueue`'s `startIndex` rule
  ("a non-playable start item → the next playable one") is read as a forward
  search from `startIndex` that wraps to the start of `items` when no
  playable item follows, so a queue always has a current item whenever any
  member is playable — the row does not name this edge case. The player's
  bounded switch is implemented as `raceWithTimeout(outgoing.stop(), 1000)`
  (a manual race that clears the 1 s timer once `stop()` wins) rather than
  the row's literal `Promise.race([prev.stop(), delay(1000)])`, to avoid
  leaking a pending timer on every fast switch; behaviour (wait for `stop()`,
  capped at 1 s, old handle never called again) is unchanged and covered by
  the never-resolving-`stop()` test. `formatPercent(null)` — not named in the
  "German formatting" row — returns `'–'` (no `%`), matching the `–:–`
  placeholder style of `formatDuration`/`formatTotal`.
- 2026-09-27: PR #126 review resolutions (issue #71) — blocking: `goTo`'s
  in-flight switch is now guarded by a monotonic `switchToken` rather than by
  reading `state.handle === null` as "first play"; `state.handle` keeps
  pointing at the outgoing handle for the whole bounded wait (it is no longer
  cleared up front), so a second switch requested inside that window (a
  double next/previous, a row click, `playQueue`, or the outgoing item's own
  `ended`/`error` firing mid-wait) is never mistaken for the page's first
  play, and a switch superseded before its wait settles starts nothing —
  it creates no handle, so none is left unstopped. Non-blocking, applied:
  `onError` re-reads `state.queue`/`current()` after its `HEAD` `await` and
  drops a stale error (the user having switched away meanwhile) instead of
  advancing from, or showing a message for, the wrong item; `formatPercent`
  rounds to 1e-4 of a percentage point before flooring, since
  `Math.floor(fraction * 100)` (the row's literal formula) mid-floors an
  exact fraction on a binary-float artefact (e.g. `0.29 * 100 ===
  28.999999999999996`) — the visible contract (floored whole percent) is
  unchanged, only the float rounding underneath it; `defaultHeadMedia` gained
  direct test coverage via a stubbed `globalThis.fetch`.
