# Spec: Foundation & accounts

> Created: 2026-09-26

Delivers the runnable, dependency-free skeleton every later phase builds on —
config, logging, HTTP router, static/page serving, SQLite with migrations,
login with sessions, admin bootstrap, user administration (API + UI) and the
app shell with category navigation — gated by `npm run verify`. This spec
carries no lifecycle state — acceptance is the spec merged on the default
branch with a milestone and issues, and all progress (in progress, done,
blocked) lives in the GitHub issues and milestone. A completed spec is moved to
`docs/specs/archive/`.

## Outcome

- [ ] `npm start` with a valid `.env` starts one process that serves the app on
      `HOST:PORT`; `GET /healthz` answers `200 {"status":"ok"}` without a session.
- [ ] Invalid or missing configuration stops the process before it listens:
      exit code 1 and one log line per problem naming the variable — never a
      secret value.
- [ ] First start on an empty database with `ADMIN_USER`/`ADMIN_PASSWORD` set
      creates exactly one admin; without them the process exits 1 with guidance;
      once any user exists both variables are ignored.
- [ ] A household member logs in at `/login`, lands on the requested page (or
      `/`), and stays logged in across server restarts for 30 days of
      inactivity; logout, password reset, user deletion or expiry end the session.
- [ ] Wrong credentials show "Benutzername oder Passwort falsch."; after 5
      failures for one username within 15 minutes further attempts for it are
      refused (`429`) until the window has passed.
- [ ] Without a valid session every page redirects to `/login?next=…` and every
      `/api/*` call answers `401 {"error":"unauthorized"}`; only `/login`,
      static assets and `/healthz` are reachable.
- [ ] Every authenticated page shows the app shell: wordmark, the five category
      entries Filme, Serien, Musik, Hörbücher, Bilder (top bar ≥ 768 px, bottom
      bar below), and an account menu with username, "Benutzerverwaltung"
      (admins only) and "Abmelden". Home and all five category pages show the
      "Noch nicht verfügbar" empty state.
- [ ] An admin lists, creates, resets the password of, changes the role of and
      deletes users on `/admin`; deleting or demoting oneself and removing the
      last admin are refused with German messages; non-admins get `403` on
      `/api/users*` and are redirected away from `/admin`.
- [ ] Cross-origin state-changing requests are rejected; every response carries
      the security headers defined below; no response or log line contains a
      password, password hash or session token.
- [ ] `npm run verify` is green, `npm ls --omit=dev --all` lists no package, and
      every module under `src/` has a matching `test/**/*.test.js`.
- [ ] `README.md` and `.env.example` document installation, every config
      variable, first start, reverse-proxy setup, backup and account recovery.

## Scope

### In scope

- Server skeleton: `src/config.js`, `src/log.js`, `src/app.js` (assembly),
  `src/server.js` (entry + lifecycle), HTTP core under `src/http/`.
- Persistence: `src/db/index.js`, migration runner, migration
  `001-users-sessions.sql`, repositories `src/db/users.js`, `src/db/sessions.js`.
- Auth under `src/auth/`: scrypt hashing, username/password rules, login
  throttle, session store, admin bootstrap.
- API under `src/api/`: `POST /login`, `POST /logout`, `GET /api/me`,
  `/api/users*`; route registration in `src/http/routes.js`; `GET /healthz`.
- Frontend: design tokens + base CSS, DOM/icon/API helpers, app shell, login
  page, home + five category placeholder pages, 404 page, admin page, favicon.
- `README.md` (new), `.env.example` (comments), `package.json` test script,
  test helper `test/helpers/app.js` for later phases, `docs/architecture.md`
  component map (adds `src/app.js`, `src/log.js`, `src/api/health.js`, test
  helper).
- Account-recovery path per OPEN-1 (if accepted as recommended).

### Out of scope

- Library scan, streaming, progress, category content (Phases 2–6).
- Self-service password change for non-admins (OPEN-2 — recommended out).
- Username rename, session/device list, "log out everywhere" UI, MFA,
  password composition rules, e-mail, self-registration (vision: out).
