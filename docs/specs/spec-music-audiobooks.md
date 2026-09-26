# Spec: Music & audiobooks

> Created: 2026-09-26

Makes every audio file under `Musik/` and `Hörbücher/` browsable and playable in
the browser: minimal in-house ID3v2 + FLAC tag readers, folder-convention
parsers, a post-scan audio metadata pass (migration 004), cover art, an audio
section with a persistent bottom-bar player and album/book queue, and audiobook
resume on top of the Phase 4 progress API. This spec carries no lifecycle
state — acceptance is the spec merged on the default branch with a milestone and
issues, and all progress lives in the GitHub issues and milestone. A completed
spec is moved to `docs/specs/archive/`.

## Outcome

- [ ] An MP3 or FLAC file copied into `Musik/<Artist>/<Album>/` appears in the
      Musik section inside its album, with title, artist, album, album artist,
      track/disc order, year and duration taken from its tags — without a
      restart, within the Phase 2 freshness bounds (≤ 10 s with a working
      watcher, at the latest after the periodic rescan).
- [ ] Audio files without readable tags (untagged MP3/FLAC, and all M4A/M4B,
      Ogg/Opus, WAV, …) still appear, grouped and ordered by the folder/filename
      conventions below; formats the Phase 2 compatibility table marks as not
      playable are listed with a "Nicht abspielbar" badge and are never queued.
- [ ] Album and book covers are shown from a folder image or from the embedded
      picture via `GET /media/:id/cover`; items without any cover show the
      placeholder without a broken-image icon.
- [ ] Musik: artist sections with album cards → album detail with track list;
      "Alle abspielen" or a track click plays the album as a queue in the
      persistent bottom bar (play/pause, previous/next, seek, auto-advance).
      Switching between any Musik and Hörbücher view never interrupts playback.
- [ ] Hörbücher: book grid with per-book progress and a "Weiterhören" row →
      book detail with per-file progress; "Fortsetzen" starts the book at the
      last file and position — also on a second device, within ±10 s of where
      it was stopped on the first (vision success criterion "Resume").
- [ ] Musik "Weiterhören": the last music track a user was playing, and its
      position, is offered on any device and resumes within ±10 s
      (per OPEN-1, recommended option C).
- [ ] The metadata pass never reads more than 256 KiB of any audio file and
      never loads picture payloads during scanning; the service still meets the
      vision's idle-RSS criterion.
- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- Tag readers `src/library/tags/id3v2.js` (ID3v2.3 + ID3v2.4),
  `src/library/tags/mpeg.js` (MP3 duration), `src/library/tags/flac.js`
  (STREAMINFO, VORBIS_COMMENT, PICTURE) and the central tag→field mapping
  `src/library/tags/index.js` (the only module that opens audio files for tag
  reading).
- Folder-convention parsers `src/library/parsers/music.js` and
  `src/library/parsers/audiobook.js` (pure functions: relative path → group
  key, fallback titles, track/disc numbers).
- Audio metadata pass `src/library/audio-meta.js`, run after every completed
  Phase 2 scan; migration `src/db/migrations/004-audio-meta.sql`; repository
  `src/db/audio-repo.js`.
- Group assembly `src/library/audio-groups.js` (pure: member rows → albums /
  books with the display precedence below), API module `src/api/audio.js`
  (`registerAudioRoutes(router, deps)`), resume logic
  `src/api/audio-resume.js`, cover route `GET /media/:id/cover`
  (`src/api/cover.js` over `src/library/cover.js`).
- Audio section: `public/audio.html` (served at `/audio`), `public/js/audio/**`,
  `public/css/audio.css` — four views (music overview, album detail, audiobook
  grid, audiobook detail), persistent bottom-bar player with queue, Media
  Session integration, audiobook progress reporting through the Phase 4 client,
  music session reporting.
- Category nav: "Musik" and "Hörbücher" entries point to `/audio#/musik` and
  `/audio#/hoerbuecher`; Phase 1's placeholder pages `public/music.html` and
  `public/audiobooks.html` become static redirects to those URLs.
- Synthetic, browser-decodable fixture tree under
  `test/fixtures/media/Musik/` and `test/fixtures/media/Hörbücher/`, produced by
  committed test helpers.
- `docs/architecture.md` updated for the new components and flow.

### Out of scope

- Tags in M4A/M4B/MP4 atoms, Ogg/Opus Vorbis comments, ID3v1, ID3v2.2, APE,
  WAV/AIFF chunks — those files play and are listed via folder/filename
  fallback (roadmap row and prior art name ID3v2 + FLAC only; candidate for a
  later phase).
- Chapter markers inside a single file (ID3 `CHAP`, MP4 chapter tracks): a
  single-file book is one entry in the file list.
- Gapless playback, crossfade, shuffle, repeat, playlists, playback speed, sleep
  timer, volume slider, lyrics, ReplayGain, genres, multi-artist/role modelling,
  search/filter, A–Z index.
- Audiobook series grouping (`Author/Series/Book` works, the series folder is
  ignored for display).
- Playback continuing while navigating to Filme, Serien, Bilder or admin pages
  (see OPEN-2).
- Server-side cover resizing, online cover/metadata lookups, transcoding
  (vision/constitution).
- Showing audio items in the Phase 4 "Weiterschauen" row — audio resume lives in
  the audio section.

## Constraints

