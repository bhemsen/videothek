# Architecture

> Structural, living document — the most volatile artifact. Update whenever a
> change alters components, boundaries, or flows. Greenfield seed (2026-09-26).

## Component map

| Component | Path | Responsibility |
| --------- | ---- | -------------- |
| Entry point | `src/server.js` | Reads config, opens DB, starts scanner + HTTP server, graceful shutdown |
| App assembly | `src/app.js` | Session resolution, origin check, dispatch, error mapping |
| Config | `src/config.js` | Sole reader of `process.env`; validates `MEDIA_ROOT` exists and is readable |
| Logging | `src/log.js` | JSON-line logger |
| HTTP core | `src/http/` | Router, static/page serving, JSON helpers, cookies, security headers + origin check, `requireUser`/`requireAdmin` guards (`src/http/guards.js`) |
| Range parsing | `src/http/range.js` | Parses a `Range` request header into a satisfiable byte window or `unsatisfiable`/`none` |
| Media types | `src/http/media-types.js` | Thin `ext -> MIME` lookup over `src/library/parsers/compat.js` (no second table) |
| Streaming | `src/http/stream.js` | `sendMedia`: 200/206/416 responses, `fs.createReadStream`, 60 s idle timeout between chunks |
| Path guard | `src/media/paths.js`, `src/media/subtitles.js` | Resolves item paths and enforces containment within `MEDIA_ROOT`; discovers `.vtt` subtitle sidecars for a video item |
| Library scanner | `src/library/scanner.js` | Walks `MEDIA_ROOT`, classifies files per category, upserts/removes index rows |
| Change detection | `src/library/watcher.js` | Debounced recursive `fs.watch` + periodic rescan timer, both call the scanner |
| Category parsers | `src/library/parsers/` | Per-category naming rules (movie, series, music, audiobook, image) and direct-play compatibility table |
| Tag/EXIF readers | `src/library/tags/` | Minimal ID3v2 / FLAC / EXIF thumbnail parsers on file headers |
| Persistence | `src/db/` | `node:sqlite` connection, schema migrations (numbered SQL), repository functions per table |
| Next episode | `src/db/episodes.js` | `getNextEpisode`: next-episode order for the player's "Nächste Folge" button, reused by P4's next-up list |
| Auth | `src/auth/` | scrypt hashing, validation, login throttle, session store, admin bootstrap |
| API handlers | `src/api/` | `/api/library/*`, `/api/progress/*`, `/api/users/*`, `src/api/auth.js` (`/login`, `/logout`, `/api/me`) — thin, call library/db/auth |
| Media routes | `src/api/media.js` | `GET /media/:id` (streams any playable item of any category) and `GET /media/:id/subtitles/:n` (`.vtt` sidecars); authenticated, holds no file-format knowledge |
| Health check | `src/api/health.js` | `GET /healthz` liveness (`ping(db)`), reachable without a session |
| CLI tools | `src/cli/` | Offline admin tools (e.g. password reset); may import `src/config.js`, `src/db/`, `src/auth/`, never `src/http/` |
| Frontend | `public/` | Static HTML/CSS/ES-module pages: login, category browse, player, gallery, admin |
| Tests | `test/` | `node:test` suites mirroring `src/`, fixture media tree in `test/fixtures/media/` |
| Test harness | `test/helpers/app.js` | In-process `createApp` harness every phase's tests build on |

## Boundaries

- Only `src/config.js` reads `process.env`.
- Only `src/media/paths.js` turns client-supplied identifiers into filesystem paths; everything else receives validated absolute paths.
- API clients reference media by index id, never by raw path.
- `src/library/` knows nothing about HTTP or users; `src/api/` knows nothing about file formats.
- `src/db/` is the only place with SQL.
- `public/` talks to the server exclusively via `/api/*` JSON, the JSON auth endpoints `POST /login` / `POST /logout`, page routes and media stream URLs.
- Data split: `MEDIA_ROOT` (read-only source) vs `DATA_DIR` (SQLite file: users, sessions, progress, derived library index).
- Progress is keyed by `(user_id, rel_path)` and never references `library_items` by id.

## Key flows

1. **Scan:** startup, watcher event (debounced) or rescan timer -> `scanner` walks `MEDIA_ROOT` -> category parser classifies each file (category, grouping, title, playable flag) -> index rows upserted by relative path, vanished rows deleted. Progress rows referencing vanished items are kept (item may reappear).
2. **Browse:** browser `GET /api/library/:category` -> session check -> DB query -> JSON list/grouping -> rendered by `public/` module.
3. **Stream:** `<video src="/media/:id">` -> `requireUser` -> id -> `library_items` row (`playable` check) -> path guard -> `stream.js` answers `Range` with 200/206/416 chunks and closes the file handle after a 60 s idle timeout with no chunk sent; `HEAD` returns the same headers with no body, letting the player disambiguate a missing file (`404`) from an unsupported codec (`2xx`). `GET /media/:id/subtitles/:n` serves the `n`-th `.vtt` sidecar discovered by `src/media/subtitles.js` the same way.
4. **Progress:** identity is `(user, rel_path)`, never the index id -> `PUT /api/progress/:id` resolves the id to `rel_path` server-side, then upserts a keepalive report sent every ~10 s while playing and immediately on pause/ended/tab-hidden/`pagehide`. Opening an item fetches its position and seeks (auto-resume). The start page mounts the "Weiterschauen" row from `GET /api/progress?view=continue`, which merges the user's `in_progress` rows with next-up ("Nächste Folge") entries computed from series whose latest episode is finished.
5. **Login:** `POST /login` -> scrypt verify -> session row + `HttpOnly; SameSite=Lax` cookie (`Secure` when behind HTTPS proxy). First start with empty users table creates the admin from `ADMIN_USER`/`ADMIN_PASSWORD`. JSON login, hashed session id, 30-day sliding expiry.

## Where new code goes

- New media category -> parser in `src/library/parsers/`, register in scanner, list page in `public/`.
- New file format -> compatibility table in `src/library/parsers/compat.js` (+ tag reader in `src/library/tags/` if metadata needed).
- New endpoint -> `register<X>Routes(router, deps)` in `src/api/<x>.js`, one line in `src/http/routes.js`, test in `test/api/`.
- Schema change -> new numbered migration in `src/db/migrations/`; never edit an applied migration.
- New UI page -> `public/<page>.html` + `public/js/<page>.js`; shared UI helpers in `public/js/lib/`.
- New config value -> `src/config.js` + `.env.example` + README.
