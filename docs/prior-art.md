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

## Challenge summary (roadmap: Konvertieren, 2026-09-28)

- **Existence:** Plex (Optimized Versions), Tdarr, Unmanic and a community
  Jellyfin plugin all pre-convert media for easier playback. The need is real
  and the pattern is established. What none of them offers is a conversion that
  never touches the source folder and plugs into a zero-dependency, single-login
  resume store.
- **USP:** one optional button per unplayable item. The household's own external
  converter runs one job at a time in a separate child process, the result lives
  only under `DATA_DIR`, and it plays under the same item id, so progress and
  "Weiterschauen" keep working. Without converter config the app behaves exactly
  as today.
- **Differentiation/non-goals:** no live transcoding, no automatic library-wide
  optimisation, no version picker, no in-place replacement (Tdarr, plugin
  "replace" policy), no copies inside the media folder (Plex "Plex Versions"), no
  hardware-encoder dependency (Jellyfin deprecated Pi V4L2, Pi 5 has no encoder).
- **Idea harvest:** ADOPT separate output storage, a transparent "same item,
  other file" choice, explicit failed state with manual retry (Unmanic), a
  one-job-at-a-time queue (parallel 1080p encodes gain little on a Pi 4), spawn
  via argv without a shell plus process-group kill, idle CPU/IO priority. AVOID
  write-back into the library, immediate cascade delete on source removal
  (Plex), non-terminal states with no recovery (Tdarr #388), and trusting the
  converter's "converted" without our own codec sniff (converter v3.1.0 remuxes
  HEVC/AC3 "successfully").

## On-demand browser-safe copies (Phase 7)

Foundation impact: vision — vision.md:71 moves "Transcoding or remuxing of any kind" from Out to an optional In item (on-demand conversion via an external converter, off without config), vision.md:58-59 narrows "files are never copied, moved or modified" to the sources under MEDIA_ROOT (derived copies live under DATA_DIR), vision.md:62-63 lets not-playable items be converted when a converter is configured, vision.md:36 USP notes the optional external converter process; constitution — constitution.md:20 adds `CONVERTER_CMD` and `CONVERT_DIR` to the config list, constitution.md:26 allows `CONVERT_DIR` as the second containment root, constitution.md:55 becomes "child processes only for the configured converter, argv without shell, one at a time", constitution.md:29 classifies conversion state and files (derivable but expensive vs. non-derivable); architecture — component map gains a conversion queue component and converted-path resolution in the path guard (architecture.md:18 and architecture.md:49), architecture.md:54 data split gains `DATA_DIR/converted/`, architecture.md:61 Stream flow serves the converted variant when present, a new key flow "Convert" (button → queue → spawn → verify via `mp4-codec.js` sniff → playable), architecture.md:76 new config values

### Plex Media Server — Optimized Versions

- Path: support article "Creating Optimized Versions" (213095317) / "Optimized Versions" (213097057); forum thread 561225
- License: Proprietary
- Verdict: reference-only — product behaviour, no code
- Date: 2026-09-28
- Notes:
  - ADOPT: the optimized copy is a second version of the same library item, and the player picks it transparently. Plexopedia: the server "will select the best quality video that best meets the selected streaming quality for the client". We take the "same item, different file" model: the converted file is served under the unchanged item id, with no version picker.
  - AVOID: default storage in a "Plex Versions" folder inside the source's media folder (search-result excerpt of the Plex support page). Under our constitution that is forbidden because MEDIA_ROOT is read-only. Converted files go only under `DATA_DIR`.
  - AVOID: deleting the original deletes the optimized version at once, even when the user picked "original only" (users report this on the forum, with no staff reply). For videothek, a vanished source must not remove its conversion right away, because root safety and kept progress rows expect that items can reappear. Cleanup happens later with a grace period (Phase 8).
  - Uncertainty: support.plex.tv answers 403 to direct fetches. The storage options come from a search-result excerpt only. Queue semantics (concurrency, reordering) are not verified.
  - Source: https://support.plex.tv/articles/213095317-creating-optimized-versions/ , https://www.plexopedia.com/plex-media-server/general/optimized-versions/ , https://forums.plex.tv/t/deleting-the-original-movie-also-deletes-optimized-version-why/561225

