# Spec: Library index — movies & series

> Created: 2026-09-26

Index every file under the configured media root into SQLite, classify it by
top-level folder into the five categories, parse movie and series names, flag
browser-incompatible files, keep the index fresh through a debounced watcher
plus a periodic full rescan, and let a logged-in user browse movies and series
in the browser. This spec carries no lifecycle state — acceptance is the spec
merged on the default branch with a milestone and issues, and all progress (in
progress, done, blocked) lives in the GitHub issues and milestone. A completed
spec is moved to `docs/specs/archive/`.

## Outcome

- [ ] On startup the server indexes every media file under the five category
      folders of `MEDIA_ROOT` without blocking HTTP; `library_items` holds one
      row per indexed file with category, kind, title, grouping columns,
      `playable`, `size`, `mtime_ms`.
- [ ] A video copied into `Filme/` or `Serien/` of a running server appears in
      `GET /api/library/movies` resp. `/api/library/series` within 10 s (watcher
      path, no full scan running); a deleted file disappears within the same
      bound.
- [ ] With the watcher broken or silent, the same changes appear after the next
      periodic full rescan (`RESCAN_INTERVAL_MIN`, default 15 min).
- [ ] An unchanged file keeps its `id` across any number of rescans and server
      restarts; ids are never reused for another file.
- [ ] Browser-incompatible files (MKV, AVI, HEVC- or AC-3-in-MP4, …) are listed
      with `playable = false` and shown with a "Nicht abspielbar" badge; they
      are never linked to the player.
- [ ] The Filme page shows all movies as a responsive card grid sorted A–Z or
      by "Neu hinzugefügt", with tokenized initials placeholders, an empty state
      and a first-scan state.
- [ ] The Serien page shows all series as cards with season/episode counts; the
      series detail page lists seasons (Staffel N, then Specials, then Weitere
      Folgen) with episode rows in episode order.
- [ ] Files in `Musik/`, `Hörbücher/` and `Bilder/` are indexed with category,
      kind, minimal title and `playable`, so Phases 5 and 6 only add parsers,
      metadata and UI.
- [ ] Hidden files, system folders and symlinks are never indexed; an unreadable
      directory is logged and never causes its already-indexed files to be
      removed; no two scans ever run at the same time.
- [ ] `npm run verify` is green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- Migration `002-library.sql`: tables `library_items` and `library_series`
  (contract below).
- Category + folder classification for all five categories; hidden/system/
  symlink skip rules.
- Filename parsers: shared title normalisation, movie parser, series/episode
  parser; minimal title for music/audiobook/image files.
- Direct-play compatibility table for video, audio and image extensions, plus a
  header-only MP4/M4A codec sniffer (`moov`/`stsd` sample-entry fourccs).
- Scanner: full scan, subtree scan and single-path reconcile; diff by
  `size` + `mtime_ms` + `scan_version`; per-directory transactions;
  serialised run queue; an enricher hook (directory-discovered modules) that
  Phases 5/6 plug into without editing the scanner.
- Watcher: debounced recursive `fs.watch` feeding path reconciles, periodic
  full rescan, error recovery with backoff; wiring into `src/server.js`
  startup/shutdown.
- Browse API: `GET /api/library/:category`, `GET /api/library/series/:id`,
  `GET /api/library/items/:id`; an exported item JSON serializer and by-id
  lookup for Phases 3–6.
- UI: Filme grid page, Serien grid page, series detail page, shared media card /
  placeholder / badge / grid / empty-state components.
- Test fixtures `test/fixtures/media/Filme/` and `test/fixtures/media/Serien/`
  (tiny synthetic files, no real media).

### Out of scope

- Streaming, the player page, `/media/:id` (Phase 3). Cards link to the player
  URL, which works once Phase 3 lands.
- Progress bars, "Gesehen" badges, "Weiterschauen" (Phase 4 decorates P2's
  cards via `data-item-id`).
- Music/audiobook/image parsers, tag/EXIF reading and their pages (Phases 5, 6).
  P2 only indexes those categories with a minimal title.
- Posters, thumbnails, frame grabs, online metadata — no ffmpeg, no network
  (constitution).
- Extras/trailer/sample detection in movie folders (listed as ordinary movies),
  multi-part movie stacking (`CD1`/`CD2` are separate items), daily/date-based
  and absolute-numbered (anime) episodes (land in "Weitere Folgen"), subtitles.
- Search, filters beyond the two sort orders, pagination (see Risks), live push
  of index changes to open pages (a reload shows them).
- Following symlinks, multiple media roots, per-item permissions.
- New configuration values — debounce, backoff and batch sizes are code
  constants.

## Constraints

- Constitution applies unchanged: zero runtime deps; `MEDIA_ROOT` read-only
  (the scanner only calls `readdir`, `lstat`/`stat`, `open(…, 'r')` + `read`);
  SQL only in `src/db/` via prepared statements; JSON errors
  `{ "error": "<code>" }`; config only via `src/config.js`; ≤ 60 lines per
  function, ≤ 300 lines per file; JSDoc on every export; a `test/` suite per new
  `src/` module; German UI copy; tokens only via `public/css/tokens.css`; no
  `innerHTML` with data (DOM built with `textContent` / `createElement[NS]`).