- Built-in HTTPS/HSTS (vision non-goal: the reverse proxy does it).
- Per-request access log (the reverse proxy logs requests).
- Any new environment variable (the constitution's config list stays as is).

## Constraints

- Constitution is binding: zero runtime deps, config only in `src/config.js`,
  SQL only in `src/db/` via prepared statements, ≤ 60 lines per function and
  ≤ 300 lines per file (JS and CSS), JSDoc on every export, JSON errors
  `{ "error": "<code>" }` for `/api/*`, no `innerHTML`/`eval`, no outbound calls,
  no secrets in logs, German UI copy, English code/docs.
- Architecture boundaries apply: only `src/config.js` reads `process.env` —
  so `loadConfig(env = process.env)` owns the default and `src/server.js` calls
  `loadConfig()` without touching `process.env`; `src/api/` stays thin.
- `docs/design.md` is the UI contract: only tokenized values, WCAG 2.1 AA,
  touch targets ≥ 44 px, visible focus ring, keyboard operable, no web fonts or
  icon fonts, inline SVG icons.
- Node.js ≥ 24 (`node:sqlite` `DatabaseSync`, `import.meta.main`,
  `server.closeIdleConnections/closeAllConnections` — verified on 24.18.1,
  `node:sqlite` loads without flag or warning).
- Must stay correct on Windows (dev) and Linux/Raspberry Pi (prod).

## Prior art

- [Minimal auth, sessions and embedded DB (Phase 1)](../prior-art.md#minimal-auth-sessions-and-embedded-db-phase-1)
  — ADOPT scrypt (N=2^14, r=8, p=1, 16-byte salt) + `timingSafeEqual`, opaque
  session id in an `HttpOnly; SameSite=Lax` cookie with SQLite session rows,
  `DatabaseSync`; AVOID JWT/OAuth/self-registration. All adopted below.
- No other `docs/prior-art.md` entry is tagged Phase 1. Security details not
  covered there (throttling, CSRF, session hashing) follow the OWASP
  Authentication / Session Management / CSRF Prevention cheat sheets, cited per
  decision below.

## Human prerequisites

none — nothing external is needed. The QA run needs a `.env` whose
`MEDIA_ROOT` points at any existing readable directory (Phase 2 adds
`test/fixtures/media/`) and `ADMIN_USER`/`ADMIN_PASSWORD` set; the implement
loop may set this itself under the project's autonomy grant (`.env` edits).

## Design

### UI (Stitch exports — layout reference, never copied verbatim)

| Screen | Mobile | Desktop |
|---|---|---|
| Login (error state) | [login-mobile.png](../design/assets/foundation-accounts/login-mobile.png) | [login-desktop.png](../design/assets/foundation-accounts/login-desktop.png) |
| App shell — category placeholder, account menu open on desktop | [shell-mobile.png](../design/assets/foundation-accounts/shell-mobile.png) | [shell-desktop.png](../design/assets/foundation-accounts/shell-desktop.png) |
| Benutzerverwaltung | [admin-users-mobile.png](../design/assets/foundation-accounts/admin-users-mobile.png) | [admin-users-desktop.png](../design/assets/foundation-accounts/admin-users-desktop.png) |

Exported HTML (layout reference only) sits next to each PNG. Working reference:
Stitch project `videothek` (`15222119956003233865`), screens titled `P1 …`.
Stitch renders every screen on a desktop canvas; the mobile PNGs are the
centred mobile frame cropped from that canvas.

Implementation notes that override the exports:

- Off-token shades in the exports map to tokens: input/select fill on a card =
  `--color-background`; hover/active = the derived state tokens in
  `tokens.css` (design.md: hover lightens 8 %, active darkens 8 %). The
  exports' Tailwind CDN script and placeholder image URLs are never copied.
- Selects are native `<select>` with `appearance: none` and an inline-SVG
  chevron; the table exports show a placeholder graphic there — ignore it.
- Home (`/`) uses the category-placeholder layout without an active nav entry:
  heading "Start", empty state "Noch nicht verfügbar" /
  "Sobald die Mediathek eingerichtet ist, findest du deine Inhalte hier."
  Category pages: heading = category label, text
  "Diese Kategorie wird in einer späteren Version freigeschaltet."
- Breakpoints: < 768 px bottom nav + stacked admin cards; ≥ 768 px top nav and
  admin table with the create form below; ≥ 1024 px table + form side by side.
- Account menu: button (initial circle; plus username ≥ 768 px) toggling a
  disclosure menu (`aria-expanded`): muted "Angemeldet als {name} (Admin|Benutzer)",
  "Benutzerverwaltung" (admins only, link `/admin`), "Abmelden" (button).
  Escape or outside click closes it and returns focus to the button.
- Nav is `<nav aria-label="Kategorien">` of links; active entry carries
  `aria-current="page"` (amber); Left/Right arrows move focus between entries.
- Admin dialogs use native `<dialog>`: delete confirm "„{name}“ wirklich
  löschen? Der Wiedergabefortschritt dieses Kontos geht verloren." with
  "Abbrechen" / "Löschen" (danger); password reset "Neues Passwort für
  „{name}“" with hint "Mindestens 8 Zeichen" and note "Alle Geräte von {name}
  werden abgemeldet." plus "Abbrechen" / "Speichern". Role change applies on
  select change; on error the select reverts. Results appear in a
  `role="status"` line (e.g. "Benutzer „julia“ angelegt.").
- German error copy (API code → text): `invalid_credentials` "Benutzername oder
  Passwort falsch."; `too_many_attempts` "Zu viele Fehlversuche. Bitte in {n}
  Minuten erneut versuchen." (n from `Retry-After`, rounded up);
  `username_taken` "Dieser Benutzername ist bereits vergeben.";
  `invalid_username` "Benutzername: 1–32 Zeichen, nur Buchstaben, Ziffern,
  Punkt, Binde- und Unterstrich."; `invalid_password` "Das Passwort muss
  mindestens 8 Zeichen lang sein."; `cannot_delete_self` "Du kannst dein
  eigenes Konto nicht löschen."; `cannot_change_own_role` "Du kannst deine
  eigene Rolle nicht ändern."; `last_admin` "Es muss mindestens ein Admin
  bestehen bleiben."; anything else "Etwas ist schiefgelaufen. Bitte erneut
  versuchen."

### Module layout (each file owned by exactly one issue)

| Path | Responsibility (exports) |
|---|---|
| `src/config.js` | `loadConfig(env = process.env)` → frozen `Config`; throws `ConfigError { problems: string[] }` |
| `src/log.js` | `createLogger({ out, err })` → `{ info, warn, error }(event, fields)`; one JSON line per call; redacts keys matching `/pass\|token\|cookie\|secret\|hash\|authorization/i` |
| `src/db/index.js` | `openDatabase(dataDir)` (mkdir -p, `videothek.db`, pragmas), re-exports `migrate` |
| `src/db/migrate.js` | `migrate(db, dir?)` → applied versions |
| `src/db/migrations/001-users-sessions.sql` | schema below |
| `src/db/users.js`, `src/db/sessions.js` | repository functions (all SQL for these tables) |
| `src/auth/password.js` | `hashPassword(pw)`, `verifyPassword(pw, stored)` (async scrypt) |
| `src/auth/validation.js` | `normalizeUsername`, `validateUsername`, `validatePassword`, `validateRole` |
| `src/auth/rate-limit.js` | `createLoginLimiter({ maxFailures, windowMs, maxKeys, now })` → `{ check, fail, reset }` |
| `src/auth/sessions.js` | `createSessionStore({ db, now })` → `{ create, resolve, revoke, revokeUser, purgeExpired }` (HTTP-agnostic) |
| `src/auth/bootstrap.js` | `ensureAdmin({ db, adminUser, adminPassword, log })` → `'created' \| 'skipped'`; throws `BootstrapError` |
| `src/http/router.js` | `createRouter()` → `{ add(method, pattern, handler), handle(req, res, ctx) }`; `:param` segments; HEAD → GET handler; typedefs `AuthUser`, `RequestContext` |
| `src/http/respond.js` | `sendJson`, `sendError(res, status, code)`, `redirect`, `readJson(req, { limit })` |
| `src/http/cookies.js` | `parseCookies(header)`, `serializeCookie(name, value, opts)` |
| `src/http/security.js` | `applySecurityHeaders(res)`, `isHttps(req)`, `isSameOrigin(req)` |
| `src/http/static.js` | `createStaticHandler({ publicDir })` — assets + page routes (rules below) |
| `src/http/routes.js` | `registerRoutes(router, deps)` — calls one `register*Routes` per API module; later phases add one line each |
| `src/api/health.js` | `registerHealthRoutes` — `/healthz` |
| `src/api/auth.js` | `registerAuthRoutes` — `/login`, `/logout`, `/api/me` |
| `src/api/users.js` | `registerUserRoutes` — `/api/users*` |
| `src/app.js` | `createApp({ config, db, log, publicDir?, now? })` → `{ server, close() }`: session resolution, origin check, routing, error mapping |
| `src/server.js` | entry (`import.meta.main`): config → DB → migrate → bootstrap → app → listen → cleanup timer → signals; exports `start()` / `stop()` for tests |
| `src/cli/reset-password.js` | only if OPEN-1 = B: offline password reset (`npm run reset-password -- <username>`) |
| `public/css/tokens.css` | 1:1 mirror of design.md tokens + derived state/layout tokens (only file with raw values) |
| `public/css/base.css`, `public/css/shell.css`, `public/css/admin.css` | reset/typography/components; header/nav/menu; admin layout |
| `public/js/lib/dom.js`, `icons.js`, `api.js`, `nav.js`, `shell.js` | safe element builder; inline-SVG icon factories; fetch wrapper; category list; `mountShell({ active })` |
| `public/*.html`, `public/js/{login,placeholder,admin}.js` | pages (see page routes) |

### HTTP surface

| Route | Auth | Behaviour |
|---|---|---|
| `GET /healthz` | none | `200 {"status":"ok"}`; `503 {"error":"db_unavailable"}` if `SELECT 1` fails |
| `POST /login` | none | JSON `{username, password}` → `200 {id, username, role}` + session cookie; `401 invalid_credentials`; `429 too_many_attempts` + `Retry-After` (seconds); `400 invalid_json` |
| `POST /logout` | session | deletes session, clears cookie, `204` (also `204` without session) |
| `GET /api/me` | user | `200 {id, username, role}` |
| `GET /api/users` | admin | `200 [{id, username, role, createdAt}]` ordered by username |
| `POST /api/users` | admin | `{username, password, role?}` (role defaults to `user`) → `201` user; `400 invalid_username\|invalid_password\|invalid_role`; `409 username_taken` |
| `PUT /api/users/:id/password` | admin | `{password}` → `204` (`400 invalid_password`, `404 not_found` for unknown or non-numeric id); revokes all of that user's sessions except the caller's current one |
| `PATCH /api/users/:id` | admin | `{role}` → `200` user; `409 cannot_change_own_role\|last_admin` |
| `DELETE /api/users/:id` | admin | `204`; `409 cannot_delete_self\|last_admin`; sessions cascade |
| page routes | see rules | HTML from `public/` |
| static assets | none | `public/` files by extension |

Common errors: `401 unauthorized`, `403 forbidden` (non-admin),
`403 forbidden_origin`, `404 not_found`, `405 method_not_allowed` (+ `Allow`),
`413 payload_too_large` (JSON body > 16 KiB), `415 unsupported_media_type`,
`500 internal` (logged with stack). API bodies are camelCase; timestamps are
ISO-8601 UTC strings named `…At`; `/api/*` responses carry
`Cache-Control: no-store`. `POST /login` and `POST /logout` are JSON endpoints
(architecture key flow 5), not form posts.

**Page routes and static rules** (`src/http/static.js`):

- `GET|HEAD /` → `public/index.html`; `/<name>` with `name` matching
  `^[a-z0-9-]+$` → `public/<name>.html` if it exists. P1 pages: `login`,
  `index`, `admin`, `movies`, `series`, `music`, `audiobooks`, `images`.
- `login` is public (a logged-in user is redirected to `/`); `admin` requires
  role admin (others → `302 /`); every other page requires a session
  (none → `302 /login?next=<encoded path+query>`).
- Requests naming an `.html` file directly (`/admin.html`) → 404. Other paths
  with an extension are static assets served without session from an allowlist
  of types (`.css`, `.js`, `.svg`, `.png`, `.ico`, `.json`, `.webmanifest`);
  anything else → 404.
- Path safety: decode once (malformed → 404), reject NUL, backslash and
  dot-segments/hidden files, resolve inside `publicDir` and verify containment
  (`resolved.startsWith(publicDir + sep)`) → otherwise 404.
- Unknown non-API path → `404` with `public/404.html` (plain German text
  fallback if absent); unknown `/api/*` → `404 {"error":"not_found"}`.
- Caching: `Cache-Control: no-cache` + `Last-Modified`; `If-Modified-Since`
  → `304`. Files are streamed (`fs.createReadStream`).

### Data model — migration 001

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE,          -- normalized (see rules)
  password_hash TEXT    NOT NULL,                 -- scrypt$N$r$p$saltB64$hashB64
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'user')),
  created_at    INTEGER NOT NULL                  -- epoch ms
);
CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,                 -- sha256 hex of the token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);
```

Runner: table `schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT
NULL, applied_at INTEGER NOT NULL)`; files `NNN-kebab-name.sql`; a `.sql` file
not matching the pattern or a duplicate number aborts startup; every
**not-yet-applied** version is applied in ascending order — including numbers
below the highest applied one (Phases 4 and 6 merge in either order) — each in
its own `BEGIN IMMEDIATE … COMMIT` with rollback + exit 1 on error. Migration
files contain no transaction statements. Connection pragmas:
`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`,
`synchronous=NORMAL`.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Config: `MEDIA_ROOT` required, resolved absolute, must be a readable directory; `DATA_DIR` default `./data` (resolved, created by `openDatabase`), must not lie inside `MEDIA_ROOT`; `HOST` default `0.0.0.0`; `PORT` default 8080, integer 1–65535; `RESCAN_INTERVAL_MIN` default 15, integer 1–1440 (validated now, consumed by Phase 2); `ADMIN_USER`/`ADMIN_PASSWORD` optional but only together; empty string = unset | Constitution config list; a `DATA_DIR` under `MEDIA_ROOT` would write into the read-only media root | 2026-09-26 |
| Config failure: collect all problems, log `config_invalid` with one entry per variable (names and rule, never values), exit 1 before opening the DB | Fail fast, fix everything in one pass | 2026-09-26 |
| Bootstrap: runs after migrations; users table empty + both vars valid → create admin, log `admin_bootstrapped {user}`; empty + vars missing/invalid → exit 1 "set ADMIN_USER and ADMIN_PASSWORD"; users exist → no-op, log `admin_env_ignored` if vars are set | No unauthenticated first-run setup page (attack window); env is the constitution's config channel | 2026-09-26 |
| Passwords: scrypt N=2^14, r=8, p=1, 64-byte key, 16-byte random salt, async `crypto.scrypt`, stored as `scrypt$N$r$p$salt$hash` (params travel with the hash); verify with `timingSafeEqual`; unknown usernames are verified against a dummy hash | Prior art (Phase 1); async keeps streams flowing; equal timing avoids username enumeration | 2026-09-26 |
| Password rule: 8–256 characters (code points), no composition rules | NIST SP 800-63B minimum 8; upper bound caps hashing work | 2026-09-26 |
| Username rule: trim, NFC, lower-case, then `^[\p{L}\p{N}._-]{1,32}$` (u); stored normalized, login normalizes the same way | Case-insensitive, umlaut-friendly, safe in URLs/logs | 2026-09-26 |
| Sessions: 32 random bytes base64url token in cookie `vt_session`; DB stores only its SHA-256; idle lifetime 30 days, sliding; `expires_at` refreshed (and cookie re-sent) only when less than 29 days remain — at most one write per session per day; invalid/expired cookie → treated as anonymous and cleared | Household TVs/phones should stay logged in; hashed ids make a DB copy useless for hijacking (OWASP Session Mgmt); minimal SD-card writes | 2026-09-26 |
| Session cleanup: `purgeExpired()` at startup and hourly (`setInterval(...).unref()`); logout, password reset (target's sessions except the caller's) and user deletion (FK cascade) revoke; role changes take effect on the next request because the role is read from `users` per request | No stale privileges, bounded table | 2026-09-26 |
| Cookie: `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, plus `Secure` when the socket is TLS or the first `X-Forwarded-Proto` value is `https` | Zero-config behind a proxy; a spoofed header only affects the spoofer's own cookie; no new env var needed | 2026-09-26 |
| Login throttle: in-memory, keyed by normalized username; 5 failures within a sliding 15 min window → `429` + `Retry-After` until the oldest failure leaves the window; success resets; max 1000 keys (oldest evicted); lost on restart | OWASP Authentication cheat sheet (throttle per account); IP keys are useless behind a proxy and `X-Forwarded-For` is spoofable | 2026-09-26 |
| CSRF: `SameSite=Lax` + for `POST/PUT/PATCH/DELETE` an `Origin` header, when present, must match `X-Forwarded-Host` (first value) or `Host` → else `403 forbidden_origin`; request bodies must be `application/json` (`415` otherwise); `GET` never mutates | OWASP CSRF cheat sheet (Fetch-metadata/Origin + SameSite); JSON content type forces a CORS preflight cross-site | 2026-09-26 |
| Security headers on every response: `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`; no HSTS | Enforces "no outbound calls / no inline script" in the browser; HSTS belongs to the TLS proxy | 2026-09-26 |
| Admin guards: cannot delete self (`cannot_delete_self`), cannot change own role (`cannot_change_own_role`), may reset own password (keeps current session); any delete/demotion that would leave zero admins → `last_admin`; check and write run in one synchronous transaction (no `await` between) | Prevents lock-out, also under concurrent requests | 2026-09-26 |
| Page URLs are English kebab-case matching page files (`/movies`, `/series`, `/music`, `/audiobooks`, `/images`, `/admin`, `/login`); nav labels German | Constitution: code/files English, UI German; one generic page rule means later phases only add/replace `public/<page>.html` | 2026-09-26 |
| Category placeholders are real files (`public/movies.html` …) sharing `public/js/placeholder.js`; the owning phase replaces its file | No shared nav-config edits between parallel phases | 2026-09-26 |
| Unauthenticated page → `302 /login?next=…`; `next` is honoured only if it starts with `/` and not `//` or `/\`; frontend API client redirects to login on `401` (not on the login page) | No open redirect; seamless expiry handling | 2026-09-26 |
| Logging: JSON lines (`{"t","level","event",…}`) to stdout, errors to stderr; events: `startup`, `listening`, `migration_applied`, `admin_bootstrapped`, `admin_env_ignored`, `login_ok`, `login_failed {user, ip}`, `login_throttled`, `user_created`, `user_deleted`, `password_reset`, `role_changed` `{user, by}`, `origin_rejected {origin, host}`, `request_error {method, path, stack}`, `shutdown`; never bodies, headers, passwords, hashes or tokens; logger redacts sensitive keys as defence in depth; no per-request access log | Constitution "no secrets in logs"; proxy does access logs; Pi SD card | 2026-09-26 |
| Graceful shutdown on SIGINT/SIGTERM: stop timers, `server.close()` + `closeIdleConnections()`, after 5 s `closeAllConnections()` (open media streams), close DB, exit 0; a second signal exits 1 immediately; startup/listen errors exit 1; no global crash handlers — a supervisor restarts (README systemd `Restart=on-failure`) | Clean WAL checkpoint; long streams must not block shutdown | 2026-09-26 |
| `createApp` is separate from the entry so tests run the full stack in-process on port 0; `test/helpers/app.js` exports `startTestApp({ mediaRoot? })` → `{ baseUrl, db, config, createUser(name, pw, role), login(name, pw) → cookie, close() }` for all later phases | Signals cannot be tested portably (Windows); one shared helper avoids six ad-hoc harnesses | 2026-09-26 |
| `npm test` = `node --test "test/**/*.test.js"` | Default discovery would execute `test/helpers/*.js` and fixtures as test files | 2026-09-26 |
| Machine-checked rules (`test/constitution.test.js`, `test/frontend-rules.test.js`): no `dependencies` in `package.json`; `process.env` only in `src/config.js`; no `src/` import from `public/` and vice versa; `tokens.css` mirrors every design.md colour; no raw hex colour in other CSS; no `http(s)://` URL in `public/` except the SVG namespace; no `innerHTML`/`outerHTML`/`insertAdjacentHTML` in `public/js` | Turns constitution/design rules into verify failures instead of review findings | 2026-09-26 |
| CSS tokens: `--color-{background,foreground,primary,secondary,accent,muted,border,destructive}`, `--font-{sans,mono}`, `--text-{xs,sm,md,lg,xl,2xl,3xl}` (12…48 px), `--weight-{regular,semibold,bold}`, `--leading-{body,heading}`, `--space-{1,2,3,4,6,8,12,16}` (×4 px), `--radius-{sm,md,lg,full}`, `--shadow-{sm,md}`; derived `--color-{primary,secondary}-{hover,active}` via `color-mix()`; layout tokens `--bar-height` 64 px, `--bar-height-mobile` 56 px, `--tap-min` 44 px, `--content-max` 1280 px; media-query breakpoints 768/1024 px are the only literal lengths allowed outside `tokens.css` | Single naming contract for all phases; design.md "raw values only in tokens.css" | 2026-09-26 |
| Timestamps: DB columns are INTEGER epoch ms; API exposes ISO-8601 strings | One convention across phases | 2026-09-26 |
| OPEN-1 — Account recovery when the (last) admin password is lost: A) none, README says "delete `DATA_DIR/videothek.db`" (loses all accounts and progress); B) offline CLI `npm run reset-password -- <username>` (prompts twice without echo, sets the password, revokes that user's sessions, promotes nothing); C) env flag on start that re-applies `ADMIN_PASSWORD` to `ADMIN_USER` (needs a new env var → constitution change). Recommended: B | resolved at the spec-acceptance gate | — |
| OPEN-2 — Self-service password change for non-admin users: A) out of scope in v1, the admin resets passwords; B) account-menu item "Passwort ändern" + `PUT /api/me/password {currentPassword, newPassword}` revoking the user's other sessions. Recommended: A (keep P1 minimal; file as `track:adhoc` if wanted) | resolved at the spec-acceptance gate | — |

## Tracking

The decomposition into steps lives as GitHub issues, not in this file — one
issue per step, grouped under a milestone. This spec owns the design; the issues
own progress. Do not duplicate the step list here.

- Milestone: TBD — created at acceptance
- Issues: created from this spec once it is merged (one per implementable step)

Each issue references this spec path in its body.

## Verification

Machine checks (`npm run verify`) plus the milestone-QA script (UI check in
Chromium and Firefox, mobile ≤ 767 px and desktop ≥ 1024 px viewport):

- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no package; every
      `src/**/*.js` has a `test/**/*.test.js`; the constitution/frontend rule
      tests pass.
- [ ] Unit tests cover the failure cases: config (missing/relative/non-dir
      `MEDIA_ROOT`, `DATA_DIR` inside `MEDIA_ROOT`, bad `PORT`, lone
      `ADMIN_USER`); migration runner (fresh, idempotent re-run, gap below max,
      duplicate number, broken SQL rolls back); scrypt (wrong password, tampered
      hash string); throttle (6th attempt blocked, window expiry, reset on
      success, key cap); session store (expiry, sliding refresh once per day,
      revocation, hashed id at rest); static serving (`/../package.json`,
      `/%2e%2e/package.json`, `/%2F..`, backslash, NUL, `/admin.html`, unknown
      extension → 404); origin check (foreign `Origin` → 403, missing `Origin`
      allowed, non-JSON body → 415, > 16 KiB → 413); admin guards (self delete,
      own role, last admin, non-admin 403).
- [ ] Start without `MEDIA_ROOT` → exit 1, log names `MEDIA_ROOT`; with
      `DATA_DIR` inside `MEDIA_ROOT` → exit 1.
- [ ] Fresh `DATA_DIR` without `ADMIN_*` → exit 1 with guidance; with them →
      `admin_bootstrapped`; restart → no second admin, `admin_env_ignored`.
- [ ] Without cookie: `/healthz` 200; `/api/me` 401 JSON; `/` → 302
      `/login?next=%2F`; `/css/tokens.css` 200; `/admin.html` 404; every
      response has the CSP and `nosniff` headers.
- [ ] Login page matches the exports on both viewports; wrong password shows
      the error; the 6th wrong attempt shows the throttle message; `next`
      is honoured, `next=//evil.example` falls back to `/`.
