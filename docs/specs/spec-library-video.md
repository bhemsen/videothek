# Spec: Library index — movies & series

> Created: 2026-09-26

Index every file under the configured media root into SQLite, classify it by
top-level folder into the five categories, parse movie and series names, flag
browser-incompatible files, keep the index fresh through debounced change
detection plus a periodic full rescan, expose a scan-completion extension point
for Phases 5/6, and let a logged-in user browse movies and series in the
browser. This spec carries no lifecycle state — acceptance is the spec merged on
the default branch with a milestone and issues, and all progress (in progress,
done, blocked) lives in the GitHub issues and milestone. A completed spec is
moved to `docs/specs/archive/`.

## Outcome

- [ ] On startup the server starts listening without waiting for the library;
      the initial full scan then indexes every media file under the category
      folders of `MEDIA_ROOT`; `library_items` holds one row per indexed file
      with category, kind, title, grouping columns, `playable`, `size`,
      `mtime_ms`.
- [ ] A video copied into `Filme/` or `Serien/` of a running server appears in
      `GET /api/library/movies` resp. `/api/library/series` within 10 s; a
      deleted file disappears within the same bound — also while a full scan is
      running.
- [ ] With change detection broken or silent, the same changes appear after the
      next periodic full rescan (`RESCAN_INTERVAL_MIN`, default 15 min).
- [ ] An unchanged file keeps its `id` across any number of rescans and server
      restarts; ids are never reused for another file.
- [ ] An unmounted, emptied or unreadable category folder (or `MEDIA_ROOT`)
      never deletes index rows; it is logged and reported as `lastError`.
- [ ] Browser-incompatible files (MKV, AVI, HEVC- or AC-3-in-MP4, …) are listed
      with `playable = false` and shown with a "Nicht abspielbar" badge; they
      are never linked to the player.
- [ ] The Filme page (`/movies`) shows all movies as a responsive card grid
      (≥ 2 columns on every phone) sorted A–Z or by "Neu hinzugefügt", with
      tokenized initials placeholders, an empty state and a first-scan state.
- [ ] The Serien page (`/series`) shows all series as cards with season/episode
      counts; the series detail page (`/series-detail?id=<seriesId>`) lists
      seasons (Staffel N, then Specials, then Weitere Folgen) with episode rows
      in episode order.
- [ ] Files in `Musik/`, `Hörbücher/` and `Bilder/` are indexed with category,
      kind, minimal title and `playable`, and every completed scan run notifies
      `onScanComplete` listeners, so Phases 5 and 6 add metadata, routes and UI
      without editing any P2 scanner module.
- [ ] Hidden files, system folders and symlinks are never indexed; no two scan
      runs ever execute at the same time.
- [ ] `npm run verify` is green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- Migration `src/db/migrations/002-library.sql`: tables `library_series` and
  `library_items` (contract below).
- Category + folder classification for all five categories (`CATEGORIES`,
  admitted kinds per category); hidden/system/symlink skip rules.
- Filename parsers: shared title normalisation, movie parser, series/episode
  parser; minimal title for music/audiobook/image files.
- Direct-play compatibility table (the single extension/MIME table of the
  project, incl. `SCAN_VERSION`) and a header-only MP4 codec sniffer.
- Scanner: serialised run queue, full scan, subtree scan, path reconcile,
  index-safety rules, `onScanComplete` listeners.
- Change detection: per-directory watches on Linux, native recursive watch on
  macOS/Windows, debounce, error recovery, periodic full rescan; the
  `startLibrary()` service wired into `src/server.js` startup/shutdown.
- Browse API: `GET /api/library/:category`, `GET /api/library/series/:id`,
  `GET /api/library/items/:id`; exported `toItemJson(row)` and
  `getItemById(db, id)` for Phases 3–6.
- UI: Filme page, Serien page, series detail page, shared media card /
  placeholder / badge / grid / empty-state pieces.
- Test fixtures `test/fixtures/media/Filme/` and `test/fixtures/media/Serien/`.
- Docs: `docs/design.md` Grid line (edited in this spec PR, H3);
  `docs/architecture.md` sections and a `README.md` section (edited by the
  implementing issue, see File ownership).

### Out of scope

- Streaming, the player page, `/media/:id`, the item-JSON fields `next` and
  `subtitles` (Phase 3 adds them to the single-item response). Cards link to
  `/player?id=<itemId>`, which works once Phase 3 lands.
- Progress bars, "Gesehen" badges, "Weiterschauen" (Phase 4 decorates P2's
  cards and rows through the DOM contract below).
- Music/audiobook/image parsers, tag/EXIF reading, their tables, routes and
  pages (Phases 5, 6). Videos inside `Bilder/` (Phase 6 admits them, H9).
- Subtitle sidecars (`.vtt`, `.srt`) — never indexed; Phase 3 discovers `.vtt`
  at request time (H4).
- Posters, thumbnails, frame grabs, online metadata — no ffmpeg, no network.
- Extras/trailer/sample detection (listed as ordinary movies), multi-part
  stacking (`CD1`/`CD2` are separate items), date-based and absolute-numbered
  episodes (land in "Weitere Folgen").
- Search, filters beyond the two sort orders, pagination, live push of index
  changes to open pages (a reload shows them), custom arrow-key grid
  navigation.
- Following symlinks, multiple media roots, per-item permissions, new
  configuration values.

## Constraints

- Constitution applies unchanged: zero runtime deps; `MEDIA_ROOT` read-only
  (the library only calls `readdir`, `lstat`/`stat`, `open(…, 'r')` + `read`,
  `fs.watch`); SQL only in `src/db/` via prepared statements; JSON errors
  `{ "error": "<code>" }`; config only via `src/config.js`; ≤ 60 lines per
  function, ≤ 300 lines per file (JS and CSS); JSDoc on every export; a
  `test/**/*.test.js` per new `src/` module; German UI copy; no `innerHTML`
  with data (DOM via `textContent` / `createElement[NS]`).
- Phase 1 server contract (D4), used verbatim: handlers `handler(req, res,
  ctx)` with `ctx = { user, params, url }`; `createApp({ config, db, log, now,
  ...extra })` passes extra keys through to every `register<X>Routes(router,
  deps)`; `library` is built in `src/server.js` `start()` and passed as
  `extra`, and `src/app.js` only gains one optional `library` property in its
  `AppDeps` typedef; `Config.mediaRoot`, `Config.rescanIntervalMin` (integer 1–1440,
  default 15, validated by P1); router matches whole segments and runs GET
  handlers for HEAD; `requireUser` in `src/http/guards.js`; `sendJson`,
  `sendError` in `src/http/respond.js`; logging only through the injected
  `log.{info,warn,error}(event, fields)` (JSON lines, no `console.*`); API JSON
  camelCase, timestamps ISO-8601 strings named `…At` (DB stores INTEGER epoch
  ms); `/api/*` answers carry `Cache-Control: no-store` (P1 app).
- Phase 1 frontend contract (D5): `public/js/lib/api.js`
  `request(method, path, { json, keepalive, redirectOn401 = true })` →
  `{ status, data }`, throws `ApiError { status, code }`;
  `public/js/lib/shell.js` `mountShell({ active })` → `{ main, setActive }`;
  tokens only from `public/css/tokens.css` (P1-owned, never edited here) incl.
  `--grid-min` (160 px), `--row-min`, `--tap-min`, `--border-width`,
  `--focus-width`, `--focus-offset`; literal lengths outside `tokens.css` only
  breakpoints 768/1024 px, `%`, `vh`/`dvh`, `fr`, `0`; CSP forbids `style=""`
  (dynamic values via `el.style.setProperty`, none needed here).
- Page URLs (D1): `GET /<name>` serves `public/<name>.html`, direct `*.html` →
  404, pages are session-gated by P1. P2 replaces P1's placeholder files
  `public/movies.html` and `public/series.html`; P1's nav module/config and
  `public/js/placeholder.js` are never edited.
- Architecture boundaries: `src/library/` knows nothing about HTTP or users;
  `src/api/` knows nothing about file formats; `src/db/` never imports parser
  code; `public/` never imports server modules.

### Data model (migration `002-library.sql`)

```sql
CREATE TABLE library_series (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  series_key TEXT    NOT NULL UNIQUE,  -- series folder name (exact) or cleaned name of a loose file
  title      TEXT    NOT NULL,
  sort_title TEXT    NOT NULL,
  year       INTEGER,
  added_at   INTEGER NOT NULL          -- epoch ms, first time seen
) STRICT;

CREATE TABLE library_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path     TEXT    NOT NULL UNIQUE,   -- '/'-separated, relative to MEDIA_ROOT, exact on-disk name
  dir          TEXT    NOT NULL,          -- parent directory of rel_path (same form)
  category     TEXT    NOT NULL CHECK (category IN ('movies','series','music','audiobooks','images')),
  kind         TEXT    NOT NULL CHECK (kind IN ('video','audio','image')),
  ext          TEXT    NOT NULL,          -- lower-case, without dot
  title        TEXT    NOT NULL,          -- best-effort display title, never empty
  sort_title   TEXT    NOT NULL,
  year         INTEGER,
  series_id    INTEGER REFERENCES library_series(id),  -- NOT NULL for category 'series', NULL otherwise
  series_title TEXT,                      -- denormalised for serializers without a join
  season       INTEGER,                   -- 0 = specials, NULL = unknown
  episode      INTEGER,
  episode_end  INTEGER,                   -- multi-episode files (S01E01-E02)
  video_codec  TEXT,                      -- first 'vide' sample-entry fourcc from the sniffer, else NULL
  audio_codec  TEXT,                      -- first 'soun' sample-entry fourcc, else NULL
  playable     INTEGER NOT NULL CHECK (playable IN (0, 1)),
  size         INTEGER NOT NULL,
  mtime_ms     INTEGER NOT NULL,          -- Math.trunc(stat.mtimeMs)
  scan_version INTEGER NOT NULL,          -- SCAN_VERSION at parse time
  added_at     INTEGER NOT NULL,          -- epoch ms, set on insert only
  scanned_at   INTEGER NOT NULL           -- epoch ms, last (re)parse
) STRICT;

CREATE INDEX library_items_category_sort ON library_items (category, sort_title);
CREATE INDEX library_items_dir ON library_items (dir);
CREATE INDEX library_items_series ON library_items (series_id, season, episode);
```