- Builds on Phase 1: `src/db/index.js` + migration runner (applies
  `src/db/migrations/NNN-*.sql` in order, `PRAGMA foreign_keys = ON`),
  `src/http/router.js`, `src/http/routes.js`, JSON/error helpers,
  `requireUser`, `src/config.js` (`mediaRoot`, `rescanIntervalMin`), app shell +
  category nav, `tokens.css`, `base.css`.
- `src/library/` knows nothing about HTTP or users; `src/api/` knows nothing
  about file formats; `public/` never imports server modules (architecture
  boundaries).

### Data model (migration `002-library.sql`)

```sql
CREATE TABLE library_series (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  series_key TEXT    NOT NULL UNIQUE,  -- series folder name (or parsed name of a loose file)
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
  series_id    INTEGER REFERENCES library_series(id),
  series_title TEXT,                      -- denormalised for serializers without a join
  season       INTEGER,                   -- 0 = specials, NULL = unknown
  episode      INTEGER,
  episode_end  INTEGER,                   -- multi-episode files (S01E01-E02)
  video_codec  TEXT,                      -- sample-entry fourcc from the sniffer, else NULL
  audio_codec  TEXT,
  playable     INTEGER NOT NULL CHECK (playable IN (0, 1)),
  size         INTEGER NOT NULL,
  mtime_ms     INTEGER NOT NULL,          -- Math.trunc(stat.mtimeMs)
  scan_version INTEGER NOT NULL,          -- SCAN_VERSION constant at parse time
  added_at     INTEGER NOT NULL,          -- epoch ms, set on insert only
  scanned_at   INTEGER NOT NULL           -- epoch ms, last (re)parse
) STRICT;

CREATE INDEX library_items_category_sort ON library_items (category, sort_title);
CREATE INDEX library_items_dir ON library_items (dir);
CREATE INDEX library_items_series ON library_items (series_id, season, episode);
```

- A row exists iff the file is currently present and indexable (vanished files
  are deleted, architecture flow 1). `AUTOINCREMENT` guarantees a deleted id is
  never handed to another file; upserts use
  `INSERT … ON CONFLICT(rel_path) DO UPDATE` (never `INSERT OR REPLACE`, which
  would change the id).
- `library_series` rows are created on the first episode and deleted when their
  last episode is deleted (after the items, so the FK holds).
- `SCAN_VERSION` (integer constant in `src/library/scanner.js`, starts at 1):
  rows with a different `scan_version` are re-parsed like changed files, so a
  parser or compat-table change reaches unchanged files on the next scan.
  Phases 5/6 bump it when their classification changes.
- Path-prefix matches (subtree deletes) use the range form
  `rel_path >= ? || '/' AND rel_path < ? || '0'` — never `LIKE`, because `_`
  and `%` are common in file names.

### Classification

| Top-level folder under `MEDIA_ROOT` (NFC-normalised, case-insensitive) | `category` | indexed `kind` |
|---|---|---|
| `Filme`, `Movies` | `movies` | video |
| `Serien`, `Series`, `TV` | `series` | video |
| `Musik`, `Music` | `music` | audio |
| `Hörbücher`, `Hoerbuecher`, `Audiobooks` | `audiobooks` | audio |
| `Bilder`, `Pictures`, `Photos` | `images` | image |

- Files directly under `MEDIA_ROOT` or in other top-level folders are ignored.
  Several aliases of one category (e.g. `Filme/` and `Movies/`) are all scanned.
- A file is indexed only if its extension is in the compatibility table for the
  category's kind; everything else (`.nfo`, `.srt`, `.jpg` in `Filme/`, `.mp4`
  in `Bilder/`, …) is ignored.
- Skipped entirely (never indexed, never descended): names starting with `.`;
  directories `@eaDir`, `#recycle`, `#snapshot`, `$RECYCLE.BIN`,
  `System Volume Information`, `lost+found` (case-insensitive); every symlink
  (file or directory, detected via `Dirent`/`lstat`); names containing U+FFFD
  (undecodable bytes — cannot be reopened reliably), logged once per scan.

### Direct-play compatibility (`src/library/parsers/compat.js`)

| Kind | Playable | Sniffed (MP4 family) | Not playable (listed) |
|---|---|---|---|
| video | `webm` | `mp4`, `m4v` | `mkv`, `avi`, `mov`, `wmv`, `flv`, `mpg`, `mpeg`, `ts`, `m2ts`, `mts`, `vob`, `ogv`, `3gp`, `divx`, `asf`, `rm`, `rmvb` |
| audio | `mp3`, `aac`, `flac`, `ogg`, `oga`, `opus`, `wav` | `m4a`, `m4b` | `wma`, `ape`, `aif`, `aiff`, `wv`, `mka`, `dsf`, `dff`, `ac3`, `dts`, `amr`, `mid`, `midi` |
| image | `jpg`, `jpeg`, `png`, `gif`, `webp`, `avif`, `bmp` | — | `heic`, `heif`, `tif`, `tiff`, `svg`, `dng`, `cr2`, `cr3`, `nef`, `arw`, `orf`, `rw2`, `raf` |