- Constitution applies unchanged: zero runtime dependencies, read-only
  `MEDIA_ROOT`, path guard on every request-derived path, `fs.createReadStream`
  for media bytes, prepared statements only, max 60 lines/function and
  300 lines/file, JSDoc on every export, a test file per new `src/` module,
  failure-case tests for path containment and auth, German UI copy, no
  `innerHTML` with unescaped data, no outbound calls.
- Architecture boundaries: `src/library/` knows nothing about HTTP or users;
  `src/api/` knows nothing about file formats; `src/db/` is the only place with
  SQL; API clients reference media by index id, never by path.
- Builds on Phase 1 (router + `src/http/routes.js` registration, migration
  runner that applies gaps, `requireUser`, nav component in `public/js/lib/`,
  `tokens.css`, pages served as `/<name>` → `public/<name>.html`, a CSP that
  forbids inline `style` attributes — dynamic widths such as progress bars are
  set through CSSOM `el.style`, never through markup), Phase 2
  (`library_items`, category classification of `Musik/` and `Hörbücher/` —
  category values as Phase 2 names them, recommended `music`/`audiobooks` —
  `playable` flag, scanner/watcher and its generic post-scan hook), Phase 3
  (`src/media/paths.js` guard, `src/http/stream.js`, `GET /media/:id` with the
  MIME map `src/http/media-types.js` already covering mp3, m4a, m4b, aac, flac,
  ogg, oga, opus, weba, wav; a paused stream is idle-disconnected after 60 s
  and re-requested by the browser), Phase 4 (progress table from migration 003
  **keyed by `rel_path`** per user, `GET/PUT /api/progress/:id`, the server-side
  audio finished rule "within the last 30 s", `GET /api/progress?category=…`,
  and the client `public/js/lib/progress.js`
  `trackPlayback(media, id, { entry, onResume })` → `{ stop() }`).
- Raspberry Pi 4 target: bounded reads per file, files processed sequentially
  with async I/O, no whole-file reads, no in-memory picture buffering.

## Design

Committed Stitch exports (layout references; the implementer builds with
vanilla HTML/CSS and `public/css/tokens.css` only — exported HTML is never
copied verbatim, see `docs/design.md`):

| Screen | Mobile | Desktop |
|---|---|---|
| Musik overview (artist sections, "Weiterhören" card) | `docs/design/assets/music-audiobooks/music-overview-mobile.png` | `docs/design/assets/music-audiobooks/music-overview-desktop.png` |
| Album detail + playing bar | `docs/design/assets/music-audiobooks/music-album-mobile.png` | `docs/design/assets/music-audiobooks/music-album-desktop.png` |
| Hörbücher grid | `docs/design/assets/music-audiobooks/audiobook-grid-mobile.png` | `docs/design/assets/music-audiobooks/audiobook-grid-desktop.png` |
| Book detail + playing bar (audiobook mode) | `docs/design/assets/music-audiobooks/audiobook-detail-mobile.png` | `docs/design/assets/music-audiobooks/audiobook-detail-desktop.png` |

Exported HTML sits next to each PNG (it loads a CSS CDN and is never served or
copied). Working reference only: Stitch project `videothek`, screens titled
`P5 …`. The designs show the recommended options of OPEN-1 (music
"Weiterhören" card) and OPEN-2 (bar shared by both sections). Most exports
predate the switch of the `primary` token and show the old accent colour; the
colour always comes from `public/css/tokens.css`. Where a PNG and this spec
disagree, the spec wins — known gaps: the Hörbücher grid exports lack the
"Weiterhören" row, the desktop audiobook bars show a volume control (out of
scope), and exact bar controls per mode follow the Bar controls row.

## Prior art