- The file contains no `BEGIN`/`COMMIT` (P1's runner wraps each file, incl. the
  `schema_migrations` insert, in one transaction — D12). It depends only on
  001 being applied first by number; it references no P1 table.
- A row exists iff the file is currently present and indexable (vanished files
  are hard-deleted, architecture flow 1). `AUTOINCREMENT` guarantees a deleted
  id is never handed to another file; upserts use
  `INSERT … ON CONFLICT(rel_path) DO UPDATE` (never `INSERT OR REPLACE`, which
  would change the id and fire `ON DELETE CASCADE` in P5/P6 tables).
- `library_series` rows are upserted by `series_key`
  (`ON CONFLICT(series_key) DO UPDATE SET title, sort_title, year`, keeping
  `id` and `added_at`) whenever an episode is (re)parsed, and deleted after
  their last episode is deleted (items first, so the FK holds).
- `SCAN_VERSION` (integer constant exported from
  `src/library/parsers/compat.js`, next to the extension table, starts at 1):
  rows with a different `scan_version` are re-parsed like changed files, so a
  parser or compat-table change reaches unchanged files on the next scan.
  Every later edit of `compat.js`, `categories.js` or a parser that changes the
  result for already-indexed files bumps it. Admitting new files (e.g. P6's
  videos in `Bilder/`) needs no bump — they are new to the diff.
- Path-prefix matches (subtree deletes, root checks) use the range form
  `rel_path >= ? || '/' AND rel_path < ? || '0'` — never `LIKE`, because `_`
  and `%` are common in file names.
- Tables of later phases reference `library_items(id) ON DELETE CASCADE`
  (P5 `audio_meta`, P6 `image_meta`); P4 progress references no library table
  (keyed by `rel_path`, D11).

### Classification (`src/library/categories.js`)

| Top-level folder under `MEDIA_ROOT` (NFC-normalised, case-insensitive) | `category` | admitted kinds (P2) |
|---|---|---|
| `Filme`, `Movies` | `movies` | video |
| `Serien`, `Series`, `TV` | `series` | video |
| `Musik`, `Music` | `music` | audio |
| `Hörbücher`, `Hoerbuecher`, `Audiobooks` | `audiobooks` | audio |
| `Bilder`, `Pictures`, `Photos` | `images` | image |

- Exports: `CATEGORIES` = frozen `['movies', 'series', 'music', 'audiobooks',
  'images']` (nav order); `categoryForFolder(name)` → category id or `null`
  (`name.normalize('NFC').toLowerCase()` against the alias list);
  `kindsFor(category)` → frozen array of admitted kinds, read from one
  `KINDS` map in that file. Phase 6 changes the `images` entry to
  `['image', 'video']` (H9) — a one-line edit; the scanner and item builder
  are kind-generic and need no change.
- Files directly under `MEDIA_ROOT` or in other top-level folders are ignored
  and those folders are not descended. Several aliases of one category (e.g.
  `Filme/` and `Movies/`) are all scanned; each alias folder is its own
  "category root".
- A file is indexed only if its lower-cased extension is in `EXTENSIONS` and
  that row's `kind` is admitted for the category; everything else (`.nfo`,
  `.srt`, `.vtt`, `.jpg` in `Filme/`, `.mp4` in `Bilder/` before P6, files
  without extension, …) is ignored.
- Skipped entirely (never indexed, never descended, never watched): names
  starting with `.`; directories `@eaDir`, `#recycle`, `#snapshot`,
  `$RECYCLE.BIN`, `System Volume Information`, `lost+found`
  (case-insensitive); every symlink (file or directory, from the `Dirent`
  type, re-checked with `lstat` for reconciles); names containing U+FFFD
  (undecodable bytes — cannot be reopened reliably), counted and logged once
  per run.

### Direct-play compatibility (`src/library/parsers/compat.js`) — single owner (D9)

`EXTENSIONS` is a frozen map `ext → { kind, playable, sniff, mime }`:
`playable` = the extension can play in Chromium and Firefox (for `sniff: true`
rows subject to the codec sniff), `mime` is set iff `playable` is true, else
`null`. It is the project's only extension/MIME table: Phase 3's
`src/http/media-types.js` is a thin `mediaTypeFor(ext)` over it, Phases 5/6
add no second table.

| Kind | Playable, MIME | Playable after MP4 sniff, MIME | Indexed, not playable |
|---|---|---|---|
| video | `webm` `video/webm` | `mp4`, `m4v` `video/mp4` | `mkv`, `avi`, `mov`, `wmv`, `flv`, `mpg`, `mpeg`, `ts`, `m2ts`, `mts`, `vob`, `ogv`, `3gp`, `divx`, `asf`, `rm`, `rmvb` |
| audio | `mp3` `audio/mpeg`, `aac` `audio/aac`, `flac` `audio/flac`, `ogg`/`oga`/`opus` `audio/ogg`, `weba` `audio/webm`, `wav` `audio/wav` | `m4a`, `m4b` `audio/mp4` | `wma`, `ape`, `aif`, `aiff`, `mka`, `wv`, `dsf`, `dff`, `ac3`, `dts`, `amr`, `mid`, `midi` |
| image | `jpg`/`jpeg`/`jfif` `image/jpeg`, `png` `image/png`, `gif` `image/gif`, `webp` `image/webp`, `avif` `image/avif`, `bmp` `image/bmp` | — | `heic`, `heif`, `tif`, `tiff`, `jxl`, `svg`, `dng`, `cr2`, `cr3`, `nef`, `arw`, `orf`, `rw2`, `raf` |

- Other exports: `SCAN_VERSION`, `isPlayableExtension(ext)` (→
  `EXTENSIONS[ext]?.playable === true`), `mimeForExtension(ext)` (→ `mime` or
  `null`), `resolvePlayable({ ext, size, codecs })` (→ `boolean`: `false` if
  the row is not `playable` or `size` is 0; for `sniff` rows with non-null
  `codecs` the fourcc rule below; otherwise `true`).
- `svg` is indexed but never playable, so `/media/:id` never serves it
  (script-capable same-origin content).
- Sniffed files are playable iff every `vide` track's sample entry is in
  {`avc1`, `avc3`, `av01`, `vp09`} and every `soun` track's is in {`mp4a`,
  `Opus`, `fLaC`, `.mp3`}; any other fourcc (`hvc1`, `hev1`, `dvh1`, `dvhe`,
  `mp4v`, `ac-3`, `ec-3`, `dtsc`, `dtsh`, `dtsl`, `alac`, …) → not playable.
  Other track types (subtitles, chapters, timecode) are ignored. If the box
  walk fails (truncated file, `moov` missing, malformed boxes) the file is
  playable by extension and both codec columns stay `NULL`; it is re-sniffed
  when its size/mtime changes.
- Size 0 → not playable, no sniff (a file that is just being created).
- The sniffer (`src/library/tags/mp4-codec.js`, `sniffMp4Codecs(absPath)` →
  `{ video: string[], audio: string[] } | null`) reads only box headers
  through one `FileHandle` opened `'r'`: walks top-level boxes (32- and 64-bit
  sizes, size 0 = to end of file) to `moov`, then `trak` → `mdia` → `hdlr`
  (handler type) and `mdia` → `minf` → `stbl` → `stsd` (first sample-entry
  fourcc). Guards: ≤ 64 boxes per level, depth ≤ 8, every size must fit its
  parent, ≤ 64 KiB read per file; any violation → `null` ("unknown"). It never
  throws for file content; I/O errors also yield `null`.

### Parse rules

Shared normalisation (`src/library/parsers/text.js`):

- `cleanName(s)`: if `s` contains no space, `.` and `_` become spaces; `_`
  always becomes a space; bracketed groups `[…]` are removed; the string is cut
  at the first release token (whole word, case-insensitive): `\d{3,4}p`, `4k`,
  `uhd`, `hdr`, `hdr10`, `bluray`, `blu-ray`, `bdrip`, `brrip`, `web-dl`,
  `webdl`, `webrip`, `hdtv`, `dvdrip`, `remux`, `x264`, `x265`, `h264`,
  `h265`, `hevc`, `xvid`, `divx`, `av1`, `aac`, `ac3`, `dts`, `truehd`,
  `atmos`, `german`, `deutsch`, `english`, `multi`, `dl`, `proper`, `repack`;
  whitespace collapsed; trailing ` -._` trimmed. Empty result → the stem with
  only separators (`.`, `_`) replaced by spaces and trimmed; still empty → the
  stem unchanged.
- `sortKey(title)`: NFKD, combining marks removed, lower-cased, every digit run
  left-padded to 8 digits (natural order: "Teil 2" < "Teil 10"). No article
  stripping ("Das Boot" sorts under D, "The Office" under T).
- `parseYear(token, now)`: 4 digits, 1888 ≤ year ≤ (UTC year of `now()`) + 1,
  else `null`.
- `episodeCode({ season, episode, episodeEnd })`: `S01E06` / `S01E01-E02`
  (season and episode 2-digit minimum), `E06` / `E06-E07` when the season is
  unknown, `null` when the episode is unknown. The frontend has a copy of the
  same rule (`public/js/lib/library-format.js`).

Movie (`src/library/parsers/movie.js`, `parseMovie(relInCategory, now)` →
`{ title, year }`), from the file stem:

1. `Title (Year)` / `Title [Year]` — first parenthesised/bracketed year: title =
   `cleanName(text before it)`.
