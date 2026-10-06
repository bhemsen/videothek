# Vision

> Normative. What and why only — no implementation detail. Keep to ~1 page;
> this file is permanently loaded via CLAUDE.md. No status marker — foundation
> docs carry none.

## Problem

A household keeps its movies, series, music, audiobooks and pictures on a disk
attached to a small always-on machine. Using them from a laptop, phone or TV
browser today means copying files around or running several heavyweight media
servers, each with its own login, database and resource appetite. Stopping a
movie on one device and continuing it on another is not possible.

## Why now

The disk and the always-on host already exist; the platform now offers
everything needed (HTTP, embedded database, hashing) built in, so a single
lightweight service is feasible without a dependency tree to maintain.

## Target users

- Primary: members of one household (a handful of accounts) using a browser on
  laptop, phone, tablet or TV.
- Secondary: the household admin who hosts the service and manages accounts.

## Goal

One small, self-hosted web application that makes every media file on the
configured storage path browsable and playable in the browser — movies, series,
music, audiobooks and images — and remembers per user where playback stopped,
so anyone can pick up on any device exactly where they left off.

## USP / differentiation

A single process with no runtime package dependencies that covers all five
categories behind one login and one resume store, built to run indefinitely on
the weakest hardware in the house. Files the browser cannot play can optionally
be handed to the household's own external converter, which runs as a separate
process; the app itself never transcodes. Jellyfin, Navidrome and Audiobookshelf
together offer more features but as three separate services; this project trades
feature breadth for one minimal footprint. Evidence and per-reference ADOPT/AVOID
harvest: `docs/prior-art.md`.

## Success criteria

- Resume: a video or audio item stopped on device A resumes on device B within
  ±10 s of the stop position.
- Freshness: a file copied onto the storage path appears in the library without
  a restart or manual import — within 10 s when change detection works, and at
  the latest after the periodic rescan interval (default 15 min).
- Weak hardware: on a Raspberry Pi 4 (4 GB) the service idles below 100 MB RSS
  and serves two concurrent 1080p direct-play streams without stutter, also
  while one conversion runs.
- Footprint: zero runtime dependencies in `package.json`.

## Scope

### In

- Media root read directly from a path configured via environment variable;
  nothing under it is ever written, moved or modified. Derived copies (converted
  files) live outside it, by default under the app's data directory.
- Categories: movies, series (season/episode grouping), music (artist/album),
  audiobooks (chapters/files per book), images (folder gallery).
- In-browser playback/viewing of browser-compatible formats; incompatible files
  are listed and clearly marked as not playable.
- Optional, on demand: when an external converter is configured, the admin can
  convert a not-playable video or audio item into a browser-playable copy. The
  copy plays under the same item and keeps its resume position. Without a
  converter this option does not exist.
- Accounts created by an admin; login; per-user playback progress and
  "continue watching/listening".
- Automatic library refresh when files are added, changed or removed.
- LAN operation; deployable behind a reverse proxy that terminates HTTPS.

### Out

- Live transcoding while streaming, automatic or library-wide conversion, and
  any conversion inside the app process itself.
- Online metadata, posters or artwork lookups.
- Uploading, editing or deleting media through the app.
- Self-registration, roles beyond admin/user, per-item permissions.
- Native mobile/TV apps, DLNA/Chromecast casting, offline downloads.

## Non-goals

- Feature parity with Jellyfin/Plex — the value is minimal footprint, not breadth.
- Built-in HTTPS/certificate handling — a reverse proxy does this better.
- Multi-server or cloud storage — one host, one attached disk.
- Social features (sharing, ratings, recommendations) — household use only.
