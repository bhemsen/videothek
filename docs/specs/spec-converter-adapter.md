# Spec: Converter adapter & Pi protection (Phase 8)

> Created: 2026-10-06

Replaces Phase 7's minimum converter contract with the real `bhemsen/converter`
(v3.2.0+, sidecars from v3.3.0) contract, runs the converter as its own process
group at the lowest CPU priority, lets the admin cancel queued and running
conversions, publishes the converter's WebVTT subtitle sidecars with the copy,
and cleans up stale, vanished and orphaned copies under `CONVERT_DIR`. This spec
carries no lifecycle state — acceptance is the spec merged on the default branch
with a milestone and issues, and all progress lives in the GitHub issues and
milestone. A completed spec is moved to `docs/specs/archive/`.

Builds on `docs/specs/archive/spec-conversion-core.md` (Phase 7, cited below as
"P7"). Everything P7 decided stays in force unless a section here replaces it
explicitly.

## Outcome

- [ ] With `CONVERTER_CMD` pointing at an installed `bhemsen/converter` v3.3.0,
      pressing "Konvertieren" on an HEVC/AC3 MKV yields a playable H.264/AAC
      copy under the same item id; the run's real JSON Lines output (`file`
      record + `summary` record, `schema: 1`) is interpreted without
      `converter_output_invalid`.
- [ ] Text subtitle streams of a converted source (SRT/ASS/mov_text inside the
      MKV) are selectable in the player after conversion, in addition to any
      `.vtt` sidecars next to the source.
- [ ] On Linux the converter and its ffmpeg children run in their own process
      group at nice 19; every signal videothek sends (graceful stop, its
      `SIGKILL` escalation, the stdout-cap kill, cancel) reaches the whole
      group, so no ffmpeg survives a stop or cancel.
- [ ] The admin can cancel a queued conversion (immediately `failed`
      `cancelled`) and a running one (process group terminated, then `failed`
      `cancelled`) from the "Konvertierung" panel; a cancelled item can be
      converted again with the existing retry button.
- [ ] Cleanup removes, only under `CONVERT_DIR`: copies whose source changed
      (stale), leftover copy files of `failed` rows, copies of sources that
      have been absent from the library for more than 30 days, and directories
      no conversion row references. A fresh row whose copy file was removed
      outside videothek is reconciled: row deleted and the item's `playable`
      flag reset (closes P7 O2 (a)).
- [ ] On a Raspberry Pi 4 two concurrent 1080p direct-play streams play
      without stutter while one conversion runs (vision success criterion, as
      amended by this spec).
- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- **Adapter:** record validation and run interpretation for the converter's
  real `--json` output (record `type`/`schema`, `file` + `summary` records,
  `attempt`, `sidecars`, exit 143), replacing P7's "exactly one record, no
  type" minimum. The stub converter (`test/helpers/converter-stub.js`) is
  upgraded to emit the real shape.
