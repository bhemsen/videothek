# Prior Art

> Descriptive, living document. Indexed BY CONCERN, not by project. Add
> entries whenever new references surface; gaps are fine.
>
> Tag each concern header with the one roadmap phase it feeds: `(Phase N)` for a
> roadmap P-number or `(feature: <slug>)` for a Features-table row (one tag, not
> both) — so `/loopkit:plan` can resolve "prior art for phase N" deterministically.

## Challenge summary (inception, 2026-09-26)

- **Existence:** Jellyfin (video) + Navidrome (music) + Audiobookshelf (audiobooks)
  together cover every category except images. Feature-wise this project is
  optional; the gap is operational — three services, three databases, three logins.
- **USP:** one process, zero runtime npm dependencies, all five media categories
  behind one login and one resume store — tuned to run indefinitely on the weakest
  hardware in the house.
- **Differentiation:** no transcoding, no online metadata scraping, no fine-grained
  permissions, no native apps.

## HTTP range streaming (Phase 3)

### pillarjs/send

- Path: `index.js` (range parsing, 206 response, `Content-Range`, stream offsets)
- License: MIT
- Verdict: reference-only — the pattern is ~40 lines; importing the package violates the zero-dependency rule
- Date: 2026-09-26
- Notes:
  - ADOPT: parse `Range: bytes=start-end`, clamp to file size, respond `206` with `Content-Range: bytes start-end/size` and `Accept-Ranges: bytes`, pass `{start, end}` to `fs.createReadStream`; unsatisfiable range -> `416`.
  - AVOID: the npm package itself; ETag/conditional-GET machinery beyond what browsers need for media seeking.
  - Source: https://github.com/pillarjs/send/blob/master/index.js , https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/206

### nginx `send_timeout`

- Path: `ngx_http_core_module` directive `send_timeout`
- License: BSD-2-Clause
- Verdict: reference-only — a configuration default, adopted as a behaviour
- Date: 2026-09-26
- Notes:
  - ADOPT: an idle timeout of 60 s measured between two successive writes (not over the whole response); a client that receives nothing for that long is disconnected, releasing the file descriptor of a paused or sleeping player.
  - AVOID: socket-level timeouts that would also cut keep-alive connections.
  - Source: https://nginx.org/en/docs/http/ngx_http_core_module.html#send_timeout

## Subtitle sidecars (Phase 3)

### jellyfin/jellyfin (external subtitles)

- Path: docs `jellyfin.org/docs/general/server/media/movies`, section "External Subtitles and Audio Tracks"
- License: GPL-2.0-only (docs describe a naming convention only)
- Verdict: reference-only — adopt the naming convention, not the code
- Date: 2026-09-26
- Notes:
  - ADOPT: subtitle files next to the video named `<video name>.<ext>` or `<video name>.<lang>.<ext>` (e.g. `Film.en.srt`), discovered by base-name match in the video's folder.
  - AVOID: flag suffixes (`default`, `forced`, `sdh`, `cc`, `hi`) and non-WebVTT formats (`.srt`, `.ass`) — they need parsing or conversion; v1 serves `.vtt` byte-for-byte to the browser's native `<track>` menu.
  - Source: https://jellyfin.org/docs/general/server/media/movies/

## Direct-play compatibility detection (Phase 2)

### Browser codec support (MDN / chromestatus)

- Path: n/a (platform documentation)
- License: n/a
- Verdict: reference-only — defines the static compatibility table
- Date: 2026-09-26
- Notes:
  - ADOPT: static extension/container lookup table. Always direct-playable: MP4 (H.264/AAC), WebM (VP9/Opus), MP3, M4A/AAC, FLAC, Ogg/Opus.
  - AVOID: MKV (no browser supports it as `<video>` src) and HEVC (OS/hardware-dependent in Chrome/Firefox) — flag as incompatible in v1; no client-side capability probe.
  - Uncertainty: Firefox HEVC version numbers (134/136/137) come from a single aggregator source, unverified.
  - Source: https://webcodecsfundamentals.org/codecs/hevc.html , https://chromestatus.com/feature/5153479456456704

## Library model and naming conventions (Phase 2)

### jellyfin/jellyfin

- Path: `Emby.Naming/Common/NamingOptions.cs`; docs `jellyfin.org/docs/general/server/media/{movies,shows}`
- License: GPL-2.0-only
- Verdict: reference-only — copyleft C#; adopt the convention, not the code
- Date: 2026-09-26
- Notes:
  - ADOPT: `Title (Year)/Title (Year).ext` for movies; `Series/Season 01/Series S01E02 - Title.ext` (zero-padded), specials in `Season 00`; a small in-house regex set.
  - AVOID: metadata-provider machinery and online lookups.
  - Source: https://jellyfin.org/docs/general/server/media/movies/

## Detecting new files without restart (Phase 2)

### jellyfin/jellyfin (LibraryMonitor) and navidrome/navidrome (scanner watcher)

