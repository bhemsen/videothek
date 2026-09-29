# Constitution

> Normative and binding. Every principle must be verifiable and specific.
> Keep to ~1 page; this file is permanently loaded via CLAUDE.md. No status
> marker — foundation docs carry none.

## Tech stack

| Area | Choice | Rationale |
| ---- | ------ | --------- |
| Runtime | Node.js 24 LTS (`engines.node: ">=24"`) | Ships `node:sqlite`, recursive `fs.watch`, `node:test` built in |
| Language | Plain JavaScript, ES modules, JSDoc types | No build step; types still checked |
| Type checking | `typescript` + `@types/node` (only devDependencies), `tsc --noEmit` with `checkJs`, `strict` | Catches defects without a compile step |
| HTTP | `node:http` with a small in-house router | No framework, full control over range streaming |
| Persistence | `node:sqlite` (`DatabaseSync`), one DB file under `DATA_DIR` | Embedded, zero-dep; users, sessions, progress, library index, conversion state |
| Auth | `node:crypto` scrypt + opaque session cookie | Built-in, OWASP-grade hashing |
| Tests | `node:test` + `node:assert/strict` | Built-in runner |
| Frontend | Vanilla HTML/CSS/JS ES modules served as static files, native `<video>`/`<audio>`/`<img>` | No bundler, no UI framework |
| UI language | German, strings inline, no i18n layer | Single-household audience |
| Config | Environment variables only (`MEDIA_ROOT`, `DATA_DIR`, `PORT`, `HOST`, `RESCAN_INTERVAL_MIN`, `ADMIN_USER`, `ADMIN_PASSWORD`, `CONVERTER_CMD`, `CONVERT_DIR`), `.env` loaded via `node --env-file-if-exists` | Built-in, no dotenv |

## Architecture principles

- Zero runtime dependencies: `package.json` has no `dependencies` key; `devDependencies` contains only `typescript` and `@types/node`.
- Media root is read-only: no code path opens files under `MEDIA_ROOT` for writing, renaming or deleting.
- Every filesystem path derived from a request or from a converter result is resolved and verified to lie inside `MEDIA_ROOT` (sources) or `CONVERT_DIR` (converted copies, never overlapping `MEDIA_ROOT`) before access; violation -> `404` or a failed job.
- Every route except `/login`, static assets and `/healthz` requires a valid session.
- Media is streamed with `fs.createReadStream` and honours `Range` (206/416); no media file is read fully into memory.
- The library index is rebuildable at any time from `MEDIA_ROOT` plus the conversion state; progress and users are the only non-derivable data. Conversion rows and the copies under `CONVERT_DIR` are derivable but expensive: losing them costs re-conversion, never user data.
- Change detection = debounced `fs.watch` fast path + periodic full rescan; the app stays correct if the watcher emits nothing.
- Server-side modules never import from `public/`; frontend never imports server modules.
- Max 60 lines per function, max 300 lines per file.
- SQL only via prepared statements with bound parameters; no string-concatenated SQL.

## Conventions

- Files and directories: `kebab-case.js`; functions/variables `camelCase`; DB tables/columns `snake_case`.
- Code, comments, commit messages, docs: English. UI text: German.
- Every exported function has a JSDoc signature (`@param`, `@returns`).
- Error responses are JSON `{ "error": "<code>" }` for `/api/*`; HTML pages only for page routes.
- Config is read once in `src/config.js`; no `process.env` access elsewhere (sole exception: the converter double `test/helpers/converter-stub.js`, which stands in for the external converter process and only reports the environment it received).
- Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Quality gates

- `npm run verify` green: `tsc --noEmit` (strict, checkJs) + `node --test`.
- Every new module under `src/` has a matching `test/*.test.js`; range handling, path containment and auth have tests for their failure cases.
- `npm ls --omit=dev --all` shows no packages.
- UI changes checked in a browser (Chromium + Firefox) before milestone QA.

## Don'ts

- No npm runtime dependency, no bundler, no frontend framework, no CSS framework.
- No writes, moves or deletes under `MEDIA_ROOT`.
- No transcoding in the app process. Code under `src/` starts child processes only for the configured external converter (`CONVERTER_CMD`) and only from `src/convert/run-converter.js`: `spawn` with an argv array, never through a shell, one at a time, with `cwd` and `TMPDIR`/`TEMP`/`TMP` set to a per-job directory under `CONVERT_DIR`, and an environment built from an allowlist (on Windows libuv adds its fixed system set) that never contains `ADMIN_PASSWORD`. A result counts only after videothek's own format check (MP4 codec sniff; FLAC/Ogg-Opus magic). The converter's own side of the contract is in `docs/architecture.md` (Boundaries).
- No outbound network calls (metadata, telemetry, CDNs) — all assets served locally.
- No secrets or password hashes in logs; no plaintext passwords stored.
- No `eval`, `new Function`, or `innerHTML` with unescaped data.
