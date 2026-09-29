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
      `503 conversion_disabled` for a known item id (an unknown or malformed
      id gets `404 not_found` first), no child process is ever started, and copies
      converted earlier keep playing.
- [ ] An admin sees "Konvertieren" on every convertible not-playable movie card
      (`/movies`), episode row (`/series-detail`), album track (`/music`) and
      audiobook file (`/audiobooks`). Pressing it shows "Wird konvertiert …" on
      an idle queue (else "In Warteschlange · Platz N" first), then
      "Konvertiert" with "Neu laden". After the
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
      `converting` (also when `CONVERTER_CMD` was removed meanwhile). A
      half-written file in the work area is removed by the next queue start
      (with the feature off, the work area is left as it is until it is
      enabled again).
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
- `src/convert/`: target mapping, pure JSON Lines reader, converter spawn, run
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
  (Windows `PATHEXT`/`COMSPEC`/`APPDATA`, `PYTHONUTF8`; libuv already injects
  `WINDIR`, `USERPROFILE`, `SYSTEMROOT`, `TEMP` and the rest of its fixed
  Windows set when missing, see Config) and `redactDetail`'s gaps for a
  Python converter: a traceback through a venv prints paths outside
  `path.dirname(converterCmd[0])`, and Python's `repr` doubles backslashes
  on Windows, so neither is matched by the plain root spellings.
- Process-group spawn and kill (`detached` plus `kill(-pid)`) for every kill
  the app sends: `stop()`'s SIGTERM, its `killGraceMs` SIGKILL escalation and
  the runner's stdout-cap SIGKILL. CPU/IO priority (`nice`/`ionice`), and
  playback protection while converting (Phase 8).
- Cancelling a queued or running job, and a per-job timeout (Phase 8 cancel).
- Deleting copies: stale-conversion cleanup, cleanup of vanished sources,
  storage-limit enforcement (Phase 8, H5).
- "Alle konvertieren" and any bulk or automatic conversion (H2).
- Videos in the `images` category (gallery). `targetFor` returns `null` for
  them in Phase 7 (see Prior decisions; follow-up is roadmap Phase 9).
- A control on the player's not-playable panel. Not-playable cards do not link
  to the player, and `public/js/player.js` is at 300 lines.
- Showing conversion state to non-admin users (H1).
- Progress within a single file (the converter reports only per file) and a
  version picker. Serving the copy is transparent: the item JSON keeps the
  source's `ext`, `size` and codecs (a converted MKV still shows "MKV"); no
  client code keys on them for playback (`player.js` checks only `playable`).
  Likewise converted audio keeps the source's `duration: null`
  (`audio_meta.duration_ms` comes from the mp3/flac tag readers only, and the
  copy is never re-read); the player reads the duration from the media
  element, and audiobook progress falls back to the duration reported with
  progress (`src/api/audiobook-resume.js`).
- Images (`kind = 'image'`), which are never convertible.

## Constraints

- The constitution applies as amended by this spec: zero runtime deps, SQL only
  in `src/db/` as prepared statements, JSON errors `{ "error": "<code>" }`,
  JSDoc on every export, ≤ 60 lines per function, ≤ 300 lines per file (JS, CSS,
  tests), a mirrored `test/` file for every new `src/` module, German UI copy,
  no `innerHTML` with unescaped data, and `process.env` only in
  `src/config.js` (`src/`; stub exception: constitution.md Conventions). Also binding, from other sources: raw values only in
  `public/css/tokens.css` (`docs/design.md`) and no `console.*` in `src/`
  (`test/constitution.test.js`, "src/ never calls console.*").
- Child processes: only `src/convert/run-converter.js` imports
  `node:child_process`, and it uses only `spawn`. It builds the argv itself:
  `spawn(cmd[0], [...cmd.slice(1), '--to', target, '--json', source, outDir])`
  with `shell` never set (Node default `false`), no `detached`,
  `stdio: ['ignore', 'pipe', 'pipe']`, `windowsHide: true`, `env` and
  `cwd` = the per-job dir (the parent of `outDir`), so relative writes of the
  converter land in the removed work dir, never in videothek's own cwd.
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
  that `child_process` occurs exactly once (no second or dynamic import),
  that `/\bshell\b/` matches nowhere (also catches `opts.shell = true` and
  `{ shell }`; the file never needs the word), and that no bare call of `exec`,
  `execFile`, `execSync`, `execFileSync` or `fork` occurs, checked with
  `/(?<![.\w$])(?:exec|execFile|execSync|execFileSync|fork)\s*\(/`. A member
  call such as `re.exec(` is allowed: with only `{ spawn }` importable, no
  `child_process` function can be reached through a member.
- Containment: every path taken from a client, from the DB (`rel_path`,
  `output_rel`) or from the converter goes through `resolveMediaPath(root,
  rel)` from `src/media/paths.js`, which is root-agnostic and is not changed.
  Sources resolve against `config.mediaRoot`. The converter's reported output
  resolves against the job's realpath'd `out/` dir. Served copies resolve
  against `config.convertDir`. A violation fails the job or answers `404`.
  Paths the queue composes from the hex `storage_key` and fixed names are
  internal (architecture Boundaries).