### mugurc/jellyfin-plugin-pre-transcode

- Path: README (output policies, control center)
- License: GPL-3.0
- Verdict: reference-only — copyleft C# plugin, and the policy list is the useful part
- Date: 2026-09-28
- Notes:
  - ADOPT: the default policy "writes the result to a chosen output directory … leaving originals untouched". The status panel shows what is encoding now, the next jobs and the last finished jobs.
  - AVOID: the "replace in place" policy ("replaces the original (deleting it if the container/extension changed)"). It breaks the read-only MEDIA_ROOT rule. Also avoid the "alternate version + version selector" model: it is more UI than we need.
  - Uncertainty: the repo is small (6 stars) and was last pushed 2026-09-27. It shows the pattern works but is not evidence of maturity. Jellyfin core has no pre-transcode feature (feature request #10 exists, but its status could not be read).
  - Source: https://github.com/mugurc/jellyfin-plugin-pre-transcode , https://features.jellyfin.org/posts/10/optimize-media-pre-transcode-like-plex

## Conversion job queue and states (Phase 7)

### Unmanic/unmanic

- Path: docs `dashboard/pending_tasks`, `dashboard/completed_tasks`
- License: GPL-3.0
- Verdict: reference-only — the Python multi-worker plugin pipeline is far larger than our need, but its task-state rules fit
- Date: 2026-09-28
- Notes:
  - ADOPT: an explicit pending → processing → completed/failed lifecycle. A failed task stays failed: "Tasks that are listed in the completed tasks list as Failed will be ignored in all future Library Scans", and the user re-queues it by hand. This becomes our queued/converting/playable/failed states plus an explicit retry, with no automatic retry loop.
  - ADOPT: a per-job log kept for diagnosis ("a full log of the commands that were run"). For us that is a short error field per conversion row.
  - AVOID: the multi-worker pool, the plugin chain, and manual reordering of the queue. A queue that runs one job at a time needs none of them.
  - Uncertainty: the docs do not say how a worker crash in the middle of a job is recovered.
  - Source: https://docs.unmanic.app/docs/dashboard/pending_tasks/ , https://docs.unmanic.app/docs/dashboard/completed_tasks/

### HaveAGitGat/Tdarr

- Path: docs `library-setup/transcode-cache`, `nodes/workers`; issue #388
- License: Other (non-OSI, per GitHub license metadata)
- Verdict: reference-only — counter-example for storage, input for scheduling
- Date: 2026-09-28
- Notes:
  - ADOPT: write into a separate staging location first and publish only a finished file.
  - AVOID: "Files will be transcoded into the transcode cache folder and then copied back into your source library, replacing the original file". This is the opposite of our read-only MEDIA_ROOT rule.
  - AVOID: jobs stuck in the staging stage with no readable error (issue #388: about 100 of 10,000 files, info dialog blank). Every non-terminal state needs a defined recovery at startup.
  - ADOPT (input for Phase 8): workers "will not process items unless they are within the scheduled times set in the library settings". A time window is one way to protect playback.
  - Uncertainty: the claim that cross-filesystem (EXDEV) move failures cause stuck files was not confirmed in #388. #910 and #1133 were not opened.
  - Source: https://docs.tdarr.io/docs/library-setup/transcode-cache/ , https://docs.tdarr.io/docs/nodes/workers/ , https://github.com/HaveAGitGat/Tdarr/issues/388

## Converter child-process supervision (Phase 7)

### Node.js `node:child_process`

- Path: https://nodejs.org/api/child_process.html (`spawn`, `options.detached`, `subprocess.kill`)
- License: MIT (Node.js)
- Verdict: reuse — a built-in, so zero dependencies
- Date: 2026-09-28
- Notes:
  - ADOPT: `spawn(cmd, args)` keeps its documented default `shell: false` (no shell). The docs warn: "If the `shell` option is enabled, do not pass unsanitized user input … shell metacharacters may be used to trigger arbitrary command execution." Item paths therefore go into argv only.
  - ADOPT: on POSIX, `detached: true` makes the child "the leader of a new process group and session". The process group can then be signalled as a whole, so a Python converter's ffmpeg grandchild is stopped too. The docs note that on Linux, child processes of child processes are not terminated by `subprocess.kill()`.
  - AVOID: `unref()` on the converter child. The queue must observe the exit. Also avoid Windows assumptions: there `detached` only gives the child its own console and creates no process group, so the dev machine needs a fallback kill path.
  - Uncertainty: the Node docs do not document `process.kill(-pid)` for group kill. That behaviour is POSIX `kill(2)` semantics and is not covered on the Node page itself.
  - Source: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options

## External converter contract (Phase 8)

Foundation impact: vision — vision.md:52-53 Pi criterion extended so two concurrent 1080p direct-play streams stay stutter-free while one conversion runs; constitution — constitution.md:55 (as amended in Phase 7) adds the minimum converter contract (JSON Lines fields, exit codes 0/1/2/130) and the rule that the converter runs at lowest CPU/IO priority, constitution.md:25 and constitution.md:54 restated so cleanup deletes only under `CONVERT_DIR`; architecture — the Convert flow gains the adapter, outcome mapping and cancel steps, architecture.md:62 Scan flow hooks stale-conversion cleanup via `onScanComplete` and respects root safety, architecture.md:10 entry-point graceful shutdown stops the converter process group

### bhemsen/converter (v3.1.0)

- Path: https://github.com/bhemsen/converter (release v3.1.0, 2026-09-28); `converter/profiles.py`, `batch.py`, `jobs.py`, `cli.py`, `ffmpegtool.py`, `paths.py`
- License: MIT
- Verdict: reuse — as an external process only (Python + ffmpeg, never imported). v3.1.0 is not sufficient; a follow-up release is a hard dependency.
- Date: 2026-09-28
- Notes:
  - ADOPT (already in v3.1.0): single-file mode `converter --to FMT FILE OUTPUT_DIR` (`paths.py:104-120`, `cli.py:202-217`). OUTPUT must be a directory, otherwise exit 2 (`cli.py:220-240`). The output path is predictable, `OUTPUT/<source stem>.<target ext>` (`paths.py:91-101`, `124-136`). The source is only ever an `-i` input (`ffmpegtool.py:135-143`).
  - ADOPT (usage rule): one fresh, empty output directory per job. Two calls with the same file name into one directory give `SKIPPED` with exit 0 (`batch.py:140-147`).
  - AVOID (gap 1, browser safety): `--to mp4` first tries a blind `-c copy` (`profiles.py:549-552`, `jobs.py:578-580`). Its copy list includes hevc, mpeg4, mpeg2video, ac3, eac3 and alac (`profiles.py:134-135`). HEVC and h264+AC3 therefore end up "converted" but still not playable (`README.md:199-202`). `--to webm` is browser-safe but re-encodes everything except VP8/VP9/AV1 to VP9 (`profiles.py:892-926`). Needed: `--to web`, probe-first, copying only h264 8-bit/vp9/av1 + aac/mp3/opus/flac.
  - AVOID (gap 2, machine-readable results): there is no `--json`. Results are text only (`batch.py:306-313`, `cli.py:416-417`), and exit 0 also covers skipped and unsupported (`batch.py:142-147`, `178-181`, `331-335`). Needed: JSON Lines with source, output, outcome (converted|skipped|failed|unsupported), notes, error.
  - AVOID (gap 3, robustness when killed): the package has no signal handling. `subprocess.run` runs without its own process group (`ffmpegtool.py:146-157`). ffmpeg writes straight to the target with `-y` (`ffmpegtool.py:135-143`). Cleanup happens only on errors (`batch.py:71-76`). After SIGTERM, ffmpeg keeps running and a truncated file stays behind, which a later run then skips with exit 0. Needed: write to `.partial`, rename atomically, and clean up on SIGTERM/SIGINT.
  - ADOPT: videothek verifies every result with its own sniffer (`src/library/tags/mp4-codec.js:188`, `src/library/parsers/compat.js:150-173`) and does not rely only on the converter's outcome.
  - Uncertainty: the file:line evidence comes from the 2026-09-28 source read (converter-gap-v3.1 analysis) and was not re-read for this entry. The sniffer does not read the `esds` object type, so DTS/MP2 in MP4 and 10-bit h264 could be falsely marked playable. The re-encode cost (`libx264 -crf 18`, default preset, `profiles.py:559-564`) has not been measured on a Pi 4.

## Converting on weak hardware without hurting playback (Phase 8)

### Will Usher — "Hardware Accelerated Video Encoding on the Raspberry Pi 4"

- Path: blog post, 2020-11-15 (FBED script)
- License: n/a (blog post)
- Verdict: reference-only — measurements that size the problem
- Date: 2026-09-28
- Notes:
  - ADOPT: the order of magnitude on a Pi 4 at 1080p: `h264_v4l2m2m` reached "53-60 FPS" and `libx264` "8-10 FPS". Correct `h264_v4l2m2m` output needs FFmpeg ≥ 4.3. The script uses fixed bitrates (8 Mbps at ≥1080p) rather than CRF.
  - AVOID: parallel conversions. The author "didn't observe much overall speed-up running two 1080p encodes in parallel", which supports running one job at a time.
  - Uncertainty: the libx264 preset used, and behaviour under concurrent streaming load, are not stated. The measurements are from 2020 with an FFmpeg of that time.
  - Source: https://www.willusher.io/general/2020/11/15/hw-accel-encoding-rpi4/

### Jellyfin — Hardware Acceleration docs (Raspberry Pi status)

- Path: docs `general/post-install/transcoding/hardware-acceleration`; Raspberry Pi forum t=378329
- License: n/a (documentation)
- Verdict: reference-only — a warning against relying on the Pi hardware encoder
- Date: 2026-09-28
- Notes:
  - AVOID: making the V4L2 hardware encoder a requirement. Jellyfin deprecated Pi V4L2 support: it "may continue to work for now, future updates to the Linux kernel or FFmpeg could break this support". The Pi 5 "lacks hardware encoders entirely". A Raspberry Pi engineer confirms: "There is no hardware H264 or H265 encoder on Pi5."
  - ADOPT: treat the hardware encoder at most as an optional converter preset. The fallback is software encoding, and that has to be affordable because the queue runs at low priority and needs no deadline.
  - Source: https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/ , https://forums.raspberrypi.com/viewtopic.php?t=378329

### util-linux `ionice`

- Path: man page `ionice(1)`
- License: GPL-2.0-or-later (util-linux)
- Verdict: reference-only — an OS mechanism, applied only to the converter process
- Date: 2026-09-28
- Notes:
  - ADOPT: the idle I/O class: "A program running with idle I/O priority will only get disk time when no other program has asked for disk I/O for a defined grace period." Pair it with the lowest CPU priority (`nice 19`, or `os.setPriority(pid, 19)` from `node:os` without an extra process).
  - AVOID: a `cpulimit`-style hard cap as the first step. Priorities are simpler, and whether they are enough is measured on the Pi.
  - Uncertainty: whether idle class is honoured depends on the active I/O scheduler (the page mentions CFQ only). There is no measurement of stutter on a Pi 4 with USB disk and idle-class conversion running.
  - Source: https://man7.org/linux/man-pages/man1/ionice.1.html