- [Music and audiobook tag reading (Phase 5)](../prior-art.md#music-and-audiobook-tag-reading-phase-5)
  — central tag→field mapping table, fast scan separated from deeper analysis,
  in-house minimal ID3v2 + FLAC parsers; drives the reader/mapping split and the
  post-scan metadata pass.
- [Playback progress and resume (Phase 4)](../prior-art.md#playback-progress-and-resume-phase-4)
  — one progress row per (user, item); audiobook files reuse it per file, book
  resume is derived.
- [HTTP range streaming (Phase 3)](../prior-art.md#http-range-streaming-phase-3)
  — audio playback reuses `GET /media/:id`; folder covers reuse the stream
  helper.
- [Direct-play compatibility detection (Phase 2)](../prior-art.md#direct-play-compatibility-detection-phase-2)
  — the `playable` flag for MP3, M4A/AAC, FLAC, Ogg/Opus decides what is queued.
- [Library model and naming conventions (Phase 2)](../prior-art.md#library-model-and-naming-conventions-phase-2)
  — same "small in-house regex set, no provider machinery" stance for the audio
  folder conventions.
- External references consulted for this spec (not yet in `docs/prior-art.md`;
  add them when the implementing PR touches that file):
  Navidrome artwork resolution — default `CoverArtPriority` is
  `cover.*, folder.*, front.*, embedded, external`
  (https://www.navidrome.org/docs/usage/library/artwork/);
  Audiobookshelf book directory structure — `{Author}/{Book}` or
  `{Author}/{Series}/{Book}`, single-file books allowed, disc subfolders named
  `Disc`/`CD`/`Disk` + number, files ordered by disc and track
  (https://audiobookshelf.org/docs/documentation/libraries/book-library/directory-structure/,
  https://www.audiobookshelf.org/guides/book-scanner/);
  Subsonic `savePlayQueue`/`getPlayQueue` — per-user saved queue, current track
  and position for moving between clients (http://www.subsonic.org/pages/api.jsp).

## Human prerequisites

- none. QA runs against the committed fixture tree; a smoke test against a real
  music/audiobook library is optional.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| **Music folder convention:** `Musik/<Artist>/<Album>/[<Disc folder>/]<NN> <Title>.<ext>`. A *disc folder* is a directory named `CD`, `Disc` or `Disk` + optional space + number (case-insensitive, regex `^(cd\|disc\|disk)\s*\d+$`). The **album (group) = the directory containing the file**, rolled up once over a disc folder. Loose tracks directly in an artist folder form one pseudo-album of that folder; tracks directly in `Musik/` form one pseudo-album of the root. | Folder identity never splits compilations (differing per-track artists) and never merges two same-named albums of different artists — both failure modes of tag-based grouping. Disc-folder names follow the Audiobookshelf convention. | 2026-09-26 |
| **Music precedence — tags win for display, path wins for grouping.** Per track: title = tag title ?? filename without extension and without a leading track number (`^\d{1,3}[\s._-]+`); track = tag ?? leading filename number; disc = tag ?? disc-folder number ?? 1. Per album (from the first track in play order): title = tag album ?? album folder name (or `Einzeltitel` for depth ≤ 1 pseudo-albums); artist = tag album artist ?? the track-artist tag if identical on all tracks ?? artist folder name ?? `Unbekannter Interpret`; year = first non-null tag year. | Navidrome precedent (tags are the source of truth for music); well-maintained music tags carry characters and ordering that folder names often lose. Grouping stays folder-based (row above). | 2026-09-26 |
| **Audiobook folder convention:** `Hörbücher/<Author>/<Book>/[<Disc folder>/]<files>` (multi-file) or `Hörbücher/<Author>/<Book>.<ext>` / `Hörbücher/<Book>.<ext>` (single-file). **Book (group) = directory containing the file, rolled up over a disc folder — unless that directory is `Hörbücher/` itself or an author folder (depth ≤ 1): then the file alone is the book.** `Author/Series/Book/…` works (book = `Book`, author = first segment). A multi-file book without an author folder is not supported (its files would appear as single-file books) — documented convention. | Mirrors Audiobookshelf's `{Author}/{Book}` / `{Author}/{Series}/{Book}` structure and single-file-book rule; a depth rule is deterministic without reading tags. | 2026-09-26 |
| **Audiobook precedence — folder wins for book title/author, tags win for file titles.** Book title = book folder name (single-file: filename without extension); author = first path segment under `Hörbücher/` when the book is below an author folder, else `Unbekannter Autor`. File title = tag title ?? cleaned filename (as for music). | Deliberate deviation from Audiobookshelf's default (tags over folder): our grouping *requires* the Author/Book folders, so they always exist and are curated, while CD-rip audiobook tags commonly carry disc suffixes ("… CD 1") or the narrator as artist. | 2026-09-26 |
| **Play order within a group:** disc ascending, then track ascending (missing = after numbered), then natural filename order (`localeCompare(a, b, 'de', { numeric: true, sensitivity: 'base' })`). Artists and books sort with the same collator; albums within an artist by year (missing last), then title. | Audiobookshelf sorts by disc and track; filename tiebreak keeps untagged sets deterministic. | 2026-09-26 |
| **Audio extensions handled by the pass:** `.mp3 .flac .m4a .m4b .aac .ogg .oga .opus .wav .wma .aif .aiff .ape .mka`. Other files under `Musik/`/`Hörbücher/` (images, `.cue`, `.nfo`, …) never get an `audio_meta` row and never appear, whatever Phase 2 indexed. Playability is Phase 2's `library_items.playable`, never re-decided here. | Keeps cover images and sidecar files out of track lists independent of Phase 2 filtering; one owner for the compatibility decision. | 2026-09-26 |
| **Tag formats: ID3v2.3/2.4 (MP3 and ID3-prefixed FLAC) and FLAC metadata only.** M4A/M4B atoms, Ogg comments, ID3v1, ID3v2.2 and APE are out (see Out of scope). | Roadmap row "ID3v2/FLAC tag readers" and prior-art verdict "in-house minimal ID3v2 + FLAC parsers"; everything else still plays via path fallback. | 2026-09-26 |
| **Fields read:** title, artist, album, album artist, track number, disc number, year, front-cover picture location. ID3v2 frames `TIT2`, `TPE1`, `TPE2`, `TALB`, `TRCK`, `TPOS`, `TDRC` (2.4) / `TYER` (2.3), `APIC`. FLAC Vorbis keys (case-insensitive) `TITLE`, `ARTIST`, `ALBUMARTIST` / `ALBUM ARTIST` / `ALBUM_ARTIST`, `ALBUM`, `TRACKNUMBER`, `DISCNUMBER`, `DATE` / `YEAR`, and `PICTURE` blocks. Parsing rules: text encodings 0 (ISO-8859-1), 1 (UTF-16 with BOM), 2 (UTF-16BE), 3 (UTF-8); first value of multi-value (`\0`-separated) frames; `"n/total"` → `n`; year = first four digits; trim; empty → null. Pictures: prefer type 3 (front cover), else the first; only `image/jpeg`, `image/png`, `image/webp` (`image/jpg` normalised to `image/jpeg`); ≤ 10 MiB. | Prior art: one central tag→field mapping table; the listed fields are exactly what the views show. | 2026-09-26 |
| **ID3v2 robustness rules:** header `ID3` + version 3 or 4; synchsafe tag size; skip the extended header; v2.3 whole-tag unsynchronisation → de-unsync the read buffer (pictures in unsynchronised tags/frames are ignored); v2.4 frame sizes synchsafe, with fallback to plain big-endian when the synchsafe reading yields an invalid next frame id (iTunes writer bug); compressed or encrypted frames skipped; frame walk stops at padding (`\0` id), an invalid id, or a size past the tag end. Readers never throw on malformed input — they return what they could parse (or `null`). | Real-world tag corpora contain these defects; the pass must never abort on one bad file. | 2026-09-26 |
| **Duration without decoding:** FLAC = `total_samples / sample_rate` from STREAMINFO (null when total samples is 0). MP3 = locate the first valid MPEG audio frame header (MPEG-1/2/2.5 Layer III) within 64 KiB after the ID3v2 tag; if a `Xing`/`Info` header with the frames flag is present → `frames × samples_per_frame / sample_rate`; else a `VBRI` header → same formula; else CBR estimate `(file_size − audio_start) × 8 / bitrate`. Other formats and failures → `duration_ms` NULL; the API then falls back to the duration the browser reported in the Phase 4 progress row, else shows `–:–`. | Exact for FLAC and LAME/Xing-tagged MP3 (the common case), cheap estimate otherwise; no decoding, no child process. | 2026-09-26 |
| **Read budget:** a reader works on `readAt(position, length) → Promise<Buffer>` (short buffer at EOF). Per file at most **256 KiB** are read in total; ID3v2 frames are walked in chunks of ≤ 64 KiB and frame bodies larger than the chunk are skipped by offset — for `APIC` only the first 512 bytes of the body are read to locate the image data; FLAC blocks other than STREAMINFO/VORBIS_COMMENT/PICTURE are skipped by offset, a VORBIS_COMMENT block > 64 KiB is skipped, a PICTURE block is read only up to 4 KiB. Budget exhaustion ends parsing with the partial result. Files are processed one at a time. | Covers are often 0.5–5 MB inside the tag; the brief's "read only the first N KB" is met without losing frames after the picture. Sequential async reads keep a USB disk on a Pi responsive. | 2026-09-26 |
| **Reader interfaces (contract between issues):** `readId3v2(readAt) → Promise<{ version, fields: Record<string,string>, picture: PictureRef \| null, tagEnd: number } \| null>` (fields keyed by frame id); `readMpegDurationMs(readAt, audioStart, fileSize) → Promise<number \| null>`; `readFlac(readAt, fileSize) → Promise<{ fields: Record<string,string>, picture: PictureRef \| null, durationMs: number \| null } \| null>` (fields keyed by upper-cased Vorbis key; skips a leading ID3v2 tag itself without importing `id3v2.js`); `PictureRef = { offset, length, mime }` in absolute file bytes. `src/library/tags/index.js` exports `readAudioTags(absPath) → Promise<AudioTags>` (dispatch by extension, budgeted file-backed `readAt`, central mapping to `{ title, artist, albumArtist, album, trackNo, discNo, year, durationMs, format, picture }`, all nullable) and `readPictureRef(absPath)`. | Lets the ID3v2, FLAC and mapping issues be built and tested in parallel against buffer-backed `readAt` fakes. | 2026-09-26 |
| **Metadata pass separate from the Phase 2 scan:** `refreshAudioMeta({ db, mediaRoot, log })` in `src/library/audio-meta.js` runs after every completed scan (startup, watcher, periodic rescan): (1) delete orphan rows (item gone or no longer music/audiobook); (2) select music/audiobook items with an audio extension whose `audio_meta` row is missing or whose `source_mtime_ms`/`source_size` differ from `library_items.mtime_ms`/`size`; (3) per item: absolute path via the Phase 3 path guard, parser + `readAudioTags` → upsert. A failing file is logged by relative path (no tag content) and still gets a path-fallback row. Single-flight: a call during a running pass sets a rerun flag. Phase 2's `library_items` rows are not modified. | Prior-art ADOPT "fast scan pass separated from deeper analysis"; staleness by (mtime, size) makes unchanged files free on rescans; the fallback row guarantees every audio file appears. | 2026-09-26 |
| **Scan hook:** `refreshAudioMeta` is registered once, at startup in `src/server.js`, through Phase 2's generic post-scan hook — the same hook Phase 6 uses for image metadata (named as Phase 2 defines it, e.g. `onScanComplete(listener)`). `scanner.js` and `watcher.js` are not edited. The pass is single-flight, so it works whether the hook awaits listeners or fires and forgets. | One registration point shared with Phase 6; no ad-hoc edits to a module owned by another phase. | 2026-09-26 |
| **Migration 004 (`src/db/migrations/004-audio-meta.sql`):** see schema below. Items appear in the audio views only once they have an `audio_meta` row (inner join) — seconds after the scan. | Separate table keyed by `item_id` avoids depending on Phase 2's grouping columns; group-level values are computed at query time from member rows. | 2026-09-26 |
| **Groups are addressed by any member item id** — album id / book id in URLs and JSON = the id of its first item in play order, and every endpoint accepts *any* member id and resolves the group via `group_key`. No group table, no paths in URLs. | Architecture: "API clients reference media by index id, never by raw path". A bookmark survives added tracks; it 404s only when that very file is removed (acceptable). | 2026-09-26 |
| **API (all behind `requireUser`, JSON, errors `{ "error": "<code>" }`, 404 `not_found` for an id that is not a music/audiobook item with metadata):** `GET /api/music` → `{ session, artists: [{ name, albums: [{ id, title, year, trackCount, coverId }] }] }`; `GET /api/music/albums/:id` → `{ id, title, artist, year, coverId, durationMs, tracks: [{ id, title, artist, trackNo, discNo, durationMs, playable }] }`; `PUT /api/music/session` body `{ trackId, positionS }` → 204 (400 `invalid_body`, 404 unknown track); `DELETE /api/music/session` → 204; `GET /api/audiobooks` → `[{ id, title, author, fileCount, durationMs, coverId, progress: { fraction, finished, lastPlayedAt } \| null }]`; `GET /api/audiobooks/:id` → `{ id, title, author, coverId, durationMs, state, resume: { itemId, positionS }, progress: { fraction } \| null, files: [{ id, title, durationMs, playable, progress: { positionS, durationS, finished } \| null }] }`. `coverId` = the group's first item id. | One module `src/api/audio.js`; shapes fixed here so API and views are built in parallel. | 2026-09-26 |
| **Audiobook resume = per-file Phase 4 progress, book state derived** (`src/api/audio-resume.js`, pure): no rows → `state: "new"`, resume first playable file at 0; latest row (max `updated_at`) unfinished → `"in_progress"`, resume that file at its position; latest row finished → next playable file after it at its saved position (0 if none); if no file follows → first unfinished playable file; all playable files finished → `"finished"`, resume first file at 0 (button "Von vorn hören"). `fraction` = Σ min(position, duration) (finished files count fully) ÷ Σ duration over files with a known duration; null when the total is 0. Progress rows are read in `src/db/audio-repo.js` by joining the Phase 4 table on (user, `rel_path`) — `finished` is the Phase 4 server rule (within the last 30 s), never recomputed here. The "Weiterhören" row and `lastPlayedAt` are derived from these rows per book, not from the per-file `GET /api/progress?category=…` list. | Phase 4 stores one row per (user, `rel_path`); multi-file books resume at "last file + position" without a book-level table. Last-write-wins matches the Phase 4 prior art. Keying by `rel_path` survives item-id churn (e.g. a temporarily unmounted disk). | 2026-09-26 |
| **File-row click in a book** starts that file at its saved position if it is unfinished, else at 0; the queue continues with the following files. **Track-row click in an album** always starts at 0. | Audiobook listeners return to a chapter to continue it; music listeners pick a song to hear it. | 2026-09-26 |
| **Progress reporting:** audiobook files report through the Phase 4 client — `trackPlayback(audio, itemId, { entry, onResume })` per file, and `stop()` on the previous handle before every queue switch (advance, previous/next, new queue, row click). The start position is decided by this spec's rules from the book API and the bar seeks itself; anything offered through `onResume` must not override it. Music tracks never write Phase 4 progress rows; the bar reports the music session (`PUT /api/music/session`) every 10 s while playing, on pause, on track change and on `pagehide` (`fetch` with `keepalive`), and sends `DELETE /api/music/session` when the queue ends. | Keeps song skips out of the progress table and out of "Weiterschauen"; same 10 s cadence as Phase 4 so the ±10 s criterion holds. | 2026-09-26 |
| **Queue semantics** (`public/js/audio/queue.js`, pure and unit-tested): a queue is one album or one book; only playable items are enqueued; "previous" within the first 3 s goes to the previous item, otherwise restarts the current one; `ended` advances; the end of the queue stops and keeps the bar visible with the last item; an item that fails to load shows "Titel konnte nicht abgespielt werden" in the bar and advances. One persistent `<audio preload="metadata">` element is reused for every item (autoplay unlock carries over from the initial user gesture). | Standard player behaviour; reusing the element avoids autoplay blocks on auto-advance. | 2026-09-26 |
| **Bar controls:** music mode = previous, play/pause, next, seek slider with elapsed/total, cover, title + artist. Audiobook mode = additionally "15 s zurück" and "30 s vor"; on viewports < 600 px audiobook mode shows 15 s zurück / play-pause / 30 s vor (previous/next file stay reachable in the file list). Seek is `<input type="range">`; all controls are `<button>`s with German `aria-label`s ("Wiedergabe", "Pause", "Vorheriger Titel", "Nächster Titel", "15 Sekunden zurück", "30 Sekunden vor", "Position"). The bar is hidden until something plays. On mobile it sits directly above the Phase 1 bottom nav; `main` gets bottom padding so the last rows stay reachable. | design.md: audio player = persistent bottom bar on `secondary`; ≥ 44 px targets; keyboard reachable. | 2026-09-26 |
| **Media Session API:** metadata (title, artist or book title, album, artwork `/media/<coverId>/cover`), handlers play, pause, previoustrack, nexttrack, seekbackward/seekforward (15 s / 30 s), seekto, plus `setPositionState`. | Built-in browser API (no dependency) giving lock-screen and hardware-key control on phones. | 2026-09-26 |
| **Audio section = one page `public/audio.html` (served at `/audio`) with hash routes** `#/musik`, `#/musik/album/<id>`, `#/hoerbuecher`, `#/hoerbuecher/<id>` (unknown → `#/musik`), views in `public/js/audio/views/`, the `<audio>` element and bar in the page shell. Nav "Musik" → `/audio#/musik`, "Hörbücher" → `/audio#/hoerbuecher` (same-document fragment navigation, no reload); the nav module in `public/js/lib/` gets these two hrefs and the audio shell re-renders the active entry on `hashchange`. Phase 1's placeholders `public/music.html` and `public/audiobooks.html` are replaced by static `<meta http-equiv="refresh">` redirects to the same URLs (no script, CSP-safe). `document.title` follows the hash. Leaving to another category is a normal page load and stops playback (resume via "Fortsetzen"/"Weiterhören"). | Per OPEN-2 recommended option A. Same-document navigation requires one path for both sections; hash routing needs no server change; Phase 1 serves `/<name>` → `public/<name>.html`. | 2026-09-26 |
| **Views:** Musik overview = optional "Weiterhören" card + artist sections, each a grid of 1:1 album cards (min column 160 px, gap 16 px, covers `loading="lazy"`). Album detail = cover, title, artist, "Jahr · n Titel · Dauer", "Alle abspielen", track rows (≥ 48 px) with disc sub-headings "CD n" only when an album has more than one disc, playing row in `primary`, non-playable rows dimmed with the "Nicht abspielbar" badge. Hörbücher grid = "Weiterhören" row (in-progress books, most recent first, one row) + all books A–Z as 1:1 cards with a 4 px `primary` progress bar and "n %" or "Gehört". Book detail = cover, title, author, "n Dateien · Dauer", overall progress + "n % gehört", primary button "Fortsetzen · <file> – <mm:ss>" / "Abspielen" / "Von vorn hören" by `state`, secondary "Von vorn hören" when in progress, file rows with per-file progress, "Gehört" for finished files. Empty states: "Keine Musik gefunden." / "Keine Hörbücher gefunden." | design.md components (media card, grid/list, progress wherever started); committed exports above. | 2026-09-26 |
| **Duration formatting (German):** tracks `m:ss` (`h:mm:ss` ≥ 1 h); album/book totals `48 Min.` / `7 Std. 12 Min.`; unknown `–:–`. Pure helpers in `public/js/audio/format.js`, unit-tested. | Consistent German UI copy. | 2026-09-26 |
| **Cover route `GET /media/:id/cover`** (auth required; music/audiobook items only, else 404): candidate order follows Navidrome's default priority — (1) folder images `cover.*`, `folder.*`, `front.*` (extensions `jpg`, `jpeg`, `png`, `webp`, case-insensitive) in the group directory, and in the file's own directory first when that is a disc folder — only when the group is a real album/book directory (depth ≥ 2); for single-file books and depth ≤ 1 pseudo-albums instead a sidecar `<audio basename>.{jpg,jpeg,png,webp}`; (2) the embedded picture of that item (`readPictureRef`); (3) 404. Every candidate path passes the Phase 3 path guard. Folder/sidecar images are sent with the Phase 3 stream helper; an embedded picture is streamed as a 200 byte slice with `fs.createReadStream(path, { start, end })` and exact `Content-Length` (a `Range` header is ignored for this slice, as RFC 9110 permits). `Cache-Control: private, max-age=86400`. Nothing is cached server-side; the lookup runs per request. | Folder art is typically higher resolution and needs no parsing; on-demand lookup is always correct when a cover file is added without the audio file changing. The constitution's Range rule targets playback streams; a ≤ 10 MiB image slice is never buffered in memory. | 2026-09-26 |
| **Fixtures:** `test/helpers/mp3-fixture.js` (ID3v2.3/2.4 builder incl. encodings, unsync, APIC; silent, browser-decodable MPEG-1 Layer III CBR frames — 32 kHz, 32 kbit/s, mono, all-zero side info — with optional Xing/VBRI header) and `test/helpers/flac-fixture.js` (STREAMINFO, VORBIS_COMMENT, PICTURE, optional ID3v2 prefix; silent decodable frames with CONSTANT subframes and correct CRC-8/CRC-16). `test/helpers/make-audio-fixtures.js` (CLI, deterministic) writes the committed QA tree: a tagged MP3 album with embedded cover, a multi-disc album with `CD 1`/`CD 2` and a folder `cover.png`, an untagged album, a FLAC album, a `.wma` dummy (not playable), music tracks of ≥ 60 s, a multi-file book (≥ 3 files of ≥ 180 s, so a 1:00 position is outside the Phase 4 "last 30 s" finished window), a single-file book with embedded cover in an author folder, and a book with disc folders. The PNG is generated with `node:zlib` (`deflateSync`, `crc32`). | Brief: synthetic files only, never real media; long enough files make the ±10 s resume check meaningful; zero-filled frames compress to almost nothing in git. | 2026-09-26 |
| **Weiterschauen row stays video-only:** audio items never appear in the Phase 4 row. If the merged Phase 4 row does not already restrict itself to the video categories (it can filter via `GET /api/progress?category=…`), the audio-views issue adds that restriction there (one condition). | Audio resume has its own entry points in the audio section; with music off the progress table only audiobook files could appear, and they belong to their book. | 2026-09-26 |
| OPEN-1 — **Music resume across devices:** A) none — music has a queue only; the vision's "Resume … video or audio item" criterion is then met by audiobooks alone. B) music tracks write Phase 4 progress rows like audiobook files; the Musik "Weiterhören" card = latest unfinished music row; row clicks start at 0; music filtered out of "Weiterschauen" — every skipped song leaves an unfinished row. C) one "music session" row per user (Subsonic `savePlayQueue` analogue: current track + position), written by the bar, shown as the "Weiterhören" card; no Phase 4 rows for music. **Recommended: C** — satisfies the vision criterion for every audio item without cluttering the progress table; cost is one table in 004, two endpoints and one card. This spec is written for C; choosing A drops `music_session`, the session endpoints and the card; choosing B replaces them with Phase 4 reporting for music. | resolved at the spec-acceptance gate | — |
| OPEN-2 — **Where the audio player lives across navigation:** A) one audio-section page (`audio.html`, hash routes) hosting Musik + Hörbücher; switching views inside the section never interrupts, leaving the section stops playback. B) a bar re-created on every separate page, queue + position restored from `sessionStorage` — every navigation interrupts the sound and, under browser autoplay policies (Firefox/Safari block audible autoplay without a gesture on the new page), usually needs a tap to continue. C) an app-wide single-page shell so audio continues in Filme/Serien/Bilder too — requires converting the Phase 1–3 and 6 pages into views, contrary to the architecture's one-page-per-screen pattern. **Recommended: A** — the only option that is "persistent" in the design contract's sense without reworking other phases; the cost is that playback stops when leaving the audio section. This spec is written for A. | resolved at the spec-acceptance gate | — |

### Migration 004 schema

```sql
CREATE TABLE audio_meta (
  item_id          INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  source_mtime_ms  INTEGER NOT NULL,  -- library_items.mtime_ms when read (staleness check)
  source_size      INTEGER NOT NULL,  -- library_items.size when read
  group_key        TEXT    NOT NULL,  -- rel path of the album/book dir, or of the file for single-file books
  group_title      TEXT    NOT NULL,  -- path-derived album/book title (fallback)
  group_artist     TEXT,              -- path-derived artist/author, NULL = unknown
  title            TEXT    NOT NULL,  -- resolved track/file title (tag, else cleaned filename)
  track_no         INTEGER,           -- resolved (tag, else filename number)
  disc_no          INTEGER NOT NULL DEFAULT 1, -- resolved (tag, else disc folder, else 1)
  tag_artist       TEXT,
  tag_album_artist TEXT,
  tag_album        TEXT,
  tag_year         INTEGER,
  duration_ms      INTEGER,           -- NULL = unknown
  tag_format       TEXT               -- 'id3v2' | 'flac' | NULL (no tag read)
);
CREATE INDEX audio_meta_group ON audio_meta(group_key);

-- OPEN-1 option C
CREATE TABLE music_session (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rel_path   TEXT    NOT NULL,       -- track, keyed like Phase 4 progress (survives id churn)
  position_s REAL    NOT NULL,
  updated_at INTEGER NOT NULL        -- epoch ms
);
```

Table/column names of `library_items` and `users` are those of migrations 002
and 001; if they differ, 004 follows them. The pass's orphan delete keeps
`audio_meta` correct even when `PRAGMA foreign_keys` is off; `audio_meta` is
derived data and is simply rebuilt when items are re-created. A
`music_session` row whose `rel_path` has no current music item is ignored by
`GET /api/music` (joined via `library_items.rel_path`) and overwritten on the
next play; the API still speaks item ids (`trackId`) and maps to `rel_path`
server-side.

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (`npm run verify`):

- [ ] `npm run verify` passes; `npm ls --omit=dev --all` shows no packages.
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
- [ ] Parsers: table tests for music and audiobook paths (disc-folder rollup,
      loose tracks, root files, single-file books in author folder and root,
      `Author/Series/Book`, filename number stripping, natural order).
- [ ] Metadata pass: new, changed (mtime/size), unchanged (not re-read),
      removed (orphan deleted) and non-audio files; a corrupt file gets a
      fallback row; concurrent calls run once more, not in parallel.
- [ ] API: every new endpoint answers 401 without a session; unknown or
      non-audio ids → 404 `not_found`; any member id resolves the same group;
      precedence rules visible in the JSON; `PUT /api/music/session` rejects a
      bad body (400) and a non-music item (404).
- [ ] Resume function: new / in-progress / latest-finished → next / gap →
      first unfinished / all finished; fraction with unknown durations.
- [ ] Cover route: folder image beats embedded; disc-folder and parent lookup;
      sidecar for single-file books; embedded slice bytes equal the source
      image and `Content-Length` matches; no cover → 404; unauthenticated → 401;
      a cover file that is a symlink out of `MEDIA_ROOT` → 404.
- [ ] Frontend pure modules: queue (previous 3 s rule, advance, end, skip of
      non-playable) and German duration formatting.

Human QA (UI check per `docs/workflow.md`, Chromium and Firefox,
`MEDIA_ROOT=test/fixtures/media`, desktop and a ≤ 400 px viewport):

- [ ] Musik shows the fixture artists alphabetically; album cards show folder or
      embedded covers, the untagged album shows a placeholder and
      filename-derived titles; nav "Musik" is active.
- [ ] Album detail: tracks in disc/track order, "CD 1"/"CD 2" headings on the
      multi-disc album only, the `.wma` row dimmed with "Nicht abspielbar".
- [ ] "Alle abspielen" plays; the bar shows cover, title, artist; pause, seek,
      next, previous (both sides of the 3 s rule) work; the playing row is
      highlighted; the album advances to the next track on its own.
- [ ] While music plays, switching to Hörbücher, opening a book and returning to
      Musik does not interrupt the sound.
- [ ] Keyboard only: every bar control and row is reachable with Tab, has a
      visible `primary` focus ring, and works with Enter/Space; the seek slider
      moves with arrow keys.
- [ ] Hörbücher: the multi-file book played to ~1:00 of its second file, stopped
      (tab closed), then opened in a second browser (other profile, same user)
      shows the progress on the card and in "Weiterhören", and "Fortsetzen"
      starts file 2 within ±10 s of 1:00.
- [ ] Finishing a book file advances to the next file; the finished file shows
      "Gehört"; the book percentage grows.
- [ ] Musik "Weiterhören" (OPEN-1 = C): a track stopped at ~0:40 on browser A is
      offered on browser B and resumes within ±10 s.
- [ ] Copying a new tagged MP3 into a fixture album (in a scratch copy of the
      tree) shows it in the album without restart (≤ 10 s with watcher).
- [ ] Phone viewport: bar sits above the bottom nav, the last track row is not
      hidden behind it; lock-screen / media-key controls (Media Session) work
      where the browser supports them.
- [ ] Leaving to Filme stops playback; returning via "Fortsetzen"/"Weiterhören"
      resumes within ±10 s (OPEN-2 = A).
- [ ] `/music` and `/audiobooks` (former Phase 1 placeholders) land on
      `/audio#/musik` and `/audio#/hoerbuecher`; the browser console shows no
      CSP violations on any audio view.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Non-conformant tags (iTunes v2.4 sizes, broken encodings, bogus sizes) crash or hang the pass | Robustness rules above; readers never throw; loop guards on zero/oversized frames; per-file try/catch writes a fallback row; fuzz-style tests with truncated and random buffers. |
| Initial pass over a large library (10 000+ files on a USB HDD) takes minutes | Sequential async I/O keeps the server responsive; items appear progressively as rows are upserted; unchanged files are skipped on every later scan; the pass logs count and duration. |
| Query-time grouping of all audio rows gets slow on the Pi for large libraries | Single indexed query per request plus in-JS grouping; if a request exceeds ~200 ms on the fixture-scaled benchmark, cache the grouped result in memory keyed by a pass counter (implementer's call inside the API issue, no schema change). |
| Stale or reused `library_items` ids attach old metadata to a different file | Staleness check on (mtime, size) plus orphan delete on every pass; `ON DELETE CASCADE` when foreign keys are on. |
| Synthetic silent MP3/FLAC fixtures are rejected by a browser decoder | Frames follow the standard layout (zero side info = digital silence; FLAC CONSTANT subframes with valid CRCs); the fixture issue verifies playback in Chromium and Firefox before merge. |
| Auto-advance blocked by autoplay policy, or suspended on a locked phone | One persistent `<audio>` element unlocked by the initial click; Media Session handlers; iOS background behaviour checked at QA and documented if limited. |
| Phase 2/4 contracts differ from assumptions (post-scan hook name, progress table columns, `trackPlayback` options) | Assumptions listed in Constraints; each affected issue reads the merged Phase 2/4 code first and adapts names, not semantics. A missing post-scan hook in Phase 2 is a Phase 2 defect (Phase 6 needs it too), not something to work around in `scanner.js`. |
| Playback stops when leaving the audio section (OPEN-2 = A) | Explicit decision at the gate; resume entry points ("Fortsetzen", "Weiterhören") make the stop cheap to recover from. |

## Decision log

- 2026-09-26: Music grouping by directory, display by tags (Navidrome-style
  tags-first display, folder identity against split/merged albums).
- 2026-09-26: Audiobooks folder-first for book title/author — deliberate
  deviation from Audiobookshelf's default metadata priority (tags over folder
  structure, per its book-scanner guide) because our grouping requires curated
  Author/Book folders.
- 2026-09-26: Disc folders `CD|Disc|Disk <n>` adopted from Audiobookshelf's
  directory-structure docs for both music and audiobooks.
- 2026-09-26: Cover priority folder → embedded adopted from Navidrome's default
  `CoverArtPriority` (`cover.*, folder.*, front.*, embedded, external`), minus
  the external step (no outbound calls).
- 2026-09-26: M4A/Ogg tags out, per roadmap row and prior-art verdict; files
  still listed and playable.
- 2026-09-26: Tag reading as a separate post-scan pass with its own table
  (prior-art "fast scan separated from deeper analysis"); Phase 2 rows are never
  modified.
- 2026-09-26: Audiobook resume derived from per-file Phase 4 rows (no book-level
  table); music does not write Phase 4 rows.
- 2026-09-26: OPEN-1 (music resume) and OPEN-2 (player persistence scope) carried
  to the spec-acceptance gate with recommendations C and A.
- 2026-09-26: Aligned with sibling specs in review (Phase 1 PR #4, Phase 3 PR #1,
  Phase 4 PR #2, Phase 6 PR #3): audio shell at `/audio` with Phase 1's
  `music.html`/`audiobooks.html` placeholders turned into redirects; no inline
  `style` attributes (CSP); no new MIME entries needed (Phase 3 map already
  covers the playable audio extensions); audiobook progress joined by
  `rel_path` and `finished` taken from Phase 4's server rule; `trackPlayback`
  handle stopped before every queue switch; `music_session` keyed by
  `rel_path` for the same reason as Phase 4; tag reading registered on
  Phase 2's generic post-scan hook shared with Phase 6.