- Deletes, renames and replacements happen only under `CONVERT_DIR`
  (architecture.md Boundaries). Recursive removals happen only on
  `CONVERT_DIR/.videothek-work/` or inside it (`start()`'s wipe, step 7); the
  only other removals are `start()`'s `unlink` of a non-directory
  `.videothek-work` entry and the publish `rename` into
  `CONVERT_DIR/<storage_key>/`, which replaces a stale copy. The work area has a distinctive name so that a `CONVERT_DIR`
  pointed at an existing shared directory never loses an unrelated `.work`
  folder. Every `rm` uses `{ recursive: true, force: true, maxRetries: 3 }`
  (Windows handles linger briefly).
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
| `CONVERTER_CMD` | unset/empty → `null` (feature off). Otherwise split on `/\s+/` after trimming, with no quote or escape handling. 1–32 tokens; the first token must be an absolute path, and on `win32` it must also start with a drive letter (`X:\` or `X:/`) or a UNC prefix (`\\`), because a rooted `\node.exe` counts as absolute but depends on the current drive (`parseConverterCmd(value, { platform = process.platform } = {})`, tested with `platform: 'win32'`). It is not checked for existence, so a missing converter fails jobs (`converter_unavailable`) and never blocks startup. Validated in every mode, also under `requireMediaRoot: false` (precedent: `PORT`), so an invalid value also stops the reset-password CLI. | `converterCmd: readonly string[] \| null` (`Object.freeze` of the token array, so the type is `readonly`; `runConverter`'s `cmd` is typed the same) |
| `CONVERT_DIR` | unset → `<dataDir>/converted`. Otherwise resolved against `cwd` like `DATA_DIR`. Only under `requireMediaRoot` and only when `mediaRoot !== ''` (no valid `MEDIA_ROOT`: the same guard as `resolveDataDir`, because `isInside('', x)` resolves `''` as `cwd` and would fire falsely): `CONVERT_DIR` must not be inside `MEDIA_ROOT` and `MEDIA_ROOT` must not be inside `CONVERT_DIR` (both directions, via the existing `isInside`, lexical; problem `CONVERT_DIR: must not overlap MEDIA_ROOT`). When `CONVERT_DIR` is unset (default derived from `DATA_DIR`), this problem is not pushed if the `DATA_DIR: must not be inside MEDIA_ROOT` problem already fired, so a bad `DATA_DIR` still yields exactly one problem (the existing `test/config.test.js` assertions stay green). An explicitly set `CONVERT_DIR` is always checked in both directions. In every mode, `CONVERT_DIR` must not lie inside the app's `public/` directory (static files are served without a session): the directory is `APP_PUBLIC_DIR`, exported by `src/config-converter.js` and derived lexically from its `import.meta.url` (`<src>/../public`, as `src/app.js` does); `src/config.js` checks against it and pushes `CONVERT_DIR: must not be inside the public directory`. Not created here; the realpath checks (`MEDIA_ROOT` overlap and `public/`) follow in the queue's `start()`. | `convertDir: string` |
| — | Child environment (`pickConverterEnv(env, { platform = process.platform } = {})` in `src/config-converter.js`): copies only `PATH`, `HOME`, `LANG`, `LC_ALL`, `SystemRoot` (those set) from `env`. The lookup is case-insensitive on `win32` (a plain-object `env` there spells it `Path`); the copy keeps the key as found. On `win32`, libuv additionally copies a fixed set from the parent environment when missing (`HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR`); none of them is `ADMIN_PASSWORD`. No other variable of the videothek process reaches the converter, except libuv's fixed Windows set. `TMPDIR`, `TEMP` and `TMP` are not copied: the job sets all three to its own `tmp/` dir (Queue, step 3). Sufficient for the Node stub; the Phase-8 adapter issue revisits it. | `converterEnv: Readonly<Record<string,string>>` |

Problems use the existing `"<VAR>: <rule>"` format and never include a value.
The pure parsers live in the new `src/config-converter.js` (taking `env` as a
parameter, mirrored by `test/config-converter.test.js`) because
`src/config.js` is at 228 lines; `process.env` is still read only in
`src/config.js`. The private `isInside(parent, child)` of `src/config.js`
moves there as a JSDoc'd export: `src/config.js` imports it for the existing
`DATA_DIR` check and the new lexical overlap check, and the queue's realpath
overlap check imports it too. `src/config-converter.js` imports nothing from
`src/`, so there is no import cycle. The three new `Config` properties are
required in the typedef. Hand-built `Config` objects in existing tests:
`test/server.test.js` (lines 18, 173, 234) and the two `test/cli/reset-password*`
tests cast their literal (`/** @type {…Config} */` or `any`), so `tsc` accepts
them and the fields are `undefined` at runtime (consumers test `converterCmd`
by truthiness, and `media.js` touches `convertDir` only when a fresh
conversion row exists). `test/library/index.test.js`'s `fakeConfig()` returns
an uncast literal typed as `Config` and would fail `tsc` (TS2741), so the
config issue adds `converterCmd: null, convertDir: '', converterEnv: {}` to it
(see "Edited").

README: paths containing spaces are not supported in `CONVERTER_CMD`; on
Windows use a Node path without spaces or its 8.3 short name
(`C:\PROGRA~1\nodejs\node.exe`), and `--sample-dir` must not contain spaces.
Tests are unaffected (they pass arrays). Startup logs `conversion_enabled {}`
or `conversion_disabled {}` and never logs the command. The README also notes
that deleting the database file under `DATA_DIR` orphans the copies under
`CONVERT_DIR` (they are no longer served and can be deleted by hand), and
"CONVERT_DIR nur zusammen mit den Kopien verschieben" (O2). Further
README notes from the config issue:

- Run the service as a user with read-only access to `MEDIA_ROOT`. This is the
  only enforcement that also covers the converter child process (the
  constitution's read-only rule binds videothek's own code; the converter
  contract below binds the converter).
- Until Phase 8, conversions run without `nice`/`ionice`, so on a Pi a running
  conversion can make concurrent streams stutter.
- `CONVERT_DIR` must not lie inside the app's `public/` directory, because
  static files are served without a session (config rejects it lexically,
  and the queue's `start()` rejects a symlink into `public/` by realpath,
  disabling conversions).
- Graceful shutdown stops the converter only through videothek's own
  `stop()`: under Docker run with `--init` (or tini) when videothek is PID 1,
  and under systemd keep the default `KillMode=control-group`, so a converter
  that outlives videothek (second signal, crash) is still reaped.
- On Windows the first `CONVERTER_CMD` token must be an `.exe` with a drive
  letter or UNC prefix: since Node's BatBadBut fix, `spawn` without a shell
  refuses `.bat`/`.cmd` shims (`EINVAL`, which ends the job as
  `converter_unavailable`).
- The converter is trusted code: it runs as the same OS user as videothek
  and can read everything that user can. Real isolation needs a separate OS
  user for the converter (not provided by Phase 7).

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

`targetFor({ category, kind, ext })` → `'web' | 'flac' | 'opus' | null`. The
rows are checked top to bottom and the first match wins, so the `null` row
comes before `audiobooks → opus` (a `.mid` audiobook file is not convertible):

| Source | Target |
|---|---|
| ext `mid` or `midi`, `kind = 'image'`, or category `images` | `null` (not convertible) |
| `kind = 'video'` and category `movies` or `series` | `web` |
| category `audiobooks` (audio) | `opus` |
| category `music`, ext in `ape aif aiff wv dsf dff m4a m4b` (lossless-capable) | `flac` |
| category `music`, any other audio ext | `opus` |

`isConvertible(row)` = `!row.playable && row.size > 0 &&
targetFor(row) !== null` (a zero-byte source would always fail;
`LibraryItemRow.playable` is typed `boolean` while SQLite returns `0`/`1`, so
only a truthiness test type-checks and works for both).
`TARGETS = { web: { file: 'web.mp4', ext: 'mp4', kind: 'video' }, flac: {
file: 'audio.flac', ext: 'flac', kind: 'audio' }, opus: { file: 'audio.opus',
ext: 'opus', kind: 'audio' } }`. `storageKey(relPath)` → `sha256` hex via
`node:crypto`.

### Converter contract and stub

Phase 7 relies on this minimum contract only. The Phase-8 converter release
must satisfy it, and the stub emulates it.

- **Invocation:** `<CONVERTER_CMD tokens…> --to web|flac|opus --json <SRC> <OUTDIR>`,
  where `SRC` is an absolute file and `OUTDIR` an existing empty directory.
  The working directory is the per-job dir (`OUTDIR`'s parent). `TMPDIR`,
  `TEMP` and `TMP` point at the per-job `tmp/` dir (an existing empty sibling
  of `OUTDIR`).
- **Side effects:** `SRC` is only read. The converter creates or changes files
  only inside `OUTDIR` or the given temp dir (no temp or `.partial` file next
  to `SRC`). This converter-side clause lives in `docs/architecture.md`
  (Boundaries, "Converter contract") and here, not in the constitution: the
  constitution keeps only the app-side obligations that its tests can check
  (argv only, no shell, one at a time, per-job `cwd` and temp env,
  allowlisted env without `ADMIN_PASSWORD`, own format check), since
  constitution.md requires verifiable principles. Phase 8 extends the
  contract. videothek hands it over (argv, `cwd`, temp env) and the stub
  tests verify its own side of it; videothek cannot enforce it on a child
  process, so the README recommends a service user with read-only access to
  `MEDIA_ROOT`.
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
  `error_detail`, in a fixed 4 KiB ring buffer (memory stays bounded however
  much the converter prints). stderr is never logged (ffmpeg prints absolute
  paths).
- **Limits:** a single stdout line over 64 KiB, or more than 1 MiB of stdout in
  total, kills the child (`SIGKILL`) and fails the job
  (`converter_output_invalid`). Both caps count bytes before decoding; lines
  are decoded with a `StringDecoder` so a multi-byte character split across
  chunks stays intact. Once a cap trips, the runner stops accumulating stdout
  and destroys the stdout stream, because a grandchild holding the pipe can
  keep writing during the `closeGraceMs` wait.

**JSON Lines reader** (`src/convert/jsonl.js`, pure, mirrored by
`test/convert/jsonl.test.js`): `createJsonLinesReader({ maxLineBytes =
65536, maxTotalBytes = 1048576 })` → `{ push(chunk: Buffer): 'ok' | 'cap',
end(): void, records, invalid }` (byte caps, `StringDecoder`, `\r` stripping,
empty lines skipped) and `validateRecord(value)` → a normalised record, `null`
for an object without `outcome` (ignored), or `'invalid'`. The runner feeds
stdout chunks into it. Keeping these pure makes the line cap vs the total cap,
a multi-byte character split across chunks, bad field types, a relative
`output` and note truncation unit-testable without a stub mode for each.

**Runner** (`src/convert/run-converter.js`):
`runConverter({ cmd, env, target, source, outDir, cwd, closeGraceMs = 2000 })` →
`{ result: Promise<RunResult>, kill(signal): void }`, where
`RunResult = { spawnError, exitCode, signal, killedBy, records, stdoutInvalid, stdioTimedOut, stderrTail }`.

- A synchronous `spawn` throw (EINVAL, …) and the `'error'` event both yield
  `spawnError` (the error code); `result` never rejects. The runner keeps an
  `'error'` listener on the child for its whole lifetime: `ChildProcess.kill()`
  can still emit `'error'` (e.g. `EPERM`) after a successful spawn. Such an
  `'error'` after the spawn succeeded, or after `result` settled, never
  becomes `spawnError` and never surfaces as an unhandled `'error'` event
  (which would crash the server).
- `result` settles on `'close'` (all stdio drained), not on `'exit'`. The wait
  is bounded: if `'close'` has not fired `closeGraceMs` (default 2000) after
  `'exit'`, the runner destroys the stdout/stderr streams and settles with
  what it has read and `stdioTimedOut = true` (records may be incomplete, so
  such a run is never published). A grandchild (e.g. ffmpeg) that inherited the pipes can
  otherwise hold them open forever and block the queue and `stop()`.
- The runner's own timers (cap handling, `closeGraceMs`) are cleared when
  `result` settles, so none keeps the event loop alive.
- `killedBy` is `'cap'` after a cap kill (which also sets
  `stdoutInvalid = true`), `'stop'` after a `kill()` call, else `null`.
- Record validation (`validateRecord` in `jsonl.js`; any violation →
  `stdoutInvalid`): a non-object line, bad
  JSON, `outcome` not in the set, `output` not a string or not
  `path.isAbsolute`, `error` not string/null, `notes` not an array or a
  non-string entry. `notes` keeps the first 10 entries, each cut to 2000
  characters (the job redacts, then keeps its first 200 characters, so a root
  spelling inside the first 2000 characters is never split by the cut before
  redaction).
- `stderrTail`: the last 4 KiB (ring buffer) as bytes, leading UTF-8 continuation bytes
  (`0x80`–`0xBF`) dropped, then decoded; once the buffer has wrapped,
  everything up to and including the first `\n` is dropped too (a partial
  first line could hold a cut root spelling that `redactDetail` misses).
- It does not interpret the result.

**Interpretation** (`interpretRun(run, { target })` in
`src/convert/result.js`, pure). The first matching rule wins:

1. `spawnError` → `converter_unavailable` (detail = the error code only, e.g. `ENOENT`; never `err.message`, which carries the converter path)
2. `signal !== null && killedBy === null` (a signal the queue did not send), or exit `130` → `converter_interrupted`
3. exit `2` → `converter_unavailable` (detail = stderr tail)
4. `stdoutInvalid` (bad line, bad field, cap kill) → `converter_output_invalid`
5. any other non-zero exit → `converter_failed` (detail = record `error`, else stderr tail)
6. not exactly one record → `converter_output_invalid`
7. outcome `failed` → `converter_failed`; `unsupported` → `unsupported_source`; `skipped` → `converter_output_invalid`
8. `stdioTimedOut` (stdio not settled within `closeGraceMs`) → `converter_output_invalid`
9. `converted` → returns `{ ok: true, output, notes }` for verification

A run ended by the queue's own stop (`killedBy = 'stop'`) is never
interpreted (see Queue, stop). `result.js` also holds the pure
`redactDetail(text, roots, { platform = process.platform } = {})`: every
occurrence of the given root paths (`mediaRoot`, `convertDir`, configured and
realpath'd spellings, plus `path.dirname(converterCmd[0])`, the converter's
install dir, which a Python traceback prints) becomes
`<MEDIA_ROOT>`/`<CONVERT_DIR>`/`<CONVERTER>`, longest root
spelling first (with `/srv/media` and `/srv/media-converted`, replacing the
shorter one first would yield `<MEDIA_ROOT>-converted/…`); the `<CONVERTER>`
replacement is skipped when `path.dirname(converterCmd[0])` is a filesystem
root (`path.parse(d).root === d`, e.g. `/` or `C:\`), which would otherwise
rewrite every separator; then
the text is cut to its last 500
characters. On `win32` the match is case-insensitive and accepts both `\` and
`/` as separators. The job applies it to `interpretRun`'s detail and to each
note before persisting (a note then keeps its first 200 characters), with `roots`
= configured and realpath'd `mediaRoot` and `convertDir` (the realpaths kept
by `start()`) plus `path.dirname(converterCmd[0])`, because notes are
stored, returned by the API and shown in the admin panel just like
`error_detail`.

**Verification** (`verifyOutput({ output, outDir, target })` in
`src/convert/verify.js`; `outDir` is the realpath'd dir passed to the
converter):

1. `resolveMediaPath(outDir, path.relative(outDir, output))` must return a
   path (inside `outDir`, exists, no symlink escape). Otherwise
   `converter_output_invalid`. From here on only this resolved realpath is
   used: `verifyOutput` returns `{ ok: true, path: <realpath> }`, and step 6
   of the job renames exactly that path (a symlink reported inside `out/` is
   never published and cannot dangle once the work dir is removed).
2. The resolved path (`lstat`) must be a regular file with `size > 0` whose
   extension, compared case-insensitively, equals `TARGETS[target].ext`
   (`.MP4` passes; the published name is fixed anyway). Otherwise
   `converter_output_invalid`.
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
polling). Its `echo` mode reads its own `process.env` to report the
environment it received, as constitution.md's `process.env` rule allows for
exactly this file (its "sole exception" clause). `--hold <dir>` is a test handshake: after writing its output the
stub creates `<dir>/started` and waits until `<dir>/go` exists. The stub is
type-checked by `tsc` and is not collected by the `test/**/*.test.js` glob.
Modes:

| Mode | Behaviour |
|---|---|
| `ok` (default) | writes `<OUTDIR>/<src stem>.<ext>`: with `--sample-dir`, a copy of `sample.<ext>` from it (human QA); otherwise synthetic bytes (MP4 boxes `avc1` + `mp4a` via `test/helpers/mp4-boxes.js`, a `fLaC` header, or an Ogg page with `OpusHead`). Prints the record plus a summary line; exit 0 |
| `echo` | writes `{ argv, env, cwd }` as JSON to `<OUTDIR>/echo.json`, no record, exit 0 |
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
| `hang` | writes a partial file (and, with `--hold <dir>`, its own pid to `<dir>/pid`, so a test can assert that no stub process is left), then waits until it is killed |
| `flood` | writes > 1 MiB to stdout |
| `orphan-pipe` | spawns a grandchild `[process.execPath, '-e', <sleep 30 s>]` with inherited stdio, writes its pid to `<OUTDIR>/grandchild.pid` and exits 0 without a record (the stub lives under `test/`, which the `child_process` rule does not scan); the test kills the grandchild by that pid afterwards |

### Queue (`src/convert/queue.js`)

`createConversionQueue({ db, config, log, now, run = runConverter,
killGraceMs = 5000, stopDeadlineMs = killGraceMs + 10000, publicDir =
APP_PUBLIC_DIR, removeDir = (p) =>
fs.rm(p, { recursive: true, force: true, maxRetries: 3 }) })` → `{ start(): Promise<boolean>, kick(): void,
stop(): Promise<void> }`. `removeDir` is the test seam for both recursive
removals: `start()`'s work-area wipe (step 6) and the job's step 7. An
injected rejection proves a cleanup error never changes the end state, and a
fake that rejects only the `.videothek-work` path itself makes `start()`
resolve `false` portably; a fake meant for step 7 rejects only paths whose
basename starts with `<storage_key>-`, so `start()` is unaffected. The per-job pipeline may live in
`src/convert/job.js` and the directory handling (setup, work dir create and
remove) in `src/convert/work-dir.js`, each with its mirrored test.

- **`start()`:** checks before it creates anything, because a symlinked
  ancestor of a not-yet-existing `CONVERT_DIR` can point into `MEDIA_ROOT`:
  1. `fs.realpath(mediaRoot)`.
  2. Walk up from `convertDir` to the nearest existing ancestor (the dir
     itself when it exists), where "existing" means `fs.lstat` succeeds on
     it (a dangling symlink counts as existing), and `fs.realpath` it. If
     that `realpath` fails (dangling link, `ELOOP`, `EACCES`), `start()`
     resolves `false` with that code; it never falls through to `mkdir`. The
     candidate is that realpath joined with the remaining missing segments.
  3. Overlap check of the candidate against realpath(`mediaRoot`) in both
     directions with `isInside` from `src/config-converter.js`, and a check
     that the candidate is not inside realpath(`publicDir`) (`code: public`;
     `publicDir` is a factory option defaulting to `APP_PUBLIC_DIR` from
     `src/config-converter.js`, the same directory the lexical config check
     uses). This closes a `CONVERT_DIR` that reaches `public/` through a
     symlink, which static serving would expose without a session.
  4. Only if both pass: `mkdir -p` `convertDir`.
  5. `fs.realpath(convertDir)` and repeat both checks (guards against a
     symlink swapped in between); keep the result as `convertDirReal`.
  6. Remove the work area (leftovers of a crash). The entry
     `workArea = path.join(convertDirReal, '.videothek-work')` (no trailing
     separator: on POSIX `lstat('link/')` follows the symlink) is `lstat`'d
     first. `ENOENT` → nothing to do. A real directory →
     `removeDir(workArea)`. Anything else (a symlink, a Windows junction, a
     regular file) → `fs.unlink(workArea)`, which removes only the link entry
     and never recurses into its target (step 3 then re-creates a real
     directory). `removeDir` is the same injectable seam as in step 7; since
     `workArea` never ends in a separator, `fs.rm` itself also only unlinks a
     link swapped in after the `lstat`.

  Any failure (realpath or mkdir `EACCES`/`ENOSPC`/`EROFS`/`ENOTDIR`, overlap,
  or an `lstat`/`unlink`/`removeDir` error of the work area such as
  `ENOTEMPTY`/`EBUSY` from an orphan still writing) logs
  `conversion_dir_unavailable { code }` (`code` = errno
  code, `overlap` or `public`) and resolves `false`: the server then runs with
  conversions disabled (POST `503`). An overlap found in step 3 has written
  nothing. On success it marks the queue ready and resolves `true`; it does
  not kick. The caller starts the queue with `kick()`: `runStart` right after
  `listen`, tests explicitly. Recovery of `converting` rows is not done here (see Server wiring).
  From here on every path the queue composes starts from `convertDirReal`.
- **`kick()`:** no-op before `start()` resolved `true`, while a job runs, and
  once `stop()` was called. Otherwise it claims the next row in one
  transaction (`status = 'queued'` regardless of a present `library_items`
  row, ordered by `queued_at, rel_path` → `converting`, `started_at = now()`;
  a row whose item is gone ends `failed` `source_missing` in step 1)
  synchronously and runs it
  asynchronously. After each job it calls `kick()` again. Exactly one job
  runs at a time. The whole chain catches everything: no unhandled rejection,
  even when the final DB write itself fails (then only a log line).
- **Job:**
  1. Look up the `library_items` row by `rel_path`. If it is absent, or
     `resolveMediaPath(mediaRoot, rel_path)` returns `null` → `source_missing`.
  2. `stat` the source (ENOENT/EACCES → `source_missing`) and record its
     size/mtime on the row.
  3. `mkdir(convertDirReal/.videothek-work, { recursive: true })` (`start()`
     removed it, and nothing else re-creates it), then `realpath` it and
     require that realpath to **equal** `path.join(convertDirReal,
     '.videothek-work')` (case-insensitive on `win32`) before anything is
     created inside it. This catches a `.videothek-work` symlink or junction
     planted in advance, also one that points elsewhere inside `CONVERT_DIR`
     (a plain `isInside` would accept that); a violation → `storage_failed`.
     Then create a fresh unique
     work dir with `fs.mkdtemp(<verified .videothek-work realpath>/<storage_key>-)`
     (the job dir), `mkdir` `out/` and `tmp/` inside it, and use `out/` as
     `OUTDIR` for the converter and `verifyOutput`, the job dir as the
     converter's `cwd`, and `env = { ...config.converterEnv, TMPDIR: tmp,
     TEMP: tmp, TMP: tmp }`. A unique name per attempt keeps an orphaned
     converter from an earlier crash out of the new dir. Errors of this
     step's `mkdir`/`mkdtemp`/`realpath` → `storage_failed`.
  4. Immediately before the spawn: if `stopping` is set (`stop()` arrived
     during the awaits of steps 1–3) → `interrupted` without calling `run`.
     Otherwise `run({ cmd: config.converterCmd, env: <step-3 env>,
     target, source, outDir, cwd: <job dir> })`, keep the returned handle as the running
     job's handle, then `await result`. The `stopping` check and the `run`
     call happen in the same synchronous step, so `stop()` either sees the
     handle or the job sees `stopping`.
  5. If `stop()` was called by now → `interrupted` (skip the rest). Else
     `interpretRun`, then `verifyOutput`, then re-check the source. The
     detail and each converter note pass through `redactDetail` (then a
     note keeps its first 200 characters) before they are stored.
  6. Publish: `mkdir` `convertDirReal/<storage_key>` (recursive), `realpath`
     it and require it to **equal** `path.join(convertDirReal, storage_key)`
     (case-insensitive on `win32`). A pre-planted symlink or junction →
     `storage_failed`, including one into `.videothek-work/<job>`, whose
     published copy step 7 would otherwise delete. Then `rename` the realpath returned by `verifyOutput` to
     `<that checked realpath>/<TARGETS[target].file>` (same file system, atomic, and it
     replaces a stale copy). Then the publish transaction (status `playable`,
     `output_rel`, `output_size`, `notes`, `error = NULL`, `finished_at`, plus
     the `library_items` flag). A `mkdir`/`realpath`/`rename` error here →
     `storage_failed`.
  7. Remove the per-job dir `.videothek-work/<storage_key>-<unique>` by the
     exact path `mkdtemp` returned under the verified realpath, passed to
     `removeDir` without a trailing separator (including
     `out/`, `tmp/` and anything the converter wrote beside them), always, in
     `finally`. This removal never changes the recorded end state: the end
     state (`playable` or `failed` with its real code) is written before it,
     and a removal error (e.g. `EBUSY`/`EPERM`/`ENOTEMPTY` after
     `maxRetries`, from an orphan still writing or a lingering Windows handle)
     is only logged as `conversion_cleanup_failed { key, code }` (no path) and
     left for the next `start()` wipe. It is caught, so it never reaches the
     `internal` path either.

  `storage_failed` covers exactly the `mkdir`/`mkdtemp`/`realpath`/containment
  failures of step 3 and the `mkdir`/`realpath`/containment/`rename` failures of
  step 6 (a containment failure has no errno; its `error_detail` is
  `containment`). Any failure → `failed` with the code, redacted `error_detail` and
  `finished_at`. For `converter_unavailable` after a spawn error, `storage_failed`,
  `source_missing` and `internal` it is only the errno code or error name
  (e.g. `EACCES`, `TypeError`), never `err.message`, which can carry the
  converter path or a path outside the redacted roots. Any other unexpected
  throw (DB error, bug) → `internal`, plus a log line
  `conversion_error { key, code }` (error code/name only, no message, no
  path). Logs: `conversion_started` and `conversion_finished`
  with `{ key, target, status, error, ms }`; no paths, no command, no stderr.
- **`stop()`:** sets `stopping` synchronously (so `kick()` claims nothing from
  then on). If the running job already has a handle (step 4 reached), it
  calls `handle.kill('SIGTERM')` at once and arms a `killGraceMs` timer that
  sends `SIGKILL`; that timer is cleared when the job's `result` settles. If
  the job is still in steps 1–3 there is no handle and nothing is killed: the
  step-4 check records `interrupted` without spawning, so `stop()` resolves
  promptly instead of waiting for a whole conversion. The job itself is the
  single writer of its end state: once `stopping` is set, a job whose run ends
  records `failed` `interrupted` without interpretation, whether the queue's
  kill or an external signal ended the child. `stop()` resolves only after the
  whole job promise settled, including its DB write and the work-dir removal
  in `finally`, or at the latest after a hard deadline of `stopDeadlineMs`
  (a factory option, default `killGraceMs + 10000`) measured from the
  `stop()` call; it never rejects. The deadline covers a child that never
  exits even after `SIGKILL` (e.g. stuck in uninterruptible I/O on a hung
  mount): `stop()` then logs `conversion_stop_timeout {}` and resolves, the
  row stays `converting`, and the next startup's recovery turns it into
  `failed` `interrupted`. A job that settles after the deadline hits a closed
  DB; that write error is caught like any other (only a log line). It is
  memoised (a second call returns the same promise). A job already past step 5 when `stop()` is called finishes
  normally (local verify + publish are short).
- No automatic retry of any kind (prior art: Unmanic). `failed` changes only
  through `POST`.

### Server wiring (`src/server.js`, `src/app.js`)

- `src/app.js`: `AppDeps` gains `conversions?: ConversionQueue` next to
  `library?: LibraryService` (typedef only; `& Record<string, unknown>`
  would make it `unknown` for `tsc --strict`).
- `runStart` calls a private helper `startConversions({ db, config, log })`
  in `src/server.js` after `ensureAdmin` and before `startLibrary`; it returns
  the queue or `null` (pre-authorised: `runStart` would otherwise grow to about
  50–55 of the 60 allowed lines), assigned to a `let queue = null` declared
  next to `let library`, so the `catch` branch can stop it.
- Its first statement, always (feature on or off), is
  `failInterruptedConversions(db, Date.now())`: every `converting` row →
  `failed`, `error = 'interrupted'`, `finished_at`; `queued` rows stay; logs
  `conversions_recovered { count }` when `count > 0`. It only touches the DB
  and is idempotent.
- Then, when `config.converterCmd` is truthy: create the queue and
  `await queue.start()`; on `false` it returns `null`.
  `createApp({ …, conversions: queue ?? undefined })`. `runStart` calls
  `queue?.kick()` only after `listen` resolved, so no converter is spawned
  before `start()` installs the signal handlers (same continuation, before
  any I/O callback). The `catch` branch of `runStart` awaits `queue?.stop()`
  before `library?.stop()` and `db.close()`.
- `createStop` (gains `queue`): the first statement starts `queue?.stop()` (so `stopping` is
  set while `app.close()` still waits up to 5 s for connections and no new job
  starts in that window). It awaits that promise inside the existing
  `finally` (so also when `app.close()` fails), before `library.stop()`, and
  `db.close()` stays last.
- `src/api/conversions.js` reads `deps.conversions`, `deps.config` and
  `deps.now` at request time and never at registration: the API tests attach
  a queue after boot, and `test/http/routes.test.js` calls `registerRoutes`
  with only `{ db }`, so a registration-time `deps.config.convertDir` would
  throw.

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
  `row.playable` truthy (409 `already_playable`: plays directly or has a fresh
  copy), then an existing `queued`/`converting` row (200, unchanged).
  Otherwise it upserts `status = 'queued'`, `target`, `storage_key`,
  `source_size`/`source_mtime_ms` from the row and `queued_at = deps.now()`,
  and clears `error`, `error_detail`, `started_at` and `finished_at`,
  and resets `notes` to `'[]'`.
  `output_rel`/`output_size` of an old copy stay until the new one replaces
  them. Then `deps.conversions.kick()`, and only then is the 202 entry built
  (the claim is synchronous, so an idle queue already answers `converting`).
  This covers a first request, a retry after `failed` and a re-conversion of a
  stale copy.
- **`GET` without `ids`:** `items` = every conversion row whose `rel_path` is
  present in `library_items`, grouped `converting`, `queued`, `failed`,
  `stale`, `playable`. `queued` rows are ascending by position; every other
  group is newest first (`finished_at`, else `queued_at`). A `queued` row
  whose item is currently absent from `library_items` is neither listed nor
  counted in `position`; the claim still takes it, and the job ends it
  `failed` `source_missing`.
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
    joined to a present `library_items` row (the visible ones) only, else
    `null`; the running job is not counted.
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
- `claimNextConversion(db, now)` → row or `undefined` (the oldest `queued`
  row by `queued_at, rel_path`, whether or not `library_items` has its path)
- `recordSourceStat(db, relPath, size, mtimeMs)`
- `publishConversion(db, { relPath, outputRel, outputSize, notes, now })`
  (transaction incl. the `library_items` update)
- `failConversion(db, { relPath, error, detail, now })`
- `failInterruptedConversions(db, now)` → count
- `listConversionRows(db)` and `listConversionRowsForIds(db, ids)` (joined to
  `library_items`, with the queue position computed in SQL). The row keeps
  `li.*` under its plain column names, so it goes straight into `toItemJson`
  (`src/api/library-json.js`); every `conversions` column is aliased with a
  `c_` prefix (`c_status`, `c_target`, `c_error`, `c_notes`, …), because both
  tables have `rel_path` and a plain `c.*` would shadow item columns. The position is numbered in a CTE (or subquery) over **all**
  visible `queued` rows (`ROW_NUMBER() OVER (ORDER BY queued_at, rel_path)`),
  and only then filtered to the requested `ids`; numbering only the
  requested rows would give wrong "Platz N" values
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
    Each host gets one control appended to it (`host.append`). Other
    decorators (P4's progress badges) also append to `.episode-row`, so
    neither the CSS nor the code relies on the control being the last child
    (`:last-child`) or on any sibling order; rules select `.convert-control`
    by class only. The rows are checked top to bottom, first match wins
    (so a `failed` or `stale` entry whose source has since become zero-byte
    shows nothing instead of a button that POST would answer with 400):

    | Entry | Control |
    |---|---|
    | `convertible` false and status not `queued`/`converting`/`playable` | no control |
    | `none` or `stale` | button "Konvertieren" |
    | `queued` | status "In Warteschlange · Platz N" |
    | `converting` | "Wird konvertiert …" |
    | `failed` | "Konvertierung fehlgeschlagen: <Grund>" + button "Erneut versuchen" |
    | `playable` | "Konvertiert" + button "Neu laden" (`location.reload()` on every page, also ending the audio bottom-bar player; Prior decisions O1) |

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
    `document.hidden` and stops for good once `root.isConnected` is false,
    nothing is active, or a poll answers `401`/`403`; any other poll error
    keeps the interval (the next tick retries). One poller per root: a module-level
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
  - Groups "Läuft gerade" (with the elapsed time since `startedAt`, e.g.
    "seit 12 Min.", refreshed with each poll, so a hanging job is visible),
    "Warteschlange", "Fehlgeschlagen" (reason + "Erneut versuchen"),
    "Veraltet – Quelle geändert" ("Erneut konvertieren") and "Fertig" (the
    newest 20, with the notes; converter notes, like `error_detail`, are
    shown verbatim and may be English, so the "UI text German" rule does not
    apply to them; the design mock's German notes are only sample data).
    "Erneut versuchen" and "Erneut konvertieren"
    are shown only when the entry's `convertible` is true (otherwise POST
    would answer 400 or 409); the row itself stays listed. Each row shows the
    title (`item.seriesTitle` + episode label for episodes, else `item.title`
    only, also for audio rows: the PNG's "Buch · Kapitel" is sample data), the
    category label from `NAV_ENTRIES` (`public/js/lib/nav.js`, the labels
    `PREVIEW_SECTIONS` mirrors) and the extension. The panel's buttons follow the decorator's POST error
    rules. The elapsed time is not in the design export; the spec wins.
  - Empty: "Keine Konvertierungen."
  - It polls every 5 s while something is active and the tab is visible, and a
    failed request shows "Status konnte nicht geladen werden.".

### File ownership (P7)

**New:**

- Server: `src/db/migrations/006-conversions.sql`, `src/db/conversions.js`,
  `src/config-converter.js` (parsers + the moved `isInside`),
  `src/convert/targets.js`, `src/convert/jsonl.js`,
  `src/convert/run-converter.js`, `src/convert/result.js`,
  `src/convert/verify.js`, `src/convert/queue.js`, `src/api/conversions.js`
- Pre-authorised splits (each `src/` split with its mirrored test, only if
  needed for the 300-line limit): `src/db/conversion-queries.js`,
  `src/convert/job.js`, `src/convert/work-dir.js`, `src/api/conversion-json.js`
  (entry/envelope JSON building and `ids` parsing),
  `public/js/lib/convert-poller.js` (the per-root poller),
`public/js/admin-conversions-rows.js` (the admin panel's row and group
builders); the API test may
  split into `test/api/conversions.test.js` (must keep this exact name, since
  `test/constitution.test.js` requires the mirror of `src/api/conversions.js`;
  e.g. the GET cases) and `test/api/conversions-post.test.js`; the lifecycle
  test into `test/convert/queue-lifecycle.test.js` plus any number of
  `test/convert/queue-lifecycle-*.test.js` siblings (e.g. `-stop`,
  `-symlinks`); the runner test into `test/convert/run-converter.test.js`
  plus any number of `test/convert/run-converter-*.test.js` siblings (e.g.
  `-kill`). Shared setup for these siblings may live in
  `test/helpers/` (not collected by the `test/**/*.test.js` glob).
- `src/api/conversions.js` keeps its own private `parseItemId`, following the
  existing precedent (`media.js`, `audiobooks.js`, `cover.js`, `music.js`,
  `progress.js` each have one); `src/api/media.js` exports nothing new.
- Frontend: `public/js/lib/conversions-api.js`,
  `public/js/lib/conversion-format.js`, `public/js/lib/convert-control.js`,
  `public/js/admin-conversions.js`, `public/css/convert-control.css`,
  `public/css/admin-conversions.css`
- Tests: `test/helpers/converter-stub.js`, `test/config-converter.test.js`,
  `test/db/conversions.test.js`,
  `test/db/library-repo-playable.test.js` (effective-playable cases;
  `test/db/library-repo.test.js` is at 289 lines),
  `test/server-conversions.test.js` (startup recovery; `test/server.test.js`
  is at 254 lines),
  `test/convert/targets.test.js`, `test/convert/jsonl.test.js`,
  `test/convert/run-converter.test.js`,
  `test/convert/result.test.js`, `test/convert/verify.test.js`,
  `test/convert/queue.test.js` (claim/FIFO/single-flight/stop with a fake
  `run`), `test/convert/queue-lifecycle.test.js` (real stub: publish, failure
  codes, stop, work-dir cleanup), `test/api/conversions.test.js`,
  `test/api/media-converted.test.js`, `test/public/conversion-format.test.js`,
  `test/public/convert-control.test.js` (DOM fakes as in
  `test/helpers/player-page-fakes.js`)

**Edited (minimal hooks only):**

- `src/config.js` (three properties; `isInside` moves out to
  `src/config-converter.js` and is imported back), `src/db/library-repo.js` (one
  statement), `src/api/media.js` (`handleMedia` branch), `src/http/routes.js`
  (one import + one `registerConversionRoutes(router, deps)` call), `src/server.js` (startup recovery; create/start/stop the queue;
  `deps.conversions`), `src/app.js` (`AppDeps` typedef only)
- `public/js/movies.js`, `public/js/series-detail.js`: one import + one
  `decorateConversionsFor(...)` call after each render, next to
  `decorateProgressFor`
- `public/js/audio/views/album.js`, `public/js/audio/views/audiobook-detail.js`:
  `dataset: { itemId }` on the unplayable row, plus one import + one call on
  the view's `container`: in `album.js` at the end of `mountAlbum` (so a
  retry that re-mounts is covered), in `audiobook-detail.js` at the end of
  `load`
- `public/js/admin.js`: one import + one `mountConversionPanel(main)` call
- `test/library/index.test.js`: `fakeConfig` gains `converterCmd: null,
  convertDir: '', converterEnv: {}` (tsc only; its literal is not cast, see
  Config)
- `test/db/migrate.test.js` (migration/repository issue): the gap test
  "003 still applies after a higher version is already recorded" records
  version 5 and asserts `migrate(db)` against the real migrations dir equals
  `[1, 2, 3, 4]`; with `006-conversions.sql` present it returns
  `[1, 2, 3, 4, 6]` (`src/db/migrate.js` applies every unrecorded version).
  Its assertion becomes `const applied = migrate(db);
  assert.deepEqual(applied.filter((v) => v < 5), [1, 2, 3, 4]);
  assert.ok(!applied.includes(5));`, which later migrations do not break
  either; the rest of the test is unchanged
- `test/constitution.test.js` (see Constraints). `test/config.test.js`,
  `test/db/library-repo.test.js` and `test/server.test.js` are not edited;
  their new cases go to the new files above (all three are close to the
  300-line limit)
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
  `playable`, `size`, `mtime_ms`), `upsertItem`, `getItemById`,
  `getItemByRelPath`, `toItemJson`,
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
  data-item-id>` (never links). `.convert-control` is appended to the host,
  but CSS must not rely on `:last-child` or sibling order (progress badges
  append to `.episode-row` too). On a 390 px episode, track or file row it drops onto its own line below
  the title instead of squeezing it. `test/frontend-rules.test.js` allows only
  `768px` and `1024px` inside `@media`, so build this with `flex-wrap` on the
  host rule in `convert-control.css` (the control gets `flex-basis: 100%`) or
  with `@media not (min-width: 768px)`, never with a `390px`/`480px`
  breakpoint.
- All conversion buttons (Konvertieren, Erneut versuchen, Neu laden,
  Erneut konvertieren) use the secondary button variant. The primary orange
  stays reserved for each page's own main action.
- The mobile PNGs are real 390 px viewports rendered at 2x (780 px wide).
  The exported HTML is a layout reference only, never copied verbatim.

## Human prerequisites

None: nothing blocks implementation, since every machine test uses the stub
and generated files.

QA-only (provided by the human at the milestone QA gate, not a blocker):

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
| Gate decision (O1 → a): "Neu laden" uses `location.reload()` on every page in Phase 7, also on `/music` and `/audiobooks`, where it ends the bottom-bar player | Only the admin sees the button, once per conversion, and the item is playable after any later navigation; an `onReload` callback would touch the audio views and `app.js` beyond one hook line | 2026-09-29 |
| Gate decision (O2 → a): a fresh row whose copy file is gone (deleted by hand, or `CONVERT_DIR` changed without the copies) stays `playable = 1` with `/media` answering `404 not_found` until the Phase-8 cleanup reconciles it; README: "CONVERT_DIR nur zusammen mit den Kopien verschieben"; `docs/architecture.md` Boundaries keeps this exception to the `playable` meaning | A manual-intervention case in a one-household app, and Phase 8 needs the flag-reset mechanism anyway; re-queue on POST or a startup copy check would add code for a hand-made state | 2026-09-29 |
| Gate decision (O3 → a): while `MEDIA_ROOT` is unmounted, queued jobs fail `source_missing` one after another; the admin re-queues each with "Erneut versuchen"; no queue pause, no automatic retry | Unmanic: manual re-queue per item. A correct pause spans job, queue, API envelope and admin panel, while one household re-queues a few items by hand | 2026-09-29 |
| Gate decision: the vision "Weak hardware" criterion is not guaranteed while a conversion runs in Phase 7 (no `nice`/`ionice`); accepted consciously | Conversions are admin-triggered and one at a time, the README states the effect, and CPU/IO priority plus playback protection arrive in Phase 8 | 2026-09-29 |
| `library_items.playable` = source direct-play OR fresh conversion, computed in `upsertItem`'s SQL and set in the publish transaction | About ten readers across P2–P6 filter on the column, and progress `PUT` rejects `playable = 0`. One flag keeps them all correct with no edits. Computing it on upsert (not only on publish) keeps the index rebuildable (vanish/reappear, `SCAN_VERSION` bump) | 2026-09-28 |
| Conversion rows reference `rel_path`, with no FK and no cascade | Plex AVOID: a vanished source must not delete its copy at once, because root safety expects items to reappear. Cleanup with a grace period is Phase 8 | 2026-09-28 |
| One queue, one job at a time, FIFO by `queued_at` (ties by `rel_path`), claim in a `BEGIN IMMEDIATE` transaction | Prior art: parallel 1080p encodes gain little on a Pi 4; the Unmanic multi-worker pool is an AVOID. A sequence column for same-millisecond ties is not worth a column | 2026-09-28 |
| Recovery (`converting` → `failed` `interrupted`; `queued` survives) runs in `src/server.js` at every startup, also with the feature off; graceful stop also ends the running job as `failed` `interrupted` | Tdarr AVOID (stuck non-terminal states) plus Unmanic ADOPT (no automatic retry loop). Re-queueing on restart could loop forever on a job that hangs or crashes the host, and Phase 7 has no cancel. Running it only in `queue.start()` would leave a row stuck once `CONVERTER_CMD` is removed | 2026-09-28 |
| `stop()` sets `stopping` synchronously at the start of `createStop`, and the job is the single writer of its end state; after `stopping`, any job end is `interrupted` without interpretation | A job finishing during `app.close()` (up to 5 s) would otherwise claim and spawn the next queued row; an unawaited `failConversion` would hit a closed DB. Ctrl+C or systemd `KillMode=control-group` signal the child together with videothek. A residual race (the child's `close` handled before the SIGINT handler) records `converter_interrupted`; both codes read "Abgebrochen" and neither retries. In that race the post-job `kick()` can still claim and spawn the next queued job before the SIGINT handler sets `stopping`, so that job also ends `interrupted` (it stays re-queueable with one "Erneut versuchen") | 2026-09-28 |
| `kick()` is a no-op until `start()` resolved; `server.js` awaits `queue.start()` before `listen()` | Otherwise `start()`'s `.videothek-work` wipe could delete a freshly claimed job's dir | 2026-09-28 |
| An unusable `CONVERT_DIR` (mkdir fails, or realpath overlap with `MEDIA_ROOT` via a symlink) disables conversions with a log line instead of failing startup | Same principle as a missing converter: conversion problems must never take down the media server. The lexical config check cannot see symlinks, and the dir may not exist at config time | 2026-09-28 |
| No automatic retry; retry = `POST` again | Unmanic: failed stays failed until the user re-queues | 2026-09-28 |
| `CONVERTER_CMD` is split on whitespace, with no quoting; the first token must be absolute; there is no existence check; it is validated in every config mode | No shell and no hand-rolled shell grammar. An absolute path avoids `PATH` surprises under systemd. A missing converter must fail jobs, not the media server. Every-mode validation follows the `PORT` precedent | 2026-09-28 |
| `CONVERT_DIR` defaults to `<DATA_DIR>/converted`, is configurable, and must not overlap `MEDIA_ROOT` in either direction (lexically in config, by realpath in `start()`: first the realpath of the nearest existing ancestor plus the missing segments, and only then `mkdir -p`, then a re-check of the created dir's realpath); it must not lie inside `public/` (lexical config problem) | Big copies may belong on the USB disk rather than the SD card. The deletes under `.videothek-work/` must never reach media. Creating the dir before the realpath check would already write under `MEDIA_ROOT` when an ancestor is a symlink into it. Static files are served without a session, so copies inside `public/` would bypass login | 2026-09-28 |
| A defaulted `CONVERT_DIR` does not add its overlap problem when the `DATA_DIR` overlap problem already fired; an explicit `CONVERT_DIR` is always checked; no overlap check at all while `mediaRoot` is `''` (no valid `MEDIA_ROOT`) | `loadConfig` collects all problems and throws once; a default derived from a `DATA_DIR` inside `MEDIA_ROOT` would otherwise add a second problem and break the unchanged `test/config.test.js` `deepEqual` assertions (106-160). The root cause is reported once, and nothing is left unchecked: the `DATA_DIR` error stops startup anyway. `isInside('', x)` resolves `''` as `cwd` and would report a false overlap next to `MEDIA_ROOT: required` (`test/config.test.js:82-104`); `resolveDataDir` uses the same guard | 2026-09-28 |
| The converter gets an allowlisted environment (`config.converterEnv`, without `TMPDIR`/`TEMP`/`TMP`); the job adds `TMPDIR`/`TEMP`/`TMP` = its own `tmp/` dir | `ADMIN_PASSWORD` must not leak into a third-party process; only `src/config.js` reads `process.env` (`src/`; stub exception: constitution.md Conventions). Pointing the temp vars into the per-job dir makes the contract "files only inside OUTDIR or the given temp dir" satisfiable, and the job-dir removal cleans temp files too. Windows/Python additions wait for the Phase-8 adapter | 2026-09-28 |
| One fresh unique work dir per attempt (`mkdtemp` under `CONVERT_DIR/.videothek-work/`, converter writes into its realpath'd `out/`), removed as a whole in `finally`; then an atomic `rename` into `CONVERT_DIR/<key>/<fixed name>` | Converter prior art: two calls into one dir give a silent `SKIPPED`, and an orphan from a crash must not write into a retry's dir. The `out/` level keeps an escaping output inside the removed job dir; the realpath avoids false `..` on a symlinked `DATA_DIR`. Tdarr ADOPT: staging, then publish. Fixed names keep every served path free of user-controlled names | 2026-09-28 |
| `runConverter` returns `{ result, kill }`, builds the argv itself, settles on `'close'`, and reports `killedBy` (`cap`/`stop`/`null`) | One shape for the real runner and the fake in `queue.test.js`; `interpretRun` can tell a foreign signal from its own cap kill; on Windows `'exit'` can precede stdio EOF | 2026-09-28 |
| A result counts only after videothek's own check: strict MP4 sniff (unknown = fail, ≥ 1 video track) or FLAC/Ogg-Opus magic (`OpusHead` after the segment table), plus a source re-stat; `--to web` always writes MP4 | Converter v3.1.0 reports HEVC/AC3 remuxes as "converted"; the scanner's lenient "unknown = playable" is wrong for a result we publish. A WebM `web` output would fail the extension rule | 2026-09-28 |
| Phase 7 parses only `outcome`, `output` (absolute), `error`, `notes` of exactly one per-file record; `skipped` is invalid; notes are validated ≤ 10 × 2000, stored ≤ 10 × 200, bad types are invalid | Minimal fields, so the Phase-8 converter spec can still shape the rest. A fresh empty dir makes `skipped` impossible | 2026-09-28 |
| stderr is never logged; only its redacted tail is stored as `error_detail` (root prefixes replaced, ≤ 500 chars) | ffmpeg's stderr carries absolute source paths, and item JSON deliberately never exposes paths; H1 (admin-only) is only the backstop. Relative media paths (below `<MEDIA_ROOT>`) stay visible to admins in `error_detail` and notes; that is intended, since admins see titles and the library layout anyway | 2026-09-28 |
| Failure codes: `storage_failed` covers only step 3 (`mkdir`/`mkdtemp`/`realpath`/containment of the work dir) and step 6 (`mkdir`/`realpath`/containment/`rename` of the publish); the step-7 work-dir removal never changes the recorded end state (see its own row); source `stat` ENOENT/EACCES → `source_missing`; any other throw → new code `internal` ("Interner Fehler") + `conversion_error` log | Every job must end in a terminal state with a displayable reason, and the `kick()` chain must never leave an unhandled rejection | 2026-09-28 |
| Audio target: `audiobooks` → `opus`; `music` lossless-capable exts → `flac`, other music → `opus`; `mid`/`midi` not convertible; zero-byte sources not convertible | Opus fits speech and keeps multi-hour books small. FLAC avoids a second lossy generation for lossless music. ffmpeg has no MIDI synthesis by default. A zero-byte file can only fail | 2026-09-28 |
| Gallery videos (`images` category) are not convertible in Phase 7 | The gallery renders tiles lazily in batches, so a one-shot decorator misses later tiles, and `public/js/images.js` is at 298 lines. It needs its own hook design; this is a follow-up (roadmap Phase 9) | 2026-09-28 |
| UI = a DOM decorator on the four video/audio pages plus an admin panel; no player-panel control | Precedent: P4's `decorateProgressFor` (one import + one call, no edit of other phases' builders or CSS). Not-playable cards do not link to the player, and `player.js` is at 300 lines | 2026-09-28 |
| The decorator's `403` doubles as the role check | `mountShell` returns `me` on the four non-audio pages, but the audio SPA has no `me` in its view params. Cost: one small `403` per render in a household member's browser console | 2026-09-28 |
| `POST` on a `queued`/`converting` item → `200` with the current entry; a directly playable or freshly converted item → `409 already_playable`; feature off → `503 conversion_disabled`; the UI turns `409` into "Konvertiert" and removes the control on `400`/`404`/`503` | Idempotent double-clicks; explicit codes for real conflicts; a missing server capability is not a client error | 2026-09-28 |
| A copy is served whenever it is fresh, even when the queue is disabled | Unsetting `CONVERTER_CMD` stops new work but must not make converted items unplayable | 2026-09-28 |
| Pre-authorised file splits (`conversion-queries.js`, `job.js`, `work-dir.js`, `src/api/conversion-json.js`, `public/js/lib/convert-poller.js`; API test split into `test/api/conversions.test.js` + `test/api/conversions-post.test.js`; lifecycle and runner tests split into `queue-lifecycle-*`/`run-converter-*` siblings by pattern, not by fixed name) | The 300-line limit is enforced by `test/constitution.test.js`, which also requires the exact mirror `test/api/conversions.test.js` for `src/api/conversions.js` | 2026-09-28 |
| `src/config-converter.js` is a required new module holding the converter parsers and the moved, exported `isInside`; it imports nothing from `src/` | `src/config.js` is at 228 lines. The queue's realpath overlap check needs the same `isInside` as the lexical config check; exporting it from a leaf module avoids a second copy and any import cycle | 2026-09-28 |
| New cases for existing near-limit tests go into new files: `test/db/library-repo-playable.test.js`, `test/server-conversions.test.js`, `test/config-converter.test.js`; `test/db/library-repo.test.js` (289 lines), `test/server.test.js` (254) and `test/config.test.js` (268) are not edited | `test/constitution.test.js` fails any test file over 300 lines; the mirrored files stay in place | 2026-09-28 |
| `stop()` kills an existing handle at once (SIGTERM, then SIGKILL after `killGraceMs`, timer cleared when `result` settles); a job checks `stopping` synchronously right before spawning and records `interrupted` without calling `run` | Otherwise a `stop()` during the awaits of steps 1–3 kills nothing, the job spawns anyway, and shutdown waits for a whole conversion (hours with a real converter, or until systemd's `TimeoutStopSec`) | 2026-09-28 |
| Step 3 re-creates the work area (`mkdir -p` under `convertDirReal`), requires its realpath to equal `path.join(convertDirReal, '.videothek-work')`, and only then runs `mkdtemp` under that verified realpath; step 6 renames into `<storage_key>/` after the same equality check; step 7 removes exactly the `mkdtemp` path | `start()` removes the work area and nothing else re-creates it; without this every job would fail `storage_failed`. Checking before `mkdtemp` means a planted `.videothek-work` symlink never receives a job dir (same write-then-verify gap as in `start()`) | 2026-09-28 |
| The work area is `CONVERT_DIR/.videothek-work/`, not `.work/` | `start()` deletes it recursively; a distinctive name keeps an unrelated `.work` folder safe when `CONVERT_DIR` points at an existing shared directory | 2026-09-28 |
| The runner's wait for `'close'` is bounded (`closeGraceMs` after `'exit'`, then stdio destroyed) | A grandchild that inherited the pipes can keep `'close'` from ever firing, which would block the queue and `stop()` forever | 2026-09-28 |
| Converter notes pass through `redactDetail` before they are stored; `redactDetail` matches case-insensitively and with both separators on `win32`; the `converterEnv` lookup is case-insensitive on `win32` | Notes are stored, returned and displayed like `error_detail`, so the same path-redaction rationale applies. Windows spells paths and `Path` in varying case and separators | 2026-09-28 |
| Removing the per-job work dir in `finally` (step 7) never changes the recorded end state; a removal error only logs `conversion_cleanup_failed { key, code }` and is left for the next `start()` wipe | The end state is committed before the removal. Mapping an `rm` error to `storage_failed` after a successful publish would leave `failed` with the flag at 1 and the copy present: `/media` would fall back to the unplayable source, POST would answer 409, and the scanner's unchanged-file skip would never repair it; for a failed job it would overwrite the real reason. `EBUSY`/`EPERM`/`ENOTEMPTY` survive `maxRetries` with an orphan still writing or a lingering Windows handle | 2026-09-28 |
| The pure JSON Lines reader and record validator live in `src/convert/jsonl.js`; `runConverter` takes `cwd` and `closeGraceMs = 2000`; stdout accumulation stops at a cap and stderr is a 4 KiB ring buffer | The line cap vs the total cap, split multi-byte characters, bad field types, relative `output` and note truncation are unit-testable without a stub mode each; memory stays bounded while a grandchild keeps writing during the `closeGraceMs` wait | 2026-09-28 |
| The minimum converter contract includes "SRC is only read; files are created or changed only inside OUTDIR or the given temp dir"; the child runs with `cwd` = the per-job dir; the README recommends read-only `MEDIA_ROOT` access for the service user | vision.md promises nothing under `MEDIA_ROOT` is written, but the constitution's read-only rule binds only videothek's code. The contract binds the converter (Phase 8 extends it), `cwd` keeps relative writes inside the removed work dir, and OS permissions are the only enforcement that also covers the child | 2026-09-28 |
| The constitution's child-process Don't keeps only app-side obligations scoped to `src/` (argv only, no shell, one at a time, per-job `cwd` and temp env, allowlisted env without `ADMIN_PASSWORD`, own format check); the converter-side "only reads / creates only inside" clause moves to `docs/architecture.md` Boundaries ("Converter contract") and this spec | constitution.md requires every principle to be verifiable; the converter's behaviour cannot be tested from videothek. The stub under `test/` spawns a grandchild, so the rule is scoped to `src/` | 2026-09-28 |
| `start()` `lstat`s `path.join(convertDirReal, '.videothek-work')` (no trailing separator) before removing it: a real directory goes to `removeDir`, anything else (symlink, junction, file) is only `unlink`ed; `removeDir` is the seam for both this wipe and step 7 | On POSIX a trailing separator makes `lstat` and `fs.rm` follow a planted symlink or junction, so a recursive delete could reach into `MEDIA_ROOT`. Unlinking the link keeps the target intact and lets step 3 re-create a real directory. One seam makes a failing `start()` wipe testable without OS-specific permission tricks | 2026-09-28 |
| `test/db/migrate.test.js` is edited by the migration issue: its gap test asserts only the versions below 5 and that 5 is not re-applied | The test runs against the real migrations dir and pins `[1, 2, 3, 4]`; adding `006-conversions.sql` makes `migrate()` return `[1, 2, 3, 4, 6]`, so `npm run verify` would fail with no permitted fix | 2026-09-28 |
| `redactDetail` also replaces `path.dirname(converterCmd[0])` with `<CONVERTER>`; the API tests pass an explicit `converterEnv: {}`; the constitution test forbids `/\bshell\b/` anywhere in `run-converter.js` | A converter's traceback prints its install path, which is outside both data roots. No test reads `process.env` today, and constitution.md's `process.env` rule has no `src/` qualifier; its only exception is the converter stub. `/\bshell\s*:/` missed `opts.shell = true` | 2026-09-28 |
| Publishing renames the realpath `verifyOutput` returned (regular-file check on that path), and the realpath of `.videothek-work` and of `<storage_key>` must equal `path.join(convertDirReal, <name>)` (case-insensitive on `win32`), not merely lie inside `CONVERT_DIR` | A symlink reported inside `out/` would otherwise be published and dangle once the work dir is removed; a symlink planted as `.videothek-work` or `<storage_key>` must not redirect writes or the publish outside `CONVERT_DIR`, nor inside it: a `<storage_key>` link into `.videothek-work/<job>` passes `isInside`, and step 7 would then delete the published copy | 2026-09-28 |
| The decorator checks "not convertible" first (except `queued`/`converting`/`playable`); the admin panel shows "Erneut versuchen"/"Erneut konvertieren" only for `convertible` entries; CSS never relies on `:last-child` for `.convert-control` | A `failed` or `stale` entry whose source later became zero-byte would otherwise offer a button that POST answers with 400 (or 409 for an already playable item); progress badges also append to `.episode-row` | 2026-09-28 |
| The work area is wiped only by `queue.start()`; with the feature off it is left as it is | A wipe in `runStart` without the queue's realpath overlap check could reach `MEDIA_ROOT` through a symlinked `CONVERT_DIR`; the Outcome was narrowed instead | 2026-09-28 |
| The three new `Config` properties are required in the typedef; `test/library/index.test.js`'s uncast `fakeConfig()` gains them; `converterCmd` is typed `readonly string[] \| null` (and `runConverter`'s `cmd` likewise) | Optional properties would push `undefined` narrowing into `media.js`, the queue and the API. The only uncast `Config` literal is that `fakeConfig()` (TS2741 otherwise); the other hand-built configs are casts. `Object.freeze` of an array yields `readonly string[]`, which `strict` does not assign to `string[]` | 2026-09-28 |
| `error_detail` for a spawn error, `storage_failed`, `source_missing` and `internal` is only the errno code or error name, never `err.message` | `spawn <abs path> ENOENT` names the converter path, and an `isInside` or `fs` error can carry a path outside the roots that `redactDetail` knows | 2026-09-28 |
| `stop()` resolves after `stopDeadlineMs` (default `killGraceMs + 10000`) at the latest; the row then stays `converting` for startup recovery | A child stuck in uninterruptible I/O ignores `SIGKILL` and never emits `'exit'`, so the `closeGraceMs` bound never starts; shutdown must still finish | 2026-09-28 |
| The queue `position` is numbered over all visible `queued` rows before the `ids` filter | The decorator asks only for the ids on its page; numbering the filtered set would show "Platz 1" for an item that is second overall | 2026-09-28 |
| On `win32` the child environment is the allowlist plus libuv's fixed Windows set (`HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR`, copied from the parent when missing); the runner test asserts exact equality only on non-`win32`, and on `win32` a superset limited to that set, never `ADMIN_PASSWORD` | Checked on the dev machine: `spawnSync` with `env: { FOO: '1' }` hands the child exactly `FOO` plus those keys. An exact-equality assertion would fail `npm run verify` on the dev platform; the security goal (no `ADMIN_PASSWORD`, constitution.md wording) still holds | 2026-09-28 |
| The stub's `echo` mode may read its own `process.env`, under the "sole exception" clause this spec PR adds to constitution.md's `process.env` rule (mirrored in architecture.md Boundaries) | A Node child can only report its received environment through `process.env`; the stub stands in for the external converter process | 2026-09-28 |
| The runner keeps an `'error'` listener on the child for its whole lifetime; an `'error'` after a successful spawn or after `result` settled is swallowed, never `spawnError` | `ChildProcess.kill()` can emit `'error'` (e.g. `EPERM`) after spawn; an unhandled `'error'` event would crash the server | 2026-09-28 |
| `start()` also rejects a `CONVERT_DIR` whose realpath (candidate before `mkdir`, then the created dir) lies inside realpath(`publicDir`) (`code: public`); `publicDir` defaults to `APP_PUBLIC_DIR` exported by `src/config-converter.js`; the ancestor walk-up uses `lstat`, and a failing `realpath` of that ancestor resolves `false` | The lexical config check cannot see a symlink into `public/`, whose files are served without a session; `start()` already has the realpaths, so one more `isInside` closes it. `lstat` makes a dangling link count as existing, so it is rejected instead of falling through to `mkdir` | 2026-09-28 |
| `redactDetail` skips `<CONVERTER>` when `path.dirname(converterCmd[0])` is a filesystem root; on `win32` the first `CONVERTER_CMD` token needs a drive letter or UNC prefix | A root dirname (`/converter`) would rewrite every separator; `\node.exe` is absolute but depends on the current drive | 2026-09-28 |
| `startConversions` runs after `ensureAdmin` and before `startLibrary`, its first statement is `failInterruptedConversions` (also with the feature off), `queue` is a `let` next to `library`; `start()` never kicks, `runStart` kicks after `listen` | The `catch` branch can stop a started queue; no converter spawns before the signal handlers exist, so a Ctrl+C during startup cannot orphan one | 2026-09-28 |
| A run whose stdio did not settle within `closeGraceMs` (`stdioTimedOut`) fails `converter_output_invalid`, checked before `converted` | Its records may be incomplete, and a grandchild may still be writing the output | 2026-09-28 |
| The job redacts `interpretRun`'s detail and each note (notes validated up to 2000 chars, redacted, then cut to their first 200 characters); a wrapped stderr tail drops its partial first line | A cut before redaction, or a partial first line, can split a root spelling so `redactDetail` misses it; only spellings inside a note's first 2000 characters are protected | 2026-09-28 |
| `verifyOutput`'s extension check is case-insensitive; re-queue resets `notes` to `'[]'` | The published name is fixed, so case is irrelevant; notes describe one run | 2026-09-28 |
| Gate decision (queue blocker): `claimNextConversion` takes the oldest `queued` row regardless of a present `library_items` row; only the `position` numbering and the listing use the visible rows | Skipping hidden rows could leave a row "In Warteschlange" forever when its path never reappears; a job whose source is gone ends `failed` `source_missing` (with "Erneut versuchen") at step 1, so a hidden row ahead costs no conversion time | 2026-09-29 |
| Admin rows show `item.title` for non-episodes (audio too) and category labels from `NAV_ENTRIES` | The item JSON has no book/album title; one label source for all pages | 2026-09-28 |
| `runStart` delegates recovery and queue start to a private `startConversions({ db, config, log })` in `src/server.js`; lifecycle and runner tests may split into any number of `queue-lifecycle-*`/`run-converter-*` siblings | `runStart` would otherwise reach about 50–55 of 60 lines; about 17 lifecycle cases with real stub setup do not fit two 300-line files | 2026-09-28 |

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
      imports only `{ spawn }` from `node:child_process` (exactly one
      `child_process` occurrence), `/\bshell\b/` matches nowhere, and the
      bare-call pattern for `exec`, `execFile`, `execSync`, `execFileSync` and
      `fork` does not match (a fixture with `re.exec(` passes).
- [ ] `test/config-converter.test.js` (parsers directly, and `loadConfig`
      for the wiring; `test/config.test.js` stays unchanged and green):
  - `CONVERTER_CMD` unset/empty → `null`
  - a relative first token, or more than 32 tokens → problem, also under
    `requireMediaRoot: false`; the problem text never contains the value
  - `CONVERT_DIR` default, and a problem when it is inside `MEDIA_ROOT` or
    `MEDIA_ROOT` is inside it (only under `requireMediaRoot`)
  - default `CONVERT_DIR` with `DATA_DIR` inside `MEDIA_ROOT` → `problems` is
    exactly `['DATA_DIR: must not be inside MEDIA_ROOT']`
  - `MEDIA_ROOT` unset (and, separately, relative) with the default
    `CONVERT_DIR` → `problems` is exactly `['MEDIA_ROOT: required']` (resp.
    `['MEDIA_ROOT: must be an absolute path']`): no false overlap problem
  - an explicit `CONVERT_DIR` inside the app's `public/` directory → the
    `public` problem, also under `requireMediaRoot: false`
  - `converterCmd` is frozen
  - an explicit `CONVERT_DIR` inside `MEDIA_ROOT` (with a valid `DATA_DIR`) →
    the `CONVERT_DIR` problem; `MEDIA_ROOT` inside the default
    `<DATA_DIR>/converted` → the `CONVERT_DIR` problem (the `DATA_DIR` check is
    one-directional and does not fire)
  - `converterEnv` never contains `ADMIN_PASSWORD` nor `TMPDIR`/`TEMP`/`TMP`; on `win32` a `Path` key
    is copied
  - `isInside`: itself, a child, a sibling with a shared prefix, `..`
- [ ] `test/db/conversions.test.js`:
  - 006 applies on a DB at 005 and as a gap; re-running it is a no-op
  - `test/db/migrate.test.js`'s gap test (edited as listed under "Edited")
    stays green with `006` in the default directory
  - claim is FIFO (ties by `rel_path`) and claims at most one row; it also
    claims a `queued` row whose `rel_path` is absent from `library_items`
  - re-queueing a row resets `notes` to `'[]'`
  - publish sets `library_items.playable = 1` only for a matching size/mtime
  - `failInterruptedConversions` touches only `converting` rows
  - usage sums copies of vanished items too
- [ ] `test/db/library-repo-playable.test.js`: effective playable.
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
    argument; no NTFS-forbidden characters). The env: on non-`win32` the
    echoed env equals the given object exactly; on `win32` every given
    key/value is present, and the remaining keys are a case-insensitive
    subset of libuv's fixed Windows set (Config, "Child environment");
    `ADMIN_PASSWORD` is never present
  - the 1 MiB total cap kills `flood` (`killedBy = 'cap'`, `stdoutInvalid`)
    and stdout accumulation stops at the cap
  - `kill('SIGTERM')` on `hang` → `killedBy = 'stop'`
  - the child's `cwd` is the given per-job dir (`echo` records
    `process.cwd()`)
  - `orphan-pipe` (the stub exits while a grandchild still holds its stdout)
    settles about `closeGraceMs` after `'exit'` (test passes a small value)
    with `stdioTimedOut = true`
  - a missing executable and a synchronous spawn throw → `spawnError`; `result`
    never rejects
- [ ] `test/convert/jsonl.test.js` (pure, Buffer chunks):
  - a single line over 64 KiB trips the line cap while the total is under
    1 MiB; many short lines over 1 MiB trip the total cap; after `'cap'`
    nothing more is accumulated
  - a multi-byte character split across two chunks decodes intact; `\r\n`
    and empty lines
  - `validateRecord`: bad field types, a relative `output`, `converted`
    without `output`, > 10 notes and notes over 2000 characters (truncated),
    an object without `outcome` (ignored)
- [ ] `test/convert/result.test.js`: every interpretation rule and its order
      (exit 2 with valid JSON → `converter_unavailable`; exit 1 + `garbage` →
      `converter_output_invalid`; 0 or 2 records; each outcome; a foreign
      signal vs a cap kill vs 130; `stdioTimedOut` with one valid
      `converted` record → `converter_output_invalid`); `redactDetail` replaces all three roots
      (`<CONVERTER>` for `path.dirname(converterCmd[0])`, skipped when that
      dirname is a filesystem root such as `/`) and
      cuts to 500 characters, replaces the longest spelling first
      (`/srv/media` + `/srv/media-converted` → `<CONVERT_DIR>/…`), and with
      `platform: 'win32'` also matches a differently-cased root and `/`
      instead of `\`.
- [ ] `test/convert/verify.test.js`:
  - an `avc1`+`mp4a` MP4 passes
  - `hvc1`, audio-only, unknown-sniff (no `moov`) and zero-byte MP4s fail
  - FLAC magic pass/fail; Opus with `page_segments` 1 and > 1 passes, a wrong
    magic fails
  - wrong extension (an upper-case `.MP4` passes); an output outside
    `outDir` and a symlink escape →
    `converter_output_invalid` (the symlink case skips on Windows `EPERM`)
- [ ] `test/convert/queue.test.js` (fake `run` returning `{ result, kill }`):
  - only one job at a time; FIFO order (constant `now` → `rel_path` order)
  - `kick()` before `start()` resolved and during a job is a no-op; a
    `start()` resolving `true` claims nothing until `kick()`
  - the next job starts after a failure; an unexpected throw → `internal`
  - a `queued` row whose `rel_path` is absent from `library_items` is claimed
    and ends `failed` `source_missing`, and the next row runs; two queued
    rows whose sources are gone (unmounted `MEDIA_ROOT`, O3) both end
    `source_missing` in turn, and nothing retries
  - `stop()` prevents new claims, including a job finishing while `stop()` is
    pending; `stop()` resolves only after the job's DB write and cleanup
  - `stop()` during steps 1–3 → `run` is never called, the row is `failed`
    `interrupted`, and `stop()` resolves promptly. No extra seam is needed: a
    synchronous `stop()` right after `kick()` lands there, because `kick()`
    claims synchronously and the job's first `await` (source resolution in
    step 1) comes before the step-4 check
  - `stop()` while a run is in flight calls the handle's `kill('SIGTERM')`
    at once and `kill('SIGKILL')` after `killGraceMs` if `result` is still
    pending; no timer stays armed after `result` settled
  - a run ending by a foreign signal after `stop()` → `interrupted`
  - a run whose `result` never settles and whose `kill` does nothing:
    `stop()` resolves after `stopDeadlineMs` (test passes a small value),
    logs `conversion_stop_timeout`, and the row stays `converting`
  - `run` receives `cwd` = the job dir, `outDir` = its `out/`, and an `env`
    equal to `config.converterEnv` plus `TMPDIR`/`TEMP`/`TMP` = the job's
    `tmp/`
- [ ] `test/convert/queue-lifecycle.test.js` (real stub):
  - `ok` publishes `<key>/web.mp4`, the flag and `output_size`, and removes the
    work dir
  - `not-browser-safe` → failed, flag stays 0, no file under `<key>/`
  - `crash`/`hang`+`stop()`/`usage`/`escape` → the matching code, and
    `.videothek-work/` is empty afterwards
  - a source modified between `--hold` `started` and `go` → `source_changed`
  - startup with a leftover `.videothek-work/x` → wiped; a `start()` with an
    unwritable `convertDir` (portable setup: its parent is a regular file, so
    `mkdir` fails `ENOTDIR`) or an overlapping one resolves `false` and writes
    nothing
  - symlinked ancestor: `<tmp>/link -> <mediaRoot>` and `convertDir =
    <tmp>/link/converted` (not existing) → `start()` resolves `false`
    (`overlap`) and the `MEDIA_ROOT` listing is unchanged (no `converted/`
    created)
  - symlink into the public dir: an injected `publicDir` (a temp dir),
    `<tmp>/pub -> <publicDir>` and `convertDir = <tmp>/pub/converted` →
    `start()` resolves `false` (`public`) and the `publicDir` listing is
    unchanged; a dangling symlink as the nearest existing ancestor →
    `false` with its `realpath` code and nothing created (on `win32` the
    junction setup skips on `EPERM`/`ENOENT`)
  - a `converterCmd` whose absolute executable does not exist →
    `converter_unavailable` with `error_detail` exactly the errno code
    (`ENOENT`), no path
  - `error_detail` and stored `notes` contain no absolute root path; no log
    line contains a path or stderr text
  - the first job after `start()` (which removed `.videothek-work/`) runs,
    i.e. step 3 re-creates the work area
  - an injected `removeDir` rejection (`EBUSY`) after a successful `ok`
    publish leaves the row `playable`, `library_items.playable = 1` and the
    copy in place, and logs `conversion_cleanup_failed`; the same injection
    after a `not-browser-safe` run keeps `error = 'not_browser_safe'`
  - a `start()` whose work-area removal fails (injected `removeDir` that
    rejects only the `.videothek-work` path itself) resolves `false`
    (`conversion_dir_unavailable`)
  - planted work-area and storage symlinks (each target is an outside temp
    dir with one file in it):
    - `.videothek-work` is a symlink to the non-empty target before
      `start()` → after `start()` the target's listing is unchanged (only the
      link was removed) and the first job still runs
    - `.videothek-work` is replaced by a symlink to the target after `start()`
      resolved and before the first job is enqueued → the job ends
      `storage_failed` and nothing is created in the target
    - `<convertDir>/<storage_key>` is pre-planted as a symlink to the target
      → the job ends `storage_failed`, the target is unchanged, the row is
      not `playable` and `library_items.playable` stays 0
    - between `--hold` `started` and `go` the test plants directory links
      `out/evil` and `tmp/evil` to the target (emulating a converter that
      leaves them) → after the job's cleanup the target's listing is
      unchanged
  - every directory link in these cases is created with
    `fs.symlink(target, p, process.platform === 'win32' ? 'junction' : 'dir')`,
    so they run on `win32` without privileges (a junction `lstat`s as a
    symbolic link); only `verify.test.js`'s file-symlink case skips on `EPERM`,
    and the dangling-link case skips on `EPERM`/`ENOENT` when `win32` cannot
    create its junction
  - nothing outside `convertDir` is created or removed (checked with a
    temp-dir listing)
- [ ] `test/server-conversions.test.js` (`start({ config, log })` with a
      hand-built config, like `test/server.test.js`; the config must carry
      `adminUser`/`adminPassword`, otherwise `ensureAdmin` throws
      `BootstrapError` and `start()` calls `process.exit(1)`, killing the
      test runner; a seeded `library_items` row needs
      `scan_version = SCAN_VERSION` besides the matching `size`/`mtime_ms`,
      because the scanner's `isUnchanged` compares all three):
  - a `converting` row becomes `failed` `interrupted` at startup with
    `CONVERTER_CMD` unset; `queued` rows stay
  - wiring with the feature on: a DB pre-seeded (migrated, one indexed item
    whose source file lies under a category root, e.g. `Filme/x.mkv`, with
    the row's `size`/`mtime_ms` matching the file's `stat`, so the startup
    scan keeps it; one `queued` row) and
    `converterCmd: [process.execPath, stub, '--mode', 'hang', '--hold',
    <dir>]`; once `<dir>/pid` exists, `stop()` resolves, and the DB reopened
    afterwards shows the row `failed` `interrupted` (the job's write happened
    before `db.close()`, i.e. the queue stopped first) and no running stub
    process is left (`process.kill(pid, 0)` throws `ESRCH`)
- [ ] `test/api/conversions.test.js` (+ `test/api/conversions-post.test.js`
      if split; boot with `startTestApp`, then build a stub-backed queue with
      `{ …config, converterCmd: [process.execPath, stub, …], converterEnv:
      {} }` (an explicit empty env: the stub is spawned through the absolute
      `process.execPath` and needs no `PATH`, and the job adds its own
      `TMPDIR`/`TEMP`/`TMP`; no test other than the converter stub reads
      `process.env`),
      `await queue.start()`, assign `deps.conversions` on the harness's
      returned `deps`; `await queue.stop()` before `close()`):
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
  - `position` counts waiting rows only; `ids` naming only the second
    waiting item → its `position` is 2; group ordering; `usage` including
    `freeBytes`
- [ ] `test/api/media-converted.test.js`:
  - a converted MKV item streams the copy with `video/mp4`, `206` for a
    Range, `416` beyond the end, and `HEAD` without a body
  - a stale copy → `404 not_playable`
  - a fresh row whose file was removed → `404 not_found` (O2 (a))
  - an `output_rel` tampered to `../x` or an absolute path → `404`
    (containment)
  - the original under `MEDIA_ROOT` is byte-identical afterwards
  - `PUT /api/progress/:id` for the converted item → 200 (not
    `not_resumable`)
- [ ] `test/public/convert-control.test.js` (DOM fakes, precedent
      `test/helpers/player-page-fakes.js`): the first-match control table row
      by row; POST error mapping (`409` → "Konvertiert", `400`/`404`/`503` →
      control removed, other → retry text, button enabled again); "Neu laden"
      calls `location.reload()` (O1); the poller
      stops on `!root.isConnected`, pauses while hidden, stops for good on
      `401`/`403` and keeps its interval on a transient error.
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
| SIGTERM does not stop a Python converter's ffmpeg grandchild, and an orphan may keep writing after a crash | Irrelevant for the stub. A unique work dir per attempt keeps an orphan out of a retry. Phase 8 introduces the process-group kill and the converter's `.partial` cleanup; `.videothek-work/` is wiped at the next start regardless |
| On Windows (dev) `kill('SIGTERM')` is `TerminateProcess` and file handles linger | Runner settles on `'close'`; every `rm` has `maxRetries: 3`; directory-link tests use junctions; only the file-symlink test skips on `EPERM` and the dangling-junction case on `EPERM`/`ENOENT`. Production is Linux |
| The strict sniff misses DTS/MP2 in `mp4a` or 10-bit h264 (`avc1`) | Known sniffer gap (prior art). The `web` target is specified to re-encode those; the human QA of Phase 8 checks real files |
| `test/db/migrate.test.js`'s gap test pins the exact set of default migrations (`[1, 2, 3, 4]` after recording version 5), so every new migration file breaks it | The migration issue relaxes the assertion to "below 5 exactly `[1, 2, 3, 4]`, and 5 not re-applied" (listed under "Edited"); Phase 8's migrations then need no edit there |
| The upsert SQL now references `conversions`, so a test applying only some migrations and then calling `upsertItem` would break | Verified 2026-09-28: every test that calls `upsertItem` migrates the default directory (`test/db/audio-meta-repo.test.js`'s `makeDb` included); the partial-directory tests (`audio-meta-repo` 004 case, `image-meta`, `migrate`) never call it. The library-repo issue re-checks this and adds the regression cases |
| Phase 8 cleanup deletes a `playable` row but leaves `library_items.playable = 1` | Stated contract for Phase 8: delete the row, then reset the flag in the same transaction by setting `scan_version = 0` for that path (forces a re-parse) or recomputing it |
| `rename` over a stale copy that is streaming (Windows `EPERM`) | Target is Linux (rename over an open file is fine). On Windows the job ends `storage_failed` and can be retried |
| A converted track earlier in play order becomes its audio group's cover member (`resolveCoverId` picks the first playable member), so an album or book that took an embedded cover from a later member can lose it when the converted track has none (e.g. APE, whose tags are not read) | Cosmetic; folder and sidecar images are unaffected. Accepted for Phase 7; revisit with the Phase-8 human QA on real files |
| Many not-playable items create large `ids` requests | Batches of ≤ 500 ids; one indexed query per batch |
| The four page hooks conflict with parallel issues | One import + one call per file, next to the existing `decorateProgressFor` line; a rebase resolves it |
| Disk fills up, since no limit is enforced | Usage and free space are visible on `/admin` (H5); enforcement comes in Phase 8 |
| Paths with spaces in `CONVERTER_CMD` | Documented as unsupported (README: 8.3 short name on Windows); production uses a venv path without spaces |
| A source re-copied with `cp` gets a new mtime and loses its copy | Documented in the README; `mv`/`rsync -t` keep the copy fresh. Stale copies are re-convertible |
| A second SIGINT/SIGTERM during shutdown (`src/server.js` `installSignalHandlers` exits 1 at once) orphans a running converter; so does a crash | The orphan cannot write into a retry's dir (unique work dir) and `.videothek-work/` is wiped at the next start. README: `--init`/tini when videothek is PID 1 in a container, default `KillMode=control-group` under systemd, so the orphan is reaped. Process-group kill is Phase 8 |
| A child that never exits, even after `SIGKILL` (uninterruptible I/O on a hung mount), would block shutdown | `stop()` resolves after `stopDeadlineMs` at the latest; the row stays `converting` and startup recovery marks it `interrupted` |
| Vision success criterion "Weak hardware" (two concurrent 1080p streams without stutter on a Pi 4) can be missed while a conversion runs, since Phase 7 has no `nice`/`ionice` | **Accepted consciously at the spec-acceptance gate** (2026-09-29, Prior decisions): conversions are admin-triggered and one at a time, the README states the effect, and CPU/IO priority plus playback protection arrive in Phase 8 |
| Issue #209: `excluded.playable` in `ON CONFLICT DO UPDATE SET playable = excluded.playable` must resolve to the *computed* effective value, not the raw first bind param, or a rescan of an unchanged file would keep a stale flag | Verified: SQLite's `excluded.<col>` is the value the `VALUES` expression for that column would have produced, so putting the whole `(? OR EXISTS (...))` expression directly in the `playable` `VALUES` slot makes `excluded.playable` already carry the OR'd result — no separate handling needed for insert vs. update |

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
- 2026-09-28: Review round (head 09a060b) folded in. Blocking: `stop()` now
  kills an existing handle at once and a job checks `stopping` right before
  spawning, so a stop during steps 1–3 no longer waits for a whole
  conversion; step 3 re-creates the work area that `start()` removed. The
  test plan no longer pushes `test/db/library-repo.test.js` (289 lines),
  `test/server.test.js` (254) or `test/config.test.js` (268) over the
  300-line limit: new files `test/db/library-repo-playable.test.js`,
  `test/server-conversions.test.js`, `test/config-converter.test.js`; the API
  test split keeps the mirrored name `test/api/conversions.test.js`.
  Non-blocking: bounded `'close'` wait (`closeGraceMs`, stub mode
  `orphan-pipe`); notes redacted; work area renamed `.videothek-work/`;
  Outcome on work-area cleanup narrowed; rule sources credited
  (`docs/design.md`, `test/constitution.test.js`); `src/config-converter.js`
  made required and holds the exported `isInside`; architecture boundary,
  config and component rows plus constitution "own format check" wording;
  Windows details (`Path` lookup, `redactDetail` case/separators, timers
  cleared); targets precedence; `position` over visible rows; audio hook
  placement; queue-stop await in `createStop`'s `finally`; `deps.conversions`
  in the API recipe; prior-art line refs; roadmap Phase 9 for gallery videos;
  README note on orphaned copies after a DB delete. O1–O3 stay open; O2 (a)
  now names its `architecture.md` exception; O3 (b) is re-posed (root health
  via `rootHealth`, explicit `paused` flag, POST on a `queued` row kicks) and
  its recommendation changes to (a) because the corrected (b) spans job,
  queue, API and admin panel.
- 2026-09-28: Review round (head fe514cf) folded in. Blocking: a defaulted
  `CONVERT_DIR` no longer adds its overlap problem when the `DATA_DIR` problem
  already fired, so the unchanged `test/config.test.js` `deepEqual`
  assertions (lines 106-160) stay green; an explicit `CONVERT_DIR` is always
  checked, with two new `test/config-converter.test.js` cases. The step-7
  work-dir removal never changes the recorded end state (only
  `conversion_cleanup_failed` is logged, `removeDir` seam + lifecycle test);
  `storage_failed` now covers only steps 3 and 6. Non-blocking: converter
  side-effects clause (SRC read-only, writes only in OUTDIR) in the contract
  and in constitution.md's child-process Don't, `cwd` = per-job dir, README
  read-only-`MEDIA_ROOT`, no-`nice` and not-inside-`public/` notes; publish
  renames `verifyOutput`'s realpath, `isInside(convertDirReal, …)` checks on
  the work dir and `<storage_key>/`; pure `src/convert/jsonl.js` for the
  runner's line/record test cases, `closeGraceMs` in the signature, stdout
  stops accumulating at a cap, 4 KiB stderr ring buffer, `start()` `rm`
  failure → `conversion_dir_unavailable`; `isConvertible` uses `!row.playable`
  (TS2367); narrowed constitution-test call pattern; decorator checks
  "not convertible" first, admin retry buttons only when `convertible`, no
  `:last-child` reliance; more pre-authorised splits and the `parseItemId`
  precedent; feature-on server wiring test and `pickConverterEnv` for the API
  test; KillMode race note; relative paths visible to admins; elapsed time
  in "Läuft gerade"; architecture Config row and "New config value" line,
  roadmap Phase-7 row and prior-art `DATA_DIR` wording aligned with
  `CONVERT_DIR`. O1-O3 stay open; O2 notes which parts change if (b) or (c)
  is chosen.
- 2026-09-28: Review round (head d073124) folded in. Blocking: the three new
  `Config` properties stay required, and `test/library/index.test.js` (whose
  `fakeConfig()` is the only uncast `Config` literal) is listed under
  "Edited" so `tsc` stays green; the lexical `CONVERT_DIR` overlap check is
  skipped while `mediaRoot` is `''`, so an unset or relative `MEDIA_ROOT`
  still yields exactly its one problem (new config-converter case);
  `start()` now realpaths the nearest existing ancestor of `CONVERT_DIR`,
  checks the overlap and only then runs `mkdir -p` (then re-checks), so a
  symlinked ancestor into `MEDIA_ROOT` never gets a directory created under
  it (new lifecycle case). Non-blocking: `playable` boundary in
  `docs/architecture.md` names the removed-copy exception under every O2
  option; step 3 verifies `.videothek-work` before `mkdtemp` and steps 6/7
  use the checked realpaths; `error_detail` is only an errno code or error
  name for spawn, storage, source and internal errors; the job points
  `TMPDIR`/`TEMP`/`TMP` at its own `tmp/` dir (dropped from the allowlist)
  and the contract and constitution wording say "OUTDIR or the given temp
  dir" and "contract handed over and verified by stub tests";
  `converterCmd` typed `readonly string[] | null`; queue `position`
  numbered over all visible queued rows before the `ids` filter;
  `CONVERT_DIR` inside `public/` is a config problem; `stop()` has a hard
  `stopDeadlineMs`; Risks rows for a second signal and for a child ignoring
  `SIGKILL`; README notes on `--init`/tini and `KillMode`; architecture
  Conversion, Path guard and Config rows; `redactDetail` longest spelling
  first; `pickConverterEnv` platform default; stub `hang` writes its pid
  with `--hold`; pre-authorised `public/js/admin-conversions-rows.js`;
  converted audio keeps `duration: null`; control-video exports relabel the
  impossible WEBM samples as MKV/AVI (PNGs re-rendered); prior-art
  Foundation-impact line numbers marked "as of main before Phase 7"; the Pi
  "Weak hardware" criterion without `nice`/`ionice` is a Risks row to be
  accepted consciously at the gate. O1-O3 stay open.
- 2026-09-28: Review round (head 9ceeea7) folded in. Blocking:
  `test/db/migrate.test.js` is listed under "Edited" for the migration issue
  and its gap assertion is relaxed to "below 5 exactly `[1, 2, 3, 4]`, 5 not
  re-applied", because `006-conversions.sql` would otherwise make it return
  `[1, 2, 3, 4, 6]` and fail verify (plus a Verification line and a Risks
  row). `start()` now `lstat`s the work area first, passes `fs.rm` a path
  without a trailing separator and only `unlink`s a symlink, junction or file,
  so a planted link is never recursed into; three new lifecycle cases cover a
  `.videothek-work` link before `start()`, one swapped in before the first
  job, and a pre-planted `<storage_key>` link. Non-blocking: steps 3/6
  require realpath equality with `path.join(convertDirReal, <name>)` instead
  of `isInside` (containment failures carry `error_detail` `containment`);
  `removeDir` is the seam for both `start()`'s wipe and step 7, with portable
  setups for a failing wipe and an unwritable `convertDir` (`ENOTDIR`); the
  constitution's child-process Don't keeps only app-side, testable
  obligations scoped to `src/`, and the converter-side clause moves to
  `docs/architecture.md` Boundaries; the API test recipe passes
  `converterEnv: {}` instead of reading `process.env`; repository rows keep
  `li.*` plain and alias conversion columns `c_*`; the constitution test
  forbids `/\bshell\b/`; CSS guidance for the 390 px line break within the
  `768px`/`1024px` breakpoint rule; the feature-on server test seeds its item
  under a category root with a matching stat; the admin-panel sample
  "Mondscheinsonate" is relabelled APE (PNGs re-rendered); `routes.js` is
  one import + one call and the conversions API reads `deps` only at request
  time; prior-art Phase-7/8 Foundation-impact wording (`CONVERT_DIR`, "as of
  main after Phase 7", group kill for every kill path, contract location);
  the architecture Scan flow notes that deleting the DB drops conversion
  state and orphans the copies; `redactDetail` gains a `<CONVERTER>` root.
  O1-O3 stay open: no finding settles them.
- 2026-09-28: Review round (head 5c7e529) folded in. Blocking: the child
  environment on `win32` is the allowlist plus libuv's fixed Windows set
  (verified on the dev machine with `spawnSync`), so the Config row no longer
  claims that no other variable reaches the converter, and the runner test's
  `echo` env assertion is exact only on non-`win32` (on `win32` a superset
  limited to libuv's set, never `ADMIN_PASSWORD`); the Phase-8 allowlist
  revisit names libuv's set. The stub's `echo` mode reading its own
  `process.env` is covered by constitution.md's `process.env` rule, whose stub
  exception the next round made explicit, and the API recipe says "no test other than
  the converter stub reads `process.env`".
  Non-blocking: lifetime `'error'` listener in the runner; the
  `test/server-conversions.test.js` recipe names `adminUser`/`adminPassword`
  and `scan_version = SCAN_VERSION`; private `startConversions` helper in
  `src/server.js`; test splits by `queue-lifecycle-*`/`run-converter-*`
  pattern; `start()` rejects a `CONVERT_DIR` reaching `public/` by realpath
  (`publicDir` seam, `APP_PUBLIC_DIR`, new lifecycle case) and defines the
  walk-up with `lstat` (a failing ancestor `realpath` resolves `false`);
  `redactDetail` skips a filesystem-root `<CONVERTER>`, and the Phase-8
  adapter issue notes venv tracebacks and doubled backslashes; `win32`
  `CONVERTER_CMD` needs a drive letter or UNC prefix, README notes on
  `.bat`/`.cmd` (`EINVAL`) and on the converter as trusted code; converter
  notes are shown verbatim and may be English; Risks row for a converted
  track taking over an audio group's cover; the Pi "Weak hardware"
  acceptance is to be recorded here at the gate; Outcome 503 applies to
  known ids only; `getItemByRelPath` in the P2 contract; prior-art
  Scan-flow line reference corrected to architecture.md:63. O1-O3 stay
  open: no finding settles them.
- 2026-09-28: Review round (head 9b57160) folded in. Blocking: constitution.md
  and architecture.md now name the converter stub as the sole exception to
  the `process.env` rule, and the spec cites that clause. Non-blocking:
  `stdioTimedOut`; `startConversions` placement and kick after `listen`;
  junction-based directory-link tests plus a links-in-`out/`/`tmp/` case;
  redaction order for detail and notes; removal wording; idle-queue Outcome
  text; `test/public/convert-control.test.js` and poller error rules; admin
  row titles and labels; the three item-9 decisions; constitution env
  wording and architecture stop-deadline note. Skipped: a `title` for
  `.convert-control` (intent unclear). O1-O3 stay open.
- 2026-09-29: Spec-acceptance gate passed. O1 (a): "Neu laden" reloads
  every page. O2 (a): a missing copy file stays flag 1 / `404` until Phase 8;
  README note, architecture.md exception kept. O3 (a): unmounted
  `MEDIA_ROOT` fails queued jobs `source_missing`, manual re-queue. H1–H5
  ratified. The Pi "Weak hardware" risk is accepted. Human prerequisites:
  none blocking; QA-only items are provided at the milestone QA gate.
  Queue blocker fixed: `claimNextConversion` no longer skips rows absent
  from `library_items` (a skipped row could wait forever); such a job fails
  `source_missing`, and only `position`/listing stay visible-only. Also: the
  `process.env` rule scoped to `src/` (stub exception) in Constraints and
  architecture.md; notes keep their first 200 characters, and the no-split
  claim is limited to spellings inside the first 2000; the dangling-junction
  case may skip on `win32` `EPERM`/`ENOENT`.
- 2026-09-29: Issue #213 (`src/convert/jsonl.js`) implemented. `invalid` is a
  sticky boolean (never reset once a line fails JSON.parse or
  `validateRecord`), not a list — the runner only needs one bit for
  `stdoutInvalid`. Both caps trip on strictly-`>` (a line/run at exactly the
  configured size is not capped); line-byte accounting counts a line's
  content only (the `\n` delimiter itself counts toward the total cap, not
  the line cap). Newline splitting scans raw bytes for `0x0A` before any
  decoding (UTF-8 continuation bytes never contain `0x0A`), so a multi-byte
  character split across `push()` calls is handled by feeding each raw
  segment through one persistent `StringDecoder`, never by decoding a chunk
  before its line boundary is known.
- 2026-09-29: Issue #212 (`test/helpers/converter-stub.js`) implemented. Two
  stub-only decisions, neither touching the app-side contract: (1) the
  `orphan-pipe` mode spawns its grandchild with `detached: true` (in addition
  to the spec's inherited stdio) — verified on the dev machine that without it
  Node ties an undetached child's lifetime to its spawning process on
  `win32`, so the grandchild died the instant the stub exited instead of
  outliving it as the mode requires; `detached` is scoped to this test double
  and does not apply to `src/convert/run-converter.js`, whose "no detached"
  constraint (Constraints) is unchanged. (2) every mode signals its exit via
  `process.exitCode` and lets the event loop drain instead of calling
  `process.exit()`, because a forced exit can truncate stdout still being
  flushed to a pipe on `win32`, which would corrupt the very JSON Lines
  records `src/convert/jsonl.js` needs to read intact. The grandchild keeps
  the spec's bounded 30-s sleep, so a detached orphan a failed test never
  kills still ends on its own. `--hold` and `--delay-ms` apply only to the
  modes that print JSON Lines (header JSDoc lists them); the delay runs after
  the output is written, right before the first line. The stub gets its own
  `test/helpers/converter-stub.test.js`, so a drifting mode fails there
  instead of inside the runner/queue suites.
- 2026-09-29: Issue #216 (`verifyOutput`) implemented. `VerifyResult` is
  `{ ok: true, path }` (the resolved realpath step 6 publishes) or
  `{ ok: false, error }` with `converter_output_invalid` (containment/type/
  extension) or `not_browser_safe` (format check) — no shape was fixed in the
  spec text, so this mirrors `interpretRun`'s `{ ok, ... }` style. The `web`
  check independently rejects a null sniff and a zero-video-track result
  before calling `resolvePlayable` (which alone would treat "unknown" as
  playable by extension, per the scanner's looser rule) — matching "unknown
  fails here, unlike the scanner".
- 2026-09-29: Issue #215 (`interpretRun` / `redactDetail`) implemented.
  `Interpretation` is `{ ok: true, output, notes }` or
  `{ ok: false, error, detail }`, mirroring `verifyOutput`'s `{ ok, ... }`
  style; `detail` is the errno code (rule 1), the stderr tail (rule 3), or
  the record's own non-empty `error` else the stderr tail (rule 5, reused for
  rule 7's `failed` outcome, since the spec gives one formula for both
  `converter_failed` sites) — every other rule (2, 4, 6, 7's `unsupported`/
  `skipped`, 8) has no stated diagnostic text and returns `detail: null`
  (the DB's `error_detail` column is nullable). Rule 5's "any other non-zero
  exit" excludes `exitCode === null` (a signal-only termination), so it
  cannot misfire on a run `killedBy = 'stop'`, though the queue never calls
  `interpretRun` for one anyway. `redactDetail`'s `roots` parameter is fixed
  as `{ mediaRoot: string[], convertDir: string[], converterDir: string |
  null }` — one entry per configured spelling, `converterDir` singular since
  config is read once — because no caller signature existed yet for later
  issues to match; `redactDetail` itself applies the `<CONVERTER>`
  filesystem-root skip (`path.parse(d).root === d`) rather than requiring the
  caller to pre-filter. Both the skip check and the case/separator-insensitive
  win32 matching use the passed `platform` option (`path.win32` vs
  `path.posix`), never the host OS, so both branches are unit-testable from
  either dev machine (same pattern as `parseConverterCmd`/`pickConverterEnv`).
- 2026-09-29: Issue #207 (`src/config-converter.js`, `CONVERTER_CMD`/
  `CONVERT_DIR` config wiring) implemented, completing rescued work from an
  interrupted prior run. Two review fixes on top of the rescue: (1) the two
  `loadConfig`-driven "relative `CONVERTER_CMD`" tests hardcoded the POSIX
  rule text, so they failed on a win32 dev machine where `loadConfig` (no
  `platform` override) reports the drive-letter/UNC rule instead — the
  expectation now follows `process.platform`, same as the pre-existing
  `converterCmd is frozen` test already did; `npm run verify` is asserted
  green on win32, not assumed from a POSIX CI run. (2)
  `test/config-converter.test.js` was 312 lines, over the constitution's
  300-line file limit (`test/constitution.test.js` caught it): consolidated
  into the codebase's existing table-driven `for (const … of […]) { test(…) }`
  style (`test/config.test.js` precedent) for the accepted-`CONVERTER_CMD`
  cases, merged the two `requireMediaRoot: false` variants into their base
  case, and dropped the one overlap-direction combination
  (`MEDIA_ROOT` inside an *explicit* `CONVERT_DIR`) not named by the
  acceptance list — both required directions stay covered (explicit dir
  containing `MEDIA_ROOT`; `MEDIA_ROOT` inside the *default* dir), plus the
  direct `isInside` unit tests.
- 2026-09-29: Issue #208 (`006-conversions.sql` + `src/db/conversions.js`)
  implemented as specified, with one line-budget fix: `test/db/conversions.test.js`
  was at 352 lines (over the constitution's 300-line limit). Fixed by merging
  redundant single-assertion tests into their nearest scenario (`getConversion`
  undefined-path check folded into the `enqueueConversion` test; the two
  `publishConversion` cases — matching and mismatching size/mtime — merged
  into one test with a second `rel_path`; `getConversionUsage`'s empty-table
  case folded into the summing test; the separate "claims a row absent from
  `library_items`" test dropped, since the existing FIFO test's rows already
  have no `library_items` counterpart, now called out with a comment) instead
  of splitting the file, since the spec's pre-authorised splits do not list
  this file and `test/constitution.test.js` requires the exact mirror name
  `test/db/conversions.test.js`. No behavioural coverage was dropped, only
  test-scaffolding overhead. `npm run verify` green (1468 tests, 0 failures).
- 2026-09-29: Issue #209 (effective `playable` in `UPSERT_ITEM_SQL`) implemented
  as specified: the `playable` `VALUES` slot becomes
  `(? OR EXISTS (SELECT 1 FROM conversions c WHERE c.rel_path = ? AND
  c.status = 'playable' AND c.source_size = ? AND c.source_mtime_ms = ?))`,
  bound with the built row's `playable`, `rel_path`, `size`, `mtime_ms`; the
  `ON CONFLICT` clause is untouched (`playable = excluded.playable` already
  picks up the computed value — see the new Risks-table row above). New file
  `test/db/library-repo-playable.test.js` inserts `conversions` rows with a
  raw SQL statement (not via `src/db/conversions.js`) so its tests exercise
  only this SQL in isolation; `test/db/library-repo.test.js` was not touched.
  `npm run verify` green (1577 tests, 0 failures).
- 2026-09-29: Issue #210 (`src/db/conversion-queries.js`) implemented as
  specified. The `queue_position` CTE (`ROW_NUMBER() OVER (ORDER BY
  queued_at, rel_path)` over `conversions JOIN library_items`, `WHERE status =
  'queued'`) is inlined as a `WITH` prefix in both statements rather than
  shared as a view, since each is its own prepared statement; both join it
  with a `LEFT JOIN … ON rel_path` after the base `FROM`, so a row absent from
  the CTE (non-queued, or the running job) gets `position IS NULL` for free.
  `listConversionRows` starts `FROM conversions c JOIN library_items li`
  (only rows present in both); `listConversionRowsForIds` starts `FROM
  library_items li LEFT JOIN conversions c`, filtered by `li.id IN (SELECT
  value FROM json_each(?))`, so an id with no conversion row still comes back
  with every `c_*` column and `position` `NULL`, and an id absent from
  `library_items` is never in the result to begin with — no special case is
  needed for an empty `ids` array, since `json_each('[]')` itself yields no
  rows. All 14 `conversions` columns are aliased `c_*` (including `c_rel_path`
  and `c_storage_key`, not just the ones the spec names as examples), per
  "every `conversions` column is aliased". `npm run verify` green (1573
  tests, 0 failures).
- 2026-09-29: Issue #224 (`src/api/conversion-json.js`) implemented as
  specified: `deriveConversionStatus` derives `stale` from a `playable` row's
  `c_source_size`/`c_source_mtime_ms` vs. the joined item's own `size`/
  `mtime_ms`; `buildConversionEntry` builds the full entry (`item` via P2's
  `toItemJson`, `convertible`/`target` via `isConvertible`/`targetFor`, notes
  `JSON.parse`d, timestamps to ISO-8601 or `null`); `buildConversionList`
  groups `listConversionRows`' rows `converting, queued, failed, stale,
  playable`, `queued` ascending by `position`, every other group descending
  by `finished_at` else `queued_at` (a stable sort keeps the SQL's own
  `queued_at, rel_path` order for ties). `listConversionRowsForIds` orders by
  `li.id`, not request order, so the request-order reordering ("in request
  order... unknown ids omitted") is this module's job too:
  `buildConversionEntriesForIds(rows, ids)` looks each requested id up in a
  `Map` and skips one absent from `rows`. `parseConversionIds` validates the
  raw comma-split token count against the 1-500 bound before deduplicating
  (so 501 identical ids is still rejected, not collapsed to one), matching
  `media.js`'s `:id` syntax (`^[1-9][0-9]{0,15}$` + `Number.isSafeInteger`).
  `test/api/conversion-json.test.js` covers status derivation (incl. size-only
  and mtime-only staleness), entry field mapping, both listing orders
  (including the `finished_at`-vs-`queued_at` fallback and the running job's
  `position: null`), request-order/omission for `ids`, and the ids parser's
  valid/invalid table (duplicates, empty, leading zero, decimal, negative,
  501 ids, an unsafe 16-digit integer). `npm run verify` green (1651 tests,
  0 failures).