- [ ] Shell: bottom nav on mobile, top nav on desktop; each category entry opens
      its placeholder with the entry active in amber; home shows the start
      placeholder; Tab reaches every control with a visible amber focus ring;
      arrows move within the nav; Escape closes the account menu.
- [ ] Admin: create a user (errors for 7-character password, duplicate name,
      invalid characters), change a role, reset a password (a second browser
      logged in as that user is logged out on its next request), delete with
      confirmation; own row has role select and delete disabled; `curl`
      attempts at self-delete / own-role change return 409.
- [ ] As a non-admin: no "Benutzerverwaltung" in the menu; `/admin` → `/`;
      `GET /api/users` → 403.
- [ ] Session survives a server restart; `Set-Cookie` has `HttpOnly`,
      `SameSite=Lax`, `Max-Age=2592000`; with `X-Forwarded-Proto: https` it also
      has `Secure`; logout returns to `/login` and the old cookie gets 401.
- [ ] `curl -X POST -H "Origin: http://evil.example" …/logout` → 403.
- [ ] Captured logs of a full QA run contain neither the admin password, a
      `vt_session` value nor `scrypt$`.
- [ ] On Linux: `SIGTERM` stops the process within 6 s with exit 0, also while a
      request is open.
- [ ] `README.md` covers install, config table, first start, systemd unit,
      reverse proxy (Caddy + nginx `Host`/`X-Forwarded-Proto`), backup (stop, copy
      `videothek.db*`), recovery per OPEN-1; `.env.example` lists all seven
      variables with comments.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `node:sqlite` is Release Candidate; API may shift | Pinned Node 24 LTS; all SQLite access behind `src/db/` |
