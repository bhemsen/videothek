# Spec: Image gallery

> Created: 2026-09-26

Roadmap phase 6: every picture (and every video) under the `images` category
roots is browsable at `/images` as a folder gallery with EXIF-embedded
thumbnails and opens in a keyboard- and touch-friendly lightbox that shows
pictures and plays videos inline — without server-side decoding, resizing or any
runtime dependency. This spec carries no lifecycle state — acceptance is the
spec merged on the default branch with a milestone and issues, and all progress
(in progress, done, blocked) lives in the GitHub issues and milestone. A
completed spec is moved to `docs/specs/archive/`.

## Outcome

- [ ] The "Bilder" nav entry (P1 shell, `active: 'images'`) opens `/images`,
      which shows the merged folder tree below all `images` category roots:
      breadcrumb, an "Ordner" section with subfolder tiles (cover, name, file
      count) and a "Bilder" section with 1:1 tiles (file name, date or
      "Video"). `/images?folder=<key>` opens a subfolder; browser back/forward
      move between folders.
- [ ] Displayable JPEG files with an EXIF IFD1 thumbnail render their tile from
      `GET /media/:id/thumb` (≤ 64 KiB, immutable-cacheable); every other
      displayable image renders its tile from the original `GET /media/:id`
      with `loading="lazy"`; videos render a play-glyph placeholder tile.
- [ ] Tiles and the lightbox show EXIF-rotated photos upright (thumbnail
      orientation applied by CSS, originals by the browser).
- [ ] Image files the browser cannot display (HEIC/HEIF/TIFF/JPEG XL/SVG and
      any other non-playable image row of `compat.js`) are listed with a
      "Nicht anzeigbar" badge; non-playable videos (e.g. `.mov`, `.mkv`) with a
      "Nicht abspielbar" badge; neither is focusable nor part of the lightbox
      sequence.
- [ ] Items are ordered by capture date (EXIF `DateTimeOriginal`, fallback
      `DateTime`, fallback file mtime), oldest first; folders by natural name
      order.
- [ ] Clicking an image or playable video opens a full-viewport lightbox with
      position counter, file name and date; images show the original, videos
      play inline in a native `<video controls>` (no autoplay, paused when
      navigating away). ←/→ and prev/next buttons navigate, Escape / close
      button / browser or Android back close it and return focus to the tile of
      the last shown item; horizontal swipe navigates on touch devices.
- [ ] A picture or video copied into a folder under an image root appears in
      the gallery without restart within the P2 freshness bound plus one
      metadata batch (≤ 10 s when no backfill is running, because the stub
      insert does no file I/O); its thumbnail is served once its EXIF header
      has been read. Deleted files disappear with their index row (cascade).
- [ ] No client-supplied value is ever turned into a filesystem path: folders
      are addressed by folder keys only compared against the index; media by
      index id through the P3 path guard.
- [ ] `npm run verify` is green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- Admitting videos under the `images` category (H9): one edit of P2's
  `src/library/categories.js` (see Prior decisions), its test
  `test/library/images-kinds.test.js`, and the two P2 test expectations that
  pin the pre-P6 behaviour: `kindsFor('images')` in P2's
  `test/library/categories.test.js` and the "non-admitted kind ignored"
  `.mp4`-in-`Bilder/` case in P2's `test/library/item-builder.test.js` (see
  the H9 Prior decisions row for the exact edit).
- EXIF reader `src/library/tags/exif.js` (JPEG APP1 only): orientation, capture
  date, IFD1 JPEG thumbnail location, JPEG SOI check, the thumbnail
  pre-check `verifyThumb` and `THUMB_MIME`.
- Migration `src/db/migrations/005-image-meta.sql` and repository
  `src/db/image-meta.js`.
- Folder keys `src/library/image-folders.js` and pure, URL-free view shaping
  `src/library/gallery.js` (URLs are built in `src/api/gallery.js`).
- Metadata sync `src/library/image-meta.js` (`createImageMetaSync`), registered
  on P2's `onScanComplete` with one line in `src/server.js`.
- Thumbnail route `GET /media/:id/thumb` (`src/api/thumb.js`,
  `registerThumbRoutes`) and gallery API `GET /api/gallery?folder=<key>`
  (`src/api/gallery.js`, `registerGalleryRoutes`); one registration line each
  in `src/http/routes.js`.
