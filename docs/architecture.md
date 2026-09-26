# Architecture

> Structural, living document — the most volatile artifact. Update whenever a
> change alters components, boundaries, or flows. Greenfield seed (2026-09-26).

## Component map

| Component | Path | Responsibility |
| --------- | ---- | -------------- |
| Entry point | `src/server.js` | Reads config, opens DB, starts scanner + HTTP server, graceful shutdown |
| Config | `src/config.js` | Sole reader of `process.env`; validates `MEDIA_ROOT` exists and is readable |
| HTTP core | `src/http/` | Router (method + path pattern -> handler), static file serving, JSON helpers, error mapping |
| Streaming | `src/http/stream.js` | Range parsing, 206/416 responses, MIME lookup, `fs.createReadStream` |
| Path guard | `src/media/paths.js` | Resolves item paths and enforces containment within `MEDIA_ROOT` |
| Library scanner | `src/library/scanner.js` | Walks `MEDIA_ROOT`, classifies files per category, upserts/removes index rows |
| Change detection | `src/library/watcher.js` | Debounced recursive `fs.watch` + periodic rescan timer, both call the scanner |
| Category parsers | `src/library/parsers/` | Per-category naming rules (movie, series, music, audiobook, image) and direct-play compatibility table |
| Tag/EXIF readers | `src/library/tags/` | Minimal ID3v2 / FLAC / EXIF thumbnail parsers on file headers |
| Persistence | `src/db/` | `node:sqlite` connection, schema migrations (numbered SQL), repository functions per table |
| Auth | `src/auth/` | scrypt hashing, sessions, login/logout, `requireUser` / `requireAdmin` guards, admin bootstrap |
| API handlers | `src/api/` | `/api/library/*`, `/api/progress/*`, `/api/users/*` — thin, call library/db/auth |
| Frontend | `public/` | Static HTML/CSS/ES-module pages: login, category browse, player, gallery, admin |
| Tests | `test/` | `node:test` suites mirroring `src/`, fixture media tree in `test/fixtures/media/` |

## Boundaries

- Only `src/config.js` reads `process.env`.
- Only `src/media/paths.js` turns client-supplied identifiers into filesystem paths; everything else receives validated absolute paths.
- API clients reference media by index id, never by raw path.
- `src/library/` knows nothing about HTTP or users; `src/api/` knows nothing about file formats.
- `src/db/` is the only place with SQL.
- `public/` talks to the server exclusively via `/api/*` JSON and media stream URLs.
- Data split: `MEDIA_ROOT` (read-only source) vs `DATA_DIR` (SQLite file: users, sessions, progress, derived library index).

## Key flows

1. **Scan:** startup, watcher event (debounced) or rescan timer -> `scanner` walks `MEDIA_ROOT` -> category parser classifies each file (category, grouping, title, playable flag) -> index rows upserted by relative path, vanished rows deleted. Progress rows referencing vanished items are kept (item may reappear).
2. **Browse:** browser `GET /api/library/:category` -> session check -> DB query -> JSON list/grouping -> rendered by `public/` module.
3. **Stream:** `<video src="/media/:id">` -> session check -> id -> relative path -> path guard -> `stream.js` answers `Range` with 206 chunks.
4. **Progress:** player reports `PUT /api/progress/:id {position, duration}` every ~10 s and on pause/ended/`pagehide` -> upsert (user, item); opening an item fetches the position and seeks; "continue" list = unfinished rows ordered by `updated_at`.
5. **Login:** `POST /login` -> scrypt verify -> session row + `HttpOnly; SameSite=Lax` cookie (`Secure` when behind HTTPS proxy). First start with empty users table creates the admin from `ADMIN_USER`/`ADMIN_PASSWORD`.

## Where new code goes

- New media category -> parser in `src/library/parsers/`, register in scanner, list page in `public/`.
- New file format -> compatibility table in `src/library/parsers/compat.js` (+ tag reader in `src/library/tags/` if metadata needed).
- New endpoint -> handler in `src/api/`, route registration in `src/http/routes.js`, test in `test/api/`.
- Schema change -> new numbered migration in `src/db/migrations/`; never edit an applied migration.
- New UI page -> `public/<page>.html` + `public/js/<page>.js`; shared UI helpers in `public/js/lib/`.
- New config value -> `src/config.js` + `.env.example` + README.