- **Process group + priority:** POSIX spawn with `detached: true`, every kill
  sent to `-pid`, a final group `SIGKILL` sweep after a queue-initiated kill;
  `os.setPriority(pid, 19)` on every platform. Windows keeps P7's single-pid
  kill (the converter's own Job Object takes ffmpeg down).
- **Env allowlist:** add `PATHEXT` (Windows; Python 3.11's `shutil.which`
  needs it to find `ffmpeg.exe`).
- **Redaction:** `redactDetail` also matches doubled backslashes on win32
  (Python `repr` paths in converter `error` text).
- **Cancel:** `POST /api/conversions/:id/cancel`, queue `cancel()`, failure
  code `cancelled`, an "Abbrechen" button on queued and running rows in the
  admin panel, a "Wird abgebrochen …" state.
- **Subtitle sidecars:** verify, publish and serve the converter's `.vtt`
  sidecars; migration `007` adds `conversions.sidecars`.
- **Cleanup:** queue-owned cleanup pass (startup + after every completed
  scan), migration `007` adds `conversions.missing_since`, fixed 30-day grace.
- **Foundation docs:** vision (Pi criterion), constitution (converter process
  group + priority, cleanup deletes only under `CONVERT_DIR`), architecture
  (component map, boundaries, Convert flow, Scan flow hook, converter
  contract pointer), README (converter version, priority/`ionice` tip,
  cancel, cleanup, container/systemd notes).

### Out of scope

- Pause-on-playback (`SIGSTOP`/`SIGCONT`) and conversion time windows —
  human decision 2026-10-06: priority only; measured at the QA gate (see Risks).
- A per-job timeout — human decision 2026-10-06: the admin cancels a hung job.
- A storage limit (P7 H5 deferred enforcement): usage stays display-only.
- A configurable grace period (fixed 30 days, no new env var).
- Cancel from the item views' "Konvertieren" control (admin panel only).
- Gallery-video conversion (roadmap Phase 9).
- Cleanup while the feature is off (no `CONVERTER_CMD`): nothing under
  `CONVERT_DIR` is deleted then; existing fresh copies keep being served.
- Probing the converter version at startup (no extra child process).

## Constraints

- Constitution "Don'ts": the converter is started only from
  `src/convert/run-converter.js`, `spawn` with argv, never a shell, one at a
  time, allowlisted env without `ADMIN_PASSWORD`; amended by this spec (see
  Foundation-doc changes) with the process-group and priority rule.
- Only the conversion queue and its helpers (`src/convert/queue.js`, `job.js`,
  `work-dir.js`, new `cleanup.js`) delete files, and only under `CONVERT_DIR`
  (architecture Boundaries). Cleanup never follows symlinks and never touches
  an entry whose name it did not create.
- Every path the converter reports (`output`, each sidecar `path`) is resolved
  through `src/media/paths.js` inside the job's realpath'd `out/` directory
  before use.
- A result counts only after videothek's own format check — also for
  sidecars (WebVTT signature).
- Max 300 lines per file / 60 per function: `src/convert/job.js` is at 298
  lines, so sidecar publishing goes into a new module
  (`src/convert/sidecars.js`) and the cancel hook stays a thin addition;
  cleanup goes into `src/convert/cleanup.js` (fs) +
  `src/db/conversion-cleanup.js` (SQL).
- SQL only in `src/db/`, prepared statements only; schema change = new
  migration `src/db/migrations/007-conversion-cleanup.sql`, no edit to `006`.
- Windows dev machine and Linux production (Pi) both pass `npm run verify`;
  POSIX-only behaviour is tested with `{ skip: process.platform === 'win32' }`.

## Prior art

- [External converter contract (Phase 8)](../prior-art.md#external-converter-contract-phase-8)
  — the v3.1.0 gaps this phase closes; the converter repo has since shipped
  v3.2.0 (`--json`, `--to web`, `.partial` + SIGTERM cleanup) and v3.3.0
  (WebVTT sidecars). Facts below re-read from the converter source on
  2026-10-06 (`converter/report.py`, `cli.py`, `batch.py`, `paths.py`,
  `profiles.py`, `ffmpegtool.py`).
- [Converter child-process supervision (Phase 7)](../prior-art.md#converter-child-process-supervision-phase-7)
  — `detached: true` makes the child a process-group leader on POSIX;
  `subprocess.kill()` does not reach grandchildren; Windows has no groups.
- [Converting on weak hardware without hurting playback (Phase 8)](../prior-art.md#converting-on-weak-hardware-without-hurting-playback-phase-8)
  — one job at a time, no hardware-encoder dependency, nice 19 + idle I/O
  class (`ionice`), measure before adding a hard cap.
- [Conversion job queue and states (Phase 7)](../prior-art.md#conversion-job-queue-and-states-phase-7)
  — Tdarr time windows (considered, not adopted); explicit failed state with
  manual retry (kept for `cancelled`).
- [On-demand browser-safe copies (Phase 7)](../prior-art.md#on-demand-browser-safe-copies-phase-7)
  — Plex AVOID: no immediate cascade delete when the source vanishes; cleanup
  with a grace period.
- [Subtitle sidecars (Phase 3)](../prior-art.md#subtitle-sidecars-phase-3)
  — `<basename>.<lang>.vtt` convention the converter's sidecar names follow.

## Human prerequisites

- [ ] `bhemsen/converter` v3.3.0 installed on the Raspberry Pi (Python ≥ 3.11,
      `ffmpeg`/`ffprobe` on the service user's `PATH`), and `CONVERTER_CMD`
      in the Pi's `.env` set to its absolute entry point.
- [ ] The same on the Windows dev machine (for the Windows QA pass of the
      `PATHEXT` and kill paths), `CONVERTER_CMD` in the main checkout's `.env`.
- [ ] Real QA sample files under the QA `MEDIA_ROOT` (not committed): an HEVC
      MKV with at least one SRT or ASS subtitle track (ideally also a PGS
      track), an MP4 with AC3/E-AC3 audio, and one not-browser-playable audio
      file (e.g. `.wma` or `.ape` per `src/convert/targets.js`).
- [ ] At the QA gate: the Phase-8 build deployed on the Pi and two playback
      devices for the two-stream measurement.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Playback protection = priority only: nice 19 via `os.setPriority`; optional idle I/O class by prefixing `CONVERTER_CMD` with `/usr/bin/ionice -c3` (README). No pause-on-playback, no time window. | Human decision at planning (option "Nur Priorität"); prior art: priorities first, measure before hard caps. Linux derives the best-effort I/O level from CPU nice (nice 19 → BE level 7), so I/O is deprioritised even without `ionice`. | 2026-10-06 |
| Cancel queued + running jobs from the admin panel; no per-job timeout. | Human decision at planning (option "Abbrechen, kein Timeout"). | 2026-10-06 |
| Converter WebVTT sidecars are published and served in Phase 8. | Human decision at planning; without them embedded MKV subtitles are lost by conversion. | 2026-10-06 |
| Vanished-source grace period: fixed 30 days; stale and orphaned copies are removed at the next cleanup. | Human decision at planning (option "30 Tage, fest"); no new env var. | 2026-10-06 |
| Minimum converter version v3.2.0 (adapter contract); sidecars need v3.3.0. A missing `sidecars` key counts as `[]`. | v3.2.0 introduced `--json`/`--to web`/kill-safety; the converter's schema is open (consumers ignore unknown keys), so v3.2.0 output stays valid. | 2026-10-06 |
| Records require `type` and `schema === 1`; a record with `schema` ≠ 1 makes the run `converter_output_invalid`. Unknown `type` values and unknown keys are ignored. | Converter rule: removing/renaming a key raises `schema`; adding keys or record types does not (converter README "The schema is open"). | 2026-10-06 |
| A run with exit 0 is complete only with exactly one `file` record and exactly one `summary` record as the last record, whose `total` is 1 and `exit_code` is 0. | Converter: the summary is emitted last and only on a completed run; a stream without it is incomplete (`cli.py:531-541`). | 2026-10-06 |
| Exit 143 (converter's SIGTERM exit) maps like 130: `converter_interrupted`, unless the queue itself killed the run (then `interrupted` / `cancelled` as decided by the job). | Converter exit-code table; P7 rule 2 extended. | 2026-10-06 |
| POSIX: `spawn(..., { detached: true })`; every queue-initiated signal goes to `process.kill(-pid, sig)`; `ESRCH` is ignored. After a queue-initiated kill, once the leader has exited, one `SIGKILL` is sent to the group. Windows: no `detached` (it would open a console), `child.kill()` as in P7. | Prior art: `subprocess.kill()` does not reach grandchildren on Linux; converter keeps ffmpeg in its own group on purpose (`spec-abort-safe-writes.md:158`) so a group kill reaches it; on Windows the converter's `KILL_ON_JOB_CLOSE` Job Object kills ffmpeg when the converter is terminated. | 2026-10-06 |
| `os.setPriority(child.pid, 19)` right after `spawn()` returns, on every platform; a failure logs `conversion_priority_failed { code }` and the job continues. | Built-in, no wrapper process; Python start-up precedes its first ffprobe/ffmpeg fork, which then inherits the niceness. Windows maps 19 to the lowest priority class, which child processes inherit. Best effort, documented. | 2026-10-06 |
| Detached consequence: an app crash (not a graceful stop) leaves a running converter alive; systemd `KillMode=control-group` (default) still ends it, Docker needs `--init` and a group-forwarding init (`tini -g`). README documents both. | `detached` removes the child from the app's process group but not from its cgroup. | 2026-10-06 |
| `PATHEXT` joins the converter env allowlist. | Python 3.11 `shutil.which` reads only `PATHEXT` to resolve `ffmpeg` → `ffmpeg.exe`; libuv's fixed Windows set does not include it. Verified at the Windows QA pass. | 2026-10-06 |
| `redactDetail` on win32 matches each path separator as `/`, `\` or `\\`. | Converter `error` text can carry Python `repr` paths with doubled backslashes (P7 deferred item). | 2026-10-06 |
| Cancel API: `POST /api/conversions/:id/cancel` (`requireAdmin`). `queued` → `200` + entry (now `failed` `cancelled`); `converting` → `202` + entry with `cancelling: true` (idempotent while pending); any other state (incl. no row) → `409 not_cancellable`; feature off → `503 conversion_disabled`; unknown/malformed id → `404 not_found`. | Mirrors P7's POST precondition order and status codes; the panel needs the "Wird abgebrochen …" state. | 2026-10-06 |
| Queue `cancel(relPath)`: a `queued` row is ended in one guarded `UPDATE … WHERE status = 'queued'`; for the running job it sets a cancel flag, sends `SIGTERM` to the group and arms the `SIGKILL` escalation after `killGraceMs`. The job records `cancelled` when the flag is set before spawn or after the run settles. Cancel wins over a concurrent `stop()`. | Same single-writer rule as P7 `stop()` (the job writes its own end state). Admin intent is the more specific end state. | 2026-10-06 |
| New failure code `cancelled`, German reason "Vom Admin abgebrochen". | Distinct from `interrupted`/`converter_interrupted` ("Abgebrochen"), which mean restart/foreign signal. | 2026-10-06 |
| Entry JSON gains `cancelling: boolean` (true only for the running row while its cancel is pending). | Drives the panel's disabled button and status text; computed from queue state, not stored. | 2026-10-06 |
| Sidecar acceptance: each `sidecars[]` entry must resolve inside the job's `out/`, be a regular file ending `.vtt`, ≤ 5 MiB, and start with `WEBVTT` (optional UTF-8 BOM). A failing entry is dropped with a note; it never fails the copy. At most 20 sidecars are kept (record order). | Own format check rule; a sidecar failure costs a note in the converter too (`batch.py:312-318`). | 2026-10-06 |
| Sidecars are published as `CONVERT_DIR/<storage_key>/sub-<n>.vtt` (`n` = 0.. in kept order) after any previous `sub-*.vtt` in that directory was removed, before the main file's rename; stored as `conversions.sidecars` JSON `[{ "file": "sub-0.vtt", "lang": "eng" \| null }]`. `lang` is the converter's `language` when it matches `^[a-z]{2,3}(-[a-z0-9]{1,8})*$` and is not `und`, else `null`. | Fixed names keep paths internal (no guard needed for composed names); converter keeps the 3-letter tag (`eng`), which `subtitles.js`'s 2-3 letter pattern already accepts. | 2026-10-06 |
| `output_size` becomes the total bytes of main file + kept sidecars. | Usage line stays one number per copy. | 2026-10-06 |
| Subtitle list = source-folder sidecars first (P3 order), then the fresh conversion's sidecars in stored order; one shared helper (`src/api/subtitle-tracks.js`) used by both the item detail JSON and `GET /media/:id/subtitles/:n`, so indices agree. A stale or absent conversion contributes nothing. Converted tracks get `label` = `lang` (or `null`). | Index stability between `/api/library/items/:id` and the subtitle route; `src/media/` stays DB-free (the helper lives in `src/api/`). | 2026-10-06 |
| Cleanup is owned by the queue and never runs concurrently with a job: it runs after `start()` before the first claim, and on `requestCleanup()` (called from `onScanComplete`) — immediately when idle, else after the running job settles and before the next claim. Coalesced, single-flight, skipped once `stop()` was called. | Single writer under `CONVERT_DIR`; no race with a publish rename. | 2026-10-06 |
| Cleanup rules, in order: (1) mark `missing_since = now` for rows whose `rel_path` is not in `library_items`, clear it for rows whose item is back; (2) delete rows (any status except `converting`) with `missing_since` older than 30 days, then their directory; (3) delete `playable` rows whose recorded source size/mtime differ from the item's, then their directory; (4) for `failed` rows with `output_rel`, delete the directory, then null `output_rel`/`output_size`/`sidecars`; (5) for fresh `playable` rows whose copy file no longer exists, delete the row and set the item's `playable = 0, scan_version = 0` in one transaction (the next scan recomputes the true flag), then delete the directory; (6) delete every directory directly under `CONVERT_DIR` whose name is 64 lowercase hex characters, which is a real directory (`lstat`), and which no row references. `.videothek-work/` and any other name are never touched. DB change first, directory removal second. | Plex AVOID (no immediate cascade); root safety keeps rows of protected roots, so they are never marked missing; P7 O2 (a) reconciliation; a crash between DB and fs leaves an orphan that rule 6 removes next time. | 2026-10-06 |
| Cleanup needs no feature-off path: without `CONVERTER_CMD` no queue exists and nothing is deleted. | Minimal; a disabled feature must not destroy copies the admin may re-enable. | 2026-10-06 |
| Migration `007-conversion-cleanup.sql`: `ALTER TABLE conversions ADD COLUMN sidecars TEXT NOT NULL DEFAULT '[]'` and `ADD COLUMN missing_since INTEGER`. | STRICT table accepts typed `ADD COLUMN`; no `BEGIN`/`COMMIT` inside (P7 migration rule). | 2026-10-06 |

## Converter contract (replaces P7 "Converter contract")

Invocation, cwd, temp env and side-effect rules are unchanged from P7:
`<CONVERTER_CMD tokens…> --to web|flac|opus --json <SRC> <OUTDIR>`.

**Records** — stdout, JSON Lines (UTF-8, `\n`; `\r` stripped, empty lines
skipped; P7 line/total caps unchanged). Every record is an object with
`type` (string) and `schema` (integer, must be `1`). Recognised types:

| `type` | Fields used | Validation |
|---|---|---|
| `file` | `outcome` (`converted`/`skipped`/`failed`/`unsupported`), `output` (absolute string; required when `converted`), `error` (string/null), `notes` (string array, P7 caps), `sidecars` (null, absent, or array of `{ path: absolute string, stream: integer, language: string }`) | any field with the wrong type → `invalid`; `source`, `attempt` and unknown keys ignored |
| `summary` | `total` (integer), `exit_code` (integer) | wrong types → `invalid`; other keys ignored |
| anything else | — | ignored |

A record without `type`, or with `schema` ≠ `1`, is `invalid`.

**Interpretation** (first match wins; replaces P7 rules 1–9):

1. Spawn error → `converter_unavailable`.
2. A signal the queue did not send, or exit `130`/`143` → `converter_interrupted`.
3. Exit `2` → `converter_unavailable`.
4. Invalid stdout (bad line, invalid record, cap kill) → `converter_output_invalid`.
5. Any other non-zero exit → `converter_failed` (detail: the single `file`
   record's `error` if present, else the stderr tail).
6. Not exactly one `file` record → `converter_output_invalid`.
7. Not exactly one `summary` record, or it is not the last record, or its
   `total` ≠ 1 or `exit_code` ≠ 0 → `converter_output_invalid`.
8. `file.outcome`: `failed` → `converter_failed`; `unsupported` →
   `unsupported_source`; `skipped` → `converter_output_invalid`.
9. `stdioTimedOut` → `converter_output_invalid`.
10. `converted` → verification of `output` (P7) and of each sidecar (above).

A run the queue itself killed (graceful stop or cancel) is never
interpreted: the job records `interrupted` or `cancelled` (P7 "Queue",
`stop()`, extended by cancel).

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the
issues own progress.

- Milestone: Phase 8 — Converter adapter & Pi protection (linked from
  `docs/roadmap.md` at acceptance)
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Design

UI delta only in the admin "Konvertierung" panel (P7 design otherwise
unchanged): `docs/design/assets/converter-adapter/admin-panel-desktop.html`
and `admin-panel-mobile.html` — "Abbrechen" (`btn-danger`, inline slot of the
retry button) on queued and running rows, the disabled "Wird abgebrochen …"
running state, and a failed row with "Vom Admin abgebrochen". Hand-derived from
the P7 exports (P7 precedent: Stitch generation timed out for this panel); no
new tokens or components.

## Verification

Machine checks (`npm run verify`):

- [ ] Verify passes; `npm ls --omit=dev --all` shows no packages.
- [ ] `validateRecord`/`interpretRun`: a v3.3.0-shaped run (file + summary)
      converts; v3.2.0 shape without `sidecars` converts; each of rules 1–9
      has a failing-case test, incl. missing summary, summary not last,
      `total` 2, `schema` 2, record without `type`, exit 143, unknown record
      type ignored, unknown keys ignored.
- [ ] Stub converter emits the real shape and exits `143` on `SIGTERM`
      (POSIX) after removing its `.partial`.
- [ ] POSIX-only: a stub mode that spawns a long-lived grandchild — after
      `stop()` and after `cancel()` the grandchild is gone (group kill), and
      the cap kill also ends it.
- [ ] Priority: the runner calls `setPriority(pid, 19)` (injected seam); a
      throwing `setPriority` logs `conversion_priority_failed` and the job
      still converts.
- [ ] Env: `pickConverterEnv` passes `PATHEXT` when set; `ADMIN_PASSWORD` is
      still never passed.
- [ ] `redactDetail` (win32 semantics) replaces a root written with doubled
      backslashes.
- [ ] Cancel: queued → `200` + `failed`/`cancelled`, row never claimed;
      running → `202` + `cancelling: true`, then `failed`/`cancelled`, job dir
      removed; cancel between claim and spawn → `cancelled` without spawn;
      `playable`/`failed`/none → `409 not_cancellable`; role `user` → `403`;
      no session → `401`; feature off → `503`; cancel + `stop()` → `cancelled`.
- [ ] Sidecars: two valid sidecars are published as `sub-0.vtt`/`sub-1.vtt`
      and listed after source-folder sidecars with matching indices in the item
      JSON and `GET /media/:id/subtitles/:n`; a sidecar outside `out/`, without
      `WEBVTT`, over 5 MiB or beyond the 20th is dropped with a note and the
      copy still publishes; a re-conversion removes old `sub-*.vtt`; a stale
      conversion contributes no tracks.
- [ ] Cleanup rules 1–6 each tested, plus: a protected (missing) category root
      marks nothing missing; a non-hex directory, a symlink named like a key
      and `.videothek-work/` survive; cleanup never runs while a job runs
      (deferred until it settles); no cleanup after `stop()`; feature off →
      nothing deleted.
- [ ] Migration `007` applies on a P7 database; existing rows get
      `sidecars = '[]'`, `missing_since = NULL`.

Human QA gate (Chromium + Firefox, plus the Pi):

- [ ] Pi, real converter v3.3.0: convert an HEVC MKV with SRT/ASS subtitles →
      plays in both browsers, subtitle tracks selectable; an AC3 MP4 → plays
      with sound; a not-playable audio file → plays in the audio player.
- [ ] Pi: while that conversion runs, two devices play two different 1080p
      direct-play videos for 10 minutes without stutter; `ps -o ni,pgid`
      shows converter and ffmpeg at nice 19 in one group separate from node.
- [ ] Pi: cancel a running conversion → ffmpeg is gone within `killGraceMs`
      (`ps`), panel shows "Wird abgebrochen …" then "Vom Admin abgebrochen";
      retry converts again. Cancel a queued one → immediate.
- [ ] Pi: `systemctl stop` (or Ctrl-C) during a conversion → no converter or
      ffmpeg process left; restart shows `Abgebrochen` (interrupted).
- [ ] Windows dev: one conversion with the real converter succeeds (proves
      `PATHEXT`), cancel ends converter and ffmpeg (Task Manager).
- [ ] Cleanup: touch a converted source (mtime change) → after the next scan
      the copy directory is gone and the item shows "Konvertieren" again;
      delete a copy file by hand → after the next scan the item is no longer
      marked playable.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Priority alone does not keep two 1080p streams stutter-free on the Pi (USB disk I/O contention). | Measured at the QA gate. If it fails: first `ionice -c3` prefix (README, no code), then a follow-up phase for pause-on-playback (option recorded in Out of scope). The vision criterion is amended now so a failure is a visible regression, not silently accepted. |
| `setPriority` races the converter's first ffmpeg fork. | Python start-up precedes any fork by far; documented best effort; QA checks `ps` nice values. |
| Detached converter survives an app crash. | systemd control-group kill / `tini -g`; job dirs are wiped at next start (P7); README. |
| Converter changes its JSON schema. | `schema` ≠ 1 fails loudly as `converter_output_invalid` (admin sees "Unerwartete Ausgabe des Konverters"), never a silent mis-publish. |
| Cleanup deletes data it should keep. | Only 64-hex directories under the realpath'd `CONVERT_DIR`, never symlinks, never `.videothek-work/`; vanished sources get 30 days; root safety prevents mass "missing" marks; feature off deletes nothing; tests for each guard. |
| `job.js` exceeds 300 lines. | Sidecar publishing in `src/convert/sidecars.js`; cancel only adds a flag check next to `isStopping()`. |

## Foundation-doc changes (land in this spec PR)

- `docs/vision.md` Success criteria, "Weak hardware": "… serves two
  concurrent 1080p direct-play streams without stutter, also while one
  conversion runs."
- `docs/constitution.md` Don'ts, converter bullet: add "On POSIX the
  converter runs as its own process group and every signal videothek sends
  goes to that group; it runs at the lowest CPU priority (nice 19)." and
  "Cleanup deletes only under `CONVERT_DIR`, only directories videothek
  created (64-hex names), never through a symlink."
- `docs/architecture.md`: component map (conversion row: `cleanup.js`,
  `sidecars.js`, `conversion-cleanup.js`, cancel route; media routes: converted
  sidecars), Boundaries (deleters include `cleanup.js`; converter contract
  pointer → this spec), Convert flow (group spawn + priority, record/summary
  interpretation, sidecars, cancel), Scan flow (`onScanComplete` →
  `requestCleanup()`), Stream flow (subtitle list order).

## Decision log

- 2026-10-06: Planning — the four genuinely-open scope questions (playback
  protection, cancel/timeout, sidecars, grace period) were asked before
  drafting and answered with the recommended options; recorded in Prior
  decisions.
- 2026-10-06: Converter v3.3.0 contract re-read from source (record shapes,
  exit codes 0/1/2/130/143, summary-last rule, sidecar naming, Job Object,
  no own process group) instead of relying on the 2026-09-28 prior-art entry.
