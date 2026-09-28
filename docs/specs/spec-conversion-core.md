# Spec: On-demand conversion (core)

> Created: 2026-09-28

An admin can press "Konvertieren" on a not-playable video or audio item; one
conversion runs at a time in a separate child process, the result is checked
with videothek's own codec sniff, stored outside `MEDIA_ROOT` under
`CONVERT_DIR`, and then streams under the unchanged item id, so progress,
resume and every list keep working. Phase 7 builds and tests the whole path
against a stub converter that emulates the converter contract; the real
`bhemsen/converter` adapter follows in Phase 8. Without `CONVERTER_CMD` the app
behaves as it does today. This spec carries no lifecycle state. It counts as
accepted once it is merged on the default branch with a milestone and issues,
and all progress (in progress, done, blocked) lives in the GitHub issues and
milestone. A completed spec is moved to `docs/specs/archive/`.

## Outcome

- [ ] With `CONVERTER_CMD` unset, nothing changes for anyone: no conversion
      control is shown, `POST /api/conversions/:id` answers
      `503 conversion_disabled`, no child process is ever started, and copies
      converted earlier keep playing.
- [ ] An admin sees "Konvertieren" on every convertible not-playable movie card
      (`/movies`), episode row (`/series-detail`), album track (`/music`) and
      audiobook file (`/audiobooks`). Pressing it shows "In Warteschlange",
      then "Wird konvertiert …", then "Konvertiert" with "Neu laden". After the
      reload the item is a normal playable item under the same id.
- [ ] A non-admin user never sees a conversion control; both conversion routes
      answer `403 forbidden` for them and `401 unauthorized` without a session.
- [ ] Only one conversion runs at a time. Other requests wait in FIFO order and
      their position ("Platz 2") is shown.
- [ ] `GET /media/:id` of a converted item streams the verified copy from
      `CONVERT_DIR` with `200`/`206`/`416`, `HEAD`, and the copy's own MIME type.
      Nothing under `MEDIA_ROOT` is ever written, renamed or deleted.
- [ ] Progress written while the converted copy plays is keyed by the item's
      `rel_path` exactly as before. It appears in "Weiterschauen"/"Weiterhören"
      and resumes on another device within ±10 s.
- [ ] A failed conversion shows the German reason and stays `failed` until an
      admin presses "Erneut versuchen". Nothing retries automatically.
- [ ] A conversion the converter reports as "converted" whose result does not
      pass videothek's own codec check ends as `failed` (`not_browser_safe`),
      and the item stays not playable.
- [ ] After a crash or restart during a conversion, that job is `failed`
      (`interrupted`) and still-queued jobs run. No row is stuck in
      `converting` (also when `CONVERTER_CMD` was removed meanwhile) and no
      half-written file is left in the work area.
- [ ] If the source file changes (size or mtime), its copy is ignored: the item
      is not playable again and can be converted again. If the source vanishes
      and reappears unchanged (same size and mtime, e.g. `mv`), it is playable
      from its copy again.
- [ ] The admin page shows the queue (running, waiting, failed, outdated,
      finished) and the storage usage of all copies plus the free space on the
      `CONVERT_DIR` file system. No limit is enforced.
- [ ] `npm run verify` is green; `npm ls --omit=dev --all` shows no packages.

## Scope

### In scope

- Config: `CONVERTER_CMD` (optional; unset means the feature is off),
  `CONVERT_DIR` (optional, default `<DATA_DIR>/converted`), and the child
  environment allowlist.
- Migration `006-conversions.sql` and the repository `src/db/conversions.js`.
- The effective `playable` flag: the `upsertItem` SQL in `src/db/library-repo.js`
  also counts a fresh `playable` conversion.
- `src/convert/`: target mapping, converter spawn and JSON Lines reader, run
  interpretation, output verification, and the one-at-a-time queue with
  graceful stop; startup recovery in `src/server.js`.
- `GET /media/:id` serves the fresh converted copy when one exists.
- API: `GET /api/conversions` and `POST /api/conversions/:id` (admin only).
- UI: a conversion control decorator on `/movies`, `/series-detail`, the album
  view and the audiobook view, plus a "Konvertierung" panel on `/admin` with
  the queue and storage usage.
- The stub converter `test/helpers/converter-stub.js`: the test double for the
  converter contract, also usable for human QA.
- The constitution-test change for `child_process` (see Constraints).
- Foundation-doc amendments (vision, constitution, architecture) are made in
  this spec PR, as the Phase-7 "Foundation impact" line requires. README and
  `.env.example` are updated by the config issue.

### Out of scope (Phase 8 or later)

- The real `bhemsen/converter` adapter. This is a hard dependency on a
  converter release with `--to web`, `--json` JSON Lines, and `.partial` output
  with SIGTERM cleanup. v3.1.0 has none of these. Pointed at v3.1.0, Phase 7
  fails every job cleanly with `converter_unavailable` (exit 2, unknown
  `--json`). The adapter issue also revisits the environment allowlist
  (Windows `PATHEXT`/`COMSPEC`/`WINDIR`/`USERPROFILE`/`APPDATA`, `PYTHONUTF8`).
- Process-group spawn and kill (`detached` plus `kill(-pid)`), CPU/IO priority
  (`nice`/`ionice`), and playback protection while converting (Phase 8).
- Cancelling a queued or running job, and a per-job timeout (Phase 8 cancel).
- Deleting copies: stale-conversion cleanup, cleanup of vanished sources,
  storage-limit enforcement (Phase 8, H5).
- "Alle konvertieren" and any bulk or automatic conversion (H2).
- Videos in the `images` category (gallery). `targetFor` returns `null` for
  them in Phase 7 (see Prior decisions).
- A control on the player's not-playable panel. Not-playable cards do not link
  to the player, and `public/js/player.js` is at 300 lines.
- Showing conversion state to non-admin users (H1).
- Progress within a single file (the converter reports only per file) and a
  version picker. Serving the copy is transparent: the item JSON keeps the
  source's `ext`, `size` and codecs (a converted MKV still shows "MKV"); no
  client code keys on them for playback (`player.js` checks only `playable`).
- Images (`kind = 'image'`), which are never convertible.

## Constraints

- The constitution applies as amended by this spec: zero runtime deps, SQL only
  in `src/db/` as prepared statements, JSON errors `{ "error": "<code>" }`,
  JSDoc on every export, ≤ 60 lines per function, ≤ 300 lines per file (JS, CSS,
  tests), a mirrored `test/` file for every new `src/` module, German UI copy,
  raw values only in `public/css/tokens.css`, no `innerHTML`, no `console.*` in
  `src/`, and `process.env` only in `src/config.js`.
- Child processes: only `src/convert/run-converter.js` imports
  `node:child_process`, and it uses only `spawn`. It builds the argv itself:
  `spawn(cmd[0], [...cmd.slice(1), '--to', target, '--json', source, outDir])`
  with `shell` never set (Node default `false`), no `detached`,
  `stdio: ['ignore', 'pipe', 'pipe']`, `windowsHide: true` and `env`.
  `source` is the realpath returned by `resolveMediaPath`. It is always
  absolute, so it can never be read as an option.
- **Constitution-test change** (made by the spawn issue, not in this docs PR):
  in `test/constitution.test.js` the test "src/ and public/ never use
  child_process, eval() or new Function()" keeps `eval(` and `new Function`
  for every file and keeps `child_process` forbidden in `public/`. For `src/`
  it skips the `child_process` pattern for exactly one file, compared as
  `path.relative(rootDir, file).split(path.sep).join('/') ===
  'src/convert/run-converter.js'` (works on Windows), and the test title
  changes to match. A new test asserts, on the comment-stripped source of
  that file (`readSourceForScan`, string literals kept), that its only
  `child_process` import is `import { spawn } from 'node:child_process'`,
  that `/\bshell\s*:/` does not match, and that no word-bounded `exec`,
  `execFile`, `execSync` or `fork` identifier occurs (`execPath` does not
  match `\bexec\b`).
- Containment: every path taken from a client, from the DB (`rel_path`,
  `output_rel`) or from the converter goes through `resolveMediaPath(root,
  rel)` from `src/media/paths.js`, which is root-agnostic and is not changed.
  Sources resolve against `config.mediaRoot`. The converter's reported output
  resolves against the job's realpath'd `out/` dir. Served copies resolve
  against `config.convertDir`. A violation fails the job or answers `404`.
  Paths the queue composes from the hex `storage_key` and fixed names are
  internal (architecture Boundaries).
- Deletes and renames happen only under `CONVERT_DIR`: the per-job work dir
  `CONVERT_DIR/.work/<storage_key>-<unique>/` and publishing into
  `CONVERT_DIR/<storage_key>/`. Nothing outside `CONVERT_DIR/.work/` is ever
  deleted in Phase 7. Every `rm` uses `{ recursive: true, force: true,
  maxRetries: 3 }` (Windows handles linger briefly).