- Sniffed files are playable iff every `vide` track's sample entry is in
  {`avc1`, `avc3`, `av01`, `vp09`} and every `soun` track's is in {`mp4a`,
  `Opus`, `fLaC`, `.mp3`}; any other fourcc (`hvc1`, `hev1`, `dvh1`, `dvhe`,
  `mp4v`, `ac-3`, `ec-3`, `dtsc`, `dtsh`, `dtsl`, `alac`, …) → not playable.
  Other track types (subtitles, chapters) are ignored. If the box walk fails
  (truncated file, `moov` missing, malformed boxes) the file is playable by
  extension and both codec columns stay `NULL`; it is re-sniffed when its
  size/mtime changes.
- Size 0 → not playable (a file that is just being created).
- `mime` per playable/sniffed extension: `mp4`/`m4v` `video/mp4`, `webm`
  `video/webm`, `mp3` `audio/mpeg`, `aac` `audio/aac`, `flac` `audio/flac`,
  `ogg`/`oga`/`opus` `audio/ogg`, `wav` `audio/wav`, `m4a`/`m4b` `audio/mp4`,
  `jpg`/`jpeg` `image/jpeg`, `png` `image/png`, `gif` `image/gif`, `webp`
  `image/webp`, `avif` `image/avif`, `bmp` `image/bmp`.
- The sniffer (`src/library/tags/mp4-codec.js`) reads only box headers: walks
  top-level boxes (32- and 64-bit sizes) to `moov`, then `trak` → `mdia` →
  `hdlr` (handler type) and `mdia` → `minf` → `stbl` → `stsd` (first sample
  entry fourcc). Guards: ≤ 64 boxes per level, depth ≤ 8, every size must fit
  its parent, ≤ 64 KiB read per file; any violation = "unknown".

### Parse rules

Shared normalisation (`src/library/parsers/text.js`):

- `cleanName(s)`: if `s` contains no space, `.` and `_` become spaces; `_`
  always becomes a space; bracketed groups `[…]` are removed; the string is cut
  at the first release token (whole word, case-insensitive): `\d{3,4}p`, `4k`,
  `uhd`, `hdr`, `hdr10`, `bluray`, `blu-ray`, `bdrip`, `brrip`, `web-dl`,
  `webdl`, `webrip`, `hdtv`, `dvdrip`, `remux`, `x264`, `x265`, `h264`, `h265`,
  `hevc`, `xvid`, `divx`, `av1`, `aac`, `ac3`, `dts`, `truehd`, `atmos`,
  `german`, `deutsch`, `english`, `multi`, `dl`, `proper`, `repack`; whitespace
  collapsed; trailing ` -._` trimmed. Empty result → the stem with only
  separators replaced.
- `sortKey(title)`: NFKD, combining marks removed, lower-cased, every digit run
  left-padded to 8 digits (natural order: "Teil 2" < "Teil 10"). No article
  stripping ("Das Boot" sorts under D, "The Office" under T).
- Year = 4 digits, 1888 ≤ year ≤ current year + 1.

Movie (`src/library/parsers/movie.js`), from the file stem:

1. `Title (Year)` / `Title [Year]` — first parenthesised/bracketed year: title =
   `cleanName(text before it)`.
