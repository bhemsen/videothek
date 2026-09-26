# Spec: Image gallery

> Created: 2026-09-26

Roadmap phase 6: every picture under the image category root is browsable as a
folder gallery with EXIF-embedded thumbnails and opens in a keyboard- and
touch-friendly lightbox — without server-side decoding, resizing or any runtime
dependency. This spec carries no lifecycle state — acceptance is the spec merged
on the default branch with a milestone and issues, and all progress (in
progress, done, blocked) lives in the GitHub issues and milestone. A completed
spec is moved to `docs/specs/archive/`.

## Outcome

- [ ] The "Bilder" nav entry opens `/gallery.html`, which shows the folder tree
      below the image category root: breadcrumb, a "Ordner" section with
      subfolder tiles (cover, name, file count) and a "Bilder" section with 1:1
      image cards (filename, date).
- [ ] JPEG files with an EXIF IFD1 thumbnail render their tile from
      `GET /media/:id/thumb` (bytes ≤ 64 KiB, cacheable); every other displayable
      image renders its tile from the original via `loading="lazy"`.
- [ ] Tiles and the lightbox show EXIF-rotated photos upright (thumbnail
      orientation applied by CSS, originals by the browser).
- [ ] Files in HEIC/HEIF/TIFF/JPEG XL/camera-RAW formats are listed with a
      "Nicht anzeigbar" badge, are not clickable and are skipped by the lightbox.
- [ ] Items are ordered by capture date (EXIF `DateTimeOriginal`, fallback file
      mtime), oldest first; folders by natural name order.
- [ ] Clicking an image opens a full-viewport lightbox with the original,
      position counter, filename and date; ←/→ and prev/next buttons navigate,
      Escape / close button / browser back close it and return focus to the tile;
      horizontal swipe navigates on touch devices.