- DB writes of the queue (claim, publish, fail) are synchronous
  `DatabaseSync` chunks with `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` (pattern
  of `src/db/users.js`) and no `await` inside, so they never interleave with
  the scanner's transactions.
- UI: every new component injects its own stylesheet (`injectStylesheet`) and
  uses tokens only. Other phases' CSS files are never edited: `library.css`,
  `audio-music.css`, `audio-books.css` and `admin.css` are at 284–296 lines.
  DOM is built with `el()` and text only via `textContent`.
- Other phases' files are edited only as listed under "File ownership", as hook
  lines.

### Config (`src/config.js`)

| Variable | Rule | Config property |
|---|---|---|
| `CONVERTER_CMD` | unset/empty → `null` (feature off). Otherwise split on `/\s+/` after trimming, with no quote or escape handling. 1–32 tokens; the first token must be an absolute path. It is not checked for existence, so a missing converter fails jobs (`converter_unavailable`) and never blocks startup. Validated in every mode, also under `requireMediaRoot: false` (precedent: `PORT`), so an invalid value also stops the reset-password CLI. | `converterCmd: string[] \| null` (frozen) |
| `CONVERT_DIR` | unset → `<dataDir>/converted`. Otherwise resolved against `cwd` like `DATA_DIR`. Only under `requireMediaRoot`: `CONVERT_DIR` must not be inside `MEDIA_ROOT` and `MEDIA_ROOT` must not be inside `CONVERT_DIR` (both directions, via the existing `isInside`, lexical). Not created here; the realpath check follows in the queue's `start()`. | `convertDir: string` |
| — | Child environment: copies only `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `TEMP`, `TMP`, `SystemRoot` (those set) from `env`. `ADMIN_PASSWORD` and every other variable never reach the converter. Sufficient for the Node stub; the Phase-8 adapter issue revisits it. | `converterEnv: Readonly<Record<string,string>>` |

Problems use the existing `"<VAR>: <rule>"` format and never include a value.
The pure parsers may live in `src/config-converter.js` (taking `env` as a
parameter, mirrored by `test/config-converter.test.js`) because
`src/config.js` is at 228 lines; `process.env` is still read only in
`src/config.js`. Hand-built `Config` objects in existing tests lack the new
fields (`undefined` at runtime): consumers test `converterCmd` by truthiness,
and `media.js` touches `convertDir` only when a fresh conversion row exists.

README: paths containing spaces are not supported in `CONVERTER_CMD`; on
Windows use a Node path without spaces or its 8.3 short name
(`C:\PROGRA~1\nodejs\node.exe`), and `--sample-dir` must not contain spaces.
Tests are unaffected (they pass arrays). Startup logs `conversion_enabled {}`
or `conversion_disabled {}` and never logs the command.

### Data model (migration `006-conversions.sql`)

```sql
CREATE TABLE conversions (
  rel_path        TEXT    PRIMARY KEY,         -- = library_items.rel_path, never an FK
  storage_key     TEXT    NOT NULL UNIQUE,     -- sha256(rel_path UTF-8) lower-case hex, 64 chars
  target          TEXT    NOT NULL CHECK (target IN ('web', 'flac', 'opus')),
  status          TEXT    NOT NULL CHECK (status IN ('queued', 'converting', 'playable', 'failed')),
  source_size     INTEGER NOT NULL,            -- source stat the copy belongs to
  source_mtime_ms INTEGER NOT NULL,            -- Math.trunc(stat.mtimeMs), same rule as library_items.mtime_ms
  output_rel      TEXT,                        -- '<storage_key>/<file>' relative to CONVERT_DIR; set iff a verified copy exists
  output_size     INTEGER,                     -- bytes of output_rel
  notes           TEXT    NOT NULL DEFAULT '[]', -- JSON array of converter notes (≤ 10 × 200 chars)
  error           TEXT,                        -- failure code (table below), NULL unless status = 'failed'
  error_detail    TEXT,                        -- ≤ 500 chars, redacted, NULL unless failed
  queued_at       INTEGER NOT NULL,            -- epoch ms, deps.now()
  started_at      INTEGER,
  finished_at     INTEGER
) STRICT;
CREATE INDEX conversions_queue ON conversions (status, queued_at, rel_path);
```

- The key is `rel_path`, not the item id (H3). Like `progress`, a row outlives
  its `library_items` row (no FK, no cascade; Plex AVOID) and re-attaches when
  the path reappears. `storage_key` names the directory, so no user-controlled
  name appears in any path under `CONVERT_DIR`.
- `source_size`/`source_mtime_ms` are set from the index row at enqueue and
  overwritten from the real `stat` at job start. A copy is **fresh** iff
  `status = 'playable'` and both equal the current `library_items` row's
  `size`/`mtime_ms`. Otherwise it is **stale**. A re-copy with plain `cp`
  (new mtime) therefore makes a copy stale; `mv` or `rsync -t` keep it fresh
  (README note).
- FIFO order is `queued_at, rel_path`: equal `queued_at` values (same
  millisecond, or tests with a constant `now`) run in `rel_path` order, not in
  arrival order. Accepted; no sequence column.
- The migration references no other table and contains no
  `BEGIN`/`COMMIT` (P1 runner).
- The final file name is fixed per target: `web.mp4`, `audio.flac`,
  `audio.opus`. The output path is therefore
  `CONVERT_DIR/<storage_key>/<file>`.

States (stored), plus two derived API states:

| Status | Meaning | Next |
|---|---|---|
| — (`none`, API only) | no row | `POST` → `queued` |
| `queued` | waiting; survives restarts | queue claims → `converting` |
| `converting` | the one running job | → `playable` or `failed`; at startup → `failed` `interrupted` |
| `playable` | verified copy published | fresh: served; stale (API `stale`): `POST` → `queued` |
| `failed` | terminal until an admin acts | `POST` → `queued` (manual retry) |

### Effective `playable` (one source of truth for every existing reader)

`library_items.playable` now means "streamable via `/media/:id`": the source
plays directly **or** a fresh conversion exists. Every existing reader
(`/api/library/*`, progress `not_resumable` and continue views, audio views,
home queries, next-up) needs no change.

- `src/db/library-repo.js` `UPSERT_ITEM_SQL`: the `playable` value becomes
  `(? OR EXISTS (SELECT 1 FROM conversions c WHERE c.rel_path = ? AND
  c.status = 'playable' AND c.source_size = ? AND c.source_mtime_ms = ?))`.
  It is bound with the built row's `playable`, `rel_path`, `size` and
  `mtime_ms`, and the `ON CONFLICT` branch keeps `playable = excluded.playable`.
  The effects: a vanished and re-added unchanged file comes back playable, a
  changed source falls back to its own flag (stale), and a `SCAN_VERSION`
  re-parse keeps the flag. The scanner's unchanged-file skip stays as it is.
- Publishing a conversion runs one transaction in `src/db/conversions.js`:
  update the row to `playable`, then
  `UPDATE library_items SET playable = 1 WHERE rel_path = ? AND size = ? AND mtime_ms = ?`.
- Nothing in Phase 7 turns a flag back to 0 except the scanner's own re-upsert.
  Phase 8's cleanup must reset it (see Risks).

### Targets (`src/convert/targets.js`, pure)

`targetFor({ category, kind, ext })` → `'web' | 'flac' | 'opus' | null`:

| Source | Target |
|---|---|
| `kind = 'video'` and category `movies` or `series` | `web` |
| category `audiobooks` (audio) | `opus` |
| category `music`, ext in `ape aif aiff wv dsf dff m4a m4b` (lossless-capable) | `flac` |
| category `music`, any other audio ext except `mid`/`midi` | `opus` |
| `mid`, `midi`, `kind = 'image'`, category `images` | `null` (not convertible) |

`isConvertible(row)` = `row.playable === 0 && row.size > 0 &&
targetFor(row) !== null` (a zero-byte source would always fail).
`TARGETS = { web: { file: 'web.mp4', ext: 'mp4', kind: 'video' }, flac: {
file: 'audio.flac', ext: 'flac', kind: 'audio' }, opus: { file: 'audio.opus',
ext: 'opus', kind: 'audio' } }`. `storageKey(relPath)` → `sha256` hex via
`node:crypto`.

### Converter contract and stub

Phase 7 relies on this minimum contract only. The Phase-8 converter release
must satisfy it, and the stub emulates it.

- **Invocation:** `<CONVERTER_CMD tokens…> --to web|flac|opus --json <SRC> <OUTDIR>`,
  where `SRC` is an absolute file and `OUTDIR` an existing empty directory.
- **Output format:** `--to web` always writes an MP4 (`.mp4`), also for
  VP9/AV1 video (VP9/AV1 in MP4 pass the sniff as `vp09`/`av01`). `flac`
  writes `.flac`, `opus` writes an Ogg Opus `.opus`.
- **stdout:** JSON Lines only, UTF-8, `\n` separated (`\r` stripped, empty
  lines skipped). Per-file record: an object with `outcome` ∈
  `converted | skipped | failed | unsupported`, `output` (absolute path,
  required when `converted`), `error` (string or null), `notes` (string array,
  optional), `source` (ignored by Phase 7). Objects without `outcome`, such as
  the summary line, are ignored.
- **Exit codes:** `0` = nothing failed (includes skipped/unsupported),
  `1` = failed, `2` = usage error or tool missing, `130` = interrupted.
- **stderr:** free text. Only the last 4 KiB (bytes) are kept, solely for
  `error_detail`. stderr is never logged (ffmpeg prints absolute paths).
- **Limits:** a single stdout line over 64 KiB, or more than 1 MiB of stdout in
  total, kills the child (`SIGKILL`) and fails the job
  (`converter_output_invalid`). Both caps count bytes before decoding; lines
  are decoded with a `StringDecoder` so a multi-byte character split across
  chunks stays intact.

**Runner** (`src/convert/run-converter.js`):
`runConverter({ cmd, env, target, source, outDir })` →
`{ result: Promise<RunResult>, kill(signal): void }`, where
`RunResult = { spawnError, exitCode, signal, killedBy, records, stdoutInvalid, stderrTail }`.

- A synchronous `spawn` throw (EINVAL, …) and the `'error'` event both yield
  `spawnError` (the error code); `result` never rejects.
- `result` settles on `'close'` (all stdio drained), not on `'exit'`.
- `killedBy` is `'cap'` after a cap kill (which also sets
  `stdoutInvalid = true`), `'stop'` after a `kill()` call, else `null`.
- Record validation (any violation → `stdoutInvalid`): a non-object line, bad
  JSON, `outcome` not in the set, `output` not a string or not
  `path.isAbsolute`, `error` not string/null, `notes` not an array or a
  non-string entry. `notes` keeps the first 10 entries, each cut to 200
  characters.
- `stderrTail`: the last 4 KiB as bytes, leading UTF-8 continuation bytes
  (`0x80`–`0xBF`) dropped, then decoded.
- It does not interpret the result.

**Interpretation** (`interpretRun(run, { target })` in
`src/convert/result.js`, pure). The first matching rule wins:

1. `spawnError` → `converter_unavailable`
2. `signal !== null && killedBy === null` (a signal the queue did not send), or exit `130` → `converter_interrupted`
3. exit `2` → `converter_unavailable` (detail = stderr tail)
4. `stdoutInvalid` (bad line, bad field, cap kill) → `converter_output_invalid`
5. any other non-zero exit → `converter_failed` (detail = record `error`, else stderr tail)
6. not exactly one record → `converter_output_invalid`
7. outcome `failed` → `converter_failed`; `unsupported` → `unsupported_source`; `skipped` → `converter_output_invalid`
8. `converted` → returns `{ ok: true, output, notes }` for verification

A run ended by the queue's own stop (`killedBy = 'stop'`) is never
interpreted (see Queue, stop). `result.js` also holds the pure
`redactDetail(text, roots)`: every occurrence of the given root paths
(`mediaRoot`, `convertDir`, configured and realpath'd spellings) becomes
`<MEDIA_ROOT>`/`<CONVERT_DIR>`, then the text is cut to its last 500
characters. Every `error_detail` passes through it.

**Verification** (`verifyOutput({ output, outDir, target })` in
`src/convert/verify.js`; `outDir` is the realpath'd dir passed to the
converter):

1. `resolveMediaPath(outDir, path.relative(outDir, output))` must return a
   path (inside `outDir`, exists, no symlink escape). Otherwise
   `converter_output_invalid`.
2. Must be a regular file with `size > 0` and a lower-case extension equal to
   `TARGETS[target].ext`. Otherwise `converter_output_invalid`.
3. `mp4`: `sniffMp4Codecs(abs)` must be non-null (strict: "unknown" fails
   here, unlike the scanner), must have ≥ 1 video track, and
   `resolvePlayable({ ext, size, codecs })` must be true. `flac`: bytes 0–3 are
   `fLaC`. `opus` (magic check, not the codec sniff): bytes 0–3 are `OggS`;
   byte 26 is `page_segments` = n; bytes `27 + n` … `34 + n` are `OpusHead`.
   Any failure → `not_browser_safe`.

Then the queue re-stats the source. A size/mtime different from the one
recorded at start → `source_changed`; an unresolvable source →
`source_missing`.

**Stub** (`test/helpers/converter-stub.js`, run as
`[process.execPath, stubPath, …options]`): accepts leading
`--mode <m>`, `--sample-dir <dir>`, `--delay-ms <n>` and `--hold <dir>`
before the contract arguments and validates them (exit 2 + stderr usage on
anything else). `--delay-ms` sleeps before printing the record (human QA can
then see "In Warteschlange", "Wird konvertiert …" and "Platz 2" with 5-s
polling). `--hold <dir>` is a test handshake: after writing its output the
stub creates `<dir>/started` and waits until `<dir>/go` exists. The stub is
type-checked by `tsc` and is not collected by the `test/**/*.test.js` glob.
Modes:

| Mode | Behaviour |
|---|---|
| `ok` (default) | writes `<OUTDIR>/<src stem>.<ext>`: with `--sample-dir`, a copy of `sample.<ext>` from it (human QA); otherwise synthetic bytes (MP4 boxes `avc1` + `mp4a` via `test/helpers/mp4-boxes.js`, a `fLaC` header, or an Ogg page with `OpusHead`). Prints the record plus a summary line; exit 0 |
| `echo` | writes `{ argv, env }` as JSON to `<OUTDIR>/echo.json`, no record, exit 0 |
| `not-browser-safe` | MP4 with an `hvc1` video track, outcome `converted`, exit 0 |
| `fail` | record `failed` with `error: "ffmpeg exited with 1"`, exit 1 |
| `unsupported` / `skipped` | that outcome, no file, exit 0 |
| `garbage` | a non-JSON stdout line, exit 0 |
| `no-record` | writes the file, prints only the summary, exit 0 |
| `missing-output` / `escape` | `converted` with an output that does not exist / lies at `<OUTDIR>/../x.<ext>` (the file is written there, i.e. inside the per-job dir, outside `out/`) |
| `wrong-ext` | writes and reports `<stem>.mkv` |
| `crash` | writes a truncated file, no record, exit 3 |
| `interrupted` | exit 130 |
| `usage` | exit 2 with `unrecognized arguments` on stderr |
| `hang` | writes a partial file, then waits until it is killed |
| `flood` | writes > 1 MiB to stdout |

### Queue (`src/convert/queue.js`)

`createConversionQueue({ db, config, log, now, run = runConverter,
killGraceMs = 5000 })` → `{ start(): Promise<boolean>, kick(): void,
stop(): Promise<void> }`. The per-job pipeline may live in
`src/convert/job.js` and the directory handling (setup, work dir create and
remove) in `src/convert/work-dir.js`, each with its mirrored test.

- **`start()`:** `mkdir -p` `convertDir`; `fs.realpath` both `convertDir` and
  `mediaRoot` and repeat the overlap check in both directions (catches a
  symlinked `CONVERT_DIR`); then remove `convertDir/.work/` entirely
  (leftovers of a crash). Any failure (mkdir `EACCES`/`ENOSPC`/`EROFS`,
  overlap) logs `conversion_dir_unavailable { code }` (`code` = errno code or
  `overlap`), writes nothing, and resolves `false`: the server then runs with
  conversions disabled (POST `503`). On success it marks the queue ready,
  calls `kick()` and resolves `true`. Recovery of `converting` rows is not
  done here (see Server wiring).
- **`kick()`:** no-op before `start()` resolved `true`, while a job runs, and
  once `stop()` was called. Otherwise it claims the next row in one
  transaction (`status = 'queued'` ordered by `queued_at, rel_path` →
  `converting`, `started_at = now()`) synchronously and runs it
  asynchronously. After each job it calls `kick()` again. Exactly one job
  runs at a time. The whole chain catches everything: no unhandled rejection,
  even when the final DB write itself fails (then only a log line).
- **Job:**
  1. Look up the `library_items` row by `rel_path`. If it is absent, or
     `resolveMediaPath(mediaRoot, rel_path)` returns `null` → `source_missing`.
  2. `stat` the source (ENOENT/EACCES → `source_missing`) and record its
     size/mtime on the row.
  3. Create a fresh unique work dir with `fs.mkdtemp(convertDir/.work/<storage_key>-)`,
     `realpath` it, `mkdir` `out/` inside, and use the realpath'd `out/` as
     `OUTDIR` for the converter and `verifyOutput`. A unique name per attempt
     keeps an orphaned converter from an earlier crash out of the new dir.
     Errors → `storage_failed`.
  4. `run({ cmd: config.converterCmd, env: config.converterEnv, target, source, outDir })`,
     then `await result`.
  5. If `stop()` was called by now → `interrupted` (skip the rest). Else
     `interpretRun`, then `verifyOutput`, then re-check the source.
  6. Publish: `mkdir` `convertDir/<storage_key>/`, then `rename` the output to
     `<storage_key>/<TARGETS[target].file>` (same file system, atomic, and it
     replaces a stale copy). Then the publish transaction (status `playable`,
     `output_rel`, `output_size`, `notes`, `error = NULL`, `finished_at`, plus
     the `library_items` flag). A filesystem error here → `storage_failed`.
  7. Remove the per-job dir `.work/<storage_key>-<unique>/` (including `out/`
     and anything the converter wrote beside it), always, in `finally`.

  Any failure → `failed` with the code, redacted `error_detail` and
  `finished_at`. Any other unexpected throw (DB error, bug) → `internal`,
  plus a log line `conversion_error { key, code }` (error code/name only, no
  message, no path). Logs: `conversion_started` and `conversion_finished`
  with `{ key, target, status, error, ms }`; no paths, no command, no stderr.
- **`stop()`:** sets `stopping` synchronously (so `kick()` claims nothing from
  then on), then sends the running child `SIGTERM` via `kill()` and
  `SIGKILL` after `killGraceMs`. The job itself is the single writer of its
  end state: once `stopping` is set, a job whose run ends records `failed`
  `interrupted` without interpretation, whether the queue's kill or an
  external signal ended the child. `stop()` resolves only after the whole job
  promise settled, including its DB write and the work-dir removal in
  `finally`; it never rejects. It is memoised (a second call returns the same
  promise). A job already past step 5 when `stop()` is called finishes
  normally (local verify + publish are short).
- No automatic retry of any kind (prior art: Unmanic). `failed` changes only
  through `POST`.

### Server wiring (`src/server.js`, `src/app.js`)

- `src/app.js`: `AppDeps` gains `conversions?: ConversionQueue` next to
  `library?: LibraryService` (typedef only; `& Record<string, unknown>`
  would make it `unknown` for `tsc --strict`).
- `runStart`: right after `migrate`, always (feature on or off),
  `failInterruptedConversions(db, Date.now())`: every `converting` row →
  `failed`, `error = 'interrupted'`, `finished_at`; `queued` rows stay; logs
  `conversions_recovered { count }` when `count > 0`. It only touches the DB
  and is idempotent.
- When `config.converterCmd` is truthy: create the queue and
  `await queue.start()` before `createApp`/`listen`; on `false` the queue is
  dropped. `createApp({ …, conversions: queue ?? undefined })`. The `catch`
  branch of `runStart` awaits `queue?.stop()` before `library?.stop()` and
  `db.close()`.
- `createStop`: the first statement starts `queue?.stop()` (so `stopping` is
  set while `app.close()` still waits up to 5 s for connections and no new job
  starts in that window). After `app.close()` it awaits that promise, then
  `library.stop()`, then `db.close()`.
- `src/api/conversions.js` reads `deps.conversions` at request time and never
  captures it at registration (the API tests attach a queue after boot).

Failure codes and German reasons (`public/js/lib/conversion-format.js`):

| `error` | German reason |
|---|---|
| `converter_unavailable` | "Konverter nicht erreichbar" |
| `converter_failed` | "Der Konverter meldet einen Fehler" |
| `converter_interrupted`, `interrupted` | "Abgebrochen" |
| `converter_output_invalid` | "Unerwartete Antwort des Konverters" |
| `unsupported_source` | "Format wird vom Konverter nicht unterstützt" |
| `not_browser_safe` | "Ergebnis ist im Browser nicht abspielbar" |
| `source_missing` | "Quelldatei nicht gefunden" |
| `source_changed` | "Quelldatei hat sich während der Konvertierung geändert" |
| `storage_failed` | "Kopie konnte nicht gespeichert werden" |
| `internal` | "Interner Fehler" |

### Serving (`src/api/media.js`, edit of `handleMedia` only)

The route is unchanged up to the `playable` check (`404 not_found` /
`404 not_playable`). Then `getFreshConversion(db, row)` (status `playable`,
`source_size = row.size`, `source_mtime_ms = row.mtime_ms`):

- If found: `resolveMediaPath(config.convertDir, conversion.output_rel)`, and
  `null` → `404 not_found`.
- Otherwise: `resolveMediaPath(config.mediaRoot, row.rel_path)` as today;
  `config.convertDir` is not read.

`sendMedia(req, res, { path })` then derives the MIME type from the copy's
extension (`web.mp4` → `video/mp4`, `audio.flac` → `audio/flac`, `audio.opus` →
`audio/ogg`) and handles Range and `HEAD` identically. Subtitle sidecars still
come from the source folder. This works whether or not the queue is enabled.

### API contract (`src/api/conversions.js`, `registerConversionRoutes(router, deps)`)

Both routes are wrapped in P1's `requireAdmin`: `401 unauthorized` without a
session, `403 forbidden` for role `user`. `:id` follows the media route's
syntax: an id not matching `^[1-9][0-9]{0,15}$`, not a safe integer, or not in
`library_items` → `404 not_found`.

| Route | Request | Success | Errors |
|---|---|---|---|
| `GET /api/conversions` | optional query `ids` | `200 { enabled, usage, items }` | 400 `invalid_query`, 401, 403 |
| `POST /api/conversions/:id` | no body | `202` entry (newly queued) or `200` entry (already `queued`/`converting`, idempotent) | 404 `not_found`, 503 `conversion_disabled`, 400 `not_convertible`, 409 `already_playable`, 401, 403, 403 `forbidden_origin` |

- **`POST` order:** id (404), then item lookup (404), then
  `deps.conversions` absent (503 `conversion_disabled`), then
  `targetFor(row) === null` or `row.size === 0` (400 `not_convertible`), then
  `row.playable = 1` (409 `already_playable`: plays directly or has a fresh
  copy), then an existing `queued`/`converting` row (200, unchanged).
  Otherwise it upserts `status = 'queued'`, `target`, `storage_key`,
  `source_size`/`source_mtime_ms` from the row and `queued_at = deps.now()`,
  and clears `error`, `error_detail`, `started_at` and `finished_at`.
  `output_rel`/`output_size` of an old copy stay until the new one replaces
  them. Then `deps.conversions.kick()`, and only then is the 202 entry built
  (the claim is synchronous, so an idle queue already answers `converting`).
  This covers a first request, a retry after `failed` and a re-conversion of a
  stale copy.
- **`GET` without `ids`:** `items` = every conversion row whose `rel_path` is
  present in `library_items`, grouped `converting`, `queued`, `failed`,
  `stale`, `playable`. `queued` rows are ascending by position; every other
  group is newest first (`finished_at`, else `queued_at`).
- **`GET` with `ids`:** a comma list of 1–500 ids with id syntax (duplicates
  ignored; any bad token, an empty list or more than 500 →
  `400 invalid_query`). `items` = one entry per requested id present in
  `library_items`, in request order, with `status: "none"` when it has no row.
  Unknown ids are omitted. Ids are bound as one JSON array
  (`json_each(?)`).
- **Entry JSON:** `{ itemId, item, convertible, target, status, position,
  error, errorDetail, notes, outputSize, queuedAt, startedAt, finishedAt }`.
  - `item` is P2's `toItemJson(row)`.
  - `convertible` = `isConvertible(row)`.
  - `target` = `targetFor(row)`.
  - `status` ∈ `none | queued | converting | playable | stale | failed`.
  - `position` is the 1-based FIFO position among waiting (`queued`) rows
    only, else `null`; the running job is not counted.
  - `errorDetail` is the stored, redacted `error_detail`.
  - `…At` values are ISO-8601 or `null`.
- **`usage`:** `{ bytes, count, freeBytes }`. `bytes`/`count` =
  `SUM(output_size)`/`COUNT(*)` over every row with `output_rel IS NOT NULL`
  (present or not). `freeBytes` = `statfs(convertDir)`
  `bavail × bsize`, or `null` when `convertDir` is missing or `statfs` fails.
  Display only (H5).
- `enabled` = `deps.conversions` exists.

### Repository (`src/db/conversions.js`)

Every function takes `db` first. The listing SQL may move to
`src/db/conversion-queries.js` (mirrored test) to stay under 300 lines.

- `getConversion(db, relPath)` → row or `undefined`
- `getFreshConversion(db, itemRow)` → row or `undefined`
- `enqueueConversion(db, { relPath, storageKey, target, sourceSize, sourceMtimeMs, now })`
  (`INSERT … ON CONFLICT(rel_path) DO UPDATE`)
- `claimNextConversion(db, now)` → row or `undefined`
- `recordSourceStat(db, relPath, size, mtimeMs)`
- `publishConversion(db, { relPath, outputRel, outputSize, notes, now })`
  (transaction incl. the `library_items` update)
- `failConversion(db, { relPath, error, detail, now })`
- `failInterruptedConversions(db, now)` → count
- `listConversionRows(db)` and `listConversionRowsForIds(db, ids)` (joined to
  `library_items` under non-colliding aliases, with the queue position computed
  in SQL)
- `getConversionUsage(db)` → `{ bytes, count }`

### UI behaviour

The design step fills in the layouts. This section fixes the behaviour and the
copy.

- **Client** (`public/js/lib/conversions-api.js`): `listConversions({ ids })`
  → envelope, and `requestConversion(itemId)` → entry, both through P1's
  `request`. `public/js/lib/conversion-format.js` (pure) holds
  `statusLabel(entry)` and the reason table above.
- **Decorator** (`public/js/lib/convert-control.js`,
  `decorateConversionsFor(root)` → `Promise<void>`):
  - Collects hosts `[data-item-id]` matching `div.media-card`,
    `div.episode-row`, `.track-row--unplayable` or `.file-row--unplayable`.
    Only not-playable items are rendered as these, so none of them is a link.
    With no host there is no request.
  - Calls `listConversions({ ids })` in batches of ≤ 500. A `403` (non-admin),
    `enabled: false` or any error leaves the page untouched. The decorator
    doubles as the role check, so no page has to plumb `me` through.
  - Idempotent: it first removes earlier nodes marked `data-convert-control`.
    Each host gets one control appended as its last child:

    | Entry | Control |
    |---|---|
    | `convertible` and `none` or `stale` | button "Konvertieren" |
    | `queued` | status "In Warteschlange · Platz N" |
    | `converting` | "Wird konvertiert …" |
    | `failed` | "Konvertierung fehlgeschlagen: <Grund>" + button "Erneut versuchen" |
    | `playable` | "Konvertiert" + button "Neu laden" (`location.reload()`; see OPEN O1) |
    | not convertible | no control |

  - A button click disables the button, then `requestConversion(id)`. The
    returned entry re-renders the control. Errors: `409 already_playable`
    (another admin was faster) → the `playable` control ("Konvertiert" +
    "Neu laden"); `503`, `404` or `400` → the control is removed; anything
    else → "Konvertieren nicht möglich. Bitte erneut versuchen." and the
    button is enabled again.
  - The status text is a `role="status"` span. Buttons are ≥ `--tap-min`.
    Clicks never propagate to the host.
  - While any decorated entry is `queued`/`converting`, it polls
    `listConversions({ ids })` every 5 s. Polling pauses while
    `document.hidden` and stops for good once `root.isConnected` is false or
    nothing is active. One poller per root: a module-level
    `WeakMap<root, poller>`; decorating a root again cancels its previous
    poller (series-detail re-decorates the persistent `main` on a retry).
    The audio views pass their per-view `container`, which is replaced on
    every navigation and therefore disconnects.
  - The stylesheet is `public/css/convert-control.css`: scoped
    `.convert-control` rules plus the placement inside the four host types.
- **Admin panel** (`public/js/admin-conversions.js`,
  `mountConversionPanel(container)`, own stylesheet
  `public/css/admin-conversions.css`), mounted by `admin.js` after its user
  list. Contents:
  - Section with H2 "Konvertierung".
  - When disabled: "Konvertierung ist nicht eingerichtet (CONVERTER_CMD fehlt)."
    followed by the usage line when `count > 0`.
  - Usage line "Kopien: 12,3 GB in 8 Dateien · 180 GB frei". `frei` is omitted
    when `freeBytes` is `null`. It uses `formatFileSize` from
    `public/js/lib/library-format.js`.
  - Groups "Läuft gerade", "Warteschlange", "Fehlgeschlagen" (reason +
    "Erneut versuchen"), "Veraltet – Quelle geändert" ("Erneut konvertieren")
    and "Fertig" (the newest 20, with the notes). Each row shows the title
    (`item.seriesTitle` + episode label for episodes), the category and the
    extension. The panel's buttons follow the decorator's POST error rules.
  - Empty: "Keine Konvertierungen."
  - It polls every 5 s while something is active and the tab is visible, and a
    failed request shows "Status konnte nicht geladen werden.".

### File ownership (P7)

**New:**

- Server: `src/db/migrations/006-conversions.sql`, `src/db/conversions.js`,
  `src/convert/targets.js`, `src/convert/run-converter.js`,
  `src/convert/result.js`, `src/convert/verify.js`, `src/convert/queue.js`,
  `src/api/conversions.js`
- Pre-authorised splits (each with its mirrored test, only if needed for the
  300-line limit): `src/config-converter.js`, `src/db/conversion-queries.js`,
  `src/convert/job.js`, `src/convert/work-dir.js`; the API test may split into
  `test/api/conversions-get.test.js` and `test/api/conversions-post.test.js`.
- Frontend: `public/js/lib/conversions-api.js`,
  `public/js/lib/conversion-format.js`, `public/js/lib/convert-control.js`,
  `public/js/admin-conversions.js`, `public/css/convert-control.css`,
  `public/css/admin-conversions.css`
- Tests: `test/helpers/converter-stub.js`, `test/db/conversions.test.js`,
  `test/convert/targets.test.js`, `test/convert/run-converter.test.js`,
  `test/convert/result.test.js`, `test/convert/verify.test.js`,
  `test/convert/queue.test.js` (claim/FIFO/single-flight/stop with a fake
  `run`), `test/convert/queue-lifecycle.test.js` (real stub: publish, failure
  codes, stop, work-dir cleanup), `test/api/conversions.test.js`,
  `test/api/media-converted.test.js`, `test/public/conversion-format.test.js`

**Edited (minimal hooks only):**

- `src/config.js` (three properties), `src/db/library-repo.js` (one
  statement), `src/api/media.js` (`handleMedia` branch), `src/http/routes.js`
  (one line), `src/server.js` (startup recovery; create/start/stop the queue;
  `deps.conversions`), `src/app.js` (`AppDeps` typedef only)
- `public/js/movies.js`, `public/js/series-detail.js`: one import + one
  `decorateConversionsFor(...)` call after each render, next to
  `decorateProgressFor`
- `public/js/audio/views/album.js`, `public/js/audio/views/audiobook-detail.js`:
  `dataset: { itemId }` on the unplayable row, plus one import + one call on
  the view's `container` after the view rendered
- `public/js/admin.js`: one import + one `mountConversionPanel(main)` call
- `test/constitution.test.js` (see Constraints), `test/config.test.js`,
  `test/db/library-repo.test.js` (effective-playable cases),
  `test/server.test.js` (startup recovery with the feature off)
- `README.md` + `.env.example` (config issue)

**Made in this spec PR:** `docs/vision.md`, `docs/constitution.md`,
`docs/architecture.md` (Foundation impact).

### Cross-phase contract P7 relies on

- **P1:** `requireAdmin`/`requireUser`, `sendJson`/`sendError`,
  `request(method, path, opts)`, `el()`, `injectStylesheet(href)`,
  `startTestApp({ mediaRoot, ...extra })` (extra deps flow into `createApp`;
  `deps` is the live object the server dispatches with),
  `test/route-auth.test.js` (401 of every route, picks new routes up
  automatically), `createStop` in `src/server.js`, the mutation guard
  (same-origin `Origin`; no content-type check without a body), and the
  migration runner (all files ascending, one transaction each).
- **P2:** `library_items` (`rel_path` UNIQUE, `category`, `kind`, `ext`,
  `playable`, `size`, `mtime_ms`), `upsertItem`, `getItemById`, `toItemJson`,
  `resolvePlayable`, `sniffMp4Codecs`, and the DOM contract (`data-item-id` on
  movie card and episode row roots, unplayable ones as `<div>`).
- **P3:** `resolveMediaPath(root, rel, { platform })` (root-agnostic;
  realpath containment) and `sendMedia`.
- **P4/P5:** progress keyed by `(user_id, rel_path)`; readers filter on
  `library_items.playable`.

## Prior art

- [On-demand browser-safe copies (Phase 7)](../prior-art.md#on-demand-browser-safe-copies-phase-7)
  — Plex "same item, other file", with no version picker. Copies go outside the
  source folder, and a vanished source does not remove its copy right away.
  The pre-transcode plugin's "output directory, originals untouched" and its
  queue panel.
- [Conversion job queue and states (Phase 7)](../prior-art.md#conversion-job-queue-and-states-phase-7)
  — Unmanic: explicit pending → processing → completed/failed, failed stays
  failed until a manual re-queue, and a short error per job. Tdarr: staging
  first and publishing only a finished file; AVOID non-terminal states without
  startup recovery.
- [Converter child-process supervision (Phase 7)](../prior-art.md#converter-child-process-supervision-phase-7)
  — `spawn` with an argv array and `shell: false`, no `unref()`. The Windows
  and process-group caveats explain why the group kill waits for Phase 8.
- [External converter contract (Phase 8)](../prior-art.md#external-converter-contract-phase-8)
  — the source of the JSON Lines fields, the exit codes, the one-empty-dir-per-job
  rule and the own-sniff rule the stub emulates.
- [Converting on weak hardware without hurting playback (Phase 8)](../prior-art.md#converting-on-weak-hardware-without-hurting-playback-phase-8)
  — parallel 1080p encodes gain little on a Pi 4, which backs one job at a
  time.

## Design

The committed exports are the durable design. They are hand-built,
self-contained HTML files using only the `docs/design.md` tokens, rendered to
PNG with headless Edge. Google Stitch (project `videothek`) was the intended
editor, but `generate_screen_from_text` timed out on every call during this
planning cycle. The exports were therefore derived from the already committed
Stitch-based exports (`library-video/`, `music-audiobooks/`,
`foundation-accounts/`) and reviewed in-session against the contract (tokens
only, 4 px spacing, contrast, 44 px targets, both viewports, German copy) and
against the UI behaviour above.

- Conversion control on movie cards and episode rows. Every control state is
  shown, including the POST error text and the in-flight disabled button:
  `docs/design/assets/conversion-core/control-video-desktop.png`,
  `docs/design/assets/conversion-core/control-video-mobile.png`
  (+ `.html` layout references).
- Conversion control on album track rows and audiobook file rows:
  `docs/design/assets/conversion-core/control-audio-desktop.png`,
  `docs/design/assets/conversion-core/control-audio-mobile.png`
  (+ `.html` layout references).
- Admin "Konvertierung" panel with the usage line and the groups. A framed
  reference inset shows the disabled, empty and load-error texts:
  `docs/design/assets/conversion-core/admin-panel-desktop.png`,
  `docs/design/assets/conversion-core/admin-panel-mobile.png`
  (+ `.html` layout references).

Notes for the implementer. Where an export and this spec differ, the spec
wins:

- The screens are state showcases, not literal pages:
  - `control-video` shows a curated grid, with one non-playable card per
    control state, and a compact series-detail excerpt.
  - `control-audio` combines an album view with a compact audiobook file
    list.
  - `admin-panel` shows a shortened, illustrative user list above the new
    section.

  Titles, counts, sizes and reasons are sample data.
- The dashed "Weitere Zustände (Referenz)" box in `admin-panel` only frames
  the review. The real disabled, empty and load-error states are plain text
  under the H2.
- Host DOM follows this spec: non-playable hosts are
  `<div class="media-card" data-item-id>` / `<div class="episode-row"
  data-item-id>` (never links). `.convert-control` is the host's last child.
  On a 390 px episode, track or file row it drops onto its own line below
  the title instead of squeezing it.
- All conversion buttons (Konvertieren, Erneut versuchen, Neu laden,
  Erneut konvertieren) use the secondary button variant. The primary orange
  stays reserved for each page's own main action.
- The mobile PNGs are real 390 px viewports rendered at 2x (780 px wide).
  The exported HTML is a layout reference only, never copied verbatim.

## Human prerequisites

None: nothing blocks implementation, since every machine test uses the stub
and generated files.

QA-only (at the milestone QA gate, not a blocker):

- A sample directory without spaces in its path, with a real playable
  `sample.mp4` (H.264/AAC), a `sample.flac` and a `sample.opus`.
- `CONVERTER_CMD="<absolute node path without spaces> <repo>/test/helpers/converter-stub.js --sample-dir <dir> --delay-ms 15000"`
  in `.env` (on this machine `C:\nvm4w\nodejs\node.exe` works; otherwise the
  8.3 short name).
- Not-playable library items: an `.mkv` movie, an `.mkv` episode, a `.wma` or
  `.ape` music track and a `.wma` audiobook file.
- A second, non-admin account. Chromium and Firefox.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Human decision (H1): the "Konvertieren" button, and all conversion UI and API, is admin-only (`requireAdmin`) | Every conversion costs CPU and storage on the Pi; household members cannot act on the status, and after a conversion they simply see a playable item | 2026-09-28 |
| Human decision (H2): no "Alle konvertieren" in Phase 7 | Bulk jobs need their own queue management (cancel, reorder, priorities) | 2026-09-28 |
| Human decision (H3): copies are keyed by a hash of `rel_path` (`storage_key = sha256`), with source size/mtime stored to detect a stale copy; not by `library_items.id` | Index ids change when an item vanishes and reappears or the index is rebuilt. `rel_path` is the stable natural key, the same reasoning as `progress` | 2026-09-28 |
| Human decision (H4): video goes through the converter's `--to web`; audio through `flac`/`opus` | `--to mp4` keeps HEVC/AC3; `--to webm` re-encodes all h264; `web` copies only browser-safe streams. `flac`/`opus` force a browser codec via the muxer | 2026-09-28 |
| Human decision (H5): storage usage is displayed only; no limit is enforced in Phase 7 | Enforcement needs deletion, which arrives with cleanup in Phase 8 | 2026-09-28 |
| **OPEN (O1) — resolved at the spec-acceptance gate:** "Neu laden" on `/music` and `/audiobooks` | `location.reload()` ends the persistent bottom-bar player there. Options: (a) accept `location.reload()` everywhere in Phase 7; (b) the decorator takes an optional `onReload` callback and the two audio views pass a re-render of the current route (touches the audio views and `app.js` beyond one hook line). **Recommendation: (a)** — only the admin sees the button, once per conversion, and the item is playable after any later navigation | 2026-09-28 |
| **OPEN (O2) — resolved at the spec-acceptance gate:** fresh row whose copy file is gone (deleted by hand, or `CONVERT_DIR` changed without moving the copies) | Today the item stays `playable = 1`, `/media` answers `404 not_found`, and the admin cannot act (a playable item has no control; POST answers 409). Options: (a) accept until the Phase-8 cleanup, which reconciles missing copies, and document in the README "CONVERT_DIR nur zusammen mit den Kopien verschieben"; (b) POST treats a fresh row whose `output_rel` does not resolve as stale and re-queues, and the admin panel's "Fertig" group shows "Kopie fehlt" + "Erneut konvertieren" (a file check per listed row); (c) at startup, rows whose copy is missing become `failed` `copy_missing` and their items get `scan_version = 0` for a re-parse. **Recommendation: (a)** — a manual-intervention case in a one-household app, and Phase 8 needs the flag-reset mechanism anyway | 2026-09-28 |
| **OPEN (O3) — resolved at the spec-acceptance gate:** `MEDIA_ROOT` temporarily unmounted while jobs are queued | Every queued job fails `source_missing` one after another, with no automatic retry. Options: (a) accept (Unmanic: manual re-queue per item); (b) when a source does not resolve and `fs.realpath(mediaRoot)` itself fails, the job puts its row back to `queued` (`started_at = NULL`), logs `conversion_paused { reason: 'media_root_unavailable' }`, and the queue claims nothing until the next `kick()` from a `POST` or a restart (no timer, so still no automatic retry). **Recommendation: (b)** — a few lines in the job, and it keeps the queue intact across a USB-disk hiccup, which is the realistic failure on the Pi | 2026-09-28 |
| `library_items.playable` = source direct-play OR fresh conversion, computed in `upsertItem`'s SQL and set in the publish transaction | About ten readers across P2–P6 filter on the column, and progress `PUT` rejects `playable = 0`. One flag keeps them all correct with no edits. Computing it on upsert (not only on publish) keeps the index rebuildable (vanish/reappear, `SCAN_VERSION` bump) | 2026-09-28 |
| Conversion rows reference `rel_path`, with no FK and no cascade | Plex AVOID: a vanished source must not delete its copy at once, because root safety expects items to reappear. Cleanup with a grace period is Phase 8 | 2026-09-28 |
| One queue, one job at a time, FIFO by `queued_at` (ties by `rel_path`), claim in a `BEGIN IMMEDIATE` transaction | Prior art: parallel 1080p encodes gain little on a Pi 4; the Unmanic multi-worker pool is an AVOID. A sequence column for same-millisecond ties is not worth a column | 2026-09-28 |
| Recovery (`converting` → `failed` `interrupted`; `queued` survives) runs in `src/server.js` at every startup, also with the feature off; graceful stop also ends the running job as `failed` `interrupted` | Tdarr AVOID (stuck non-terminal states) plus Unmanic ADOPT (no automatic retry loop). Re-queueing on restart could loop forever on a job that hangs or crashes the host, and Phase 7 has no cancel. Running it only in `queue.start()` would leave a row stuck once `CONVERTER_CMD` is removed | 2026-09-28 |
| `stop()` sets `stopping` synchronously at the start of `createStop`, and the job is the single writer of its end state; after `stopping`, any job end is `interrupted` without interpretation | A job finishing during `app.close()` (up to 5 s) would otherwise claim and spawn the next queued row; an unawaited `failConversion` would hit a closed DB. Ctrl+C or systemd `KillMode=control-group` signal the child together with videothek. A residual race (the child's `close` handled before the SIGINT handler) records `converter_interrupted`; both codes read "Abgebrochen" and neither retries | 2026-09-28 |
| `kick()` is a no-op until `start()` resolved; `server.js` awaits `queue.start()` before `listen()` | Otherwise `start()`'s `.work` wipe could delete a freshly claimed job's dir | 2026-09-28 |
| An unusable `CONVERT_DIR` (mkdir fails, or realpath overlap with `MEDIA_ROOT` via a symlink) disables conversions with a log line instead of failing startup | Same principle as a missing converter: conversion problems must never take down the media server. The lexical config check cannot see symlinks, and the dir may not exist at config time | 2026-09-28 |
| No automatic retry; retry = `POST` again | Unmanic: failed stays failed until the user re-queues | 2026-09-28 |
| `CONVERTER_CMD` is split on whitespace, with no quoting; the first token must be absolute; there is no existence check; it is validated in every config mode | No shell and no hand-rolled shell grammar. An absolute path avoids `PATH` surprises under systemd. A missing converter must fail jobs, not the media server. Every-mode validation follows the `PORT` precedent | 2026-09-28 |
| `CONVERT_DIR` defaults to `<DATA_DIR>/converted`, is configurable, and must not overlap `MEDIA_ROOT` in either direction (lexically in config, by realpath in `start()`) | Big copies may belong on the USB disk rather than the SD card. The deletes under `.work/` must never reach media | 2026-09-28 |
| The converter gets an allowlisted environment (`config.converterEnv`) | `ADMIN_PASSWORD` must not leak into a third-party process; only `src/config.js` reads `process.env`. Windows/Python additions wait for the Phase-8 adapter | 2026-09-28 |
| One fresh unique work dir per attempt (`mkdtemp` under `CONVERT_DIR/.work/`, converter writes into its realpath'd `out/`), removed as a whole in `finally`; then an atomic `rename` into `CONVERT_DIR/<key>/<fixed name>` | Converter prior art: two calls into one dir give a silent `SKIPPED`, and an orphan from a crash must not write into a retry's dir. The `out/` level keeps an escaping output inside the removed job dir; the realpath avoids false `..` on a symlinked `DATA_DIR`. Tdarr ADOPT: staging, then publish. Fixed names keep every served path free of user-controlled names | 2026-09-28 |
| `runConverter` returns `{ result, kill }`, builds the argv itself, settles on `'close'`, and reports `killedBy` (`cap`/`stop`/`null`) | One shape for the real runner and the fake in `queue.test.js`; `interpretRun` can tell a foreign signal from its own cap kill; on Windows `'exit'` can precede stdio EOF | 2026-09-28 |
| A result counts only after videothek's own check: strict MP4 sniff (unknown = fail, ≥ 1 video track) or FLAC/Ogg-Opus magic (`OpusHead` after the segment table), plus a source re-stat; `--to web` always writes MP4 | Converter v3.1.0 reports HEVC/AC3 remuxes as "converted"; the scanner's lenient "unknown = playable" is wrong for a result we publish. A WebM `web` output would fail the extension rule | 2026-09-28 |
| Phase 7 parses only `outcome`, `output` (absolute), `error`, `notes` of exactly one per-file record; `skipped` is invalid; notes are truncated (10 × 200), bad types are invalid | Minimal fields, so the Phase-8 converter spec can still shape the rest. A fresh empty dir makes `skipped` impossible | 2026-09-28 |
| stderr is never logged; only its redacted tail is stored as `error_detail` (root prefixes replaced, ≤ 500 chars) | ffmpeg's stderr carries absolute source paths, and item JSON deliberately never exposes paths; H1 (admin-only) is only the backstop | 2026-09-28 |
| Failure codes: work-dir `mkdtemp`/`mkdir`/`rm` and publish errors → `storage_failed`; source `stat` ENOENT/EACCES → `source_missing`; any other throw → new code `internal` ("Interner Fehler") + `conversion_error` log | Every job must end in a terminal state with a displayable reason, and the `kick()` chain must never leave an unhandled rejection | 2026-09-28 |
| Audio target: `audiobooks` → `opus`; `music` lossless-capable exts → `flac`, other music → `opus`; `mid`/`midi` not convertible; zero-byte sources not convertible | Opus fits speech and keeps multi-hour books small. FLAC avoids a second lossy generation for lossless music. ffmpeg has no MIDI synthesis by default. A zero-byte file can only fail | 2026-09-28 |
| Gallery videos (`images` category) are not convertible in Phase 7 | The gallery renders tiles lazily in batches, so a one-shot decorator misses later tiles, and `public/js/images.js` is at 298 lines. It needs its own hook design; this is a follow-up | 2026-09-28 |
| UI = a DOM decorator on the four video/audio pages plus an admin panel; no player-panel control | Precedent: P4's `decorateProgressFor` (one import + one call, no edit of other phases' builders or CSS). Not-playable cards do not link to the player, and `player.js` is at 300 lines | 2026-09-28 |
| The decorator's `403` doubles as the role check | `mountShell` returns `me` on the four non-audio pages, but the audio SPA has no `me` in its view params. Cost: one small `403` per render in a household member's browser console | 2026-09-28 |
| `POST` on a `queued`/`converting` item → `200` with the current entry; a directly playable or freshly converted item → `409 already_playable`; feature off → `503 conversion_disabled`; the UI turns `409` into "Konvertiert" and removes the control on `400`/`404`/`503` | Idempotent double-clicks; explicit codes for real conflicts; a missing server capability is not a client error | 2026-09-28 |
| A copy is served whenever it is fresh, even when the queue is disabled | Unsetting `CONVERTER_CMD` stops new work but must not make converted items unplayable | 2026-09-28 |
| Pre-authorised file splits (`config-converter.js`, `conversion-queries.js`, `job.js`, `work-dir.js`, API test by route) | `src/config.js` is at 228 lines and the 300-line limit is enforced by `test/constitution.test.js` | 2026-09-28 |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file: one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (`npm run verify`):

- [ ] Verify passes; `npm ls --omit=dev --all` lists no packages; every new
      `src/` module has its mirrored test.
- [ ] `test/constitution.test.js`: `child_process` is still rejected in every
      other `src/` file and in `public/`. `src/convert/run-converter.js`
      imports only `{ spawn }` from `node:child_process`, `/\bshell\s*:/` does
      not match, and it has no `exec`, `execFile`, `execSync` or `fork`
      identifier.
- [ ] `test/config.test.js` (or `test/config-converter.test.js`):
  - `CONVERTER_CMD` unset/empty → `null`
  - a relative first token, or more than 32 tokens → problem, also under
    `requireMediaRoot: false`; the problem text never contains the value
  - `CONVERT_DIR` default, and a problem when it is inside `MEDIA_ROOT` or
    `MEDIA_ROOT` is inside it (only under `requireMediaRoot`)
  - `converterEnv` never contains `ADMIN_PASSWORD`
- [ ] `test/db/conversions.test.js`:
  - 006 applies on a DB at 005 and as a gap; re-running it is a no-op
  - claim is FIFO (ties by `rel_path`) and claims at most one row
  - publish sets `library_items.playable = 1` only for a matching size/mtime
  - `failInterruptedConversions` touches only `converting` rows
  - usage sums copies of vanished items too
- [ ] `test/db/library-repo.test.js`: effective playable.
  - An upsert with a fresh `playable` conversion yields 1.
  - A changed size or mtime yields the source flag (0).
  - A deleted and re-inserted row with the same size/mtime yields 1.
  - A `failed`/`queued` row yields 0.
  - Every existing test that calls `upsertItem` still passes (all of them
    migrate the default directory).
- [ ] `test/convert/targets.test.js`: the mapping table row by row, including
      `mid`, images and gallery video → `null`; `isConvertible` is false for
      `size = 0` and for playable rows; `storageKey` is 64 hex chars, stable,
      and differs for NFC/NFD spellings.
- [ ] `test/convert/run-converter.test.js` (real stub):
  - `echo`: the argv reaches the stub exactly as `[…cmd, '--to', t, '--json', src, out]`
    (no shell: a source name with `;`, `$()` and spaces arrives as one
    argument; no NTFS-forbidden characters) and the env is only the given
    object
  - a 64 KiB line cap and a 1 MiB total cap kill `flood` (`killedBy = 'cap'`,
    `stdoutInvalid`)
  - a multi-byte character split across chunks decodes intact
  - `kill('SIGTERM')` on `hang` → `killedBy = 'stop'`
  - a missing executable and a synchronous spawn throw → `spawnError`; `result`
    never rejects
  - bad field types, a relative `output`, and > 10 notes (truncated) behave
    as specified
- [ ] `test/convert/result.test.js`: every interpretation rule and its order
      (exit 2 with valid JSON → `converter_unavailable`; exit 1 + `garbage` →
      `converter_output_invalid`; 0 or 2 records; each outcome; a foreign
      signal vs a cap kill vs 130); `redactDetail` replaces both roots and
      cuts to 500 characters.
- [ ] `test/convert/verify.test.js`:
  - an `avc1`+`mp4a` MP4 passes
  - `hvc1`, audio-only, unknown-sniff (no `moov`) and zero-byte MP4s fail
  - FLAC magic pass/fail; Opus with `page_segments` 1 and > 1 passes, a wrong
    magic fails
  - wrong extension; an output outside `outDir` and a symlink escape →
    `converter_output_invalid` (the symlink case skips on Windows `EPERM`)
- [ ] `test/convert/queue.test.js` (fake `run` returning `{ result, kill }`):
  - only one job at a time; FIFO order (constant `now` → `rel_path` order)
  - `kick()` before `start()` resolved and during a job is a no-op
  - the next job starts after a failure; an unexpected throw → `internal`
  - `stop()` prevents new claims, including a job finishing while `stop()` is
    pending; `stop()` resolves only after the job's DB write and cleanup
  - a run ending by a foreign signal after `stop()` → `interrupted`
- [ ] `test/convert/queue-lifecycle.test.js` (real stub):
  - `ok` publishes `<key>/web.mp4`, the flag and `output_size`, and removes the
    work dir
  - `not-browser-safe` → failed, flag stays 0, no file under `<key>/`
  - `crash`/`hang`+`stop()`/`usage`/`escape` → the matching code, and
    `.work/` is empty afterwards
  - a source modified between `--hold` `started` and `go` → `source_changed`
  - startup with a leftover `.work/x` → wiped; a `start()` with an
    unwritable or overlapping `convertDir` resolves `false` and writes nothing
  - `error_detail` contains no absolute root path; no log line contains a
    path or stderr text
  - nothing outside `convertDir` is created or removed (checked with a
    temp-dir listing)
- [ ] `test/server.test.js`: a `converting` row becomes `failed`
      `interrupted` at startup with `CONVERTER_CMD` unset; `queued` rows stay.
- [ ] `test/api/conversions.test.js` (boot with `startTestApp`, then build a
      stub-backed queue with `{ …config, converterCmd: [process.execPath, stub, …],
      converterEnv }`, `await queue.start()`, assign `app.deps.conversions`;
      `await queue.stop()` before `close()`):
  - 401 without a session and 403 for a user, on both routes
  - foreign `Origin` → 403
  - bad and unknown ids → 404
  - disabled → 503, and `GET` shows `enabled: false`
  - image, gallery video, `.mid`, a zero-byte file → 400 `not_convertible`
  - a playable MP4 → 409; a second `POST` while queued → 200, same entry
  - the 202 entry of an idle queue already reports `converting`
  - retry of `failed` → 202; a stale copy reports `stale` and re-queues
  - `ids` validation (empty, 501 ids, bad token → 400); unknown ids omitted;
    `status: none`
  - `position` counts waiting rows only; group ordering; `usage` including
    `freeBytes`
- [ ] `test/api/media-converted.test.js`:
  - a converted MKV item streams the copy with `video/mp4`, `206` for a
    Range, `416` beyond the end, and `HEAD` without a body
  - a stale copy → `404 not_playable`
  - a fresh row whose file was removed → `404 not_found`
  - an `output_rel` tampered to `../x` or an absolute path → `404`
    (containment)
  - the original under `MEDIA_ROOT` is byte-identical afterwards
  - `PUT /api/progress/:id` for the converted item → 200 (not
    `not_resumable`)
- [ ] `test/public/conversion-format.test.js`: `statusLabel` for all six
      states (queue position included), and a German reason for every failure
      code including `internal`.

Human QA (Chromium + Firefox, stub with `--sample-dir` and `--delay-ms` per
Human prerequisites, phone 390 px and desktop 1440 px, compared with the design
exports):

- [ ] As admin, `/movies`: the MKV card shows "Konvertieren". Press it: "Wird
      konvertiert …" (or "In Warteschlange" while another job runs), then
      "Konvertiert" + "Neu laden". After the reload the card links to the
      player and the sample plays with seeking.
- [ ] Queue two episodes and a music track quickly: the second and third show
      "Platz 1"/"Platz 2", and they run one after the other.
- [ ] Watch the converted movie to ~5 min, then open it in the other browser:
      it resumes within ±10 s and appears in "Weiterschauen".
- [ ] Set `--mode fail` in `CONVERTER_CMD` and restart: a conversion shows
      "Konvertierung fehlgeschlagen: Der Konverter meldet einen Fehler". Switch
      back to `ok`, and "Erneut versuchen" succeeds.
- [ ] Restart the service (Ctrl+C) during `--mode hang`: after the start the
      row shows "Abgebrochen" and the queued items continue.
- [ ] As a non-admin user: no control anywhere, and the converted item plays.
- [ ] `/admin` shows the "Konvertierung" panel with the groups, the usage line
      in GB and the free space. With `CONVERTER_CMD` removed it shows the
      not-configured line, and the converted movie still plays.
- [ ] Touch the source MKV (new mtime): after the rescan the card is "Nicht
      abspielbar" with "Konvertieren", and the admin panel lists it under
      "Veraltet".
- [ ] Keyboard only: Tab reaches every "Konvertieren"/"Erneut versuchen"/"Neu
      laden" button, the focus ring is visible, and a screen reader announces
      status changes.
- [ ] `MEDIA_ROOT` is unchanged (file list and mtimes before and after QA).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| The Phase-8 converter's JSON shape differs from this minimum | Only four fields, the MP4 rule for `web` and the exit codes are fixed here; the Phase-8 adapter issue adapts `interpretRun`, never the queue or the DB |
| A converter hangs forever and blocks the queue (no cancel/timeout in Phase 7) | A restart ends it as `failed interrupted` (no loop); cancel and timeout arrive in Phase 8. The admin panel makes a long "Läuft gerade" visible |
| SIGTERM does not stop a Python converter's ffmpeg grandchild, and an orphan may keep writing after a crash | Irrelevant for the stub. A unique work dir per attempt keeps an orphan out of a retry. Phase 8 introduces the process-group kill and the converter's `.partial` cleanup; `.work/` is wiped at the next start regardless |
| On Windows (dev) `kill('SIGTERM')` is `TerminateProcess` and file handles linger | Runner settles on `'close'`; every `rm` has `maxRetries: 3`; the symlink test skips on `EPERM`. Production is Linux |
| The strict sniff misses DTS/MP2 in `mp4a` or 10-bit h264 (`avc1`) | Known sniffer gap (prior art). The `web` target is specified to re-encode those; the human QA of Phase 8 checks real files |
| The upsert SQL now references `conversions`, so a test applying only some migrations and then calling `upsertItem` would break | Verified 2026-09-28: every test that calls `upsertItem` migrates the default directory (`test/db/audio-meta-repo.test.js`'s `makeDb` included); the partial-directory tests (`audio-meta-repo` 004 case, `image-meta`, `migrate`) never call it. The library-repo issue re-checks this and adds the regression cases |
| Phase 8 cleanup deletes a `playable` row but leaves `library_items.playable = 1` | Stated contract for Phase 8: delete the row, then reset the flag in the same transaction by setting `scan_version = 0` for that path (forces a re-parse) or recomputing it |
| `rename` over a stale copy that is streaming (Windows `EPERM`) | Target is Linux (rename over an open file is fine). On Windows the job ends `storage_failed` and can be retried |
| Many not-playable items create large `ids` requests | Batches of ≤ 500 ids; one indexed query per batch |
| The four page hooks conflict with parallel issues | One import + one call per file, next to the existing `decorateProgressFor` line; a rebase resolves it |
| Disk fills up, since no limit is enforced | Usage and free space are visible on `/admin` (H5); enforcement comes in Phase 8 |
| Paths with spaces in `CONVERTER_CMD` | Documented as unsupported (README: 8.3 short name on Windows); production uses a venv path without spaces |
| A source re-copied with `cp` gets a new mtime and loses its copy | Documented in the README; `mv`/`rsync -t` keep the copy fresh. Stale copies are re-convertible |

## Decision log

- 2026-09-28: Spec drafted. The five human decisions from the idea sparring
  are recorded as H1–H5. The Phase-7 foundation amendments (vision scope,
  constitution config/containment/child-process/derivability rules,
  architecture component, boundaries and Convert flow) are made in this spec
  PR.
- 2026-09-28: Pre-mortem folded in. Fixed: `runConverter` shape
  (`{ result, kill }`, `killedBy`, settle on `close`, sync spawn throw);
  interpretation rule 2 via `killedBy`; stop ordering (synchronous `stopping`
  at the start of `createStop`, job as single writer, `stop()` awaits the
  whole job); `kick()` gated on `start()`; recovery moved to `server.js` at
  every startup; unusable or symlink-overlapping `CONVERT_DIR` disables
  conversions; unique `mkdtemp` work dir with realpath'd `out/`; stub `echo`,
  `--delay-ms`, `--hold`; stderr never logged, `error_detail` redacted;
  new failure code `internal`; Opus magic after the segment table; `web`
  always MP4; notes/line-cap rules; `isConvertible` excludes zero-byte
  sources; GET ordering and waiting-only positions; UI handling of
  409/400/404; one poller per root; `AppDeps.conversions`; API tests attach
  the queue after boot; pre-authorised file splits; constitution-test
  exemption details; architecture boundary and frontend row clarified. The
  claimed `audio-meta-repo` migration breakage was checked and does not
  occur. Open for the gate: O1 ("Neu laden" in the audio section), O2
  (missing copy file), O3 (unmounted `MEDIA_ROOT`).
