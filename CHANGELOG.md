# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-28

The start page now shows more than "Weiterschauen": what you were listening to, and what was recently added to each category.

### Added

- **"Weiterhören" on the start page:** a row below "Weiterschauen".
  - It lists every audiobook in progress with its chapter and remaining time. A book whose current chapter is finished shows the next one.
  - It also shows the latest unfinished music track.
  - Cards link into the audio section, where one click resumes playback.
  - Backed by the new `GET /api/home/listening`.
- **Category previews on the start page:** one section each for Filme, Serien, Musik, Hörbücher and Bilder.
  - Each section shows the count, the ten most recently added entries (folders for Bilder) and an "Alle anzeigen" link.
  - Empty categories are hidden.
  - Backed by the new `GET /api/home/previews`. Its queries are limited, so the start page never loads a whole library.

### Changed

- The start page's "Willkommen" message appears only when every row has loaded and all are empty. It no longer flashes briefly while the page loads.

### Known limitations

- The new start-page rows were checked in Chromium (headless Edge) only. The Firefox check is still open, as it is for the earlier phases.

## [0.1.0] - 2026-09-28

First release: one dependency-free Node.js 24 process that makes movies, series, music,
audiobooks and pictures on `MEDIA_ROOT` browsable and playable in the browser, with per-user
resume across devices.

### Added

- **Foundation & accounts (Phase 1)** — environment config loader (`MEDIA_ROOT`, `DATA_DIR`,
  `PORT`, `HOST`, `RESCAN_INTERVAL_MIN`, `ADMIN_USER`, `ADMIN_PASSWORD`), JSON-line logger with
  secret redaction, `node:sqlite` database with numbered migrations, in-house router with
  security headers, same-origin check and static/page serving, scrypt password hashing with
  login throttling, opaque session cookies, admin bootstrap on first start, login/logout,
  user administration API and "Benutzerverwaltung" page, app shell with category navigation,
  offline `npm run reset-password` command, `/healthz`.
- **Library index: movies & series (Phase 2)** — scanner over `MEDIA_ROOT` (full/subtree scan,
  path reconcile, root safety so an unmounted disk never wipes the index), serialised scan queue,
  change detection (per-directory watches on Linux, recursive elsewhere) plus periodic rescan,
  movie/series filename parsers, direct-play compatibility table with MP4 codec sniffing,
  browse API, "Filme" and "Serien" pages with series detail.
- **Video streaming & player (Phase 3)** — `MEDIA_ROOT` path guard, HTTP Range streaming
  (206/416) for `/media/:id`, WebVTT subtitle sidecars, item detail with next episode,
  player page `/player?id=` with keyboard shortcuts, retry and error states.
- **Progress & resume (Phase 4)** — per-user progress API, auto-resume with toast on the player,
  "Weiterschauen" row on the start page (incl. next episode), progress bars and "Gesehen" badges.
- **Music & audiobooks (Phase 5)** — ID3v2.3/2.4 and FLAC tag readers, MPEG duration, folder
  conventions, music and audiobook APIs with derived book resume, cover art route, audio
  section with persistent player bar, queue and Media Session, "Musik" overview and album
  views, "Hörbücher" grid and book views.
- **Image gallery (Phase 6)** — EXIF reader with embedded thumbnails, image metadata sync,
  gallery API and `/images` folder view, lightbox with inline video and browser-history
  integration.

### Fixed

- UI fidelity to the mockups found by automated milestone QA and post-merge audits: category
  nav spacing and its overlap with the account menu at 768–900 px, account menu width and icon
  size, admin mobile card labels, page heading and empty-state typography, Filme header on phones, series
  detail layout, episode title alignment, player error panel icon and mobile spacing, audiobook
  view headings and cards, mobile audio player bar position.
- Lightbox keyboard focus at the first/last item and Back after reloading a `#bild-` link.
- Cover images in the audio section are shown whole instead of cropped.
- Path guard rejects NTFS alternate-data-stream selectors on Windows.
- Guarded rollback in the image-metadata repository; spurious `request_error` logs for completed
  static responses.

### Known limitations

- Automated milestone QA has not yet run for Phase 4 (progress & resume) and Phase 6 (image
  gallery); human checks are still open for all phases: Firefox, touch devices/iOS Safari,
  Raspberry Pi 4 memory budget (< 100 MB idle RSS, two 1080p streams), real media codecs, and
  graceful shutdown on Linux.
- No transcoding: formats the browser cannot play are listed as "Nicht abspielbar" (images as
  "Nicht anzeigbar"). Converting them is out of scope for this release; it may come in a later
  phase.
- Very long usernames can push the desktop header into horizontal scrolling (#201).
- Pages are served in German only.

[Unreleased]: https://github.com/bhemsen/videothek/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/bhemsen/videothek/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/bhemsen/videothek/releases/tag/v0.1.0