2. Otherwise tokens after separator normalisation: the **last** year token that
   is not the first token splits title / year ("2001 A Space Odyssey 1968
   1080p" → "2001 A Space Odyssey", 1968).
3. Otherwise title = `cleanName(stem)`, year `NULL`.
4. If the stem yields no year and the file sits in a sub-folder of the category
   folder whose name yields a year by 1–2, title and year come from the
   nearest such ancestor folder (`Inception (2010)/inception.mp4` →
   "Inception", 2010).

Series (`src/library/parsers/series.js`, `parseEpisode(relInCategory, now)` →
`{ seriesKey, seriesTitle, seriesYear, season, episode, episodeEnd, title }`),
path relative to the category folder:

- Series: if the file is in a sub-folder, `seriesKey` = that first folder name
  (exact), title/year = movie rules 1–3 on the folder name. A loose file
  directly in the category folder: `seriesKey` = `seriesTitle` =
  `cleanName(text before the episode token)`, or `cleanName(stem)` without a
  token; year `null`. Equal keys merge (a loose `Dark.S01E05.mp4` joins folder
  `Dark/`, not `Dark (2017)/`).
- Season/episode, first match wins on the file stem (all patterns
  case-insensitive, `\b` = ASCII word boundary):
  1. `\bS(\d{1,2})[ ._-]?E(\d{1,3})` with optional second episode
     `(?:-?E|-)(\d{1,3})\b` → `episodeEnd`.
  2. `\b(\d{1,2})x(\d{2,3})\b` ("1x02"; "1920x1080" does not match).
  3. Season from the nearest ancestor folder below the series folder matching
     `^(season|staffel|s)[ ._-]*(\d{1,2})$` or `^specials?$` (→ 0), combined
     with an episode from `\b(e|ep|episode|folge|teil)[ ._-]*(\d{1,3})\b` or a
     leading `^(\d{1,3})[ ._-]` in the stem.
  4. Otherwise season = folder season or `NULL`, episode `NULL`.
- Episode title = `cleanName(text after the matched token)` with leading
  separators removed. Empty → `episodeCode(...)` when the episode is known,
  else `cleanName(stem)`. The UI shows "Folge N" when the title equals the
  code (see UI).

Music, audiobook, image and any other admitted kind (P2 minimal): title =
`cleanName(stem)`, no grouping beyond `dir`; Phases 5/6 keep their own
metadata in their own tables and never rewrite `library_items`.

### Scanner modules (`src/library/`)

| Module | Exports | Responsibility |
|---|---|---|
| `walk.js` | `isSkippedName(name)`, `listDirectory(absDir)` → `{ files: [{ name, stat }], dirs: string[], skipped: { symlinks, undecodable } }` | One `readdir({ withFileTypes: true })` + `stat` per candidate file (extension known), skip rules applied; a `stat` ENOENT drops the file, any other `stat` error is returned in `files` as `{ name, error }` |
| `item-builder.js` | `buildItem({ mediaRoot, relPath, category, stat, now })` → row or `null` | Extension + kind admission, category parser, `resolvePlayable` (+ sniff for `sniff` rows with size > 0), `sortKey`, `scan_version`, timestamps |
| `dir-sync.js` | `syncDirectory(ctx, relDir)` → `{ stats, dirs }` | Load `WHERE dir = ?` rows, classify new / changed (size, mtime or `scan_version` differ) / unchanged / vanished, build rows for new + changed only, apply in transactions of ≤ 500 rows; a file with a non-ENOENT `stat` error keeps its row |
| `reconcile.js` | `reconcilePaths(ctx, relPaths)` → `{ stats, escalate }` | Path reconcile rules below |
| `scan-queue.js` | `createScanQueue({ runFull, runPaths, onComplete, log })` → `{ requestFull(kind?), requestPaths(relPaths), drainPathsBetweenDirs(), idle(), stop(), running() }` | Serialisation and coalescing only (no I/O) |
| `scanner.js` | `createScanner({ db, mediaRoot, log, now, dirObserver? })` → `{ requestFull(), requestPaths(relPaths), onScanComplete(listener), status(), idle(), stop() }` | Full/subtree scan, root safety, sweep, series orphan cleanup, listener dispatch |

- `ctx` = `{ db, mediaRoot, log, now, dirObserver, stats }`, built by
  `scanner.js`.
- Queue: at most one run in flight. Requests arriving meanwhile are coalesced:
  path sets are unioned; a pending full scan absorbs pending paths; several
  full requests collapse into one. While a full scan runs, pending path
  requests are **not** deferred to its end: the full walk calls
  `drainPathsBetweenDirs()` after every directory, which runs the pending
  reconcile inline (so the 10 s freshness bound holds during a full scan);
  the directories that reconcile touched are added to the running full scan's
  visited set, so the final sweep never deletes them. `idle()` resolves when
  the queue is empty (tests, shutdown).
- Run kinds (payload `kind`): `'initial'` (the first full scan after
  `startLibrary`), `'full'` (timer, watcher escalation, recovery), `'paths'`
  (a coalesced reconcile batch, incl. subtree scans it triggers — also an
  interleaved one during a full scan).
- Full scan: `readdir(MEDIA_ROOT)`; if that fails the run aborts with no DB
  change (`lastError = 'media_root_unreadable'`, warn
  `library_scan_failed`). Each category root is walked sequentially,
  depth-first, directories in `readdir` order: `dirObserver.seen(relDir)` is
  called **before** a directory is listed, then `syncDirectory`. After the
  walk, rows whose `dir` was not visited are deleted, except under
  directories whose `readdir` failed (subtree protected, warn
  `library_dir_failed { dir, code }`) and under protected roots (below); then
  orphaned series are deleted; then `dirObserver.sweep(visitedDirs)`.
- Root safety (D7): a category root that has rows (range query on its prefix)
  but is missing, unreadable, or empty (no entry left after the skip rules) is
  **protected**: no row under it is deleted, warn
  `library_root_protected { root, reason: 'missing' | 'unreadable' | 'empty' }`,
  `lastError = 'root_protected'`. The same applies to `MEDIA_ROOT` itself
  (readable but empty while rows exist → every root is protected). To empty a
  whole category on purpose, leave one file in it or delete the DB file
  (documented in `README.md` and `docs/architecture.md`).
- Subtree scan (a directory path): the same walk scoped to that directory;
  the sweep only covers that prefix.
- Path reconcile (from change detection), per path, `lstat`:
  - `MEDIA_ROOT` itself or a top-level folder → escalate to a full scan
    (`escalate: true`, the queue turns the batch into one `'full'` run).
  - path outside every category root → ignored.
  - ENOENT → first check the path's category root: missing or empty →
    escalate to a full scan (which applies root safety); otherwise delete the
    row and every row under the path, and `dirObserver.gone(relPath)`.
  - any other `lstat` error → keep rows (the periodic scan repairs).
  - directory → subtree scan.
  - regular file, indexable → upsert (or leave when unchanged); not
    indexable → delete its row if one exists.
  - symlink or skipped name → delete rows for it (and under it).
- `onScanComplete(listener)` → `unsubscribe()` (D6). Fires once after every
  completed run — `'initial'`, `'full'`, `'paths'` (incl. interleaved
  reconciles and runs that ended with protected roots) — with the payload
  `{ kind, stats, completedAt }` (`completedAt` epoch ms). Not fired for a
  run aborted because `MEDIA_ROOT` is unreadable or cut short by `stop()`.
  Listeners are invoked after the run has finished and left the queue
  (`setImmediate`; for an interleaved reconcile: after that reconcile),
  each in its own `try`/`catch`, never awaited; a throw or rejected promise is
  logged as `library_listener_failed { error: message }`. A listener may still
  be running when the next scan starts; listener contract for Phases 5/6:
  single-flight inside the listener (a call during its pass → one coalesced
  rerun), stale rows found by comparing their `source_size`/`source_mtime_ms`
  with `library_items.size`/`mtime_ms`, items deleted mid-pass are skipped
  (FK error tolerated), their tables `STRICT` with `item_id … REFERENCES
  library_items(id) ON DELETE CASCADE` (no orphan-delete code needed).
- `status()` → `{ running: boolean, lastCompletedAt: number | null, lastStats,
  lastError: string | null }`; `lastError` is reset to `null` by the next run
  that completes without a protected root or failed directory.
- Stats: `{ added, updated, removed, unchanged, failedDirs, skippedSymlinks,
  skippedUndecodable, protectedRoots, durationMs }`.
- Memory: never holds the whole library in memory — only the current
  directory's rows and the set of visited directory paths.
- Logging: one `library_scan_complete { kind, ...stats }` info line per
  completed run; warnings as named above plus
  `library_names_undecodable { count }` once per run; relative paths may be
  logged, file contents never.

### Change detection (`src/library/watcher.js`, `src/library/dir-watch.js`)

- Mode by platform (injectable `platform`, default `process.platform`):
  - **Linux — per directory (D8):** `createDirWatchSet({ mediaRoot, watchFn,
    onEvent, onWatchError, log })` → `{ seen(relDir), gone(relDir),
    sweep(visitedDirs), count(), closeAll() }` is passed to the scanner as its
    `dirObserver`. `MEDIA_ROOT` and every directory the walk visits get one
    non-recursive `fs.watch(absDir)` (idempotent per directory; skip rules
    apply because the walk never visits skipped directories). An event's
    `filename` is joined to the watched directory's relative path. `gone`
    closes the watch of that directory and all below it; `sweep` closes every
    watch whose directory was not visited (only after full scans), except
    `''` (MEDIA_ROOT) itself, which `sweep` never closes since the scanner's
    walk never visits MEDIA_ROOT and so never lists `''` as visited. Each watch
    handles its own `error`: close it, log `library_watch_error { dir, code }`,
    and `requestPaths([dir])` (the rescan re-adds it). `ENOSPC`/`EMFILE` from
    `fs.watch` → log `library_watch_limit { count }` once, stop adding watches
    until the next full scan (the periodic rescan covers unwatched
    directories).
  - **macOS / Windows — native recursive:** one `fs.watch(mediaRoot,
    { recursive: true })`; `filename` (backslashes → `/`) is relative to
    `MEDIA_ROOT`; `dirObserver` is a no-op. An `error` event or a throwing
    `fs.watch` closes it, logs `library_watch_error`, and retries after 5 s,
    doubling up to 5 min; a successful restart resets the backoff and requests
    one full scan (events may have been missed). The same backoff applies to
    the Linux `MEDIA_ROOT` watch. Change detection never stays off.
- Debounce (both modes): each event path goes into a pending set; a `null`
  filename or > 1000 pending paths escalates to a full scan. Flush = trailing
  5 s after the last event, but at most 8 s after the first pending event;
  flush → `requestPaths([...])` or `requestFull()`. Constants in
  `watcher.js`, injectable for tests.
- `createWatcher({ mediaRoot, scanner, log, platform?, watchFn?, timers?,
  debounceMs?, maxWaitMs? })` → `{ dirObserver, start(), stop() }`.

### Service (`src/library/index.js`) and wiring

- `startLibrary({ db, config, log, now = Date.now })` →
  `{ onScanComplete(listener) → unsubscribe, requestFull(), stop(), status() }`
  (D6). Synchronously creates the watcher and scanner and returns; the watcher
  start and the `'initial'` full scan are deferred with `setImmediate`, so
  `listen` is never delayed. Periodic rescan: every
  `config.rescanIntervalMin` minutes `requestFull()` (`setInterval`,
  `unref()`ed, coalesced by the queue — never overlapping). `stop()` →
  `Promise<void>`: clears timers, closes all watches, aborts the walk between
  directories, resolves once the in-flight run has exited (transactions are
  synchronous, so none is left half-applied).
- `src/server.js` (P1-owned; P2 adds a few lines in `start()`/`stop()`):
  after migrations/bootstrap `const library = startLibrary({ db, config,
  log })` (`now` defaults to `Date.now`), passes `library` as an extra key to
  `createApp`, and `await library.stop()` in `stop()` before the DB is
  closed. Phases 5/6 each add one line `library.onScanComplete(...)` there.
  `src/app.js` gets `library?: LibraryService` in the `AppDeps` typedef
  (`LibraryService` = the JSDoc typedef of `startLibrary`'s return value,
  exported from `src/library/index.js`).

### API contract (`src/api/library.js`, `src/api/library-json.js`, `src/db/library-queries.js`)

Registered via `registerLibraryRoutes(router, deps)` in `src/http/routes.js`
(one line); uses `deps.db` and the optional `deps.library` (absent → `scan` is
`{ running: false, lastCompletedAt: null }`). All routes wrapped in
`requireUser`; JSON camelCase; timestamps ISO-8601 (`new
Date(ms).toISOString()`).

Item JSON (`toItemJson(row)` takes a full `library_items` row, no join):

```json
{ "id": 42, "category": "series", "kind": "video", "title": "Geheimnisse",
  "year": null, "ext": "mp4", "size": 1503238553, "playable": true,
  "videoCodec": "avc1", "audioCodec": "mp4a", "addedAt": "2026-09-26T10:00:00.000Z",
  "seriesId": 7, "seriesTitle": "Dark", "season": 1, "episode": 1,
  "episodeEnd": null, "fileName": "Dark S01E01 - Geheimnisse.mp4" }
```

All keys are always present (`null` when not applicable); `rel_path` and `dir`
are never sent to clients; `fileName` is the last path segment.

| Route | Success | Errors |
|---|---|---|
| `GET /api/library/:category?sort=title\|added` | `200 { category, sort, scan: { running, lastCompletedAt }, items: [Item…] }` for `movies`, `music`, `audiobooks`, `images`; for `series`: `200 { category, sort, scan, series: [{ id, title, year, seasonCount, episodeCount, playableCount, addedAt }] }` | 404 `not_found` (category not in `CATEGORIES`), 400 `invalid_sort` (present and not `title`/`added`), 401 `unauthorized` |
| `GET /api/library/series/:id` | `200 { id, title, year, addedAt, seasonCount, episodeCount, playableCount, seasons: [{ season, episodes: [Item…] }] }` | 404 `not_found`, 401 |
| `GET /api/library/items/:id` | `200 Item` (Phase 3 adds `next` and `subtitles` to this single-item response only) | 404 `not_found`, 401 |

- `:id` must match `^[1-9][0-9]{0,15}$`, else 404 `not_found`.
- Sort `title` (default when `sort` is absent): `sort_title`, then `year`
  (NULL last), then `id`. Sort `added`: `added_at` desc, then `mtime_ms` desc,
  then `id`. Series `addedAt` = max `added_at` of its episodes (a new episode
  moves its series up); series title sort uses `library_series.sort_title`,
  `year`, `id`.
- `seasonCount` counts distinct seasons ≥ 1; `episodeCount` counts all items;
  `playableCount` the playable ones. A series appears only while it has items.
- Detail `seasons` order: 1…n, then 0 ("Specials"), then `null` ("Weitere
  Folgen"); episodes by `episode` (NULL last), then `episode_end`, then
  `sort_title`, then `id`.
- `src/db/library-queries.js` exports `listCategoryItems(db, category,
  sort)`, `listSeries(db, sort)`, `getSeriesWithEpisodes(db, id)` and
  `getItemById(db, id)`; all reads for the API live there, all writes in
  `src/db/library-repo.js`.
- Exports for later phases: `getItemById(db, id)` (full row incl. `rel_path`,
  or `undefined`) from `src/db/library-queries.js`; `toItemJson(row)` from
  `src/api/library-json.js`; `CATEGORIES`, `categoryForFolder`, `kindsFor`
  from `src/library/categories.js`; `EXTENSIONS`, `SCAN_VERSION`,
  `isPlayableExtension`, `mimeForExtension` from
  `src/library/parsers/compat.js`; `startLibrary` from
  `src/library/index.js`. Phase 3 edits the single-item handler in
  `src/api/library.js` to add `next`/`subtitles` (H4, D10) and owns the
  next-episode query; list responses never carry them.

### UI (German copy)

Pages: `/movies` = `public/movies.html` + `public/js/movies.js` and `/series` =
`public/series.html` + `public/js/series.js` (both replace P1's placeholder
files), `/series-detail?id=<seriesId>` = `public/series-detail.html` +
`public/js/series-detail.js`. Each page calls `mountShell({ active: 'movies' |
'series' })` (detail page: `'series'`) and renders into `main`. Shared:
`public/js/lib/media-card.js` (card, placeholder tile, badge, episode row),
`public/js/lib/library-icons.js` (`ban` and `play` icons built with P1's
`createIcon`; film/TV icons are P1's `icon('movies')` / `icon('series')`;
P1's `icons.js` is never edited),
`public/js/lib/library-format.js` (pure, Node-testable: initials, plurals,
file size, episode number/label, `episodeCode`),
`public/js/lib/library-api.js` (`getCategory(category, sort)`,
`getSeries(id)` over P1's `request`), `public/css/library.css`. Document
titles: "Filme – Videothek", "Serien – Videothek", "<Serie> – Videothek".

- Header: H1 "Filme" / "Serien" + muted count ("1 Titel"/"12 Titel", "1 Serie"
  / "8 Serien"); sort control = two links "A–Z" (`/movies` resp. `/series`)
  and "Neu hinzugefügt" (`?sort=added`), `aria-current="true"` on the active
  one, active in `accent`, each `min-height: var(--tap-min)`. The page reads
  `sort` from its URL: `added` → added, anything else → title (never sends an
  invalid value).
- Grid (H3): `display: grid; gap: var(--space-4);
  grid-template-columns: repeat(auto-fill, minmax(min(var(--grid-min),
  calc(50% - var(--space-2))), 1fr))` — 160 px minimum, but always ≥ 2
  columns on phones (recorded in `docs/design.md` Grid).
- Card (design.md Media card): root carries `data-item-id` (movies) resp.
  `data-series-id` (series), radius `md`, `shadow-sm`; tile
  `.media-card__tile` (2:3, `position: relative`, `secondary`,
  `var(--border-width)` `border`, radius `md`) with up to two initials (first
  letter/digit — `\p{L}\p{N}` — of the first two words of the title,
  upper-case; `#` if none) in `muted`, `--text-2xl`, bold, and a small film
  (movie) / TV (series) icon top left; title one line + ellipsis
  (`foreground`, `--text-md`, semibold); meta `muted` `--text-sm`: movie
  `2010 · MP4` (year omitted when `null`), series `3 Staffeln · 26 Folgen`
  (German singular/plural; the Staffeln part is omitted when `seasonCount` is
  0). Playable movie card = `<a href="/player?id=<id>">`; series card =
  `<a href="/series-detail?id=<id>">`. Tiles in one grid row have equal
  height.
- "Nicht abspielbar": pill badge top right in the tile, `destructive` text and
  border on `background`, `--text-xs` semibold, ban icon; unplayable movie
  cards are `<div>`s (no link, no tabindex) with
  `title="Dieses Dateiformat kann der Browser nicht direkt abspielen."`. A
  series card shows the badge only when `playableCount` is 0 (still a link).
- Series detail: back link "‹ Serien" (`/series`, `min-height:
  var(--tap-min)`), 2:3 placeholder with initials, H1 title, meta
  `2017 · 3 Staffeln · 26 Folgen`; season chips `<nav aria-label="Staffeln">`
  of in-page anchor links ("Staffel 1", …, "Specials", "Weitere Folgen"; ids
  `staffel-<n>`, `specials`, `weitere-folgen`), each ≥ `--tap-min` high,
  horizontally scrollable below 768 px; one `<section>` per season (H2 +
  muted "10 Folgen"); episode rows `.episode-row` (`min-height:
  var(--row-min)`, `position: relative`) on `secondary` with `border`
  dividers: episode number in `font-mono` muted (`01`, `01–02`, `–`; at least
  two digits), title (or "Folge 6" / "Folgen 1–2" when the title equals
  `episodeCode(...)`), meta `MP4 · 1,4 GB`, play icon; unplayable rows show
  the badge instead of the icon and are not links. Row root carries
  `data-item-id`; playable rows are `<a href="/player?id=<id>">`.
- File size: 1024-based, units B / KB / MB / GB,
  `Intl.NumberFormat('de-DE', { minimumFractionDigits: 1,
  maximumFractionDigits: 1 })` above 1023 B ("1,4 GB"), integer bytes below
  ("512 B"); GB is the largest unit.
- States: while loading, only the header (without count); empty +
  `scan.running` → "Bibliothek wird eingelesen …" / "Beim ersten Start kann
  das einige Minuten dauern." and the page re-fetches every 5 s until the list
  is non-empty or the scan has ended; empty → Filme: "Noch keine Filme" /
  "Lege Videodateien im Ordner „Filme“ ab – neue Dateien erscheinen nach
  wenigen Sekunden automatisch.", Serien: "Noch keine Serien" / "Lege Serien
  im Ordner „Serien“ ab, z. B. „Serien/Dark/Staffel 1/Dark S01E01.mp4“.";
  request error (`ApiError` other than 401, or network failure) → "Die
  Bibliothek konnte nicht geladen werden." + button "Erneut versuchen"
  (re-runs the fetch); detail page with missing/malformed `id` or 404 →
  "Diese Serie gibt es nicht mehr." + link "Zu den Serien". 401 → P1's
  `request` redirects to login (`redirectOn401` default). Empty/first-scan/
  missing-series states use P1's `createEmptyState({ title, text })`; DOM is
  built with P1's `el()`.
- Focus: P1's global focus ring (`var(--focus-width)` `primary` outline,
  `var(--focus-offset)` offset) on every link/button; Tab order = visual
  order; no custom arrow-key navigation.
- DOM contract for Phase 4: `movies.js` and `series-detail.js` render all
  cards/rows before resolving their render function; Phase 4 adds one import
  + one `decorateProgress(root, entries)` call after it, targeting
  `[data-item-id]` elements and their `.media-card__tile` / `.episode-row`
  (both `position: relative` for the 4 px bottom bar).

### QA fixture tree (committed, every file a few synthetic bytes)

```
test/fixtures/media/
  Filme/
    Arrival (2016)/Arrival (2016).mp4          -> "Arrival" 2016, playable (sniff unknown)
    Inception (2010)/inception.mp4             -> "Inception" 2010 (folder fallback)
    Blade.Runner.2049.2017.1080p.BluRay.x264.mp4 -> "Blade Runner 2049" 2017
    Metropolis 1927.webm                       -> "Metropolis" 1927, playable
    Heat (1995).mp4                            -> synthetic hvc1+mp4a boxes, NOT playable
    Das Boot (1981).mkv                        -> NOT playable
    Paprika (2006).avi                         -> NOT playable
    .versteckt.mp4, Extras/info.nfo            -> ignored
  Serien/
    Dark (2017)/Staffel 1/Dark S01E01 - Geheimnisse.mp4
    Dark (2017)/Staffel 1/Dark S01E02 - Lügen.mp4
    Dark (2017)/Staffel 1/Dark.S01E03.German.1080p.WEB.x264.mp4  -> title "S01E03", UI "Folge 3"
    Dark (2017)/Staffel 1/Dark S01E04 - Doppelleben.mkv          -> NOT playable
    Dark (2017)/Staffel 2/Dark S02E01 - Anfänge und Enden.mp4
    Dark (2017)/Specials/Dark S00E01 - Making-of.mp4             -> season 0
    Dark (2017)/Extras/Interview.mp4                             -> season NULL ("Weitere Folgen")
    Stromberg/Season 01/Stromberg - 1x01 - Der Parkplatz.mkv     -> NOT playable
    Stromberg/Season 01/Stromberg - 1x02.avi                     -> NOT playable
    Babylon.Berlin.S01E01.mp4                                     -> loose file, series "Babylon Berlin"
```

Expected: 7 movies (3 not playable); 3 series — "Babylon Berlin"
(1 Staffel · 1 Folge), "Dark" (2017, 2 Staffeln · 7 Folgen), "Stromberg"
(1 Staffel · 2 Folgen, badge). `Heat (1995).mp4` is generated once with
`test/helpers/mp4-boxes.js` and committed. Unit tests build their own temp
trees; this tree exists for the human QA walk and one scanner smoke test.

### File ownership (P2)

New: `src/db/migrations/002-library.sql`, `src/db/library-repo.js`,
`src/db/library-queries.js`, `src/library/categories.js`,
`src/library/parsers/{text,movie,series,compat}.js`,
`src/library/tags/mp4-codec.js`,
`src/library/{walk,item-builder,dir-sync,reconcile,scan-queue,scanner,dir-watch,watcher,index}.js`,
`src/api/library.js`, `src/api/library-json.js`,
`public/movies.html` (replaces P1 placeholder), `public/series.html`
(replaces P1 placeholder), `public/series-detail.html`,
`public/js/{movies,series,series-detail}.js`,
`public/js/lib/{media-card,library-icons,library-format,library-api}.js`,
`public/css/library.css`, tests mirroring each module under `test/` (incl.
`test/public/library-format.test.js`), `test/helpers/media-tree.js`,
`test/helpers/mp4-boxes.js`, `test/fixtures/media/Filme/**`,
`test/fixtures/media/Serien/**`.

Edited: `src/http/routes.js` (one `registerLibraryRoutes` line),
`src/server.js` (start/pass/stop the library service),
`docs/architecture.md` (component-map rows for the modules above incl.
`dir-watch.js`/`scan-queue.js`; "Change detection" row rewritten to
per-directory watches on Linux / recursive elsewhere; flow 1 with
`onScanComplete` and root safety; `library_series`; note on
`fs.inotify.max_user_watches` counting directories), `README.md` (section
"Medienordner": folder names, naming conventions, how to empty a category),
`docs/design.md` (Grid line — done in this spec PR),
`src/app.js` (one optional `library` property in the `AppDeps` typedef, no
logic). Not edited: `src/config.js`, `.env.example`, `public/css/tokens.css`,
P1's nav/shell/placeholder modules.

## Prior art

- [Library model and naming conventions (Phase 2)](../prior-art.md#library-model-and-naming-conventions-phase-2)
  — Jellyfin's `Title (Year)` movie and `Series/Season NN/Series SxxEyy`
  conventions (specials in Season 00) are the primary parse rules; metadata
  providers avoided.
- [Direct-play compatibility detection (Phase 2)](../prior-art.md#direct-play-compatibility-detection-phase-2)
  — static extension table; MKV and HEVC flagged incompatible in v1, no client
  capability probe. The MP4 sniffer exists to honour the HEVC verdict, which an
  extension alone cannot detect.
- [Detecting new files without restart (Phase 2)](../prior-art.md#detecting-new-files-without-restart-phase-2)
  — debounced watch (Navidrome's 5 s) plus an always-on periodic rescan; never
  stop watching after an error (jellyfin#16874, #10012). The ADOPT of a single
  recursive `fs.watch` is narrowed to macOS/Windows (see Prior decisions, D8).

## Design

Produced with Google Stitch (project `videothek`, working reference only); the
committed exports are the durable design:

- Filme grid: `docs/design/assets/library-video/filme-desktop.png`,
  `docs/design/assets/library-video/filme-mobile.png`
- Serien grid: `docs/design/assets/library-video/serien-desktop.png`,
  `docs/design/assets/library-video/serien-mobile.png`
- Series detail: `docs/design/assets/library-video/serie-detail-desktop.png`,
  `docs/design/assets/library-video/serie-detail-mobile.png`
- Matching `.html` exports next to each PNG are layout references only (one
  loads a CDN script — never copy them). Mobile PNGs are crops of Stitch's
  2560 px canvas to the 390 px phone column.

Where an export and this spec differ, the spec and `docs/design.md` win: the
primary colour is the `primary` token `#ff7a1a` (all six exports were
recoloured and show it); off-token shades in the exports map to the tokens and
P1's derived state tokens in `tokens.css` (D5); fonts are the system stack;
initials are at most two characters (an export shows "HTS"); tiles in one grid
row have equal height; phones always show at least two grid columns (H3); the
app bar/nav belong to Phase 1's shell; the empty and first-scan states are
specified in text above (no mockup); unplayable cards are not links.

## Human prerequisites

none for implementation. QA-only (does not block any issue): access to the
Raspberry Pi 4 (4 GB) production host with the real media disk to record the
rescan duration and idle RSS line in Verification (D8; the dev-machine
substitute was not accepted, so this line is run on the Pi).

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Category ids `movies`, `series`, `music`, `audiobooks`, `images`, exported as `CATEGORIES` from `src/library/categories.js`; used verbatim in API paths and params | Cross-phase consolidation D3; matches P1's page names; later phases import the constant instead of re-spelling it; German names stay UI-only. | 2026-09-26 |
| Top-level folder → category mapping NFC-normalised and case-insensitive; `Hoerbuecher` ASCII alias; each alias folder is its own category root | D3; macOS-written folders arrive as NFD; ASCII-only users/file systems. | 2026-09-26 |
| Admitted kinds per category live in one `KINDS` map in `categories.js` (`kindsFor`); the scanner and item builder are kind-generic | Human gate decision H9: Phase 6 indexes videos under `images` by changing one entry to `['image', 'video']`, without touching scanner code. | 2026-09-26 |
| Scan extension point = `onScanComplete(listener)` → unsubscribe, returned by `startLibrary()`; fires after every completed run with `{ kind, stats, completedAt }`, after the run leaves the queue, not awaited, failures logged; no enricher directory, no `updateItemDisplay` | Cross-phase consolidation D6: Phases 5/6 need backfill of pre-existing rows, retry after failure and must not block the scan queue (freshness ≤ 10 s); per-batch enrichers gave none of these. Listeners detect staleness via `source_size`/`source_mtime_ms`. | 2026-09-26 |
| `SCAN_VERSION` lives in `compat.js` next to the extension table; bumped by any change that alters results for already-indexed files | D6; the most frequent reason to bump is a table change, so the constant sits beside it. | 2026-09-26 |
| `compat.js` is the single extension/MIME table (`{ kind, playable, sniff, mime }`); P3's `mediaTypeFor(ext)` is a thin wrapper; image rows jpg/jpeg/jfif/png/gif/webp/avif/bmp displayable, heic/heif/tif/tiff/jxl/svg + RAW formats indexed not displayable; audio incl. `weba`; `ogv`, `mov` not playable | Cross-phase consolidation D9: removes the P2/P3/P6 drift. RAW formats (`dng`, `cr2`, …) are kept as "indexed, not displayable" because both the P2 and P6 drafts list them and D9 does not exclude them. `svg` is never playable, so `/media/:id` never serves it. | 2026-09-26 |
| Hard delete of vanished rows + `AUTOINCREMENT` ids; upsert via `ON CONFLICT(rel_path) DO UPDATE` | Architecture flow 1; ids of present files stay stable across rescans/restarts and a freed id is never reused. Progress (P4) is keyed by `(user_id, rel_path)` (D11) because a reappearing file gets a new id and a rebuilt index reassigns all ids. | 2026-09-26 |
| Migration 002 is `STRICT`, uses `AUTOINCREMENT`, contains no `BEGIN`/`COMMIT` | Cross-phase consolidation D12: P1's runner wraps each file incl. the `schema_migrations` insert in one transaction. | 2026-09-26 |
| `library_series` table with its own `AUTOINCREMENT` id, keyed by series folder name | The series detail route needs a stable id that is not a path (architecture: clients reference by index id, never by raw path). | 2026-09-26 |
| `series_title` denormalised into `library_items` | `toItemJson(row)` must work on a bare `library_items` row (Phase 4 selects rows without a join). | 2026-09-26 |
| `scan_version` column + constant forces re-parse after parser/compat changes | Unchanged files (same size/mtime) would otherwise keep stale titles or playable flags forever. | 2026-09-26 |
| MP4/M4V/M4A/M4B are sniffed for sample-entry fourccs; HEVC, Dolby Vision, MPEG-4 Part 2, AC-3/E-AC-3/DTS, ALAC → not playable; sniff failure → playable by extension | Prior art: flag HEVC incompatible in v1; vision: incompatible files clearly marked. AC-3 audio plays silently in Chromium/Firefox. A failed sniff must not hide a probably-fine MP4. | 2026-09-26 |
| `.mov` and `.ogv` not playable | `.mov` has no reliable cross-browser MIME support in Firefox; Chromium dropped Theora. Conservative; revisit with evidence (+ `SCAN_VERSION` bump). | 2026-09-26 |
| Symlinks are never followed or indexed | Constitution: containment inside `MEDIA_ROOT`; skipping avoids escape, loops and duplicates without realpath bookkeeping. | 2026-09-26 |
| Hidden names (leading `.`) and NAS/OS system folders are skipped | They are never media (AppleDouble `._*`, Synology `@eaDir`, recycle bins). | 2026-09-26 |
| Index safety: a category root (or `MEDIA_ROOT`) that has rows but is missing, empty or unreadable deletes nothing, warns and sets `lastError`; a reconcile of a missing path checks its root first and escalates to a full scan; non-ENOENT `stat`/`lstat` errors keep rows; unreadable directories protect their subtree; emptying a category needs one file left or a DB delete | Cross-phase consolidation D7: an unmounted disk leaves a readable, empty mount point, which would otherwise wipe the index (and cascade P5/P6 metadata). | 2026-09-26 |
| Diff by `size` + `mtime_ms` (+ `scan_version`); parse/sniff only new or changed files; per-directory processing with ≤ 500-row transactions; sequential depth-first walk | Keeps a rescan of an unchanged library to `readdir` + `stat` calls, memory bounded by one directory, event-loop blocks short, a USB disk on a Pi un-thrashed. | 2026-09-26 |
| Scanner split into `walk`, `item-builder`, `dir-sync`, `reconcile`, `scan-queue`, `scanner` modules | Review finding: one `scanner.js` would exceed the 300-line limit; each module is PR-sized and separately testable. | 2026-09-26 |
| Change detection: Linux = one non-recursive `fs.watch` per indexed directory, registered by the scanner walk (`dirObserver.seen` before listing) with per-watch error handling; macOS/Windows = native recursive watch with backoff 5 s → 5 min and a full scan after recovery | Cross-phase consolidation D8: on Linux, Node's recursive `fs.watch` walks the tree synchronously and keeps one inotify watch plus `Stats` per file (~1.3 KB heap per entry measured; 50 k files ≈ 65 MB) and swallows errors — incompatible with the 100 MB RSS target. Registering before listing closes the add-during-walk race. | 2026-09-26 |
| Debounce 5 s trailing, max wait 8 s; > 1000 pending paths or `null` filename → full scan; pending path reconciles run between directories of a running full scan | D8: event → flush ≤ 8 s leaves ≥ 2 s for the reconcile inside the 10 s freshness bound, also during a long full scan. | 2026-09-26 |
| One serialised scan queue with coalescing; watcher and timer only enqueue | Constitution/brief: no overlapping scans; serialises all index writes. | 2026-09-26 |
| Debounce, max wait, backoff, batch size are code constants; only `RESCAN_INTERVAL_MIN` is configurable (already validated by P1) | Constitution fixes the env-var list; P1 owns `src/config.js`. | 2026-09-26 |
| `startLibrary` returns synchronously; watcher start and the initial scan are deferred; `library` is built in `server.js` `start()`, passed to `createApp` as an extra key, stopped in `stop()` before the DB closes; `src/app.js` only gains the optional `library` in its `AppDeps` typedef | D4 and P1's server contract: wiring never delays `listen`; `createApp` passes extra keys through to route modules. | 2026-09-26 |
| Logging through the injected `log` as JSON events (`library_scan_complete`, `library_scan_failed`, `library_dir_failed`, `library_root_protected`, `library_names_undecodable`, `library_watch_error`, `library_watch_limit`, `library_listener_failed`, `library_scan_run_failed`, `library_scan_queue_oncomplete_failed`) | D4: no `console.*` in modules; one log format for the whole app; the last two are `scan-queue.js`-internal (unexpected `runFull`/`runPaths` failure, `onComplete` failure), distinct from the scanner's own `library_scan_failed`/`library_listener_failed`. | 2026-09-26 |
| API timestamps are ISO-8601 strings (`addedAt`, `scan.lastCompletedAt`); DB keeps epoch ms | D4 cross-phase JSON convention. | 2026-09-26 |
| `next` and `subtitles` appear only in `GET /api/library/items/:id` and are added by Phase 3; P2's `toItemJson` and list responses never carry them | Cross-phase consolidation D10 + human gate decision H4 (subtitles = `.vtt` sidecars discovered at request time, never indexed). | 2026-09-26 |
| Page URLs `/movies`, `/series`, `/series-detail?id=<seriesId>`; player links `/player?id=<itemId>`; P2 replaces P1's `movies.html`/`series.html` placeholders and never edits nav or `placeholder.js` | Cross-phase consolidation D1. | 2026-09-26 |
| Grid columns `repeat(auto-fill, minmax(min(var(--grid-min), calc(50% - 8px)), 1fr))` (in CSS `calc(50% - var(--space-2))`, as P1's literal-length rule prescribes), recorded in `docs/design.md` Grid | Human gate decision H3 (option B): 160 px everywhere except that phones always get two columns (≈ 156 px at 360 px); 8 px = half the 16 px gap, written as the `--space-2` token so no raw length leaves `tokens.css` (D5). | 2026-09-26 |
| Tokens only from P1's `tokens.css` (`--grid-min`, `--row-min`, `--tap-min`, `--border-width`, `--focus-*`, text/space/radius/shadow scales); episode rows use `--row-min`; card uses `shadow-sm`; chips, back link and sort links ≥ `--tap-min` | D5; design.md Media card (`shadow-sm`) and list rows; review finding on touch targets. | 2026-09-26 |
| Movie and series cards use the 2:3 "poster fallback" ratio with a tokenized initials placeholder | design.md: 2:3 poster fallback; no posters or frames exist (no ffmpeg, no network). | 2026-09-26 |
| Sorting: `A–Z` (natural, accent-insensitive, no article stripping) and "Neu hinzugefügt" | Predictable for German and English titles alike; "new" helps find freshly copied files. | 2026-09-26 |
| Unplayable movies/episodes are shown but not linked | Vision: incompatible files are listed and clearly marked; Phase 3 streams only playable items. | 2026-09-26 |
| No pagination in v1; `GET /api/library/:category` returns flat item lists for music/audiobooks/images too | Household scale; Phases 5/6 serve their own grouped routes (`/api/music…`, `/api/gallery`), the flat list stays for QA and simple consumers. | 2026-09-26 |
| Episode title fallback is the language-neutral code (`S01E06`); the UI renders "Folge 6" | Server stays free of German strings; `title` is never empty for other consumers. | 2026-09-26 |
| File sizes 1024-based with B/KB/MB/GB labels, one decimal, de-DE formatting | Matches the file managers the household uses; one fixed rule for the implementer. | 2026-09-26 |
| No custom arrow-key grid navigation; native Tab order | Keeps P2 minimal; TV browsers provide spatial navigation for links; P6 reuses nothing from P2 here. | 2026-09-26 |
| Phase 4 decorates via DOM contract (`[data-item-id]`, `.media-card__tile`, `.episode-row`, both `position: relative`) and one call in `movies.js`/`series-detail.js` | P4 runs after P2; attribute/class contract keeps library responses user-agnostic (architecture boundary). | 2026-09-26 |
| Initial scan runs asynchronously after the server starts listening; the API reports `scan.running`, the UI shows a first-scan state and re-fetches every 5 s | A first scan of a large disk must not delay login; the user sees why the library is empty. | 2026-09-26 |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (`npm run verify`):

- [ ] Verify passes; `npm ls --omit=dev --all` lists no packages; no
      `console.` call in `src/library/`, `src/api/library*.js`,
      `src/db/library-*.js`; every new file ≤ 300 lines.
- [ ] Migration 002 applies after 001 through P1's runner; re-run is a no-op;
      both tables are `STRICT`; `INSERT OR REPLACE` appears nowhere in `src/`.
- [ ] Repository: upsert keeps the id when size/mtime change; a deleted row's id
      is not reused by the next insert; prefix delete with `_`/`%` in names
      deletes exactly the subtree; series upsert keeps its id; orphaned series
      are removed after their last episode; deleting an item cascades to a
      test table declared `REFERENCES library_items(id) ON DELETE CASCADE`.
- [ ] Categories: every alias maps (case variants, NFD "Hörbücher",
      "Hoerbuecher"); other names → `null`; `kindsFor` per category.
- [ ] Parsers: table-driven cases for every movie rule (parens year, scene name,
      title starting with a year, "Blade Runner 2049 (2017)", folder fallback,
      no year, year above now+1 rejected) and every series rule (SxxEyy,
      multi-episode, 1x02, "1920x1080" no match, season folder +
      "Folge 3"/leading number, Specials → 0, loose root file, no numbers →
      unnumbered, code fallback title); `sortKey` natural/accent order;
      `episodeCode` forms.
- [ ] Compat + sniffer: synthetic MP4s built by `test/helpers/mp4-boxes.js`
      (avc1+mp4a → playable; hvc1, ac-3, alac, mp4v → not; `moov` after a 64-bit
      `mdat`; truncated/looping/oversized boxes → `null` without throwing);
      every table extension resolves with `mime` iff `playable`; `svg`
      not playable; size 0 → not playable.
- [ ] Walk + item builder: skip rules (hidden, system folders, symlinks —
      `t.skip` where the OS forbids creating them — U+FFFD names); non-admitted
      kinds ignored (`.jpg` in `Filme/`, `.mp4` in `Bilder/`); movies/series
      rows carry parser results.
- [ ] Scan queue: concurrent `requestFull`/`requestPaths` never overlap and
      coalesce to at most one follow-up run; paths requested during a full
      run are drained between directories.
- [ ] Scanner (temp trees via `test/helpers/media-tree.js`): first scan
      indexes exactly the expected rows; a second scan of 2 000 unchanged
      files in 200 directories performs zero inserts/updates/deletes and zero
      sniffs; changed size/mtime/`scan_version` re-parses keeping the id;
      removed file and removed directory delete their rows; a directory made
      unreadable keeps its rows (POSIX only); unreadable `MEDIA_ROOT` aborts
      without changes; an **emptied category root (mount-point simulation)**
      and a **removed category root** delete nothing and set
      `lastError = 'root_protected'`; a reconcile of a missing file under a
      removed root escalates to a full scan; a reconcile adding a file in a
      directory the running full scan already passed survives the sweep;
      `onScanComplete` fires once per run with the right `kind`, a throwing
      listener is logged and the next scan still runs, `unsubscribe` works;
      the fixture tree smoke test yields 7 movies (3 not playable) and 3
      series.
- [ ] Change detection (fake `watchFn`, fake scanner, `node:test` mock
      timers): events within 5 s flush once; a continuous stream flushes at
      8 s; `null` filename and > 1000 paths escalate to full; Linux mode
      registers one watch per `seen` directory, closes on `gone`/`sweep`,
      handles a per-watch `error` by rescanning that directory, stops adding
      after `ENOSPC`; recursive mode restarts with 5 s, 10 s, … capped at
      5 min and requests a full scan after recovery; `stop()` clears
      everything.
- [ ] Watcher scale (own test file, real `fs.watch` in Linux mode on every
      OS): a temp tree of 20 000 zero-byte files in 400 directories yields
      exactly 402 watches (root + category root + 400 directories) and
      heap growth across watch registration below 8 MB.
- [ ] Freshness (real scanner, fake watcher events, injected short debounce):
      a file added to the temp tree is in `library_items` right after the
      flush, also while a slow full scan is in progress; with a silent watcher
      it appears after the injected interval.
- [ ] Service: `startLibrary` returns before any scan I/O; `stop()` resolves
      with no timers or watches left (test exits without `--test-force-exit`).
- [ ] API: every route answers 401 without a session; unknown category,
      malformed/unknown id and unknown series → 404 `not_found`; bad sort →
      400 `invalid_sort`; response shapes and all sort/season/episode
      orderings as specified; ISO timestamps; `scan` reflects a fake
      `library` injected via P1's `startTestApp({ library })` and defaults
      without it; no `relPath`/`dir` in any response.
- [ ] Frontend helpers (`test/public/library-format.test.js`): initials,
      plurals, file sizes, episode number and "Folge N" labels.

Human QA (Chromium + Firefox, `MEDIA_ROOT=test/fixtures/media`, phone 360–390 px
and desktop 1440 px, compared with the design exports):

- [ ] Filme: all fixture movies with correct titles/years ("Inception" from its
      folder, "Blade Runner 2049" from a scene name); MKV, AVI and the HEVC
      fixture show "Nicht abspielbar" and are not clickable; "Neu hinzugefügt"
      reorders and survives reload via the URL; two columns on a 360 px phone.
- [ ] Serien: "Dark" shows "2 Staffeln · 7 Folgen"; "Stromberg" shows the badge;
      the loose root file forms the series "Babylon Berlin"; Dark's detail page
      lists Staffel 1, Staffel 2, Specials, Weitere Folgen in that order; the
      scene-named episode reads "Folge 3"; S01E04 shows the badge and is not
      clickable; chips jump to their sections.
- [ ] With the server running, copy a new `.mp4` into `Filme/`: it appears on
      reload within 10 s; delete it: it disappears within 10 s; the log shows
      `library_scan_complete` with `kind: "paths"`, no full scan.
- [ ] Rename `Filme/` away while the server runs: the log shows
      `library_root_protected`, the movies stay listed; rename it back.
- [ ] Stop the server, delete the DB file, start again: the Filme page first
      shows "Bibliothek wird eingelesen …" (on a slow disk) or the full grid; an
      empty `Filme/` (no rows yet) shows the empty state.
- [ ] Keyboard only: Tab reaches the sort links, every playable card, chips and
      episode rows with a visible primary (orange) focus ring; unplayable items
      are skipped.
- [ ] On the Raspberry Pi 4 target with the real library (QA-only
      prerequisite): the logged `durationMs` of a periodic rescan of the
      unchanged library and the process RSS after it (vision: idle < 100 MB)
      are noted in the QA comment.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Linux inotify limit (`max_user_watches`) reached on a library with very many directories | Watches count directories, not files; `ENOSPC` logged once, periodic rescan covers the rest; architecture note on raising `fs.inotify.max_user_watches`. |
| USB/exFAT/SMB mounts drop watch events | Periodic rescan backstop; per-watch error recovery; watcher never stays off. |
| A single huge directory (thousands of files) delays interleaved reconciles past 10 s during a full scan | Drain points are only between directories (a mid-directory drain could resurrect a file the reconcile just deleted); unchanged directories are `stat`-only and full scans are rare (every 15 min), so the bound is exceeded only for a directory whose `stat` pass takes > 2 s during a full scan. Accepted. |
| Media disk unmounted while the mount point stays readable | Root safety (D7): nothing is deleted, `library_root_protected` warns; the index is derived data if the user deletes the DB on purpose. |
| Partially copied files get indexed mid-copy | Size/mtime change on completion re-parses and re-sniffs; a 0-byte start is flagged not playable. |
| MP4 with `moov` at the end of a multi-GB file | The sniffer seeks via box headers (≤ 64 KiB read), never reads `mdat`. |
| Parser misreads unusual names | Fallback titles are always non-empty; `scan_version` lets a parser fix reach existing rows; table-driven tests grow with reported cases. |
| Large flat category JSON (e.g. 20 000 images at `/api/library/images`) | No P2 page requests it; Phases 5/6 own grouped routes. |
| Firefox/Chromium codec support changes (HEVC, `.mov`) | One table in `compat.js` + `SCAN_VERSION` bump reclassifies everything on the next scan. |
| `onScanComplete` listeners overlap the next scan | Listener contract (single-flight, staleness by size/mtime, FK errors on deleted items tolerated). |
| `src/http/routes.js` / `src/server.js` edited by several phases | One registration line / a few start+stop lines each; trivial rebase. |

## Decision log

- 2026-09-26: Hard delete + `AUTOINCREMENT` chosen over soft delete — Phase 4
  keys progress by `rel_path`, so soft delete would only add a
  `removed_at IS NULL` filter every consumer could forget.
- 2026-09-26: Codec sniffing added to realise the prior-art HEVC verdict;
  AC-3/E-AC-3/DTS and ALAC added by the same "browser-compatible" rule from the
  vision.
- 2026-09-26: Watcher events reconcile individual paths instead of triggering
  full scans, so the 10 s freshness criterion holds on a Pi-sized library.
- 2026-09-26: cross-phase consolidation — category ids plural (`movies`,
  `series`, `music`, `audiobooks`, `images`) exported as `CATEGORIES` (D3).
- 2026-09-26: cross-phase consolidation — page URLs `/movies`, `/series`,
  `/series-detail?id=`, player `/player?id=`; P2 replaces its placeholder
  files, never edits nav (D1).
- 2026-09-26: cross-phase consolidation — P1 server/frontend contracts adopted
  verbatim (D4, D5): `ctx`, `library` built in `server.js` `start()` and
  passed as a `createApp` extra key (only an `AppDeps` typedef line in
  `src/app.js`), injected JSON logging, ISO `…At` timestamps,
  `request`/`mountShell`/`el`/`createEmptyState`/`createIcon`,
  `startTestApp({ ...extra })`, token names incl. `--grid-min`/`--row-min`,
  half-gap written `calc(50% - var(--space-2))`.
- 2026-09-26: cross-phase consolidation — enricher hook removed in favour of
  `onScanComplete` returned by `startLibrary()` (D6); supersedes the earlier
  draft's enricher directory and `updateItemDisplay` (review BLOCKING 1).
- 2026-09-26: cross-phase consolidation — index safety for missing/empty/
  unreadable roots (D7; review BLOCKING 2).
- 2026-09-26: cross-phase consolidation — per-directory watches on Linux,
  native recursive elsewhere, max wait 8 s, drain reconciles during full scans,
  20 k-file watcher test, mandatory Pi RSS QA line (D8; review BLOCKING 3).
- 2026-09-26: cross-phase consolidation — `compat.js` is the single
  extension/MIME table with `{ kind, playable, sniff, mime }`; added `jfif`,
  `jxl`, `weba`; `svg` indexed, never playable; `SCAN_VERSION` moved into
  `compat.js` (D9, D6; review BLOCKING 4).
- 2026-09-26: `scan-queue.js` — `drainPathsBetweenDirs()` is a nested-call
  contract: it assumes it is only ever invoked from within the currently
  running `runFull`, so it neither toggles the queue's own in-flight state
  nor triggers chaining itself; only the top-level dispatch (`startNext`)
  owns those. This keeps "at most one run in flight" correct without a
  re-entrancy flag. A thrown/rejected `onComplete` at this internal
  scan-queue seam (between `scan-queue.js` and `scanner.js`, before
  `scanner.js` dispatches to its own public `onScanComplete` listeners) is
  logged as `library_scan_queue_oncomplete_failed`, distinct from
  `library_listener_failed` (D6's event name for a public listener's own
  failure) so the two are told apart in logs. A rejected (not just thrown)
  `onComplete` is caught and logged the same way, since Node 24 terminates
  the process on an unhandled rejection.
- 2026-09-26: `scan-queue.js` treats a `'paths'` run's resolved value as
  opaque except for one field: a truthy `escalate` (the shape `reconcile.js`
  returns per the path-reconcile rules above) makes the queue set its
  pending kind to `'full'` — never downgrading an already-pending
  `'initial'` — so the top-level `MEDIA_ROOT`-or-category-root escalation
  case chains into one follow-up full run instead of waiting for the
  periodic rescan. Applies identically to a top-level `'paths'` job and one
  run inline via `drainPathsBetweenDirs()`. A thrown/rejected `runFull` or
  `runPaths` is logged as `library_scan_run_failed`, an internal
  scan-queue-only event distinct from the scanner's own `library_scan_failed`
  (which covers an expected, handled abort such as an unreadable
  `MEDIA_ROOT` and still resolves normally); `library_scan_run_failed` fires
  only for an unexpected failure that escapes `scanner.js`'s own handling.
- 2026-09-26: cross-phase consolidation — `next`/`subtitles` only in the
  single-item response, added by Phase 3 (D10, H4).
- 2026-09-26: cross-phase consolidation — migration 002 `STRICT` +
  `AUTOINCREMENT`, no transaction statements (D12); architecture.md edits
  listed in scope (D13).
- 2026-09-26: gate decision — phone grid option B (H3):
  `minmax(min(var(--grid-min), calc(50% - 8px)), 1fr)`, recorded in
  `docs/design.md` Grid in this spec PR.
- 2026-09-26: gate decision — videos in `Bilder/` = option C (H9): P2 keeps
  admitted kinds in one `KINDS` map so Phase 6 admits `video` under `images`
  with a one-line edit of `categories.js`.
- 2026-09-26: review non-blocking findings applied — scanner pre-split into
  six modules, injected logging, chips/back link ≥ `--tap-min`, media card
  `shadow-sm`; `src/app.js` is touched only for the `AppDeps` typedef line
  (P1's contract builds deps in `server.js` `start()`, narrowing the review's
  "library deps into createApp"); the recursive-watch human prerequisite is
  moot with per-directory watches on Linux.
- 2026-09-26: pre-mortem — settled: `now` injected for timestamps and the
  year bound; run kinds `initial`/`full`/`paths`; watch registered before a
  directory is listed; interleaved reconciles extend the visited set;
  `onScanComplete` not fired for aborted runs; `sort` default and invalid
  URL values; file-size format; "Folgen 1–2" label; season-less series meta;
  README section "Medienordner".
- 2026-09-26 (#27): `src/db/library-repo.js`'s write functions take/return
  plain objects whose keys are the table's snake_case column names verbatim
  (`rel_path`, `mtime_ms`, …), not a camelCase JS-side shape — so
  `item-builder.js`'s (#32) `buildItem()` result can be passed into
  `upsertItem()` unchanged, and a loaded row can be passed into
  `toItemJson()` unchanged. `playable` is accepted as a JS boolean and
  coerced to `0`/`1` at the bind boundary (`node:sqlite` cannot bind a JS
  `boolean`). The upsert functions use `... ON CONFLICT ... RETURNING id` in
  one round trip instead of a separate lookup `SELECT`.
- 2026-09-26 (#27): added `deleteItem(db, relPath)` (exact single-row delete)
  alongside the range-form `deleteItemsUnderDir(db, dir)` the issue names —
  needed by the planned `reconcile.js` (#33) for a single vanished/
  unplayable/skipped file, distinct from a whole-subtree delete.
- 2026-09-26 (#29): `sniffMp4Codecs(absPath)` is async (`Promise<SniffedCodecs
  | null>`) — the spec's arrow notation left this implicit; callers (P2's
  item builder) must `await` it. Within one `trak`, a missing `mdia`, `hdlr`,
  `minf`, `stbl`, `stsd`, or an empty `stsd` skips only that track (it
  contributes nothing to `video`/`audio`) rather than aborting the whole
  file — only an actual guard violation (box count/depth/size-fits-parent/
  64 KiB read budget) or a real I/O truncation aborts the walk and yields
  `null`. This keeps a track type the sniffer doesn't care about (hint,
  timecode, …) from ever downgrading a file to "unknown", while a moov
  literally missing is still treated as `null` per spec.
- 2026-09-26: change detection (#31) — `MEDIA_ROOT` itself is watched by
  `watcher.js`'s `start()` calling `dirObserver.seen('')` directly, not by the
  scanner's walk: the scanner (#33) only calls `seen(relDir)` for category
  roots and their descendants (readdir(MEDIA_ROOT) enumerates roots but is
  never itself passed to `syncDirectory`), yet "MEDIA_ROOT and every directory
  the walk visits get one watch" requires it watched too. `seen('')` is
  idempotent, so `startLibrary` (#34) needs no special-casing either way.
- 2026-09-26: change detection (#31) — "the same backoff applies to the
  Linux MEDIA_ROOT watch" is implemented by having `watcher.js` intercept
  `dirObserver`'s `onWatchError('')` (the root's entry in the same
  per-directory watch set, not a second parallel watch) and run it through
  the identical 5 s→5 min doubling reconnect + "one full scan on recovery"
  used for the macOS/Windows recursive watch, instead of the generic
  per-directory `requestPaths([dir])` handling every other directory gets.
- 2026-09-26: change detection (#31) — `dir-watch.js`'s ENOSPC/EMFILE
  "stop adding watches" flag is cleared inside `sweep()` (only ever called
  after a full scan), so watches resume being attempted starting with the
  next full scan's walk, matching "stops adding watches until the next full
  scan" without a separate reset signal.
- 2026-09-26: change detection (#31), review fix — the entry above settled
  how `''` gets *watched*, but not how it survives `sweep()`: since the
  scanner's walk never visits MEDIA_ROOT, its `visitedDirs` set never
  contains `''`, so a `sweep()` that closed every unvisited key like any
  other directory would close the root watch after the very first full scan,
  with no code path ever calling `seen('')` again. Fixed by having `sweep()`
  unconditionally skip the `''` key — its lifecycle stays owned by
  `start()`/`stop()`, outside the scanner-driven visited set entirely. Covered
  by a `dir-watch.test.js` case asserting `sweep(new Set(['Filme']))` leaves
  `''` open. (The matching ENOSPC-on-`''` edge case — `seen('')` itself
  failing with a limit error before any watch exists — is left for `startLibrary`
  (#34)/the scanner (#33) to close, since a `sweep()`-side retry would race
  `watcher.js`'s own root backoff bookkeeping in `rootRetrying`/`attemptRootWatch`.)
- 2026-09-26 (issue #28): review caught that `cleanName`'s empty-result
  rescue masked the episode-title fallback rule ("Empty → `episodeCode(...)`")
  for a suffix that is release tags with real words (e.g.
  `.German.1080p.WEB.x264`), producing `"German 1080p WEB x264"` instead of
  the code and breaking the `Dark.S01E03...` QA-fixture line. Fixed in
  `src/library/parsers/text.js` by splitting `cleanName` into an exported
  `cutReleaseTokens` step (no rescue) and the rescue itself; the
  episode-title fallback now checks `cutReleaseTokens` emptiness before the
  rescue can reintroduce release tags as text. `cleanName`'s own
  input/output contract is unchanged. The QA fixture's stated title
  `"S01E03"` stands as originally specified.
- 2026-09-26 (issue #32): `item-builder.js`'s `buildItem({ mediaRoot, relPath,
  category, stat, now })` takes `relPath` relative to `MEDIA_ROOT` (matching
  `library_items.rel_path` verbatim, including the leading category-root
  segment), not relative to the category folder — it strips the first path
  segment itself before calling `parseMovie`/`parseEpisode`, so callers never
  need to know which alias folder ("Filme" vs "Movies") matched on disk. For
  `category: 'series'` the returned row carries two extra fields beyond
  `LibraryItemInput` — `series_key` (-> `library_series.series_key`) and
  `series_year` (-> `library_series.year`) — since `item-builder.js` never
  touches the database (architecture: `src/library/` has no DB access) and so
  cannot resolve `series_id` itself; `series_title` doubles as both the
  series' own title and the denormalised `library_items.series_title` column,
  since both are the same value. `dir-sync.js` (a later step) upserts
  `library_series` from `series_key`/`series_title`/`series_year`, sets
  `series_id` on the row, and can then pass it into `upsertItem()` unchanged,
  matching the (#27) hand-off note. `video_codec`/`audio_codec` are each the
  *first* sniffed fourcc of their track type (`codecs.video[0] ?? null` /
  `codecs.audio[0] ?? null`), matching the migration's column comments.
  `walk.js`'s `listDirectory(absDir, { statFn? })` takes an optional,
  test-only `statFn` (default `fs.stat`) to let tests inject a deterministic
  non-`ENOENT` `stat` failure without relying on platform-specific
  permission tricks; production callers always call it with one argument.
  Hidden names and the known NAS/OS system folders are skipped silently
  (uncounted, per `isSkippedName`); symlinks and U+FFFD (undecodable) names
  are counted in `skipped` since the scanner logs their counts once per run.