- [ ] A new image copied into a folder under the image root appears in the
      gallery without restart (within the scanner's freshness bound), and its
      thumbnail is served once its metadata has been read.
- [ ] No client-supplied value is ever turned into a filesystem path: folders
      are addressed by validated folder keys looked up in the index; media by
      index id through the P3 path guard.
- [ ] `npm run verify` is green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- Image category parser rules: which extensions under the image root are
  indexed, which are displayable, which entries are skipped.
- EXIF reader `src/library/tags/exif.js` (JPEG APP1 only): orientation,
  capture date, IFD1 JPEG thumbnail location.
- Migration `005-image-meta.sql` and repository `src/db/image-meta.js`.
- Metadata sync `src/library/image-meta.js`, run after every completed scan
  pass (startup, watcher, periodic rescan).
- Thumbnail route `GET /media/:id/thumb` (`src/http/thumb.js`).
- Gallery API `GET /api/gallery?folder=<key>` (`src/api/gallery.js`, pure
  shaping in `src/library/gallery.js`).
- Gallery page `public/gallery.html` + `public/js/gallery.js` +
  `public/js/gallery-helpers.js` + `public/css/gallery.css`; lightbox
  `public/js/lightbox.js` + `public/css/lightbox.css`; switching the shared
  nav's "Bilder" entry from the placeholder to `/gallery.html`.
- Synthetic fixtures under `test/fixtures/media/Bilder/` and an EXIF/JPEG test
  helper.
- Video files inside image folders — handling per OPEN-1 (recommended: tile
  that opens the P3 player).

### Out of scope

- Server-side decoding, resizing, re-encoding or transcoding of any kind
  (vision "Out"; constitution "no child processes").
- EXIF from PNG `eXIf`, WebP, AVIF or HEIF containers; XMP; GPS/maps; camera
  details panel.
- Zoom/pan inside the lightbox (native pinch-zoom of the page stays usable),
  slideshow, download, rotate, delete, sharing, favourites, albums, search.
- User-selectable sort order; server-side pagination.
- Progress/resume for pictures (P4 covers video/audio only).
- Custom arrow-key roving focus inside the grid (see Prior decisions).

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

Where the mocks and this spec differ, the spec wins: tile count label is
"N Dateien" (mock: "Bilder"); a focused card shows only the 2 px `primary`
outline (the desktop mock also tints the filename); cover/tile artwork in the
mocks is placeholder art — real tiles show thumbnails.

German UI copy (exact):

| Where | Text |
|---|---|
| Page title / root heading | `Bilder` |
| Section headings | `Ordner`, `Bilder` (hidden when the section is empty) |
| Header meta | `{n} Ordner · {m} Dateien` (singular `1 Datei`) |
| Folder tile meta | `{n} Dateien` / `1 Datei` |
| Badge | `Nicht anzeigbar` |
| Video tile meta (OPEN-1 B/C) | `Video` |
| Empty folder / empty root | `Keine Bilder in diesem Ordner.` / `Noch keine Bilder vorhanden.` |
| Unknown folder (API 404) | `Ordner nicht gefunden.` + link `Zu Bilder` |
| Load error | `Bilder konnten nicht geladen werden.` |
| Lightbox buttons (aria-label + title) | `Schließen`, `Vorheriges Bild`, `Nächstes Bild` |
| Lightbox dialog aria-label | `Bildansicht` |
| Lightbox hint | desktop `← → Blättern · Esc Schließen`; coarse pointer `Wischen zum Blättern` |
| Lightbox image load error | `Bild konnte nicht geladen werden.` |

## Constraints

- Constitution applies unchanged: zero runtime deps, read-only `MEDIA_ROOT`
  (files opened with flag `r` only), path containment → `404`, SQL only in
  `src/db/` via prepared statements, ≤ 60 lines/function, ≤ 300 lines/file,
  JSDoc on every export, one `test/*.test.js` per new `src/` module, JSON errors
  `{ "error": "<code>" }` on `/api/*`, no `innerHTML` with unescaped data
  (build tiles with `createElement`/`textContent`).
- Architecture boundaries: `src/library/` has no HTTP knowledge; `src/api/`
  has no file-format knowledge (EXIF lives in `src/library/tags/exif.js`);
  only `src/media/paths.js` (P3) maps index rows to absolute paths.
- Cross-phase contract (shared brief): P6 depends on P3 (path guard,
  `GET /media/:id` streaming images with correct MIME) and on P2 (index
  `library_items`, scanner, `compat.js`, the image category constant). P6 runs
  in parallel with P4 and must not edit P4-owned files (`003` migration,
  progress API, `public/js/lib/progress.js`, player page, and the P2 shared media card that P4 extends).
- Shared files P6 touches, with small additive changes only:
  `src/http/routes.js` (two registration calls), the shared nav module in
  `public/js/lib/` ("Bilder" link target), and — only if P2/P3 did not already
  provide them — the image rows in `compat.js` / the MIME map and a post-scan
  hook in the scanner (see Prior decisions).
- Design tokens only via `public/css/tokens.css`; grid per design.md
  (min column 160 px, gap 16 px); touch targets ≥ 44×44 px; WCAG 2.1 AA.

## Prior art

- [Image thumbnails without native dependencies (Phase 6)](../prior-art.md#image-thumbnails-without-native-dependencies-phase-6)
  — ADOPT: hand-rolled EXIF IFD1 thumbnail extraction by buffer parsing; fallback
  to the original with `loading="lazy"` and browser downscaling; AVOID sharp /
  libvips / Immich / PhotoPrism. Not cloned: the IFD layout is the published
  EXIF 2.3 / TIFF 6.0 structure and no decision here depends on exifr internals.
- [Direct-play compatibility detection (Phase 2)](../prior-art.md#direct-play-compatibility-detection-phase-2)
  — static extension table, no client-side capability probe; P6 adds the image
  rows on the same principle (HEIC stays "not displayable" even though Safari
  renders it).
- [Detecting new files without restart (Phase 2)](../prior-art.md#detecting-new-files-without-restart-phase-2)
  — freshness comes from the P2 watcher + periodic rescan; P6 only hooks a
  metadata sync after each completed pass and stays correct if the watcher is
  silent.

## Human prerequisites

none — all fixtures are synthetic and generated/committed by the implementer.
(Optional for the QA gate, not blocking: a real phone-photo folder on a local
`MEDIA_ROOT`, including portrait/EXIF-rotated JPEGs and a HEIC file.)

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| **Indexed extensions under the image root** (case-insensitive). Displayable: `.jpg .jpeg .jfif .png .gif .webp .avif .bmp`. Listed as not displayable: `.heic .heif .tif .tiff .jxl .dng .cr2 .cr3 .nef .arw .orf .rw2 .raf`. Everything else (incl. `.svg`, sidecars, `Thumbs.db`) is not indexed. Video extensions per OPEN-1. | Static table (prior art, P2 compat principle). First set renders in current Chromium, Firefox and Safari; the second renders nowhere or Safari-only, and transcoding is out of scope (vision). SVG excluded: served same-origin from `/media/:id` it could run script when opened directly, and it is not a photo format. | 2026-09-26 |
| MIME for displayable images: `image/jpeg` (jpg/jpeg/jfif), `image/png`, `image/gif`, `image/webp`, `image/avif`, `image/bmp`. P6 relies on P3's MIME map; if a row is missing, P6 adds only that row. | `/media/:id` streams any playable item (shared brief); a wrong type breaks `<img>` in Firefox with `nosniff`. | 2026-09-26 |
| Skip any path with a segment starting with `.` or equal to `@eaDir` (case-insensitive) below the image root. | Hidden dirs and Synology thumbnail caches would otherwise flood the gallery with duplicates. | 2026-09-26 |
| **Folder key** = the item's `rel_path` minus its first segment (the category root folder, whichever alias) minus the file name, `/`-separated, `''` = root. Alias roots (e.g. `Bilder/` and `Photos/`) merge into one virtual tree. | Keeps API free of raw/absolute paths; the key is never turned into a filesystem path — only compared against the index (architecture boundary). Merging is the only consistent reading of "one category, several aliases". | 2026-09-26 |
| **Folder key validation** (`?folder=`): absent → root; else must be a string ≤ 4096 chars, no NUL, no `\`, no leading/trailing `/`, no empty, `.` or `..` segment; and must exist (some `image_meta.folder` equals it or starts with `key + '/'`). Any violation → `404 {"error":"not_found"}`. Root always exists. Clients only reuse keys the API returned. | Constitution: path violations → 404. Existence check by index lookup means traversal strings can never reach `fs`. | 2026-09-26 |
| **Migration 005** creates `image_meta(item_id INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE, folder TEXT NOT NULL, taken_at TEXT, orientation INTEGER, thumb_offset INTEGER, thumb_length INTEGER, source_size INTEGER, source_mtime_ms INTEGER)` + `CREATE INDEX image_meta_folder ON image_meta(folder)`. `source_*` NULL = EXIF not read yet. Depends only on 002. | Capture-date sort and thumbnail offsets must be stored (reading headers per request is too slow on a Pi HDD). Separate table: no change to P2's table/queries, derived and rebuildable (constitution). Fixed number 005 (shared brief). | 2026-09-26 |
| **Metadata sync** (`syncImageMeta`) runs after every completed scan pass, single-flight (a trigger during a run schedules exactly one follow-up run). Phase 1: insert stub rows (`folder` only) for image items without a row — pure string work, one transaction. Phase 2: for rows whose `source_size`/`source_mtime_ms` differ from the item's `size`/`mtime_ms` (or are NULL): JPEGs → read header + parse EXIF; other types → set `source_*` without I/O. Sequential, one file at a time, one reused 128 KiB buffer. Phase 3: delete orphan rows (`item_id` not in `library_items`) in case FK enforcement is off. Read errors (ENOENT/EACCES/…) leave the row stale for the next pass; one summary log line per run (counts + duration, no file contents). | Items become visible in the gallery immediately after the scan (phase 1) while slow I/O fills in later. Staleness is checked against the index, so rows indexed before P6 shipped are backfilled automatically and the sync is independent of the scanner's own change detection. Sequential reads protect concurrent streams on a Pi. | 2026-09-26 |
| **Post-scan hook**: P6 subscribes `syncImageMeta` through the scanner's completion notification provided by P2. If P2's accepted scanner exposes none, P6 adds a minimal `onScanComplete(listener)` to `scanner.js` (additive, ≤ 15 lines). | Keeps P6 out of the scan walk; see Risks for the P5 collision. | 2026-09-26 |
| **EXIF reader scope**: JPEG only (`FF D8` at offset 0), header window = first 131,072 bytes. Walk markers from offset 2 over APPn/COM segments; stop at SOS (`FFDA`), EOI, a non-marker byte or the window end. First APP1 whose payload starts `Exif\0\0` → TIFF header (`II`/`MM`, magic 42). Read IFD0 `0x0112` Orientation (1–8, else null), `0x8769` → Exif IFD `0x9003` DateTimeOriginal, fallback IFD0 `0x0132` DateTime; IFD1 (next-IFD of IFD0) `0x0201`/`0x0202` JPEG thumbnail offset/length, accepted only if IFD1 `0x0103` Compression is absent or 6, `0 < length ≤ 65,535`, the range lies inside the APP1 segment's declared length, and — when its start lies inside the window — it begins `FF D8`. Stored `thumb_offset` is absolute in the file. Every read is bounds-checked; IFD offsets visited once (cycle guard); ≤ 512 entries per IFD; malformed input yields `null` fields, never a throw. | Prior art ADOPT; an APP1 segment is ≤ 64 KiB by format, so APP0 + APP1 fit in 128 KiB; only the IFD structures (not the thumbnail bytes) need to be in the window. Uncompressed TIFF thumbnails are rare and not servable as JPEG. | 2026-09-26 |
| **Capture date** stored as `YYYY-MM-DDTHH:MM:SS` (camera wall-clock, no timezone) when the EXIF value matches `YYYY:MM:DD HH:MM:SS` with month 1–12, day 1–31, year ≥ 1900; otherwise NULL (e.g. `0000:00:00 00:00:00`). API `date` = `taken_at` or, when NULL, the item's `mtime_ms` formatted in the server's local time in the same shape. The client formats it by string slicing to `DD.MM.YYYY, HH:MM`, e.g. `14.07.2024, 18:03` (no `Date` parsing, no TZ shift). | EXIF has no reliable offset; wall-clock is what the photographer saw. String formatting avoids timezone drift between server and browsers. | 2026-09-26 |
| **Sort**: items by (`date` asc, file name via `Intl.Collator('de', {numeric: true, sensitivity: 'base'})`, `id`); folders by the same collator on name. Sorting happens server-side in `src/library/gallery.js`. | Chronological order is the album convention and fixes mixed camera prefixes (`IMG_`/`DSC_`); one comparator, unit-testable, trivial to flip later. | 2026-09-26 |
| **Thumbnail route** `GET /media/:id/thumb`: same auth behaviour as `GET /media/:id` (P3). `id` must match `^[1-9]\d{0,15}$` else 404. 404 when the item is unknown, not in the image category, has no thumbnail, its path fails the P3 guard, the file's current size/mtime (normalised exactly as P2 stores `mtime_ms`) differ from `source_size`/`source_mtime_ms`, or the read bytes do not start `FF D8`. Otherwise read exactly `thumb_length` bytes at `thumb_offset` with a `FileHandle` (flag `r`) and answer `200`, `Content-Type: image/jpeg`, `Content-Length`, `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`. `Range` is ignored; query string ignored. | The bounded ≤ 64 KiB slice is not "a media file read fully into memory" (constitution) and needs no range support for `<img>`. Versioned URL (below) makes immutable caching safe; `private` because content is behind auth. | 2026-09-26 |
| **Thumbnail fallback is decided by the API, not by a 404 round-trip**: `thumbUrl` = `/media/:id/thumb?v=<mtime_ms>` when a thumbnail is recorded, else `/media/:id` (original). Client `onerror` on a thumb URL switches once to the original; on an original, shows the placeholder icon. | No wasted request per EXIF-less image; the `onerror` path covers files edited between scans. | 2026-09-26 |
| **Orientation**: originals rely on the browser default `image-orientation: from-image`. Embedded thumbnails carry no EXIF, so the API returns `thumbOrientation` (1–8 from IFD0; 1 when `thumbUrl` is the original) and the client applies a CSS class: 2 `scaleX(-1)`, 3 `rotate(180deg)`, 4 `scaleY(-1)`, 5 `rotate(270deg) scaleX(-1)`, 6 `rotate(90deg)`, 7 `rotate(90deg) scaleX(-1)`, 8 `rotate(270deg)`. The `<img>` fills a square box with `object-fit: cover`, so 90° rotations keep the tile square. | Without this, portrait phone photos show sideways tiles. Transform table follows the exiftool naming of EXIF orientation values. | 2026-09-26 |
| **Gallery API** `GET /api/gallery?folder=<key>` (auth: `requireUser`, 401 JSON otherwise). Response: `{ key, name, breadcrumb: [{name, key}] /* ancestors incl. root "Bilder", excl. current */, folders: [{ key, name, count, cover: {thumbUrl, thumbOrientation} \| null }], items: [{ id, name, kind: "image"\|"video", displayable, date, url: "/media/:id"\|null, thumbUrl\|null, thumbOrientation }] }`. At the root: `key: ""`, `name: "Bilder"`, `breadcrumb: []`. `items` = direct children only; `count` = all indexed files in the subfolder's subtree; `cover` = first displayable `kind: "image"` item in the subtree in (`folder`, `rel_path`) binary order. Non-displayable items: `url` and `thumbUrl` null. | A dedicated route avoids pattern ambiguity with P2's `/api/library/:category` and fits the tree shape the generic list cannot express; the whole folder in one response keeps lightbox navigation trivial. | 2026-09-26 |
| **No server-side pagination.** The client renders tiles in batches of 120 (first batch immediately, next batch when a sentinel after the grid comes within 800 px of the viewport via `IntersectionObserver`). Every `<img>` has `loading="lazy" decoding="async"`. | A 5,000-item folder is ~1 MB JSON on a LAN; batching bounds DOM size and memory on phones/TVs; one list keeps "12 / 148" counters and prev/next exact. | 2026-09-26 |
| **Tiles**: own markup and styles in `public/js/gallery.js` / `public/css/gallery.css`, visually following the design.md Media card (1:1, radius `md`, `shadow-sm`, title 1 line ellipsis, meta `muted`). Folder tile = `<a href="/gallery.html?folder=…">`; image tile = `<button>` with `aria-label` = file name and `<img alt="">`; non-displayable tile = non-interactive `<div>` with icon + badge. Grid keyboard: native Tab/Enter; if P1/P2 ship a shared grid arrow-key helper in `public/js/lib/`, reuse it, otherwise none. | Avoids editing P2's shared media card while P4 adds progress bars to it (parallel-phase collision). Folder links give native back/forward and bookmarkable URLs. | 2026-09-26 |
| Badge text `Nicht anzeigbar` (the design.md badge component with image wording). | "abspielbar" is wrong for a still picture; same token, shape and colour. | 2026-09-26 |
| **Lightbox**: native `<dialog>` + `showModal()`, backdrop fully `--color-background`, `html` scroll locked while open. Image = original via `url`, scaled down to fit (never upscaled), `object-fit: contain`. Only displayable images form the sequence; no wrap-around — prev disabled on first, next on last (disabled = 40 % opacity). Preload only the previous and next original. Initial focus on `Schließen`; on close focus returns to the opening tile. Keys: ArrowLeft/ArrowRight navigate; Escape closes (via `cancel`). Swipe: pointer events on the stage with `touch-action: pan-y pinch-zoom`; horizontal distance ≥ 50 px and > 1.5 × vertical distance → swipe left = next, swipe right = previous. | Native dialog gives focus trapping and Escape for free; bounded preloading protects bandwidth and memory. | 2026-09-26 |
| **Lightbox history**: opening pushes a history entry with hash `#bild-<id>`; navigating replaces it; close button / Escape call `history.back()`; `popstate` without the lightbox state closes the dialog. Loading the page with `#bild-<id>` of a displayable item in the folder opens it (first `replaceState` to the plain URL, then push the lightbox entry) so Back still closes it. | Android back gesture and browser back must close the viewer, not leave the folder. | 2026-09-26 |
| Frontend pure helpers (`formatDate`, `orientationClass`, `classifySwipe`, count labels) live in `public/js/gallery-helpers.js` without DOM access and are unit-tested from `test/public/gallery-helpers.test.js`. | Keeps the fiddly logic under `node --test`; importing a DOM-free frontend module from a test does not violate the server/frontend import rule. | 2026-09-26 |
| Fixtures: tiny synthetic JPEGs (≤ 2 KiB, ≤ 64 px, created once with any local encoder, e.g. PowerShell `System.Drawing` or a browser canvas) are embedded as base64 in `test/helpers/exif-jpeg.js`, which builds EXIF-wrapped buffers (both byte orders, thumbnail, orientation, dates, malformed variants) for unit tests and, via `node test/helpers/exif-jpeg.js --write`, the committed tree under `test/fixtures/media/Bilder/`. Base images carry an asymmetric marker band so orientation is visually verifiable. Tests needing specific mtimes copy fixtures to a temp dir first. | Shared brief: synthetic, never real media; one generator keeps unit and QA fixtures consistent. | 2026-09-26 |
| OPEN-1 — Video files (`.mp4 .m4v .webm .mov`) inside image folders: **A)** not indexed (invisible), **B)** indexed as `kind: "video"`, shown as a play-icon tile that links to the P3 player page for that id (playability per P2 `compat.js`; not in the lightbox sequence), **C)** like B but played inline in the lightbox with native `<video controls>`. Recommended: **B**. | resolved at the spec-acceptance gate | — |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine (per PR and at QA):

- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no packages.
- [ ] `test/library/tags/exif.test.js`: II and MM files yield orientation,
      `takenAt` (DateTimeOriginal preferred over DateTime) and the absolute
      thumbnail offset/length; no-EXIF JPEG, PNG input, Compression ≠ 6, thumb
      range outside APP1, length 0 / > 65,535, invalid date, IFD offset cycle,
      out-of-window IFD → `null` fields; feeding every truncation length of a
      valid sample and random garbage never throws.
- [ ] `test/library/parsers/image.test.js`: extension table (case-insensitive),
      `.svg` not indexed, `.heic` indexed not displayable, `.`-prefixed and
      `@eaDir` paths skipped, folder-key derivation for nested paths, root files
      and alias roots.
- [ ] `test/db/image-meta.test.js` + `test/library/image-meta.test.js`: stub
      insert, stale detection by size/mtime, backfill of pre-existing items,
      orphan cleanup, single-flight coalescing, ENOENT during sync leaves the row
      stale, fixture files unchanged (hash + mtime) after a sync.
- [ ] `test/http/thumb.test.js`: 200 with exact thumbnail bytes, `image/jpeg`,
      `Content-Length`, immutable `Cache-Control`; 404 for non-numeric id,
      unknown id, non-image item, item without thumb, changed file
      (size/mtime), bytes not starting `FF D8`, `rel_path` escaping
      `MEDIA_ROOT`; unauthenticated → same response as `GET /media/:id`.
- [ ] `test/api/gallery.test.js`: response shape, breadcrumb, direct-children
      items only, subtree counts, cover choice, sort order (EXIF date, mtime
      fallback, natural name tie-break), `thumbUrl`/`thumbOrientation` rules,
      non-displayable nulls; 404 JSON for `..`, `.`, `//`, leading/trailing `/`,
      `\`, NUL, > 4096 chars, unknown key; root 200 on an empty library;
      401 JSON without session; 5,000-item folder returns all items.
- [ ] `test/public/gallery-helpers.test.js`: date formatting, orientation
      classes 1–8, swipe classification thresholds, singular/plural labels.

Human QA (Chromium + Firefox; desktop and 390 px mobile emulation; app on
`test/fixtures/media/`):

- [ ] Nav "Bilder" opens the gallery root: folders with cover + "N Dateien",
      no hidden or `@eaDir` entries; mobile shows the bottom nav with "Bilder"
      active — matches the committed mocks.
- [ ] Folder navigation: breadcrumb `Bilder › Urlaub 2024 › Italien`, browser
      back/forward move between folders, heading + meta line correct.
- [ ] Network panel: EXIF JPEG tiles load `/media/<id>/thumb?v=…` (200,
      `image/jpeg`, ≤ 64 KiB, cached on reload); PNG / EXIF-less JPEG tiles load
      `/media/<id>` lazily (not all at once).
- [ ] Orientation-6 and -8 fixtures show the marker band at the top in the tile
      and in the lightbox.
- [ ] HEIC fixture shows "Nicht anzeigbar", is not focusable/clickable and is
      skipped by lightbox navigation; video fixture behaves per OPEN-1.
- [ ] Order: EXIF-dated fixtures in capture order, EXIF-less by mtime.
- [ ] Lightbox: opens on click/Enter with counter, filename, date
      `DD.MM.YYYY, HH:MM`; ←/→ and buttons navigate; buttons disabled at the
      ends; Escape, close button and browser back close it and focus returns
      to the tile; reload with `#bild-<id>` reopens that image, Back closes it.
- [ ] Mobile emulation (touch): horizontal swipe navigates, vertical scroll and
      pinch are not hijacked, hint "Wischen zum Blättern" visible.
- [ ] `/gallery.html?folder=..%2F..` shows "Ordner nicht gefunden." with link
      "Zu Bilder"; `/api/gallery?folder=../..` returns 404 JSON.
- [ ] Freshness (temp `MEDIA_ROOT`): copy a JPEG into a subfolder → visible
      after reload within the P2 freshness bound, thumbnail served afterwards;
      delete it → gone after the next scan.
- [ ] Large folder (temp `MEDIA_ROOT`, 2,000 copies of a fixture): first tiles
      appear promptly, more render on scroll, lightbox counter shows `1 / 2000`.
- [ ] Keyboard only: every tile, breadcrumb link and lightbox control reachable
      with a visible 2 px `primary` focus outline; touch targets ≥ 44 px.
- [ ] Optional on the target host (Pi 4): RSS stays < 100 MB after the initial
      sync and while browsing a 1,000-image folder.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| P2's scanner exposes no completion hook → P5 (tags) and P6 (EXIF) both add one to `scanner.js` in parallel. | Flagged to the orchestrator; preferred fix is a generic post-scan hook in the P2 spec. Fallback: P6's addition is minimal and additive; whichever lands second rebases onto the first. |
| Migration 005 may be applied on a DB before 003/004 exist (P4/P6 parallel). | 005 depends only on 002; P1's runner must apply any unapplied migration in ascending order, not only numbers above the max (flagged to P1). |
| Embedded thumbnails are small (often 160×120) → soft tiles on HiDPI screens; some cameras pad them with black bars. | Accepted trade-off of the prior-art decision (no server resize); `object-fit: cover` crops most padding; the lightbox always shows the original. |
| Thumbnail orientation mismatches when an editor rotated pixels but left a stale thumbnail/tag. | Rare; the original in the lightbox is correct; no mitigation beyond documenting it. |
| iPhone households store HEIC → many "Nicht anzeigbar" tiles. | README note (issue acceptance): set iOS camera to "Maximale Kompatibilität" or export as JPEG; transcoding stays out of scope. |
| Folders of PNG screenshots without thumbnails → heavy downloads and decode memory on phones/TVs. | `loading="lazy"`, `decoding="async"`, 120-tile batches; originals only fetched when near the viewport. |
| Initial backfill of a large library competes with streaming on a Pi HDD. | Sequential single-reader sync with a reused 128 KiB buffer; runs once per changed file. |
| Malicious or corrupt JPEG headers crash or hang the parser. | Bounds checks on every read, cycle guard, entry cap, truncation/garbage tests; parser returns `null` fields instead of throwing; sync catches per-file errors. |
| A file is edited between scans → stored thumbnail offset is stale. | Thumb route compares current size/mtime with `source_*` and returns 404; client falls back to the original via `onerror`. |
| `routes.js` / nav module edited by P4/P5 in parallel → merge conflicts. | Additive one-line changes only; trivial rebase. |

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
  original when no thumbnail exists) plus a client `onerror` safety net —
  avoids a 404 round-trip per EXIF-less image.
- 2026-09-26: Thumbnail orientation fixed client-side by CSS transforms; the
  server never rewrites image bytes (read-only, no re-encoding).
- 2026-09-26: Capture date kept as timezone-less wall-clock text and formatted
  by string slicing — avoids TZ shifts between server and clients.
- 2026-09-26: Chronological (oldest-first) item order and natural folder order
  settled as album convention; not asked at the gate.
- 2026-09-26: SVG excluded from the index (same-origin script risk via
  `/media/:id`); HEIC/TIFF/JXL/RAW listed as not displayable (no transcoding).
- 2026-09-26: Own tile markup instead of P2's shared media card — P4 edits that
  card in parallel.
- 2026-09-26: exifr/exif-parser not cloned — the EXIF 2.3/TIFF layout is a
  published standard and no decision depended on their internals.