- Path: jellyfin `Emby.Server.Implementations/IO/LibraryMonitor.cs`; navidrome scanner watcher (`ND_SCANNER_WATCHERWAIT`, `ND_SCANNER_SCHEDULE`)
- License: GPL-2.0-only / GPL-3.0-only
- Verdict: reference-only — failure modes are the lesson
- Date: 2026-09-26
- Notes:
  - ADOPT: `fs.watch(root, {recursive: true})` as a debounced fast path (Navidrome default 5 s) PLUS an always-on periodic full rescan as the correctness backstop.
  - AVOID: watcher as sole mechanism — USB/NTFS/exFAT/SMB mounts drop events, inotify `max_user_watches` exhaustion silently stops watching (jellyfin#16874, #10012); never stop watching permanently after an error.
  - Uncertainty: exact Node version that added recursive `fs.watch` on Linux not cross-checked; verify on the pinned Node 24.
  - Source: https://github.com/jellyfin/jellyfin/issues/16874 , https://github.com/navidrome/navidrome/discussions/4021

## Minimal auth, sessions and embedded DB (Phase 1)

### Node built-ins (`node:crypto` scrypt, `node:sqlite`)

- Path: https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback , https://nodejs.org/api/sqlite.html
- License: MIT (Node.js)
- Verdict: reuse — built-ins, zero dependencies
- Date: 2026-09-26
- Notes:
  - ADOPT: scrypt (N=2^14, r=8, p=1, random 16-byte salt) with `timingSafeEqual`; opaque random session id in an `HttpOnly; SameSite=Lax` cookie, session rows in SQLite; `DatabaseSync` from `node:sqlite`.
  - AVOID: JWTs, OAuth, self-registration.
  - Verified locally: Node 24.18.1 loads `node:sqlite` without a flag (SQLite 3.53.1). API is still marked Release Candidate (stability 1.2) — accepted risk.

## Playback progress and resume (Phase 4)

### advplyr/audiobookshelf

- Path: `server/objects/user/MediaProgress.js`; SQLite table `mediaProgresses`
- License: GPL-3.0-only
- Verdict: reference-only — the data model is the value
- Date: 2026-09-26
- Notes:
  - ADOPT: one row per (user, media item): `position_seconds`, `duration_seconds`, `finished`, `updated_at`; client reports periodically during playback plus on pause/end/page hide; last write wins.
  - AVOID: dual ebook/audio tracking and multi-device conflict resolution.
  - Uncertainty: audiobookshelf's actual sync interval not read from source; our ~10 s interval is an assumption.

## Music and audiobook tag reading (Phase 5)

### navidrome/navidrome

- Path: `model/metadata/metadata.go`, `model/metadata/map_mediafile.go`, `resources/mappings.yaml`
- License: GPL-3.0-only
- Verdict: reference-only — Go/copyleft; architecture instructive
- Date: 2026-09-26
- Notes:
  - ADOPT: one central tag->field mapping table (ID3v2 / Vorbis comment / MP4 atoms); fast scan pass separated from deeper analysis; in-house minimal ID3v2 + FLAC parsers.
  - AVOID: full tag coverage, multi-artist/role modelling, ReplayGain etc.
  - Source: https://deepwiki.com/navidrome/navidrome/6.3-metadata-extraction-and-tag-parsing

## Audio artwork resolution (Phase 5)

### navidrome/navidrome (artwork)

- Path: docs `usage/library/artwork`; config option `CoverArtPriority`
- License: GPL-3.0-only
- Verdict: reference-only — adopt the lookup order, not the code
- Date: 2026-09-26
- Notes:
  - ADOPT: default `CoverArtPriority` = `cover.*, folder.*, front.*, embedded, external` — folder images in the album directory before the embedded picture, resolved on demand per request.
  - AVOID: the `external` step (online lookups — constitution: no outbound calls); server-side artwork resizing and caching.
  - Uncertainty: order taken from the documentation, not read from source.
  - Source: https://www.navidrome.org/docs/usage/library/artwork/

## Audiobook directory structure (Phase 5)

### advplyr/audiobookshelf (book library scanner)

- Path: docs `documentation/libraries/book-library/directory-structure`; guide `guides/book-scanner`
- License: GPL-3.0-only
- Verdict: reference-only — folder convention adopted
- Date: 2026-09-26
- Notes:
  - ADOPT: `{Author}/{Book}` and `{Author}/{Series}/{Book}` directories; single-file books allowed; disc subfolders named `CD`/`Disc`/`Disk` + number; files ordered by disc, then track.
  - AVOID: its default metadata precedence (tags over folder names) — our grouping requires curated Author/Book folders; series modelling; OPF/NFO sidecar metadata.
  - Source: https://audiobookshelf.org/docs/documentation/libraries/book-library/directory-structure/ , https://www.audiobookshelf.org/guides/book-scanner/

## Image thumbnails without native dependencies (Phase 6)

### exifr / exif-parser (npm)

- Path: https://www.npmjs.com/package/exifr , https://www.npmjs.com/package/exif-parser
- License: MIT
- Verdict: reference-only — algorithm hand-rolled to keep zero deps
- Date: 2026-09-26
- Notes:
  - ADOPT: extract the embedded JPEG thumbnail from EXIF IFD1 via buffer parsing; fallback: original with `loading="lazy"` and browser downscaling; no server-side decode/resize.
  - AVOID: sharp, libvips, Immich, PhotoPrism — native builds or ML pipelines, unfit for Pi and zero-dep.