| Username-keyed throttle lets someone who knows a name lock that person out for 15 min | Accepted for a household; `login_throttled` is logged; bounded window |
| Proxy does not send `X-Forwarded-Proto` → cookie lacks `Secure` | Functionality unaffected; README proxy snippets set it |
| Proxy rewrites `Host` without `X-Forwarded-Host` → every write is `403 forbidden_origin` | README snippets preserve `Host`; the 403 is logged as `origin_rejected {origin, host}` for diagnosis |
| scrypt CPU/RAM on a Pi (~16 MiB, tens of ms per hash) | Async API; only on login and password set; throttle bounds abuse |
| SD-card wear from session writes | Refresh at most once per session per day; WAL + `synchronous=NORMAL` |
| Parallel phases merge migrations out of number order | Runner applies every missing version, not only numbers above the max |
| `admin.js` or CSS outgrow 300 lines | Split into page-private modules (`public/js/admin-*.js`) / per-concern CSS files |
| Stitch exports are desktop-canvas renders with off-token shades and a placeholder graphic | Exports are layout reference only; notes above override them; tokens test blocks raw colours |
| Later phases pick other page URLs or token names | Contracts fixed here (page rule, token names, test helper); flagged to the other phase specs |

## Decision log

- 2026-09-26: Spec drafted. Decided zero new env vars: `Secure` cookie is
  auto-detected from TLS / `X-Forwarded-Proto`, session lifetime and throttle
  limits are constants.
- 2026-09-26: Session ids are stored hashed (SHA-256) — OWASP Session
  Management; costs one hash per request.
- 2026-09-26: Page access is enforced server-side (redirects) in addition to
  API `401`/`403`, so HTML for protected pages is never served anonymously.
- 2026-09-26: Migration runner applies gaps below the highest applied version
  because Phases 4 (003) and 6 (005) are implemented in parallel.
- 2026-09-26: Design produced in Stitch (6 screens); mobile PNGs cropped from
  the desktop canvas Stitch renders; exports reviewed at spec acceptance.