2. Otherwise tokens after separator normalisation: the **last** year token that
   is not the first token splits title / year ("2001 A Space Odyssey 1968
   1080p" → "2001 A Space Odyssey", 1968).
3. Otherwise title = `cleanName(stem)`, year `NULL`.
4. If the stem yields no year and the file sits in a sub-folder of the category
   folder whose name yields a year by 1–2, title and year come from that
   folder (`Inception (2010)/inception.mp4` → "Inception", 2010).

Series (`src/library/parsers/series.js`), path relative to the category folder:

- Series: if the file is in a sub-folder, `series_key` = that first folder name
  (exact), title/year = movie rules 1–3 on the folder name. A loose file directly
  in the category folder: `series_key` = title = `cleanName(text before the
  episode token)`, or `cleanName(stem)` without a token. Equal keys merge
  (a loose `Dark.S01E05.mp4` joins folder `Dark/`).
- Season/episode, first match wins on the file stem (all patterns
  case-insensitive, `` = ASCII word boundary):
  1. `S(\d{1,2})[ ._-]?E(\d{1,3})` with optional second episode
     `(?:-?E|-)(\d{1,3})` → `episode_end`.
  2. `(\d{1,2})x(\d{2,3})` ("1x02"; "1920x1080" does not match).
  3. Season from the nearest ancestor folder below the series folder matching
     `^(season|staffel|s)[ ._-]*(\d{1,2})$` or `^specials?$` (→ 0), combined
     with an episode from `(e|ep|episode|folge|teil)[ ._-]*(\d{1,3})` or
     a leading `^(\d{1,3})[ ._-]` in the stem.
  4. Otherwise season = folder season or `NULL`, episode `NULL`.
- Episode title = `cleanName(text after the matched token)` with leading
  separators removed. Empty → the code `S01E06` (season and episode known) /
  `E06` (episode only) / `cleanName(stem)` (neither). The UI shows
  "Folge 6" when the title equals the code (see UI).

Music, audiobook, image (P2 minimal): title = `cleanName(stem)`, no grouping
beyond `dir`; Phases 5/6 add real parsers.

### Scanner (`src/library/scanner.js`, helpers in `walk.js`, `item-builder.js`)

- `createScanner({ db, mediaRoot, log })` → `{ requestFull(), requestPaths(relPaths),
  status(), idle(), stop() }`. One run in flight at most; requests arriving
  meanwhile are coalesced (a pending full scan absorbs pending paths; path sets
  are unioned) and run once after the current run. `idle()` resolves when the
  queue is empty (tests, shutdown). `status()` → `{ running, lastCompletedAt,
  lastStats, lastError }`.
- Full scan: `readdir(MEDIA_ROOT)`; if that fails the scan aborts with no DB
  change (`lastError` set). Each category folder is walked sequentially with
  async `readdir({ withFileTypes: true })` + `stat` per candidate file. Per
  directory: load its rows (`WHERE dir = ?`), classify new / changed (size,
  mtime or `scan_version` differ) / unchanged / vanished, build rows for new +
  changed only (parse + sniff), apply in one transaction (chunks of ≤ 500
  rows). After the walk, rows whose `dir` was not visited are deleted, except
  under directories whose `readdir` failed (those subtrees are protected and
  logged). Then orphaned series are deleted.
- Subtree scan (a directory path): the same, scoped to that directory's prefix.
- Path reconcile (from the watcher): `lstat` each path — missing → delete the
  row and every row under it; directory → subtree scan; indexable file → upsert
  / leave; symlink or skipped name → delete rows for it; any other error →
  ignore (the periodic scan repairs). `MEDIA_ROOT` itself or a top-level
  category folder → full scan; a path outside every category folder → ignored.
- Memory: never holds the whole library in memory — only the current
  directory's rows and the set of visited directory paths.
- Logging (`console.info`/`console.warn`, prefix `[library]`): one line per
  completed scan (kind, duration, added/updated/removed/unchanged, failed dirs,
  skipped symlinks); one warning per failed directory. If a full scan removes
  every row of a non-empty index, an extra warning "all items vanished — is the
  media disk mounted?".

### Enricher hook (`src/library/enrichers.js`) — extension point for Phases 5/6

- At scanner creation all modules in `src/library/enrichers/*.js` are loaded
  in file-name order (directory listing, like the migration runner; the
  directory ships empty with a `.gitkeep`; `createScanner` accepts an
  `enrichersDir` option for tests). Each default-exports
  `{ name, categories: string[], enrich(ctx): Promise<void> }`.
- After each directory transaction the scanner awaits, per enricher whose
  `categories` match, `enrich({ db, mediaRoot, items })` with the rows that were
  **inserted or changed** in that batch: `items` =
  `[{ id, relPath, absPath, category, kind, ext, playable }]`. Unchanged rows
  are never passed; bumping `SCAN_VERSION` re-enriches everything once.
- Enrichers persist through their own `src/db/` functions into their own tables
  with `item_id INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE`
  (deleting an item cleans their rows); they may refine an item's display
  fields through `updateItemDisplay(db, id, { title, year, playable })` from
  `src/library/enrichers.js` (P2 export; computes `sort_title` with `sortKey`
  and writes through the repository's `updateItemFields`, so `src/db/` never
  imports parser code).
- An enricher that throws or rejects is logged (`[library] enricher <name>
  failed: …`) and skipped for that batch; the scan continues. Enrichers run
  inside the serialised scan queue, so they never overlap a scan.
- Phases 5 (tags) and 6 (EXIF) add files to `src/library/enrichers/` and never
  edit `scanner.js`.

### Watcher (`src/library/watcher.js`) and service (`src/library/index.js`)

- `fs.watch(mediaRoot, { recursive: true })` (injectable `watchFn` for tests).
  Each event's `filename` (backslashes → `/`) is added to a pending set; a
  `null` filename or > 1000 pending paths escalates to a full scan. Flush =
  trailing debounce 5 s after the last event, but at most 30 s after the first
  pending one; flush → `requestPaths([...])` or `requestFull()`.
- Error recovery: an `error` event or a throwing `fs.watch` closes the watcher,
  logs a warning and retries after 5 s, doubling up to 5 min; a successful
  restart resets the backoff and requests one full scan (events may have been
  missed). The watcher never stays off permanently.
- Periodic rescan: every `config.rescanIntervalMin` minutes `requestFull()`
  (coalesced by the queue — never overlapping); the timer is `unref()`ed.
- `startLibrary({ db, config })` (in `src/library/index.js`) creates the
  scanner, starts the watcher, requests the initial full scan and returns
  `{ scanner, stop() }`; `src/server.js` calls it after migrations and
  `stop()` on shutdown (closes watcher, clears timers, aborts the walk between
  directories and awaits the running transaction).

### API contract (`src/api/library.js`, `src/api/library-json.js`, `src/db/library-queries.js`)

All routes use `requireUser`; JSON keys are camelCase; timestamps epoch ms.
Registered via `registerLibraryRoutes(router, { db, library })` in
`src/http/routes.js`; `library` may be absent (then `scan` reports
`{ running: false, lastCompletedAt: null }`).

Item JSON (`toItemJson(row)` takes a full `library_items` row, no join):

```json
{ "id": 42, "category": "series", "kind": "video", "title": "Geheimnisse",
  "year": null, "ext": "mp4", "size": 1503238553, "playable": true,
  "videoCodec": "avc1", "audioCodec": "mp4a", "addedAt": 1790000000000,
  "seriesId": 7, "seriesTitle": "Dark", "season": 1, "episode": 1,
  "episodeEnd": null, "fileName": "Dark S01E01 - Geheimnisse.mp4" }
```

All keys are always present (`null` when not applicable); `rel_path` and `dir`
are never sent to clients.

| Route | Success | Errors |
|---|---|---|
| `GET /api/library/:category?sort=title\|added` | `200 { category, sort, scan: { running, lastCompletedAt }, items: [Item…] }` for `movies`, `music`, `audiobooks`, `images`; for `series`: `… series: [{ id, title, year, seasonCount, episodeCount, playableCount, addedAt }] }` | 404 `not_found` (unknown category), 400 `invalid_sort`, 401 |
| `GET /api/library/series/:id` | `200 { id, title, year, addedAt, seasons: [{ season, episodes: [Item…] }] }` | 404 `not_found`, 401 |
| `GET /api/library/items/:id` | `200 Item` | 404 `not_found`, 401 |

- `:id` must match `^[1-9][0-9]{0,15}$`, else 404 `not_found`.
- Sort `title` (default): `sort_title`, then `year`, then `id`. Sort `added`:
  `added_at` desc, then `mtime_ms` desc, then `id` (first scan gives all rows
  the same `added_at`). Series `addedAt` = max `added_at` of its episodes, so a
  new episode moves its series up.
- `seasonCount` counts distinct seasons ≥ 1; `episodeCount` counts all items;
  `playableCount` the playable ones.
- Detail `seasons` order: 1…n, then 0 ("Specials"), then `null` ("Weitere
  Folgen"); episodes by `episode` (NULLs last), then `sort_title`.
- Exports for later phases: `getItemById(db, id)` (full row incl. `rel_path`,
  for P3's stream route and P4) from `src/db/library-queries.js`;
  `toItemJson(row)` from `src/api/library-json.js`; `CATEGORIES` and
  `categoryForFolder(name)` from `src/library/categories.js`; `EXTENSIONS`
  (ext → `{ kind, support: 'yes' | 'sniff' | 'no', mime }`, `mime` set for every
  `yes`/`sniff` entry) and `isPlayableExtension(ext)` from
  `src/library/parsers/compat.js` (P3's MIME source).

### UI (German copy)

Pages (Phase 1 serves `/<name>` from `public/<name>.html`; `*.html` URLs are
404): `/movies` = `public/movies.html` + `public/js/movies.js` and `/series` =
`public/series.html` + `public/js/series.js` (both replace Phase 1's
placeholders), `/series-detail?id=<seriesId>` = `public/series-detail.html` +
`public/js/series-detail.js`. Shared: `public/js/lib/media-card.js`,
`public/js/lib/library-api.js`, `public/css/library.css`. The player is Phase
3's `/player?id=<itemId>`.

- Header: H1 "Filme" / "Serien" + muted count ("12 Titel", "8 Serien"); sort
  control as two links "A–Z" / "Neu hinzugefügt" (`?sort=added`,
  `aria-current` on the active one, active in `accent`), each ≥ 44 px high.
- Grid: `repeat(auto-fill, minmax(<min>, 1fr))`, gap 16 px, `<min>` per OPEN-1.
- Card: root carries `data-item-id` (movies) resp. `data-series-id` (series);
  2:3 placeholder tile on `secondary` with 1 px `border`, radius `md`, up to two
  initials (first letter/digit of the first two words, upper-case; `#` if none)
  in `muted` 32 px bold, small inline-SVG film (movie) / TV (series) icon top
  left; title one line + ellipsis (`foreground`, 16 px semibold); meta `muted`
  14 px: movie `2010 · MP4` (year omitted when unknown), series
  `3 Staffeln · 26 Folgen` (German singular/plural, specials not counted as a
  Staffel). Playable movie card = `<a href="/player?id=<id>">`; series
  card = `<a href="/series-detail?id=<id>">`.
- "Nicht abspielbar": pill badge top right in the tile, `destructive` text and
  1 px border on `background`, 12 px semibold, ban icon; unplayable movie cards
  are not links (`<div>`, no tabindex) and carry
  `title="Dieses Dateiformat kann der Browser nicht direkt abspielen."`. A
  series card shows the badge only when `playableCount` is 0 (still a link).
- Series detail: back link "‹ Serien", 2:3 placeholder with initial, H1 title,
  meta `2017 · 3 Staffeln · 26 Folgen`; season chips as in-page anchor links
  ("Staffel 1", …, "Specials", "Weitere Folgen"), horizontally scrollable on
  mobile; one section per season (heading + "10 Folgen"); episode rows ≥ 56 px
  on `secondary` with `border` dividers: episode number in `font-mono` muted
  (`01`, `01–02`, `–`), title (or "Folge N" when the title equals the
  `S..E..` / `E..` code), meta `MP4 · 1,4 GB` (`Intl.NumberFormat('de-DE')`,
  one decimal, B/KB/MB/GB), play icon; unplayable rows show the badge instead
  of the icon and are not links. Row root carries `data-item-id`; playable rows
  link to `/player?id=<id>`.
- States: while loading, nothing but the header; empty + `scan.running` →
  "Bibliothek wird eingelesen …" / "Beim ersten Start kann das einige Minuten
  dauern." and the page re-polls every 5 s until the scan ends; empty → Filme:
  "Noch keine Filme" / "Lege Videodateien im Ordner „Filme“ ab – neue Dateien
  erscheinen nach wenigen Sekunden automatisch.", Serien: "Noch keine Serien" /
  "Lege Serien im Ordner „Serien“ ab, z. B. „Serien/Dark/Staffel 1/Dark S01E01.mp4“.";
  request error → "Die Bibliothek konnte nicht geladen werden." + button
  "Erneut versuchen"; unknown series → "Diese Serie gibt es nicht mehr." +
  link "Zu den Serien". `401` from any call → redirect to `/login` (through P1's
  request helper when it exists).
- Focus: 2 px `primary` outline, 2 px offset on every link/button; Tab order =
  visual order.

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
(1 Staffel · 2 Folgen, badge). Unit tests build their own temp trees; this
tree exists for the human QA walk and one scanner smoke test.

### File ownership (P2)

New: `src/db/migrations/002-library.sql`, `src/db/library-repo.js`,
`src/db/library-queries.js`, `src/library/categories.js`,
`src/library/parsers/{text,movie,series,compat}.js`,
`src/library/tags/mp4-codec.js`, `src/library/{walk,item-builder,scanner,enrichers,watcher,index}.js`,
`src/library/enrichers/.gitkeep`,
`src/api/library.js`, `src/api/library-json.js`, the pages and shared UI files
above, tests mirroring each module under `test/` plus
`test/helpers/media-tree.js`, `test/helpers/mp4-boxes.js`,
`test/fixtures/media/Filme/**`, `test/fixtures/media/Serien/**`.
Edited: `src/http/routes.js` (one registration), `src/server.js` (start/stop
the library service), `src/config.js` + `.env.example` only if Phase 1 did not
already expose `rescanIntervalMin` (integer 1–1440, default 15),
`docs/architecture.md` (component map, flows 1/2, `library_series`, enricher
hook, note on raising `fs.inotify.max_user_watches`).

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
  — debounced recursive `fs.watch` (Navidrome's 5 s) plus an always-on periodic
  rescan; never stop watching after an error (jellyfin#16874, #10012).

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
primary colour is the current `primary` token (the `filme-mobile`,
`serien-desktop`, `serien-mobile` and `serie-detail-mobile` exports predate the token change and show
the old primary hue); fonts are the system stack (Stitch's design system may
name web fonts); initials are at most two characters (an export shows "HTS");
tiles in one grid row have equal height; the app bar/nav belong to Phase 1's
shell; the empty and first-scan states are specified in text above (no
mockup); unplayable cards are not links.

## Human prerequisites

none

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Category ids `movies`, `series`, `music`, `audiobooks`, `images`, exported as `CATEGORIES` from `src/library/categories.js`; used verbatim in the API path (`/api/library/movies`) | Matches Phase 1's page names (`/movies`, `/series`) and its recommendation; later phases import the constant instead of re-spelling it; German names stay UI-only. | 2026-09-26 |
| Enricher hook: modules in `src/library/enrichers/` are discovered by directory listing and called after each batch with inserted/changed items; their tables cascade on `library_items` delete | Phases 5 and 6 run after/parallel to Phase 4 and must not both edit `scanner.js`; discovery avoids even a shared registration file; cascade keeps their metadata consistent with hard deletes. | 2026-09-26 |
| `compat.js` exports the extension table with MIME types and `isPlayableExtension` | Phase 3 needs one source for MIME and "may this be streamed"; the table already knows every extension. | 2026-09-26 |
| Top-level folder → category mapping as in the shared cross-phase contract, NFC-normalised and case-insensitive; `Hoerbuecher` added as ASCII alias | macOS-written folders arrive as NFD ("Hörbücher" would not match otherwise); ASCII-only file systems/users. | 2026-09-26 |
| Hard delete of vanished rows + `AUTOINCREMENT` ids; upsert via `ON CONFLICT(rel_path) DO UPDATE` | Architecture flow 1 ("vanished rows deleted"); ids of present files stay stable across rescans/restarts; a freed id is never reused, so nothing keyed by id can be misattributed. Progress survives vanish/reappear because Phase 4 keys it by `rel_path`. | 2026-09-26 |
| `library_series` table with its own `AUTOINCREMENT` id, keyed by series folder name | The series detail route needs a stable id that is not a path (architecture: clients reference by index id, never by raw path). | 2026-09-26 |
| `series_title` denormalised into `library_items` | `toItemJson(row)` must work on a bare `library_items` row (Phase 4 selects rows without a join). | 2026-09-26 |
| `scan_version` column + constant forces re-parse after parser/compat changes | Unchanged files (same size/mtime) would otherwise keep stale titles or playable flags forever. | 2026-09-26 |
| MP4/M4V/M4A/M4B are sniffed for sample-entry fourccs; HEVC, Dolby Vision, MPEG-4 Part 2, AC-3/E-AC-3/DTS, ALAC → not playable; sniff failure → playable by extension | Prior art: flag HEVC incompatible in v1; vision: incompatible files clearly marked. AC-3 audio plays silently in Chromium/Firefox, so it is incompatible too. A failed sniff must not hide a probably-fine MP4. | 2026-09-26 |
| `.mov` and `.ogv` not playable | `.mov` has no reliable cross-browser MIME support in Firefox; Chromium dropped Theora (uncertain version, conservative). Revisit with evidence. | 2026-09-26 |
| Symlinks are never followed or indexed | Constitution: containment inside `MEDIA_ROOT`; vision: one host, one disk. Skipping avoids escape, loops and duplicates without realpath bookkeeping. | 2026-09-26 |
| Hidden names (leading `.`) and NAS/OS system folders are skipped | They are never media (AppleDouble `._*`, Synology `@eaDir`, recycle bins) and would otherwise surface as junk items. | 2026-09-26 |
| Unreadable directory → logged, subtree protected from deletion; unreadable `MEDIA_ROOT` → scan aborted without changes | An I/O hiccup must never wipe the index. | 2026-09-26 |
| Diff by `size` + `mtime_ms` (+ `scan_version`); parse/sniff only new or changed files; per-directory processing with ≤ 500-row transactions; sequential walk | Keeps a rescan of an unchanged library to `readdir` + `stat` calls, memory bounded by one directory, event-loop blocks short, and a USB disk on a Pi un-thrashed. | 2026-09-26 |
| Watcher events drive path-level reconciles (not full scans); debounce 5 s trailing, 30 s max wait; > 1000 paths or `null` filename → full scan | Prior art (Navidrome 5 s); a full scan of a large library on a Pi can exceed the 10 s freshness budget, a path reconcile cannot. | 2026-09-26 |
| One serialised scan queue with coalescing; watcher and timer only enqueue | Constitution/brief: no overlapping scans; also serialises all index writes. | 2026-09-26 |
| Watcher error → close, retry with backoff 5 s → 5 min, full scan after recovery; periodic rescan always on | Prior art AVOID: never stop watching permanently; the app stays correct without events (constitution). | 2026-09-26 |
| Debounce, max wait, backoff, batch size are code constants; only `RESCAN_INTERVAL_MIN` is configurable | Constitution fixes the env-var list. | 2026-09-26 |
| Initial scan runs asynchronously after the server starts listening; the API reports `scan.running`, the UI shows a first-scan state | A first scan of a large disk must not delay login; the user sees why the library is empty. | 2026-09-26 |
| Movie and series cards use the 2:3 "poster fallback" ratio with a tokenized initials placeholder | design.md: 2:3 poster fallback; no posters or frames exist (no ffmpeg, no network); tokens only. | 2026-09-26 |
| Sorting: `A–Z` (natural, accent-insensitive, no article stripping) and "Neu hinzugefügt" | Predictable for German and English titles alike ("Die Hard" is not moved to H); "new" helps find freshly copied files. | 2026-09-26 |
| Unplayable movies/episodes are shown but not linked | Vision: incompatible files are listed and clearly marked not playable; Phase 3 streams only playable items. | 2026-09-26 |
| No pagination in v1 | Household scale (hundreds to low thousands of titles per category, ~300 B JSON per item); see Risks. | 2026-09-26 |
| Episode title fallback is the language-neutral code (`S01E06`); the UI renders "Folge 6" | Server stays free of German strings (UI text is a frontend concern); `title` is never empty for other consumers. | 2026-09-26 |
| OPEN-1 — Grid column minimum on phones: design.md fixes "min column 160 px, gap 16 px", which yields ONE column on a 360 px phone with 16 px gutters (2×160+16 = 336 > 328). Options: A) keep 160 px strictly (one huge poster per row below ~376 px); B) `minmax(min(160px, calc(50% - 8px)), 1fr)` — 160 px everywhere except that phones always get two columns (≈ 156 px on 360 px); C) 12 px page gutter on phones so two 160 px columns fit exactly (Phase 1 owns the gutter). **Recommended: B** — self-contained in `library.css`, deviates from 160 px only by a few px on the narrowest phones; the UI-components issue records the rule in design.md's Grid component. | resolved at the spec-acceptance gate | — |

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
- [ ] Migration 002 applies after 001; the runner is a no-op on re-run;
      `INSERT OR REPLACE` appears nowhere in `src/`.
- [ ] Repository: upsert keeps the id when size/mtime change; a deleted row's id
      is not reused by the next insert; prefix delete with `_`/`%` in names
      deletes exactly the subtree; orphaned series are removed after their last
      episode.
- [ ] Categories: every alias maps (case variants, NFD "Hörbücher"); other
      top-level folders and root-level files are ignored.
- [ ] Parsers: table-driven cases for every movie rule (parens year, scene name,
      title starting with a year, "Blade Runner 2049 (2017)", folder fallback,
      no year) and every series rule (SxxEyy, multi-episode, 1x02, season folder
      + "Folge 3"/leading number, Specials → 0, loose root file, no numbers →
      unnumbered, code fallback title); `sortKey` natural/accent order.
- [ ] Compat + sniffer: synthetic MP4s built by `test/helpers/mp4-boxes.js`
      (avc1+mp4a → playable; hvc1, ac-3, alac, mp4v → not; `moov` after a 64-bit
      `mdat`; truncated/looping/oversized boxes → unknown without throwing);
      every table extension resolves; size 0 → not playable.
- [ ] Scanner (temp media trees via `test/helpers/media-tree.js`): first scan
      indexes exactly the expected rows; a second scan of 2 000 unchanged files
      in 200 directories performs zero inserts/updates/deletes and zero sniffs;
      changed size/mtime/`scan_version` re-parses keeping the id; removed file
      and removed directory delete their rows; hidden files, system folders,
      symlinks (skipped with `t.skip` where the OS forbids creating them) and
      U+FFFD names are never indexed; a directory made unreadable keeps its rows
      (POSIX only); unreadable `MEDIA_ROOT` aborts without changes; concurrent
      `requestFull`/`requestPaths` never overlap and coalesce to at most one
      follow-up run.
- [ ] Enrichers (temp `enrichersDir`): an enricher receives exactly the
      inserted/changed items of its categories with ids; an unchanged rescan
      calls it with nothing; a throwing enricher is logged and the scan still
      completes; `updateItemDisplay` changes title/sort order; deleting an item
      cascades to an enricher table created in the test.
- [ ] Watcher (fake `watchFn`, fake scanner, mock timers): events within 5 s
      flush once; a continuous stream flushes at 30 s; `null` filename and
      > 1000 paths escalate to full; an `error` event restarts with 5 s, 10 s, …
      capped at 5 min and requests a full scan after recovery; the interval
      timer enqueues full scans; `stop()` clears everything.
- [ ] Freshness (real scanner, fake watcher, injected short debounce): a file
      added to the temp tree is returned by the API right after the flush; with
      a silent watcher it appears after the injected interval.
- [ ] API: every route answers `401` without a session; unknown category,
      malformed/unknown id and unknown series → 404 `not_found`; bad sort → 400
      `invalid_sort`; response shapes and all sort/season/episode orderings as
      specified; no `relPath`/`dir` in any response.

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
      reload within 10 s; delete it: it disappears within 10 s; the server log
      shows one scan line per change, no full scan.
- [ ] Stop the server, delete the DB file, start again: the Filme page first
      shows "Bibliothek wird eingelesen …" (on a slow disk) or the full grid; an
      empty `Filme/` shows the empty state.
- [ ] Keyboard only: Tab reaches the sort links, every playable card, chips and
      episode rows with a visible primary (orange) focus ring; unplayable items are skipped.
- [ ] Optional, on the Raspberry Pi 4 target with a real library: the logged
      duration of a periodic rescan of an unchanged library and the process RSS
      after it (vision: idle < 100 MB) are noted in the QA comment.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Recursive `fs.watch` on Linux hits `max_user_watches` (ENOSPC) or misses events on USB/exFAT/SMB | Periodic rescan backstop; watcher retry with backoff; architecture note on raising `fs.inotify.max_user_watches`. |
| A full scan in progress delays a watcher-triggered reconcile past 10 s | Unchanged rescans are `stat`-only and rare (every 15 min); freshness is specified "when no full scan is running". |
| Media disk unmounted while the mount point stays readable → every row deleted | Warning in the log; ids of reappearing files change but progress is keyed by `rel_path` (Phase 4); the index is derived data by design. |
| Partially copied files get indexed mid-copy | Size/mtime change on completion re-parses and re-sniffs; a 0-byte start is flagged not playable. |
| MP4 with `moov` at the end of a multi-GB file | The sniffer seeks via box headers (≤ 64 KiB read), never reads `mdat`. |
| Parser misreads unusual names | Fallback titles are always non-empty; `scan_version` lets a parser fix reach existing rows; table-driven tests grow with reported cases. |
| Large category JSON (e.g. 20 000 images) | Movies/series stay small; Phases 5/6 own their category handlers and may add grouping/paging. |
| Firefox/Chromium codec support changes (HEVC, `.mov`) | One table in `compat.js` + `scan_version` bump reclassifies everything on the next scan. |
| `src/http/routes.js` / `src/server.js` edited by several phases | One registration line / one start+stop call each; trivial rebase. |

## Decision log

- 2026-09-26: Hard delete + `AUTOINCREMENT` chosen over soft delete — Phase 4's
  draft keys progress by `rel_path`, so soft delete would only add a
  `removed_at IS NULL` filter every consumer could forget.
- 2026-09-26: Category ids set to the plural form recommended by Phase 1
  (`movies`, `series`, `music`, `audiobooks`, `images`); Phase 4's draft used
  singular ids — it imports `CATEGORIES`, so only its examples change. JSON
  camelCase aligned with Phase 4.
- 2026-09-26: Pages addressed as `/movies`, `/series`, `/series-detail`,
  `/player` because Phase 1 serves `public/<name>.html` at `/<name>` only.
- 2026-09-26: Enricher hook added on the coordinator's request so Phases 5/6
  extend indexing without touching `scanner.js`.
- 2026-09-26: Codec sniffing added to realise the prior-art HEVC verdict;
  AC-3/E-AC-3/DTS and ALAC added by the same "browser-compatible" rule from the
  vision.
- 2026-09-26: Watcher events reconcile individual paths instead of triggering
  full scans, so the 10 s freshness criterion holds on a Pi-sized library.