- Gallery page at `/images`: `public/images.html` (replaces P1's placeholder),
  `public/js/images.js`, `public/js/image-tiles.js`, `public/js/image-format.js`,
  `public/js/image-icons.js`, `public/css/images.css`; lightbox
  `public/js/lightbox.js`, `public/js/lightbox-slide.js`,
  `public/js/lightbox-history.js`, `public/js/lightbox-gestures.js`,
  `public/css/lightbox.css`.
- Tests: `test/library/tags/exif.test.js`, `test/db/image-meta.test.js`,
  `test/library/image-folders.test.js`, `test/library/gallery.test.js`,
  `test/library/image-meta.test.js`, `test/library/images-kinds.test.js`,
  `test/api/thumb.test.js`, `test/api/gallery.test.js`,
  `test/public/image-format.test.js`, `test/public/lightbox-gestures.test.js`;
  fixture builder `test/helpers/exif-jpeg.js`; QA fixture trees
  `test/fixtures/media/Bilder/**` and `test/fixtures/media/Photos/**`.
- `docs/architecture.md` edits (D13, made by the docs/fixtures issue, not in
  this spec PR): component map rows "Tag/EXIF readers" (name `exif.js`), new
  rows "Image metadata sync" (`src/library/image-meta.js`) and "Gallery
  shaping" (`src/library/image-folders.js`, `src/library/gallery.js`); "API
  handlers" row gains `/api/gallery` and `/media/:id/thumb`; "Frontend" row
  names `/images` + lightbox; new key flow "Image metadata" (scan completes →
  `onScanComplete` → stub rows → sequential EXIF header reads → `image_meta`).
- `README.md`: one additive section "Bilder" (supported formats, HEIC advice:
  iOS camera "Maximale Kompatibilität" or export as JPEG; videos in picture
  folders play inline).

### Out of scope

- Server-side decoding, resizing, re-encoding or transcoding of any kind
  (vision "Out"; constitution "no child processes"); video thumbnails or poster
  frames.
- EXIF from PNG `eXIf`, WebP, AVIF or HEIF containers; XMP; GPS/maps; camera
  details panel; video duration (unknown, not shown).
- Zoom/pan inside the lightbox (native pinch-zoom of the page stays usable),
  slideshow, download, rotate, delete, sharing, favourites, albums, search.
- User-selectable sort order; server-side pagination.
- Progress/resume for pictures and for videos under `images` (P4 answers
  `400 not_resumable` for category `images`); P3's player page stays
  movies/series-only.
- Custom arrow-key roving focus inside the grid.
- Edits of P1's nav/shell/icons/tokens, P2's media card/`library.css`, P3's
  stream/player files, any P4/P5 file.

## Design

Committed exports (Google Stitch; layout reference only — build with vanilla
HTML/CSS and `public/css/tokens.css`, never copy the exported HTML, which pulls
a CDN):

| Screen | Mobile (390 px) | Desktop |
|---|---|---|
| Folder view | `docs/design/assets/image-gallery/gallery-mobile.png` | `docs/design/assets/image-gallery/gallery-desktop.png` |
| Lightbox | `docs/design/assets/image-gallery/lightbox-mobile.png` | `docs/design/assets/image-gallery/lightbox-desktop.png` |

HTML exports next to each PNG (`*.html`). Working reference (not durable):
Stitch project `videothek`, screens "P6 Bilder Ordneransicht Desktop/Mobile",
"P6 Lightbox Desktop", "P6 Lightbox Mobile – 390px Viewport".

Where the mocks and this spec differ, the spec wins:

- The app bar/nav belong to P1's shell (`mountShell({ active: 'images' })`); the
  mock's "Abmelden" button stands in for P1's account menu.
- Folder tile count label is "N Dateien" (mock: "Bilder").
- A focused tile shows only the 2 px `primary` outline with 2 px offset (the
  desktop mock also tints the file name).
- Tile artwork is placeholder art — real tiles show thumbnails/originals.
- Every off-token shade in the exports maps to a P1 token: hover and active
  shades of buttons, tiles and links (e.g. `#262c38`, `#252a36`, `#161a22`)
  → the derived state tokens `--color-secondary-hover` /
  `--color-secondary-active`; border greys (e.g. `#3b4252`) →
  `--color-border`; any other surface shade → the nearest design.md surface
  token (`--color-background`, `--color-secondary`). Fills that only paint the
  placeholder artwork inside tiles and the lightbox stage (e.g. `#131720`,
  `#151921`, `#252d3c`) are ignored — real tiles show images.
- The mobile lightbox mock is drawn inside a rounded phone frame; the real
  lightbox is full-viewport with the same arrangement (counter + close top,
  caption, then prev · hint · next at the bottom).
- No mock shows a video slide: it uses the image slide layout with a native
  `<video controls>` in place of the `<img>`.

German UI copy (exact):

| Where | Text |
|---|---|
| Page heading at root / `document.title` | `Bilder` / `Bilder – Videothek`; in a folder: heading = folder name, title `<Name> – Bilder – Videothek` |
| Breadcrumb root / `aria-label` of breadcrumb nav | `Bilder` / `Pfad` |
| Section headings | `Ordner`, `Bilder` (each hidden when its section is empty) |
| Header meta | non-zero parts of `{n} Ordner` and `{m} Dateien` (singular `1 Datei`), joined by ` · `; no meta when both are 0 |
| Folder tile meta | `{n} Dateien` / `1 Datei` |
| Image tile meta | date `DD.MM.YYYY, HH:MM` |
| Video tile meta | `Video` |
| Badges | images `Nicht anzeigbar`; videos `Nicht abspielbar` |
| Empty root (P1 `createEmptyState({ title, text })`) | title `Noch keine Bilder`, text `Lege Bilder im Ordner „Bilder“ ab – neue Dateien erscheinen nach wenigen Sekunden automatisch.` |
| Unknown folder (API 404) | `Ordner nicht gefunden.` + link `Zu Bilder` (`/images`) |
| Load error | `Bilder konnten nicht geladen werden.` + button `Erneut versuchen` |
| Lightbox buttons (`aria-label` + `title`) | `Schließen`, `Vorheriges Bild`, `Nächstes Bild` |
| Lightbox dialog `aria-label` | `Bildansicht` |
| Lightbox hint | fine pointer `← → Blättern · Esc Schließen`; coarse pointer `Wischen zum Blättern` |
| Lightbox image / video load error | `Bild konnte nicht geladen werden.` / `Video konnte nicht abgespielt werden.` |
| Tile accessible names | image `<file name>`; video `<file name>, Video` |

## Constraints

- Constitution applies unchanged: zero runtime deps, read-only `MEDIA_ROOT`
  (files opened with flag `r` only), path containment → `404`, SQL only in
  `src/db/` via prepared statements, ≤ 60 lines/function, ≤ 300 lines/file,
  JSDoc on every export, one `test/*.test.js` per new `src/` module, JSON errors
  `{ "error": "<code>" }` on `/api/*`, no `innerHTML` with data (DOM via
  P1's `el()`/`createIcon` or `createElement`/`textContent`), no `console.*` in modules
  (injected `log`, D4).
- Architecture boundaries: `src/library/` has no HTTP knowledge (it builds no
  URLs — `src/library/gallery.js` returns a neutral `thumb` marker, and
  `src/api/gallery.js` maps it to `/media/…` URLs, following P2's
  `src/api/library-json.js` precedent); `src/api/` has no file-format
  knowledge (EXIF parsing, the JPEG SOI check, the thumbnail pre-check
  `verifyThumb` and the thumbnail MIME `THUMB_MIME` live in
  `src/library/tags/exif.js`; `src/api/thumb.js` only orchestrates); only
  `src/media/paths.js` (P3,
  `resolveMediaPath(mediaRoot, relPath) → Promise<string | null>`) maps index
  rows to absolute paths — also for the metadata sync's reads.
- Consumed contracts (exact, from the cross-phase decisions):
  - P1 (D4/D5): `handler(req, res, ctx)`, `ctx = { user, params, url }`;
    `register<X>Routes(router, deps)`, `deps = { config, db, log, now,
    ...extra }` (extras passed through `createApp`/`startTestApp`; P6 reads
    only the optional test seam `deps.openFile`);
    `Config.mediaRoot`; router whole-segment matching (`/media/:id` ≠
    `/media/:id/thumb`), HEAD runs the GET handler with `req.method === 'HEAD'`;
    `requireUser` from `src/http/guards.js` (`401 {"error":"unauthorized"}`);
    `sendJson`/`sendError` from `src/http/respond.js`; `/api/*` gets
    `Cache-Control: no-store` from P1; `test/helpers/app.js`
    `startTestApp({ mediaRoot?, now?, ...extra })` → `{ baseUrl, db, config,
    deps, createUser, login, close }`; logger `log.info|warn|error(event,
    fields?)`; migration runner applies every unapplied file ascending (gaps
    allowed); `PRAGMA foreign_keys=ON`; frontend `public/js/lib/api.js`
    `request(method, path, opts) → { status, data }` throwing
    `ApiError { status, code }` (`code: 'network'` on network failure, `401`
    redirects to login); `public/js/lib/shell.js` `mountShell({ active }) →
    { main, setActive, me }`; `public/js/lib/dom.js` `el(tag, attrs, ...children)`
    and `createEmptyState({ title, text })`; `public/js/lib/icons.js`
    `createIcon(paths, opts)`, `icon(name)` (never edited); tokens incl.
    `--grid-min`, `--focus-width`, `--focus-offset`, `--tap-min`,
    `--border-width`, `--space-*`, `--color-secondary-{hover,active}`; CSP
    forbids `style=""` (dynamic values via `el.style.setProperty`); a page links
    its own `public/css/<page>.css` + `public/js/<page>.js`.
  - P2 (D3/D6/D9): `library_items` (`id`, `rel_path`, `dir`, `category`,
    `kind`, `ext`, `playable`, `size`, `mtime_ms` = `Math.trunc(stat.mtimeMs)`);
    `CATEGORIES`, `kindsFor(category)` and the `KINDS` map in
    `src/library/categories.js`; `EXTENSIONS` rows
    `{ kind, playable, sniff, mime }` in `src/library/parsers/compat.js` (sole
    owner of extensions and MIME); in `src/server.js`
    `const library = startLibrary({ db, config, log, now })` →
    `{ onScanComplete(listener) → unsubscribe, requestFull(), stop(), status() }`,
    listener called with `{ kind, stats, completedAt }` after every completed
    run, not awaited, throws logged. Skip rules (hidden names, `@eaDir`, …)
    are P2's; P6 adds none.
  - P3 (D10): `GET /media/:id` streams playable items (incl. `images` videos)
    with the compat MIME and `Cache-Control: private, no-cache`; non-playable →
    404; `resolveMediaPath` from `src/media/paths.js`; `sendMedia(req, res,
    { path, contentType?, cacheControl?, idleTimeoutMs?, slice?: { offset,
    length }, openFile? })` from `src/http/stream.js`.
- P6 runs in parallel with P4/P5 and edits only its own files plus the shared
  one-line/section additions named in Scope: `src/server.js` (one line),
  `src/http/routes.js` (two lines), `src/library/categories.js` (one line),
  P2's `test/library/categories.test.js` and `test/library/item-builder.test.js`
  (the two H9 expectations, nothing else), `docs/architecture.md` (listed
  rows/flow), `README.md` (one section).
- Design tokens only via `public/css/tokens.css`; literal lengths only as the
  D5 exceptions (breakpoints 768/1024 in `@media`, `%`, `vh`/`dvh`/`vw`, `fr`,
  `0`, `env(...)`; machine-checked by P1); touch
  targets ≥ 44×44 px; WCAG 2.1 AA.

## Prior art

- [Image thumbnails without native dependencies (Phase 6)](../prior-art.md#image-thumbnails-without-native-dependencies-phase-6)
  — ADOPT: hand-rolled EXIF IFD1 thumbnail extraction by buffer parsing; fallback
  to the original with `loading="lazy"` and browser downscaling; AVOID sharp /
  libvips / Immich / PhotoPrism. Not cloned: the IFD layout is the published
  EXIF 2.3 / TIFF 6.0 structure and no decision here depends on exifr internals.
- [Direct-play compatibility detection (Phase 2)](../prior-art.md#direct-play-compatibility-detection-phase-2)
  — static extension table (P2's `compat.js`), no client-side capability probe;
  HEIC stays "not displayable" even though Safari renders it; videos under
  `images` get the same playability verdict (incl. codec sniff) as in `movies`.
- [Detecting new files without restart (Phase 2)](../prior-art.md#detecting-new-files-without-restart-phase-2)
  — freshness comes from the P2 watcher + periodic rescan; P6 only listens for
  completed scans and stays correct if the watcher is silent.

## Human prerequisites

none — all fixtures are synthetic and generated/committed by the implementer;
nothing blocks implementation. QA-only and optional (the human waived the
gates): a real phone-photo folder on a local `MEDIA_ROOT` including
portrait/EXIF-rotated JPEGs, a HEIC file and a phone MP4 (H.264/AAC) to confirm
inline video playback with real media; access to the Raspberry Pi 4 for the
optional RSS line.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| **Page URL** `/images` = `public/images.html` (replaces P1's placeholder file of the same name) + `public/js/images.js`; subfolders `/images?folder=<key>` (key encoded with `URLSearchParams`); lightbox hash `#bild-<id>`. No nav edit — P1's "Bilder" entry already points to `/images`; the page calls `mountShell({ active: 'images' })`. | Cross-phase consolidation D1: `GET /<name>` serves `public/<name>.html`, `*.html` URLs are 404, owning phase replaces its placeholder, nobody edits the nav. Supersedes the draft's `/gallery.html` and nav edit. | 2026-09-26 |
| **Indexed files under `images`** come solely from P2's `compat.js` (no P6 table). Images, displayable (`playable = 1`): `jpg jpeg jfif png gif webp avif bmp`; indexed but "Nicht anzeigbar": `heic heif tif tiff jxl svg` and any further non-playable image row `compat.js` carries (e.g. camera RAW). Videos: every `EXTENSIONS` row with `kind: 'video'`, playability incl. MP4 codec sniff exactly as in `movies`. "Displayable" ≡ `library_items.playable`. MIME comes from `compat.js` via P3. `svg` is never served (`/media/:id` 404 for non-playable). | Cross-phase consolidation D9 (single owner of extensions/MIME) + gate decision H9 (videos in `Bilder` = C). Supersedes the draft's own extension/MIME rows and its "SVG not indexed". | 2026-09-26 |
| **Videos under `images` (H9 = C):** P6 changes the `images` entry of the `KINDS` map in `src/library/categories.js` to `['image', 'video']` (one line; `kindsFor('images')` then returns both). P2's scanner and item builder are kind-generic: each file's `kind` comes from its `EXTENSIONS` row and it is indexed iff that kind is admitted by its category. Rows get `category = 'images'`, `kind = 'video'`. No `SCAN_VERSION` bump: previously ignored files have no row and are inserted as new files by the next scan (P2 states the same). **The same PR updates the two P2 test expectations that pin the pre-P6 behaviour, so `npm run verify` stays green:** (a) P2's `test/library/categories.test.js`: the `kindsFor('images')` expectation becomes `['image', 'video']` (other categories unchanged); (b) P2's `test/library/item-builder.test.js` (P2 Verification "Walk + item builder: non-admitted kinds ignored"): the `.mp4`-in-`Bilder/` example is replaced by `.mp3` in `Bilder/` (still ignored — audio is not admitted under `images`), so P2's intent "a non-admitted kind is ignored" keeps its coverage; the positive case (`.mp4` under `Bilder/` → indexed, kind `video`) lives in P6's `test/library/images-kinds.test.js`. If P2 placed that assertion in `test/library/walk.test.js` instead, the same one-case edit applies there; an expectation P2 already wrote P6-independently needs no edit. No other P2 test or source line is touched. | Human decision at spec-acceptance gate (H9); D15 names the `categories.js` edit explicitly; P2's spec defines `KINDS`/`kindsFor` for exactly this edit. A bump would needlessly re-parse every row. Spec-acceptance review (blocking): P2's tests assert the pre-P6 kinds, so the P6 edit must carry the matching test edits — an unauthorised fork (red gate vs. editing P2's tests) would otherwise stop the implementer. Swapping the example to `.mp3` (rather than deleting it) keeps P2's negative coverage. | 2026-09-26 |
| Video items: tile with an inline-SVG play glyph on the placeholder surface and meta `Video` (no thumbnail, no duration); playable ones join the lightbox sequence and play inline with `<video controls preload="metadata" playsinline src="/media/<id>">` — no `autoplay`, no progress reporting; on leaving the slide or closing: `pause()`, `removeAttribute('src')`, `load()` (releases the stream). Non-playable videos: "Nicht abspielbar" tile, skipped. Thumb route unchanged (never video thumbs). | Human decision at spec-acceptance gate (H9). Releasing `src` frees the server file handle immediately instead of waiting for P3's 60 s idle timeout. | 2026-09-26 |
| **Folder key** = the item's `dir` minus its first segment (the category root folder, whichever alias), `/`-separated, `''` = root (`folderKeyForDir(dir)` in `src/library/image-folders.js`). Alias roots (`Bilder/`, `Pictures/`, `Photos/`) merge into one virtual tree; keys are case-sensitive (`Bilder/urlaub` and `Photos/Urlaub` stay two folders). A key never changes for an item id (a move is delete + insert in P2). | Keeps API free of raw paths; the key is only compared against the index (architecture boundary). Merging is the only consistent reading of "one category, several aliases". | 2026-09-26 |
| **Folder key validation** (`?folder=`): absent or empty → root (the client links the root as plain `/images` and subfolders as `'/images?' + new URLSearchParams({ folder: key })`); else must be ≤ 4096 UTF-16 units, contain no NUL, no leading/trailing `/`, no empty, `.` or `..` segment (split on `/`), and must exist (`folder = key` or in the range `folder >= key \|\| '/' AND folder < key \|\| '0'` (SQL string concatenation) — never `LIKE`). `\` is allowed (a legal file-name character on Linux; the key never reaches `fs`). Syntax check = `parseFolderKey(value: string \| null) → string \| null` in `src/library/image-folders.js` (`''` for absent/empty, `null` for a violation); existence = `folderExists`. Any violation → `404 {"error":"not_found"}`. Root always exists (200 even on an empty library). A deep folder URL longer than P1's `safeNext` cap (2,048 chars) loses its target across a login redirect and lands on `/` — accepted (only an expired session on an extremely deep folder is affected; the user navigates again). | Constitution: path violations → 404; existence by index lookup means traversal strings can never reach `fs`. Range form per P2 (`_`/`%` common in names). The `safeNext` cap is P1's open-redirect guard and stays unchanged. | 2026-09-26 |
| **Migration `005-image-meta.sql`** (STRICT, no BEGIN/COMMIT, depends only on 002): `image_meta(item_id INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE, folder TEXT NOT NULL, taken_at TEXT, orientation INTEGER, thumb_offset INTEGER, thumb_length INTEGER, source_size INTEGER, source_mtime_ms INTEGER, meta_version INTEGER) STRICT` + `CREATE INDEX image_meta_folder ON image_meta (folder)`. One row per `images` item (images and videos). `source_*`/`meta_version` NULL = header not processed yet. | Cross-phase consolidation D12 (005 = P6, STRICT, one transaction per file by the runner) and D6 (meta table cascades on `library_items`, so no orphan-delete code). Capture-date sort and thumbnail offsets must be stored — reading headers per request is too slow on a Pi HDD. | 2026-09-26 |
| **Scan extension point:** `src/server.js` gets exactly one line directly after P2's `const library = startLibrary({ db, config, log, now })`: `library.onScanComplete(createImageMetaSync({ db, mediaRoot: config.mediaRoot, log }).syncImageMeta);`. `scanner.js`/`watcher.js` are not edited; no shutdown line is added (P2 awaits `library.stop()` before the DB closes, and a still-running pass stops at the next `db.isOpen` check). | Cross-phase consolidation D6 (`onScanComplete`, P6 registers `syncImageMeta` with one line). Supersedes the draft's conditional scanner edit. | 2026-09-26 |
| **`createImageMetaSync({ db, mediaRoot, log, now = Date.now, resolvePath = resolveMediaPath, openFile = (p) => fs.promises.open(p, 'r') })` → `{ syncImageMeta(event?) → Promise<void>, idle() → Promise<void> }`** (module also exports `IMAGE_META_VERSION = 1`). `resolvePath` and `openFile` are test seams (production passes neither): tests inject a spy `openFile` to assert which rows cause I/O and that every handle is closed, and a `resolvePath` returning `null` for the guard case. `now` only measures `durationMs`. Single-flight: a call while a pass runs sets `rerun` and returns the running promise; after the pass, one more pass runs if `rerun` was set. A pass = (1) **stubs**: select `images` items without a meta row (`id > cursor`, chunks of 500), compute `folderKeyForDir(dir)`, insert `(item_id, folder)` with `ON CONFLICT(item_id) DO NOTHING`, one transaction per chunk, no `await` between select and insert; (2) **headers**: keyset-walk stale rows (`item_id > cursor ORDER BY item_id LIMIT 50`; stale = `source_size IS NULL` or ≠ `library_items.size`, `source_mtime_ms` ≠ `mtime_ms`, or `meta_version` ≠ `IMAGE_META_VERSION` = 1). For `ext ∈ JPEG_EXTENSIONS` and `size > 0`: `resolvePath(mediaRoot, relPath)` → `openFile(path)` → one `read` of ≤ 131,072 bytes at 0 into one reused buffer (handle closed in `finally`) → `parseExif` → save. Other rows: save NULL EXIF fields without I/O. `source_size`/`source_mtime_ms` are the index values read with the row. Between batches, if `rerun` is set, run step (1) again so new files appear within one batch. | D6 listener contract (single-flight, coalesced rerun, stale detection by `source_size`/`source_mtime_ms`, backfill of rows indexed before P6, not blocking the scan queue). Keyset cursor makes a failing file impossible to loop on within a pass; stub refresh between batches keeps the ≤ 10 s freshness during a long initial backfill. `meta_version` lets a later reader fix reach existing rows. | 2026-09-26 |
| Sync failure handling: a per-file error (guard `null`, ENOENT, EACCES, EISDIR, short read) leaves the row stale → retried on the next pass (next completed scan, at the latest the periodic rescan). An item deleted mid-pass updates 0 rows (harmless). A pass ends quietly when `db.isOpen` is false (shutdown); any other thrown error ends the pass and is logged `image_meta_failed { error }`. One log line `image_meta_synced { stubs, read, skipped, failed, durationMs }` per pass that changed or failed anything; no file contents or paths beyond counts. | D6 (retry after failure, deleted items tolerated), D4 logging (injected JSON logger, no `console.*`). `db.isOpen` avoids a second shutdown line in `server.js`. | 2026-09-26 |
| **EXIF reader** `src/library/tags/exif.js` exports `EXIF_WINDOW_BYTES = 131072`, `JPEG_EXTENSIONS = ['jpg','jpeg','jfif']`, `THUMB_MIME = 'image/jpeg'`, `isJpegStart(buf) → boolean` (true iff `buf.length ≥ 2` and exactly the first two bytes are `FF D8`; nothing beyond byte 2 is inspected), `verifyThumb(path, { thumbOffset, sourceSize, sourceMtimeMs }, { openFile = (p) => fs.promises.open(p, 'r') } = {}) → Promise<boolean>` (one `openFile(path)`; `handle.stat()` must be a regular file whose `size` and `Math.trunc(mtimeMs)` equal `sourceSize`/`sourceMtimeMs`; a 2-byte `read` at `thumbOffset` must return 2 bytes passing `isJpegStart`; handle closed in `finally`; any error → `false`, never throws), `parseExif(buf) → { orientation, takenAt, thumbOffset, thumbLength }` (each `number \| string \| null`). JPEG only (`FF D8` at 0). Walk markers from offset 2 over APPn/COM segments; stop at SOS (`FFDA`), EOI, a non-marker byte or the window end. First APP1 whose payload starts `Exif\0\0` → TIFF header (`II`/`MM`, magic 42). IFD0 `0x0112` Orientation (1–8, else null); `0x8769` → Exif IFD `0x9003` DateTimeOriginal, fallback IFD0 `0x0132` DateTime; IFD1 (next-IFD of IFD0) `0x0201`/`0x0202` thumbnail offset/length, accepted only if IFD1 `0x0103` Compression is absent or 6, `0 < length ≤ 65,535`, the range lies inside the APP1 segment's declared length, and — when its first two bytes lie inside the window — they are `FF D8`. `thumbOffset` is absolute in the file. Every read bounds-checked; IFD offsets visited once (cycle guard); ≤ 512 entries per IFD; malformed input yields `null` fields, never a throw. | Prior art ADOPT; APP1 ≤ 64 KiB by format, so APP0 + APP1 IFD structures fit in 128 KiB; uncompressed TIFF thumbnails are rare and not servable as JPEG. D10 places the SOI check in `exif.js`; the architecture boundary "`src/api/` knows nothing about file formats" (review) moves the whole pre-check and the thumbnail MIME there too. `THUMB_MIME` is a format fact (EXIF IFD1 Compression 6 = JPEG), not an extension→MIME mapping, so it does not contradict D9's single extension table and keeps `exif.js` free of cross-phase imports. `isJpegStart` checks 2 bytes because the pre-check reads 2 bytes. | 2026-09-26 |
| **Capture date** stored as `YYYY-MM-DDTHH:MM:SS` (camera wall-clock, no offset) when the EXIF value's first 19 chars match `YYYY:MM:DD HH:MM:SS` with year ≥ 1900, month 1–12, day 1–31, hour 0–23, minute/second 0–59; else NULL (e.g. `0000:00:00 00:00:00`). API `takenAt` = `taken_at` or, when NULL (also every video/PNG/HEIC), `mtime_ms` formatted in the server's local time in the same shape. The client formats `DD.MM.YYYY, HH:MM` by string slicing (no `Date` parsing). | EXIF has no reliable offset; wall-clock is what the photographer saw; string handling avoids TZ drift. Deliberate deviation from D4's "ISO instant": `takenAt` is an ISO-8601 local date-time without offset. | 2026-09-26 |
| **Sort** (server-side, `src/library/gallery.js`): items by (`takenAt` string asc, file name via `Intl.Collator('de', { numeric: true, sensitivity: 'base' })`, `id`); folders by the same collator on name, tie by key (binary). | Chronological order is the album convention and fixes mixed camera prefixes; one comparator, unit-testable. | 2026-09-26 |
| **Thumbnail route** `GET /media/:id/thumb` in `src/api/thumb.js` (`registerThumbRoutes(router, deps)`), wrapped in `requireUser` (unauthenticated → `401 {"error":"unauthorized"}`, like `/media/:id`). `id` must match `^[1-9][0-9]{0,15}$` and be a safe integer. Pre-checks, each failing with `404 {"error":"not_found"}`: id malformed or unknown (`getThumbSource`), category ≠ `images`, `kind` ≠ `image`, not playable, no recorded thumbnail, `resolveMediaPath` → null, `verifyThumb(path, source, { openFile })` → false (see the EXIF reader row: staleness by size/mtime and SOI check, handle closed in `finally`). Then P3's `sendMedia(req, res, { path, contentType: THUMB_MIME, cacheControl: 'private, max-age=31536000, immutable', slice: { offset: thumb_offset, length: thumb_length }, openFile })` serves the bytes (200 with `Content-Length`, `nosniff`, `Accept-Ranges`; `Range` within the slice → 206; `HEAD` without body; slice past EOF → 404). The query string (`?v=`) is ignored. `openFile` = the optional test seam `deps.openFile` (absent in production → both calls use their default `fs.promises.open(p, 'r')`); `thumb.test.js` injects a spy through `startTestApp({ openFile })` to assert every opened handle is closed. | D10 (route, file, `cacheControl` pass-through, SOI check in `exif.js`); P3's `sendMedia` `slice` option serves byte windows with the same range/streaming logic (`fs.createReadStream(realPath, { fd: handle, start, end })`), so P6 needs no streaming code. The pre-check open is needed because the staleness and SOI checks must run before headers are sent. Versioned URL makes `immutable` safe. | 2026-09-26 |
| **Thumbnail choice is decided server-side, in two layers:** `src/library/gallery.js` sets a neutral marker per item/cover — `thumb: 'embedded'` when kind `image`, playable, a thumbnail is recorded and `source_size`/`source_mtime_ms` equal the item's `size`/`mtime_ms`; `'original'` for other playable images; `null` for videos and non-playable items — plus `version` (= `mtime_ms`). `src/api/gallery.js` maps it: `thumbUrl` = `/media/<id>/thumb?v=<version>` for `'embedded'`, `/media/<id>` for `'original'`, `null` for `null`; `url` = `/media/<id>` when playable, else `null`; `thumb`/`version` are not sent. Client `onerror` on a thumb URL switches once to `url` (orientation class reset to 1); on an original it hides the `<img>` and shows the image icon. | No wasted request per EXIF-less image; `onerror` covers files edited between scans. Architecture boundary "`src/library/` knows nothing about HTTP" (review): URLs are built only in `src/api/`, following P2's `src/api/library-json.js` precedent. | 2026-09-26 |
| **Orientation**: originals rely on the browser default `image-orientation: from-image`. The API returns `thumbOrientation` = stored orientation (1–8, NULL → 1) when `thumbUrl` is the thumb, else 1; the client maps it to a CSS class: 2 `scaleX(-1)`, 3 `rotate(180deg)`, 4 `scaleY(-1)`, 5 `rotate(270deg) scaleX(-1)`, 6 `rotate(90deg)`, 7 `rotate(90deg) scaleX(-1)`, 8 `rotate(270deg)`. The `<img>` fills a square box with `object-fit: cover`, so 90° rotations keep the tile square. | Embedded thumbnails carry no EXIF; without this, portrait photos show sideways tiles. Table follows exiftool's naming of EXIF orientation values. | 2026-09-26 |
| **Gallery API** `GET /api/gallery?folder=<key>` in `src/api/gallery.js` (`registerGalleryRoutes(router, deps)`, `requireUser`). `200 { key, name, breadcrumb: [{ key, name }], folders: [{ key, name, count, cover: { thumbUrl, thumbOrientation } \| null }], items: [{ id, name, kind: 'image' \| 'video', playable, takenAt, url: '/media/<id>' \| null, thumbUrl, thumbOrientation }] }`. At the root `key: ''`, `name: ''`, `breadcrumb: []`; elsewhere `name` = last key segment and `breadcrumb` = ancestors below the root (root and current excluded) — the client renders the root label "Bilder". `items` = direct children only; `name` = last segment of `rel_path`; `count` = all indexed files (images + videos, incl. non-playable) in the subfolder's subtree; `cover` = first playable `kind: 'image'` item in the subtree in (`folder`, `rel_path`) binary order, `null` if none. `url` null for non-playable. Errors: 404 `not_found` (key), 401. No `rel_path`/`dir` in the response. Layering: `src/library/gallery.js` (pure — no URLs, no DB, no I/O) exports `childFolders(key, folderCounts) → [{ key, name, count }]` (aggregates `listSubtreeFolderCounts` rows into direct child folders with subtree counts, unsorted) and `buildGalleryView({ key, items, folders }) → { key, name, breadcrumb, folders: [{ key, name, count, cover: { id, thumb, thumbOrientation, version } \| null }], items: [{ id, name, kind, playable, takenAt, thumb, thumbOrientation, version }] }` where `items` are `ItemRow`s and `folders` are `{ key, name, count, coverRow: ItemRow \| null }` (sort, breadcrumb, `takenAt` fallback, `thumb` marker, orientation). `src/api/gallery.js` validates the key (`parseFolderKey`), checks `folderExists`, reads items and counts, calls `childFolders`, fetches one `findFolderCover` per child, calls `buildGalleryView` and maps markers to URLs (previous row). | A dedicated route avoids ambiguity with P2's `/api/library/:category` and expresses the tree; one response per folder keeps lightbox navigation exact. The server stays free of German strings (P2 precedent), so the root label is client-side. camelCase per D4. | 2026-09-26 |
| Repository `src/db/image-meta.js` exports: `listItemsWithoutMeta(db, afterId, limit) → [{ id, dir }]`, `insertMetaStubs(db, rows: [{ itemId, folder }])`, `listStaleMeta(db, afterId, limit, metaVersion) → [{ itemId, relPath, ext, size, mtimeMs }]`, `saveMeta(db, itemId, { takenAt, orientation, thumbOffset, thumbLength, sourceSize, sourceMtimeMs, metaVersion })`, `folderExists(db, key) → boolean`, `listFolderItems(db, key) → ItemRow[]` (direct children, unsorted), `listSubtreeFolderCounts(db, key) → [{ folder, count }]` (every folder strictly below `key` with its direct item count), `findFolderCover(db, key) → ItemRow \| null`, with `ItemRow = { id, relPath, kind, playable, size, mtimeMs, takenAt, orientation, thumbOffset, thumbLength, sourceSize, sourceMtimeMs }` (`playable` boolean, meta fields as stored, NULL → `null`), `getThumbSource(db, itemId) → { relPath, category, kind, playable, thumbOffset, thumbLength, sourceSize, sourceMtimeMs } \| null`. All prepared statements; joins to `library_items` read-only. | Constitution: SQL only in `src/db/`; names fixed so the sync, API and route issues build in parallel. | 2026-09-26 |
| **Test seeding:** DB, sync and API tests migrate a temp DB through P1's runner (001, 002, 005; 003/004 not needed) and insert `library_items` rows with prepared statements in the tests (all NOT NULL columns of P2's 002 filled; `size`/`mtime_ms`, and in thumb tests `source_*` and the thumbnail offset/length, taken from `fs.stat` and `parseExif` of the real temp file); API tests (`test/api/gallery.test.js`, `test/api/thumb.test.js`) also insert `image_meta` rows directly (via `insertMetaStubs` + `saveMeta`) and use `startTestApp({ mediaRoot })` with a temp tree whose files are built by `test/helpers/exif-jpeg.js` — they never run the scanner or the sync. Only `test/library/images-kinds.test.js` runs P2's scanner, and `test/library/image-meta.test.js` runs the sync over directly inserted `library_items` rows. | Keeps each API/repo issue independent of the scanner, watcher and sync issues (P5's "Test seeding" precedent); a direct insert also lets tests set exact size/mtime/thumbnail values. | 2026-09-26 |
| **No server-side pagination.** Folder tiles render at once; item tiles render in batches of 120 (first batch immediately, next when a sentinel after the grid comes within 800 px via `IntersectionObserver` `rootMargin`). Every `<img>` has `loading="lazy" decoding="async"`. | A 5,000-item folder is ~1 MB JSON on a LAN; batching bounds DOM size and memory on phones/TVs; one list keeps counters and prev/next exact. | 2026-09-26 |
| **Grid**: `grid-template-columns: repeat(auto-fill, minmax(min(var(--grid-min), calc(50% - var(--space-2))), 1fr)); gap: var(--space-4)` in `public/css/images.css`. | Human decision at spec-acceptance gate (H3): always ≥ 2 columns on phones. `var(--space-2)` (8 px) replaces the literal `8px` because D5 forbids literal lengths outside `tokens.css`. | 2026-09-26 |
| **Tiles**: own markup in `public/js/image-tiles.js` and styles in `public/css/images.css`, visually following the design.md Media card (1:1, radius `md`, `shadow-sm`, title 1 line ellipsis, meta `muted`). Folder tile = `<a href="/images?folder=…">` (cover `<img alt="">` or folder icon, small folder badge bottom-left); image tile = `<button type="button" data-item-id aria-label="<name>">` with `<span>` children and `<img alt="">`; playable video tile = same `<button>` with play glyph, `aria-label="<name>, Video"`; non-playable tile = non-interactive `<div>` with icon + badge (pill, `destructive` text and 1 px border on `background`, 12 px semibold). Elements are built with P1's `el()` (`public/js/lib/dom.js`); page-private inline-SVG icons (folder, play, image-off, chevron-left/right, close) live in `public/js/image-icons.js`, built with P1's `createIcon(paths)`; the folder-less "Bilder" glyph may reuse P1's `icon('images')`. Grid keyboard: native Tab/Enter/Space. | Avoids editing P2's shared media card (P4 extends it in parallel); P1 forbids edits of `icons.js` and prescribes `createIcon` for phase icons (D5). Folder links give native back/forward and bookmarkable URLs. | 2026-09-26 |
| Header, breadcrumb and states: breadcrumb `<nav aria-label="Pfad"><ol>` — "Bilder" + ancestors as links, current as `<span aria-current="page">`, separator `›` `aria-hidden`; each link ≥ 44 px hit area (`min-block-size: var(--tap-min)`, inline-flex). Header meta counts direct subfolders and direct items only. Root with no folders and no items → empty state (no first-scan state; a reload shows new files). A non-root folder cannot be empty (it exists only through indexed items), so no subfolder empty state. API 404 → "Ordner nicht gefunden." + link; any other error → load error + "Erneut versuchen" (re-runs the fetch). `401` → P1's `request` redirects to login. | Review findings (header counts, breadcrumb targets); dead UI states removed in the pre-mortem. | 2026-09-26 |
| **Lightbox** (`public/js/lightbox.js`, `createLightbox({ items, onClose }) → { open(itemId), close() }`, `items` = the API items, `onClose(lastItemId)` lets the page restore focus): native `<dialog aria-label="Bildansicht">` + `showModal()`, full viewport (`100vw` × `100dvh`, no margin/border), `::backdrop` and stage on `--color-background`, `html` scroll locked via a class while open. Sequence = playable items (images and videos) in API order; counter `i / n` over that sequence. Images: original via `url`, `max-inline-size: 100%; max-block-size: 100%; object-fit: contain` (never upscaled). No wrap-around — prev disabled on first, next on last (40 % opacity). Preload only previous and next when they are images (`new Image().src`); videos never preloaded. Initial focus on `Schließen`. Keys (from `lightbox-gestures.js` `keyAction`): ArrowLeft/ArrowRight navigate unless the event target is the `<video>` (native seek); Escape = native dialog close. Swipe: pointer events on the stage with `touch-action: pan-y pinch-zoom`; ignored when the pointer started on the `<video>`; `classifySwipe(dx, dy)`: `\|dx\| ≥ 50` and `\|dx\| > 1.5 × \|dy\|` → `dx < 0` next, `dx > 0` previous, else none. Caption (file name · formatted `takenAt`, for videos too) in an `aria-live="polite"` region. Layout per mocks: desktop counter top-left, close top-right, prev/next vertically centred at the sides, caption bottom-left, hint bottom-right; < 768 px counter + close top, caption, then prev · hint · next at the bottom. Buttons 44 px round on `secondary` with `border`. **Module split** (each ≤ 300 lines): `lightbox.js` = dialog shell, controls, counter/caption, navigation, key and swipe wiring, scroll lock, focus return; `lightbox-slide.js` = `renderSlide(stage, item) → { release() }` (builds the `<img>` or `<video>` with its error message; `release()` pauses and detaches a video's `src`) and `preloadNeighbours(items, index)`; `lightbox-history.js` = the history binding (next row); `lightbox-gestures.js` = pure helpers. | Native dialog gives focus trapping and Escape; bounded preloading protects bandwidth; keeping native video controls usable avoids gesture/key conflicts (H9 inline playback). The split is fixed up front (review) so the lightbox issue stays PR-sized and within the 300-line limit. | 2026-09-26 |
| **Lightbox history** (`public/js/lightbox-history.js`, `createLightboxHistory({ onPop }) → { push(id), replace(id), release(), dispose() }`): open → `push` = `history.pushState({ lightbox: id }, '', '#bild-<id>')`; navigating → `replace` (`replaceState`, same shape); the close button calls `dialog.close()`; one `close` handler in `lightbox.js` releases the slide, unlocks scroll, restores focus and calls `release()`, which calls `history.back()` only if `history.state?.lightbox` is still set; the module's single `popstate` listener calls `onPop()` when the new state has no `lightbox`, and `lightbox.js` then closes the dialog if open; `dispose()` removes the listener. On page load (`images.js`, using `parseBildHash(location.hash) → number \| null` from `image-format.js`) with `#bild-<id>` of a playable item in the folder: `replaceState` to the plain URL, render batches up to that item, then open it (push) so Back closes it; unknown/non-playable id → hash dropped, no dialog. Focus returns to the tile of the last shown item (batches rendered up to it, `scrollIntoView({ block: 'nearest' })`). | Browser back and the Android back gesture (which closes a modal dialog via the close-watcher without navigating) must both leave history consistent and close the viewer, not the folder. | 2026-09-26 |
| Frontend pure helpers without DOM access: `public/js/image-format.js` (`formatTakenAt(s)`, `orientationClass(n)`, `countLabel(n)`, `headerMeta(folders, items)`, `parseBildHash(hash)` → positive safe integer id from `#bild-<id>` or `null`) and `public/js/lightbox-gestures.js` (`classifySwipe(dx, dy)`, `keyAction({ key, targetTag, altKey, ctrlKey, metaKey })` → `'prev' \| 'next' \| null`), unit-tested from `test/public/`. | Keeps the fiddly logic under `node --test`; importing a DOM-free frontend module from a test does not violate the server/frontend import rule. | 2026-09-26 |
| Fixtures: tiny synthetic JPEGs (≤ 2 KiB, ≤ 64 px, created once with any local encoder, e.g. a browser canvas) are embedded as base64 in `test/helpers/exif-jpeg.js`, which builds EXIF-wrapped buffers (both byte orders, thumbnail, orientation, dates, malformed variants) for unit tests. `node test/helpers/exif-jpeg.js --write` (re)writes the committed QA tree below with fixed mtimes (`fs.utimes`, because git does not keep mtimes); `--bulk <n> <dir>` writes `n` copies for the large-folder check. Base images carry an asymmetric marker band so orientation is visually verifiable. The playable video fixture `VID_0433.webm` (≤ 50 KiB, 2 s, VP8/VP9, synthetic content: solid background + moving marker) is created once with any local encoder — a browser's `MediaRecorder` on a canvas, or `ffmpeg` if installed (a dev-time tool, not a runtime dependency) — and committed as a file; if the implementing agent has no encoder available, the file is omitted and the QA step uses any H.264 MP4 copied into that folder (QA-only); all other non-JPEG fixtures are a few synthetic bytes. Tests needing specific mtimes use temp dirs. | Never real media; one generator keeps unit and QA fixtures consistent; a canvas recording is synthetic yet decodable, so inline playback is QA-able without a human prerequisite. | 2026-09-26 |
| QA fixture tree (`MEDIA_ROOT=test/fixtures/media`): `Bilder/Urlaub 2024/Italien/` with `IMG_0412.jpg` (II, thumb, orientation 1, DateTimeOriginal 2024-07-14 09:14), `IMG_0415.jpg` (MM, thumb, orientation 6, 10:28), `IMG_0419.jpg` (thumb, orientation 8, 11:45), `IMG_0424.jpg` (no EXIF), `IMG_0431.heic`, `VID_0433.webm` (playable), `VID_0434.mov` (not playable), `Screenshot 2.png`, `Screenshot 10.png`, subfolders `Tag 1 – Rom/IMG_0501.jpg`, `Tag 2 – Florenz/IMG_0601.jpg`; `Bilder/Familie/geburtstag.jpg` (IFD0 DateTime only); `Bilder/root.gif`; `Bilder/.versteckt.jpg` and `Bilder/@eaDir/x.jpg` (skipped by P2); `Photos/Familie/alias.jpg` (merges into `Familie`). | Covers every visible rule once; P2's QA tree (`Filme/`, `Serien/`) sits beside it. | 2026-09-26 |
| Category id `images` (plural) everywhere — SQL filters, tests, API; imported from `CATEGORIES`, not re-spelled where the module is available. | Cross-phase consolidation D3. | 2026-09-26 |
| No progress for anything under `images`: the lightbox never loads P4's `progress.js`. | Cross-phase consolidation D11 / H9: P4 returns `not_resumable` for category `images`. | 2026-09-26 |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine (per PR and at QA):

- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no packages;
      every new `src/` module has its test file; no function > 60 lines, no
      file > 300 lines.
- [ ] `test/library/tags/exif.test.js`: II and MM files yield orientation,
      `takenAt` (DateTimeOriginal preferred over DateTime) and the absolute
      thumbnail offset/length; no-EXIF JPEG, PNG input, Compression ≠ 6, thumb
      range outside APP1, length 0 / > 65,535, thumb not starting `FF D8`,
      invalid date (`0000:00:00 00:00:00`, month 13), IFD offset cycle,
      out-of-window IFD → `null` fields; every truncation length of a valid
      sample and random garbage never throw; `isJpegStart` true/false cases
      (incl. a 1-byte buffer → false); `verifyThumb` (temp files, injected
      `openFile` spy): matching size/mtime + `FF D8` → true; changed size,
      changed mtime, a directory, a 1-byte read at the offset, bytes not
      `FF D8`, an `openFile` rejection → false without throwing; every opened
      handle is closed; `THUMB_MIME === 'image/jpeg'`.
- [ ] `test/library/images-kinds.test.js` (temp tree, P2 `createScanner({ db, mediaRoot, log, now })` → `requestFull()` → `idle()`): `.mp4` and
      `.webm` under `Bilder/` are indexed with `category 'images'`,
      `kind 'video'`; `.mov` indexed not playable; `.svg` and `.heic` indexed
      not playable; `.jfif` playable; `.mp4` under `Musik/` still ignored.
      Same PR: P2's `test/library/categories.test.js` expects
      `kindsFor('images')` = `['image', 'video']`, and P2's "non-admitted kind
      ignored" case in `test/library/item-builder.test.js` uses `.mp3` in
      `Bilder/` — both green under `npm run verify`.
- [ ] `test/db/image-meta.test.js`: 005 applies after 002 (also when 003/004 are
      absent), table is STRICT; stub insert; stale detection by size, mtime and
      `meta_version`; deleting a `library_items` row cascades; folder existence
      and subtree counts with `_`/`%` in names use exact ranges; cover order.
- [ ] `test/library/image-folders.test.js` + `test/library/gallery.test.js`:
      key derivation for nested dirs, root files, alias roots, case
      sensitivity; key validation (`..`, `.`, `//`, leading/trailing `/`, NUL,
      > 4096, `\` allowed); breadcrumb; child folders with subtree counts; sort
      (EXIF date, mtime fallback in local time, natural name tie-break, id);
      `thumb` marker (`'embedded'`/`'original'`/`null`) and
      `thumbOrientation` rules incl. stale source; video and non-playable
      `null` markers; `childFolders` aggregation; the view contains no URL
      strings.
- [ ] `test/library/image-meta.test.js`: stubs appear for new items; backfill of
      pre-existing items; JPEG rows read, PNG/video rows marked without I/O
      (injected `openFile` spy, every handle closed); single-flight: 3 triggers during a pass → exactly one rerun;
      a trigger mid-pass makes a new item's stub visible before the pass ends;
      ENOENT and a guard `null` (injected `resolvePath`) leave the row stale
      and do not loop; a closed DB
      ends the pass quietly; fixture files unchanged (hash + mtime) after a sync.
- [ ] `test/api/thumb.test.js` (`startTestApp`): 200 with exact thumbnail bytes,
      `image/jpeg`, `Content-Length`, immutable `Cache-Control`, `nosniff`;
      `HEAD` headers without body; `Range: bytes=0-1` → 206 inside the slice;
      `?v=123` ignored; 404 for `abc`, `0`, `01`,
      17-digit id, unknown id, non-image item, video item, non-playable image,
      no thumb, changed size/mtime, bytes not starting `FF D8`, `rel_path`
      escaping `MEDIA_ROOT`; unauthenticated → 401 JSON; every handle opened
      through the spy passed as `startTestApp({ openFile })` is closed on
      every path.
- [ ] `test/api/gallery.test.js` (`startTestApp`): response shape, breadcrumb,
      direct-children items only, subtree counts incl. videos and non-playable,
      cover choice, alias merge, sort order, no `relPath`/`dir`/`thumb`/
      `version` keys; URL mapping (`thumbUrl` `/media/<id>/thumb?v=<mtimeMs>`
      for a valid thumbnail, `/media/<id>` for other playable images, `null` for
      videos and non-playable; `url` `null` iff not playable); 404 JSON
      for `..`, `.`, `//`, leading/trailing `/`, NUL, > 4096 chars, unknown key;
      a key containing `\` of an existing folder → 200; root 200 on an empty
      library; 401 JSON without session; a 5,000-item folder returns all items.
- [ ] `test/public/image-format.test.js` + `test/public/lightbox-gestures.test.js`:
      date formatting, orientation classes 1–8 (+ unknown → none),
      `parseBildHash` (`#bild-42` → 42; `#bild-0`, `#bild-01`, `#bild-x`,
      `#foo`, `''` → `null`), count and
      header-meta labels (singular/plural, zero parts omitted), swipe thresholds
      (49/50 px, ratio 1.5 boundary, vertical), key mapping incl. `VIDEO`
      target and modifiers → `null`.

Human QA (Chromium + Firefox; desktop 1280 px and 390 px mobile emulation;
`node test/helpers/exif-jpeg.js --write` then `MEDIA_ROOT=test/fixtures/media`):

- [ ] Nav "Bilder" opens `/images` with "Bilder" active: folders "Familie" and
      "Urlaub 2024" with cover + "N Dateien"; `root.gif` as item; no hidden or
      `@eaDir` entries; `Photos/Familie/alias.jpg` appears inside "Familie";
      two columns at 390 px — matches the committed mocks.
- [ ] Folder navigation: breadcrumb `Bilder › Urlaub 2024 › Italien`, browser
      back/forward move between folders, heading, `document.title` and meta
      line (`2 Ordner · 9 Dateien`) correct.
- [ ] Network panel: EXIF JPEG tiles load `/media/<id>/thumb?v=…` (200,
      `image/jpeg`, ≤ 64 KiB, served from cache on reload); PNG / EXIF-less JPEG
      tiles load `/media/<id>` lazily (not all at once).
- [ ] Orientation-6 and -8 fixtures show the marker band at the top in the tile
      and in the lightbox.
- [ ] HEIC shows "Nicht anzeigbar", `.mov` shows "Nicht abspielbar"; neither is
      focusable/clickable and both are skipped by lightbox navigation.
- [ ] `VID_0433.webm` shows the play tile with "Video"; in the lightbox it plays
      only after pressing play, ←/→ with focus on the video seek natively,
      navigating away stops playback (no further `/media/` traffic), swipe on
      the video does not change slides.
- [ ] Order: EXIF-dated fixtures in capture order, EXIF-less by mtime,
      "Screenshot 2" before "Screenshot 10".
- [ ] Lightbox: opens on click/Enter with counter, file name, date
      `DD.MM.YYYY, HH:MM`; ←/→ and buttons navigate; buttons disabled at the
      ends; Escape, close button and browser back close it and focus returns
      to the tile of the last shown item; reload with `#bild-<id>` reopens that
      item, Back closes it and stays in the folder.
- [ ] Mobile emulation (touch): horizontal swipe navigates, vertical scroll and
      pinch are not hijacked, hint "Wischen zum Blättern" visible.
- [ ] `/images?folder=..%2F..` shows "Ordner nicht gefunden." with link
      "Zu Bilder"; `/api/gallery?folder=../..` returns 404 JSON; `/images.html`
      is 404.
- [ ] Freshness (temp `MEDIA_ROOT`, sync idle — no backfill running): copy a
      JPEG into a subfolder → visible after reload within 10 s (P2's ≤ 8 s
      debounce + scan, then the stub insert, which does no file I/O); its
      thumbnail served after the header batch that follows; copy a `.mp4` →
      video tile; delete them → gone after the next scan. (During a large
      initial backfill the bound is the Outcome's "P2 bound plus one
      metadata batch".)
- [ ] Large folder (temp `MEDIA_ROOT`, `--bulk 2000`): first tiles appear
      promptly, more render on scroll, lightbox counter shows `1 / 2000`.
- [ ] Keyboard only: every tile, breadcrumb link and lightbox control reachable
      with a visible 2 px `primary` focus outline; touch targets ≥ 44 px.
- [ ] Optional on the target host (Pi 4): RSS stays < 100 MB after the initial
      sync and while browsing a 1,000-image folder.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migration 005 may be applied on a DB before 003/004 exist (P4/P5/P6 parallel). | 005 depends only on 002; P1's runner applies every unapplied file ascending (D12). Test covers it. |
| Initial backfill of a large library competes with streaming on a Pi HDD and delays new files. | Sequential single reader, one reused 128 KiB buffer, 50-row batches; stubs refreshed between batches keep new files visible; the listener is not awaited by the scan queue (D6). |
| `/media/:id` sends `Cache-Control: private, no-cache` without validators (P3), so originals used as tile fallback or in the lightbox are re-downloaded on each page visit. | Accepted for v1 on a LAN: in-document memory cache and bfcache cover back/forward within a session; EXIF JPEGs (the bulk of phone photos) use the immutable thumb URL; lazy loading limits traffic. Changing P3's policy is out of scope. |
| Embedded thumbnails are small (often 160×120) → soft tiles on HiDPI screens; some cameras pad them with black bars. | Accepted trade-off of the prior-art decision (no server resize); `object-fit: cover` crops most padding; the lightbox always shows the original. |
| Thumbnail orientation mismatches when an editor rotated pixels but left a stale thumbnail/tag. | Rare; the original in the lightbox is correct; documented. |
| iPhone households store HEIC/MOV (HEVC) → many "Nicht anzeigbar"/"Nicht abspielbar" tiles. | README note (docs issue acceptance): iOS camera "Maximale Kompatibilität" or export as JPEG/H.264; transcoding stays out of scope. |
| Folders of PNG screenshots without thumbnails → heavy downloads and decode memory on phones/TVs. | `loading="lazy"`, `decoding="async"`, 120-tile batches; originals only fetched when near the viewport. |
| Malicious or corrupt JPEG headers crash or hang the parser. | Bounds checks on every read, cycle guard, entry cap, truncation/garbage tests; `null` fields instead of throwing; the sync catches per-file errors. |
| A file is edited between scans → stored thumbnail offset is stale. | Thumb route compares current size/mtime with `source_*` and returns 404; client falls back to the original via `onerror`; `thumbUrl` changes with `mtime_ms`. |
| A playing inline video keeps a server file handle after the slide changes. | `pause()` + `removeAttribute('src')` + `load()` on leave/close; P3's 60 s idle timeout as backstop. |
| `routes.js`, `server.js`, `categories.js`, P2's `categories.test.js`/`item-builder.test.js`, `architecture.md`, `README.md` edited by several phases in parallel → merge conflicts. | One line / one section / one test case each; trivial rebase. |

## Decision log

- 2026-09-26: Folder addressing by validated folder keys (index lookup only)
  instead of synthetic folder ids — no extra table, bookmarkable URLs that
  survive an index rebuild, and no filesystem access derived from the key.
- 2026-09-26: Metadata in a separate `image_meta` table filled by a post-scan
  sync with index-based staleness — decouples P6 from the scanner's internals,
  backfills items indexed before P6 shipped, keeps items visible immediately.
- 2026-09-26: Dedicated `GET /api/gallery` instead of extending P2's
  `/api/library/:category` — tree-shaped response and no router ambiguity.
- 2026-09-26: Thumbnail fallback signalled by the API (`thumbUrl` is the
  original when no valid thumbnail exists) plus a client `onerror` safety net —
  avoids a 404 round-trip per EXIF-less image.
- 2026-09-26: Thumbnail orientation fixed client-side by CSS transforms; the
  server never rewrites image bytes (read-only, no re-encoding).
- 2026-09-26: Capture date kept as timezone-less wall-clock text and formatted
  by string slicing — avoids TZ shifts between server and clients.
- 2026-09-26: Chronological (oldest-first) item order and natural folder order
  settled as album convention; not asked at the gate.
- 2026-09-26: Own tile markup instead of P2's shared media card — P4 edits that
  card in parallel.
- 2026-09-26: exifr/exif-parser not cloned — the EXIF 2.3/TIFF layout is a
  published standard and no decision depended on their internals.
- 2026-09-26: cross-phase consolidation — page at `/images` (`public/images.html`
  replaces P1's placeholder, `?folder=<key>`), no nav edit (D1); supersedes
  `/gallery.html` and the nav-module edit.
- 2026-09-26: cross-phase consolidation — extensions and MIME owned solely by
  P2's `compat.js` (D9): `jfif` displayable, `jxl` and `svg` indexed as
  "Nicht anzeigbar"; P6 keeps no extension table and no `parsers/image.js`.
- 2026-09-26: cross-phase consolidation — metadata sync registered via P2's
  `onScanComplete` with one `src/server.js` line (D6); orphan cleanup dropped
  (FK cascade), scanner untouched.
- 2026-09-26: cross-phase consolidation — thumbnail route in `src/api/thumb.js`,
  JPEG SOI check in `src/library/tags/exif.js`, served through P3's
  `sendMedia` with `cacheControl: 'private, max-age=31536000, immutable'` and
  its `slice` option (D10); supersedes the draft's own bounded read.
- 2026-09-26: cross-phase consolidation — migration number 005, STRICT, no
  transaction statements, depends only on 002 (D12); category id `images`
  (D3); P1 server/frontend contracts used verbatim (D4/D5), incl. JSON-line
  logging via the injected `log`.
- 2026-09-26: cross-phase consolidation — `docs/architecture.md` edits listed in
  scope and made by the docs/fixtures issue (D13).
- 2026-09-26: gate decision — videos in `Bilder` = C (H9): indexed under
  `images` with kind `video` via one `categories.js` edit, video tiles, inline
  native playback in the lightbox, non-playable videos skipped, no progress,
  no video thumbs.
- 2026-09-26: gate decision — phone grid = B (H3): `minmax(min(var(--grid-min),
  calc(50% - var(--space-2))), 1fr)`, `--space-2` instead of the literal 8 px.
- 2026-09-26: Pre-mortem — keyset cursor + stub refresh between batches in the
  sync (no retry loop, freshness during backfill); `meta_version` column for
  future reader fixes; `db.isOpen` check instead of a shutdown hook; root label
  and header meta computed client-side; unreachable subfolder empty state
  removed; lightbox history reconciled in one `close` handler (covers Android
  back via close-watcher); focus returns to the last shown item; arrow keys and
  swipes on a `<video>` left to native controls.
- 2026-09-26: `orientationClass(n)` (`public/js/image-format.js`) names the
  per-orientation CSS classes `orient-2`..`orient-8` (kebab-case, one class
  per non-identity transform of the Orientation row); orientation 1 and any
  unknown value get `''` (no class, no transform). `image-tiles.js`/
  `images.css` and the lightbox slide styling must use exactly these class
  names. `classifySwipe` returns the same `'prev' | 'next' | null` literals
  as `keyAction` so both feed one navigation function.
- 2026-09-26: Review findings resolved — breadcrumb hit area ≥ 44 px; header
  meta counts direct children and omits zero parts; `\` allowed in folder keys;
  range form instead of `LIKE`; `test/library/gallery.test.js` added; P3's
  `no-cache` on originals recorded as an accepted risk.
- 2026-09-26: spec-acceptance review (blocking) resolved — the H9 `KINDS` edit
  carries the two P2 test expectations it invalidates: `kindsFor('images')`
  → `['image', 'video']` in P2's `categories.test.js`, and P2's
  "non-admitted kind ignored" example switches from `.mp4` to `.mp3` in
  `Bilder/` (keeps P2's negative coverage); listed in Scope and in the
  Constraints' shared-edit list. Chosen over asking P2 to change its example
  because P6 owns the behaviour change and the fix must not depend on another
  phase's timing.
- 2026-09-26: spec-acceptance review (non-blocking) resolved — architecture
  boundaries restored: `src/library/gallery.js` returns a neutral `thumb`
  marker and `src/api/gallery.js` builds URLs (P2 `library-json.js`
  precedent); the thumbnail pre-check `verifyThumb` and `THUMB_MIME` moved
  into `src/library/tags/exif.js`, so `src/api/thumb.js` holds no format
  knowledge (`THUMB_MIME` is a format fact, not an extension table, so D9
  stands).
- 2026-09-26: spec-acceptance review (non-blocking) resolved — test seams
  fixed: `createImageMetaSync` takes optional `resolvePath`/`openFile` (P5
  precedent), the thumb route reads the optional `deps.openFile` passed via
  `startTestApp({ openFile })` and forwards it to `verifyThumb` and
  `sendMedia`; test seeding by direct prepared-statement inserts (P5
  precedent), no scanner/sync in API tests.
- 2026-09-26: spec-acceptance review (non-blocking) resolved — freshness QA
  line aligned with the Outcome (≤ 10 s with an idle sync; P2 bound plus one
  batch during backfill); `isJpegStart` checks exactly two bytes; off-token
  mapping generalised to all hover/active/border shades, placeholder-art
  fills ignored; lightbox split pre-named (`lightbox-slide.js`,
  `lightbox-history.js`) to stay within 300 lines per file; folder URLs beyond
  P1's 2,048-char `safeNext` cap fall back to `/` after login — accepted.
- 2026-09-26: Issue #77 (`005-image-meta.sql` + `src/db/image-meta.js`)
  implemented exactly per D12/the repository row: `insertMetaStubs` wraps its
  batch in one `BEGIN IMMEDIATE`/`COMMIT`, no-op when given an empty array;
  `BEGIN` sits outside the `try`, so a call inside a caller's open
  transaction throws without rolling that transaction back (must not be
  called inside one); `folderExists`/`findFolderCover`/
  `listSubtreeFolderCounts` use the `[key/, key0)` range trick throughout
  (root short-circuits `folderExists` to `true` without a query). The image
  repository tests migrate a temp-dir copy of exactly 001+002+005
  (`test/helpers/image-meta-seed.js`), so they prove the Risks row (005 on a
  DB at 002 without 003/004, and alongside synthetic 003/004) independently
  of sibling migrations in `src/db/migrations/`. `test/db/index.test.js` and
  `test/db/library-repo.test.js`, which migrate the shared default directory,
  now assert containment of the versions they need instead of an exact
  list, so adding a sibling migration no longer requires editing them.
- 2026-09-27 (#75, `src/library/tags/exif.js`): the IFD cycle guard is a
  shared `Set` of absolute IFD start offsets visited across the three fixed
  reads (IFD0, its Exif sub-IFD, IFD1) rather than a generic "follow next"
  loop — the reader never chains past IFD1, so this is enough to make a
  self-referencing offset (IFD0 as its own Exif pointer or next-IFD) a no-op
  instead of a special case. The thumbnail's "inside the APP1 segment" check
  uses the segment's *declared* end (from its length field, unclamped),
  while any actual byte access (TIFF/IFD parsing, the thumbnail's FF D8 peek)
  is bounded by `min(declared end, bytes actually read)` — the two coincide
  for a real file (APP1 ≤ 64 KiB, read window 128 KiB) and only diverge for a
  deliberately truncated test buffer. `parseExif` also wraps its body in a
  top-level try/catch as a defensive backstop on top of the explicit bounds
  checks, matching "never throws" for any bounds-check gap. "Fallback IFD0
  DateTime" applies whenever DateTimeOriginal yields no valid date (absent,
  unreadable or invalid such as `0000:00:00 00:00:00`), not only when absent;
  "Compression absent or 6" treats a present but unreadable Compression entry
  (unknown TIFF type, out-of-bounds value) as not 6, so the thumbnail is
  rejected. The marker walk skips every length-bearing segment (DQT, SOFn,
  DHT, ...), not only APPn/COM, so a table segment before APP1 does not stop
  it.
- 2026-09-27 (#75, `test/helpers/exif-jpeg.js`): the embedded base JPEG is a
  16x16 baseline grayscale image built from flat 8x8 blocks (top block-row
  dark, bottom light) — a flat block's DCT has no AC energy, so the one-off
  generator (not committed) needed no real DCT, only the DC term, and the
  custom AC Huffman table needs only one symbol (EOB), avoiding transcribing
  the large standard 162-symbol table; verified by decoding the output
  visually before embedding it as base64. The QA fixture tree's non-JPEG
  entries (`.heic`/`.mov`/`.png`/`.gif`) are a few arbitrary bytes per the
  Fixtures row's explicit sanction; `VID_0433.webm` is that row's one
  exception (a real, decodable VP8/VP9 file, ≤ 50 KiB), committed separately
  by the docs/fixtures issue, so `--write` never generates or overwrites it —
  it only re-applies the fixed mtime when the file is already present and
  otherwise leaves it out. Capture dates/times for the fixture files the QA
  tree row leaves unpinned (Tag 1/Tag 2, `geburtstag.jpg`, `alias.jpg`) were
  chosen to keep chronological order plausible.
- 2026-09-27 (#85, `test/fixtures/media/Bilder/Urlaub 2024/Italien/VID_0433.webm`):
  a local `ffmpeg` was available, so the Fixtures row's QA fallback (an H.264
  MP4 copied in) was not needed. Generated with `libvpx-vp9`, 64×64 px, 10 fps,
  ~30 kbit/s, 2 s: a `color` source with a `drawbox` filter drawing an 8×8
  marker sliding left-to-right, so the content is visibly synthetic and moving
  (not a static frame). Output is ~1 KiB, well under the 50 KiB cap; fixed
  mtime applied via `exif-jpeg.js --write`'s existing "leave present files'
  mtime alone" behaviour for this file.
