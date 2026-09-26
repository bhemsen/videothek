# Spec: Foundation & accounts

> Created: 2026-09-26

Delivers the runnable, dependency-free skeleton every later phase builds on —
config, logging, HTTP router, static/page serving, SQLite with migrations,
login with sessions, admin bootstrap, offline password recovery, user
administration (API + UI) and the app shell with category navigation — gated
by `npm run verify`. This spec carries no lifecycle state — acceptance is the
spec merged on the default branch with a milestone and issues, and all progress
(in progress, done, blocked) lives in the GitHub issues and milestone. A
completed spec is moved to `docs/specs/archive/`.

## Outcome

- [ ] `npm start` with a valid `.env` starts one process that serves the app on
      `HOST:PORT`; `GET /healthz` answers `200 {"status":"ok"}` without a session.
- [ ] Invalid or missing configuration stops the process before it listens:
      exit code 1 and one log line listing every problem by variable name —
      never a value.
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
      other registered route (`/api/*`, `/logout`, later `/media/*`) answers
      `401 {"error":"unauthorized"}`; only `/login`, static assets and
      `/healthz` are reachable — machine-checked for every registered route.
      Unregistered `/api/*` paths answer `404` and method mismatches `405`
      before any session check (they are not routes and reveal nothing).
- [ ] Every authenticated page shows the app shell: wordmark, the five category
      entries Filme, Serien, Musik, Hörbücher, Bilder (top bar ≥ 768 px, bottom
      bar below), and an account menu with username, "Benutzerverwaltung"
      (admins only) and "Abmelden". Home (`/`) shows the heading "Start", an
      empty rows slot and the "Willkommen" empty state; the five category pages
      show the "Noch nicht verfügbar" placeholder.
- [ ] An admin lists, creates, resets the password of, changes the role of and
      deletes users on `/admin`; deleting or demoting oneself and removing the
      last admin are refused with German messages; non-admins get `403` on
      `/api/users*` and are redirected away from `/admin`.
- [ ] A lost admin password is recoverable offline with
      `npm run reset-password -- <username>`, which also ends that user's
      sessions.
- [ ] Cross-origin state-changing requests are rejected; every response carries
      the security headers defined below; no response or log line contains a
      password, password hash or session token.
- [ ] `npm run verify` is green, `npm ls --omit=dev --all` lists no package, and
      the constitution/frontend rule tests pass (every `src/` module has a
      matching test, no file over 300 lines).
- [ ] `README.md` and `.env.example` document installation, every config
      variable, first start, reverse-proxy setup, backup and account recovery.

## Scope

### In scope

Files this phase creates (each owned by exactly one issue):

- Server: `src/config.js`, `src/log.js`, `src/app.js`, `src/server.js`,
  `src/http/{router,respond,cookies,security,static,guards,routes}.js`,
  `src/api/{health,auth,users}.js`, `src/cli/reset-password.js`.
- Persistence: `src/db/{index,migrate,users,sessions}.js`,
  `src/db/migrations/001-users-sessions.sql`.
- Auth: `src/auth/{password,validation,rate-limit,sessions,bootstrap}.js`.
- Frontend: `public/css/{tokens,base,shell,home,login,admin}.css`,
  `public/js/lib/{dom,icons,api,nav,shell}.js`,
  `public/js/{login,home,placeholder,admin}.js`,
  `public/{index,login,admin,movies,series,music,audiobooks,images,404}.html`,
  `public/favicon.svg`.
- Tests: one `test/<path>.test.js` per `src/<path>.js` (mirrored tree),
  `test/constitution.test.js`, `test/frontend-rules.test.js`,
  `test/route-auth.test.js`, `test/public/api.test.js`,
  `test/helpers/app.js`.
- Docs/config: `README.md` (new), `.env.example` (comments), `package.json`
  (`test` script, `reset-password` script).
- `docs/design.md` Input line, edited in this spec PR: "Input — `background`
  fill (inputs and selects sit on `secondary` cards, where a secondary fill
  would be invisible), 1 px `border`, …" (rest unchanged). P2 edits only the
  Grid line, so the two edits do not collide.
- `docs/architecture.md` edits, made by the app-assembly issue (not in this
  spec PR): Component map — add rows `src/app.js` (assembly: session
  resolution, origin check, dispatch, error mapping), `src/log.js` (JSON-line
  logger), `src/api/health.js`, `src/cli/` (offline admin tools, may import
  `src/config.js`, `src/db/`, `src/auth/`, never `src/http/`), `test/helpers/app.js`
  (in-process app for all phases); change the Auth row to "scrypt hashing,
  validation, login throttle, session store, admin bootstrap" and the HTTP
  core row to "router, static/page serving, JSON helpers, cookies, security
  headers + origin check, `requireUser`/`requireAdmin` guards
  (`src/http/guards.js`)"; API handlers row adds `src/api/auth.js`
  (`/login`, `/logout`, `/api/me`); Key flow 5 gets "JSON login, hashed
  session id, 30-day sliding expiry"; Boundaries line "`public/` talks to the
  server exclusively via `/api/*` JSON and media stream URLs" becomes
  "`public/` talks to the server exclusively via `/api/*` JSON, the JSON auth
  endpoints `POST /login` / `POST /logout`, page routes and media stream URLs";
  "Where new code goes" → new endpoint line
  reads "`register<X>Routes(router, deps)` in `src/api/<x>.js`, one line in
  `src/http/routes.js`, test in `test/api/`".

### Out of scope

- Library scan, streaming, progress, category content (Phases 2–6); the
  owning phase replaces its placeholder page and P4 replaces `public/js/home.js`.
- Self-service password change for non-admins (gate decision H2: out of v1;
  admin resets; a later `track:adhoc` if wanted).
- Username rename, session/device list, "log out everywhere" UI, MFA,
  password composition rules, e-mail, self-registration (vision: out).
- Built-in HTTPS/HSTS (vision non-goal: the reverse proxy does it).
- Per-request access log (the reverse proxy logs requests).
- Any new environment variable (the constitution's config list stays as is).

## Constraints

- Constitution is binding: zero runtime deps, config only in `src/config.js`,
  SQL only in `src/db/` via prepared statements, ≤ 60 lines per function and
  ≤ 300 lines per file (JS, CSS, HTML), JSDoc on every export, JSON errors
  `{ "error": "<code>" }` for `/api/*`, no `innerHTML`/`eval`, no outbound
  calls, no child processes, no secrets in logs, German UI copy, English
  code/docs, every route except `/login`, static assets and `/healthz` needs a
  session.
- Architecture boundaries apply: only `src/config.js` reads `process.env`
  (`loadConfig(env = process.env)` owns the default; `src/server.js` and the
  CLI call `loadConfig()` without touching `process.env`); `src/api/` stays
  thin; `src/db/` is the only place with SQL.
- `docs/design.md` is the UI contract: only tokenized values, WCAG 2.1 AA,
  touch targets ≥ 44 px, visible focus ring, keyboard operable, no web fonts or
  icon fonts, inline SVG icons.
- Node.js ≥ 24 (`node:sqlite` `DatabaseSync`,
  `server.closeIdleConnections/closeAllConnections`, `node --test` globs —
  verified on 24.18.1, `node:sqlite` loads without flag). `import.meta.main`
  (24.2+) is NOT used, so every 24.x works.
- TypeScript 7 (devDependency) ships no JS compiler API — rule tests parse
  files with plain string/regex scans, never with `typescript`.
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

none — nothing blocks implementation. QA-only needs (milestone QA gate, not
implementation):

- [ ] QA `.env`: `MEDIA_ROOT` pointing at any existing readable directory and
      `ADMIN_USER`/`ADMIN_PASSWORD` set — the implement loop may write it itself
      under the project's autonomy grant (`.env` edits).
- [ ] QA-only: a Linux host (the Pi or WSL) for the `SIGTERM` check; the same
      shutdown logic is machine-tested via `stop()` on every platform.
- [ ] QA-only: Chromium and Firefox for the UI walk-through.

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

Home (`/`), the 404 page and the two admin dialogs have no export on purpose:
they are fully specified in the text below and only reuse components that the
exports already show (shell, empty state, card, buttons, inputs).

Implementation notes that override the exports:

- Off-token shades in the exports map to tokens: input/select fill =
  `--color-background` (design.md Input line amended in this spec PR — the
  fields sit on `secondary` cards, where a secondary fill would be invisible);
  hover/active = the derived state tokens in
  `tokens.css` (design.md: hover lightens 8 %, active darkens 8 %). The
  exports' Tailwind CDN script and placeholder image URLs are never copied.
- Selects are native `<select>` with `appearance: none` inside a
  `.select` wrapper that positions an inline-SVG chevron element (from
  `icons.js`); the table exports show a placeholder graphic there — ignore it.
- Login: wordmark, fields "Benutzername" (`autocomplete="username"`) and
  "Passwort" (`autocomplete="current-password"`), primary button "Anmelden"
  (disabled while the request runs), error line `role="alert"` above the
  button (`alert` icon + text, colour `destructive`), muted footer "Konten
  werden von der Verwaltung angelegt." (kept from the export). No shell on the
  login page. `login.js` submits with
  `request('POST', '/login', { json: { username, password }, redirectOn401: false })`
  — never with the default, which would navigate away on `401
  invalid_credentials` and lose the message; on success it navigates to
  `safeNext(new URLSearchParams(location.search).get('next'))`.
- Home (`/`): shell without an active nav entry; `<h1>Start</h1>`, then a rows
  slot `<section class="home-rows" aria-label="Übersicht">`, then the empty
  state (title "Willkommen", text "Wähle eine Kategorie, um loszulegen.") which
  carries `hidden` whenever the rows slot has at least one child. P1 mounts no
  row, so the empty state is always visible in P1. This copy stays valid in
  every later phase.
- Category placeholder pages: heading = category label, empty state title
  "Noch nicht verfügbar", text "Diese Kategorie wird in einer späteren Version
  freigeschaltet." — retired by the owning phase replacing its page file.
- 404 page: standalone (no shell, works without session): wordmark, heading
  "Seite nicht gefunden", link "Zur Startseite" (`/`).
- Page skeleton (every `public/*.html`): `<!doctype html>`, `<html lang="de">`,
  `<meta charset="utf-8">`, viewport meta, `<title>{Seite} · Videothek</title>`,
  `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`, stylesheets
  `tokens.css`, `base.css` (+ `shell.css` on shell pages, + page CSS), one
  `<script type="module" src="/js/<page>.js">`, and a German `<noscript>` line.
  No inline `<script>`/`<style>`, no `style=""` attribute.
- Shell: skip link "Zum Inhalt springen" → `#main`; header with wordmark
  (link `/`); nav; account menu; `<main id="main">`. Breakpoints: < 768 px
  bottom nav (fixed; `main` padded by `--bar-height-mobile` plus
  `env(safe-area-inset-bottom)`) + stacked admin cards; ≥ 768 px top nav and
  admin table with the create form below; ≥ 1024 px table + form side by side.
- Nav is `<nav aria-label="Kategorien">` of links, each
  `<a href="/<id>" data-nav="<id>">` with icon + label; the active entry
  carries `aria-current="page"` (primary, orange). All links are in the Tab
  order; Left/Right arrows move focus between entries (wrapping), Home/End jump
  to first/last. `data-nav` is the stable hook later phases may attach click
  listeners to (P5, D14); nobody edits `nav.js`.
- Account menu: button (initial circle — first letter of the username,
  upper-cased; plus username ≥ 768 px) toggling a disclosure menu
  (`aria-expanded`, `aria-controls`): muted "Angemeldet als {name}
  (Admin|Benutzer)", "Benutzerverwaltung" (admins only, link `/admin`, `users`
  icon), "Abmelden" (button, `logout` icon). The button stays disabled until `/api/me` resolves.
  Escape or outside click closes it and returns focus to the button.
  "Abmelden" sends `POST /logout` (`redirectOn401: false`) and then navigates
  to `/login` whatever the status (204, 401 or network error).
- Admin page: heading "Benutzerverwaltung", muted subline "{n} Konten"
  ("1 Konto"). Rows/cards show username, muted "(du)" on the own row, muted
  "Angelegt am {dd.mm.yyyy}" (`toLocaleDateString('de-DE')` of `createdAt`),
  role `<select>` (Admin/Benutzer, accessible name "Rolle von {name}"),
  "Passwort zurücksetzen" (secondary) and "Löschen" (danger). The mobile
  export's extra role pill is dropped — the select is the single role display.
  Own row: role select and "Löschen" disabled (the API refuses anyway).
  Create form "Neuer Benutzer": Benutzername (placeholder "z. B. julia"),
  Passwort (hint "Mindestens 8 Zeichen", `autocomplete="new-password"`), Rolle
  (default Benutzer), primary "Benutzer anlegen"; field errors below the field
  (design.md Input error), form clears and the list reloads on success.
- Admin dialogs use native `<dialog>` (`showModal`, Escape = Abbrechen, focus
  returns to the triggering button): delete confirm "„{name}“ wirklich
  löschen? Der Wiedergabefortschritt dieses Kontos geht verloren." with
  "Abbrechen" / "Löschen" (danger); password reset "Neues Passwort für
  „{name}“" with hint "Mindestens 8 Zeichen" and note "Alle Geräte von {name}
  werden abgemeldet." plus "Abbrechen" / "Speichern". Role change applies on
  select change; on error the select reverts. Results appear in a
  `role="status"` line: "Benutzer „{name}“ angelegt.", "Rolle von „{name}“
  geändert.", "Passwort von „{name}“ geändert.", "Benutzer „{name}“ gelöscht."
- German error copy (API code → text): `invalid_credentials` "Benutzername oder
  Passwort falsch."; `too_many_attempts` "Zu viele Fehlversuche. Bitte in {n}
  Minuten erneut versuchen." (n = `max(1, ceil(err.retryAfterSec / 60))` from
  `ApiError.retryAfterSec`, singular "1 Minute"; when `retryAfterSec` is
  `null`: "Zu viele Fehlversuche. Bitte später erneut versuchen.");
  `username_taken` "Dieser Benutzername ist bereits vergeben.";
  `invalid_username` "Benutzername: 1–32 Zeichen, nur Buchstaben, Ziffern,
  Punkt, Binde- und Unterstrich."; `invalid_password` "Das Passwort muss
  8–256 Zeichen lang sein."; `cannot_delete_self` "Du kannst dein
  eigenes Konto nicht löschen."; `cannot_change_own_role` "Du kannst deine
  eigene Rolle nicht ändern."; `last_admin` "Es muss mindestens ein Admin
  bestehen bleiben."; `not_found` "Dieses Konto gibt es nicht mehr."; anything
  else (incl. network) "Etwas ist schiefgelaufen. Bitte erneut versuchen."

### Module layout (each file owned by exactly one issue)

| Path | Responsibility (exports) |
|---|---|
| `src/config.js` | `loadConfig(env = process.env, { requireMediaRoot = true } = {})` → frozen `Config = { mediaRoot, dataDir, host, port, rescanIntervalMin, adminUser, adminPassword }` (`adminUser`/`adminPassword`: `string \| null`); throws `ConfigError { problems: string[] }`, each problem `"<VAR>: <rule>"` |
| `src/log.js` | `createLogger({ out = process.stdout, err = process.stderr, now = Date.now } = {})` → `Logger { info, warn, error }(event, fields?)`; one JSON line `{"t":<ISO>,"level","event",...fields}` per call (`error` → `err`, others → `out`); recursively redacts keys matching `/pass\|token\|cookie\|secret\|hash\|authorization/i` to `"[redacted]"`; `Error` values serialized as `{ message, stack }` |
| `src/db/index.js` | `openDatabase(dataDir)` → `DatabaseSync` (mkdir -p, `videothek.db`, pragmas); `ping(db)` → `boolean` (`SELECT 1`, never throws); re-exports `migrate` |
| `src/db/migrate.js` | `migrate(db, { dir = <src/db/migrations>, log } = {})` → applied version numbers; throws `MigrationError` |
| `src/db/migrations/001-users-sessions.sql` | schema below |
| `src/db/users.js` | `insertUser(db, { username, passwordHash, role, createdAt })` → `UserRow`; `getUserById`, `getUserByUsername` → `UserRow \| undefined` (incl. `password_hash`); `listUsers(db)`; `countUsers(db)`; `setPasswordHash(db, id, hash)` → `boolean`; `setRoleGuarded(db, id, role)` / `deleteUserGuarded(db, id)` → `'ok' \| 'not_found' \| 'last_admin'` (check + write in one `BEGIN IMMEDIATE` transaction) |
| `src/db/sessions.js` | `insertSession(db, { id, userId, createdAt, expiresAt })`; `getSessionWithUser(db, id)` → `{ id, expiresAt, user: { id, username, role } } \| undefined`; `setSessionExpiry(db, id, expiresAt)`; `deleteSession(db, id)`; `deleteUserSessions(db, userId, exceptId = null)` → count; `deleteExpiredSessions(db, now)` → count |
| `src/auth/password.js` | `hashPassword(pw)` → `Promise<string>`; `verifyPassword(pw, stored)` → `Promise<boolean>` (false on malformed/tampered string, never throws); `DUMMY_HASH` |
| `src/auth/validation.js` | `normalizeUsername(s)`, `validateUsername(s)` → normalized `string \| null`, `validatePassword(s)` → `boolean`, `validateRole(s)` → `boolean` |
| `src/auth/rate-limit.js` | `createLoginLimiter({ maxFailures = 5, windowMs = 900000, maxKeys = 1000, now })` → `{ check(key) → { allowed, retryAfterSec }, fail(key), reset(key) }` |
| `src/auth/sessions.js` | `createSessionStore({ db, now })` → `SessionStore { create(userId) → { token, sessionId, expiresAt }, resolve(token) → { user, sessionId, refreshedExpiresAt: number \| null } \| null, revoke(sessionId), revokeUser(userId, { exceptSessionId } = {}) → count, purgeExpired() → count }` (HTTP-agnostic; `sessionId` = SHA-256 hex of the token) |
| `src/auth/bootstrap.js` | `ensureAdmin({ db, adminUser, adminPassword, log, now })` → `Promise<'created' \| 'skipped'>`; throws `BootstrapError` |
| `src/http/router.js` | `createRouter()` → `{ add(method, pattern, handler), match(method, pathname) → { handler, params } \| { allow: string[] } \| null, routes() → { method, pattern }[] }`; typedefs `AuthUser = { id, username, role }`, `RequestContext = { user: AuthUser \| null, params: Record<string,string>, url: URL, sessionId: string \| null }`, `Handler = (req, res, ctx) => void \| Promise<void>` |
| `src/http/respond.js` | `HttpError(status, code, headers?)`; `sendJson(res, status, body)`; `sendError(res, status, code, headers?)`; `sendNoContent(res)`; `redirect(res, location, status = 302)`; `readJson(req, { limit = 16384 } = {})` → `Promise<unknown \| undefined>` |
| `src/http/cookies.js` | `parseCookies(header)` → `Record<string,string>`; `serializeCookie(name, value, { maxAge, secure, path = '/', httpOnly = true, sameSite = 'Lax' })` |
| `src/http/security.js` | `applySecurityHeaders(res)`, `isHttps(req)`, `isSameOrigin(req)`, `safeNext(value)` → path or `'/'` |
| `src/http/static.js` | `createStaticHandler({ publicDir, log })` → `(req, res, ctx) → Promise<boolean>` (false = nothing served; rules below) |
| `src/http/guards.js` | `requireUser(handler)`, `requireAdmin(handler)` → `Handler`; `ctx.user` null → `401 unauthorized`, not admin → `403 forbidden` |
| `src/http/routes.js` | `registerRoutes(router, deps)` — one `register<X>Routes(router, deps)` call per API module; later phases add one line each |
| `src/api/health.js` | `registerHealthRoutes(router, deps)` — `/healthz` |
| `src/api/auth.js` | `registerAuthRoutes(router, deps)` — `/login`, `/logout`, `/api/me`; owns the login limiter instance |
| `src/api/users.js` | `registerUserRoutes(router, deps)` — `/api/users*` |
| `src/app.js` | `createApp({ config, db, log, now = Date.now, publicDir = <repo>/public, ...extra })` → `{ server, deps, close() → Promise<void> }` (server not yet listening); typedef `AppDeps = { config, db, log, now, sessions } & extra` |
| `src/server.js` | entry: `start({ config?, log? } = {})` → `Promise<{ app, db, config, stop() → Promise<void> }>`: config → DB → migrate → bootstrap → [later phases build extra deps here] → `createApp` → `listen` → purge timer; signal handlers only when run as entry |
| `src/cli/reset-password.js` | `resetPassword({ args, config, db, input, output, log, isTTY })` → `Promise<number>` exit code; entry block wires real streams |
| `public/css/tokens.css` | 1:1 mirror of design.md tokens + derived state/layout tokens (only file with raw colours/lengths) |
| `public/css/base.css` | reset, typography, focus ring, buttons, inputs, `.select`, `.empty-state`, `.visually-hidden`, dialog |
| `public/css/shell.css`, `home.css`, `login.css`, `admin.css` | header/nav/menu; home rows + empty state layout; login card; admin table/cards/form |
| `public/js/lib/dom.js` | `el(tag, attrs = {}, ...children)` → `HTMLElement` (strings become text nodes; `class`, `dataset`, `on<event>` functions, boolean attributes; `null`/`false` omitted; never `innerHTML`); `createEmptyState({ title, text })` → `HTMLElement` |
| `public/js/lib/icons.js` | `createIcon(paths, { viewBox = '0 0 24 24' } = {})` → `SVGSVGElement` (`aria-hidden="true"`, `focusable="false"`); `icon(name)` for `'logo' \| 'movies' \| 'series' \| 'music' \| 'audiobooks' \| 'images' \| 'chevron-down' \| 'users' \| 'logout' \| 'alert'` |
| `public/js/lib/api.js` | `request(method, path, { json, keepalive, redirectOn401 = true } = {})` → `Promise<{ status, data }>`; `ApiError { status, code, retryAfterSec }` (`retryAfterSec: number \| null`); `toLogin()`; `safeNext(value)` |
| `public/js/lib/nav.js` | `NAV_ENTRIES` (frozen `{ id, label, href }[]`, ids = `CATEGORIES` order: movies, series, music, audiobooks, images); `renderNav(active)` → `HTMLElement`; arrow-key handling |
| `public/js/lib/shell.js` | `mountShell({ active = null } = {})` → `{ main, setActive(id), me }` (`me`: `Promise<AuthUser>`) |
| `public/js/{login,home,placeholder,admin}.js` | page scripts; `placeholder.js` reads the category from `<body data-category="<id>">` |

### Server contract (fixed here, used verbatim by every phase — D4)

- Handler signature `handler(req, res, ctx)` with `ctx = { user, params, url,
  sessionId }` (`sessionId` is P1-internal; later phases ignore it).
- `createApp({ config, db, log, now, ...extra })` builds `deps = { config, db,
  log, now, sessions, ...extra }` and calls `registerRoutes(router, deps)`.
  Later phases add optional keys (e.g. `library`) by building them in
  `src/server.js` `start()` before `createApp` and passing them as `extra`
  (one line in `start()`, one optional property in the `AppDeps` typedef);
  building them never awaits a scan, so wiring never delays `listen`. Their
  shutdown hooks go into `stop()` before the DB closes.
- Router: patterns are `/`-separated segments; `:name` matches exactly one
  non-empty segment (percent-decoded; malformed encoding → no match); matching
  is whole-segment (`/media/:id` never matches `/media/1/thumb`); trailing
  slash is significant; query string ignored. At equal segment count a literal
  segment beats a parameter at the same position. A duplicate
  `(method, pattern)` throws at registration. A path that matches a pattern
  only under other methods yields `{ allow }` (`HEAD` included when `GET`
  exists). An explicit `HEAD` route wins; otherwise the `GET` handler runs with
  `req.method === 'HEAD'` (Node drops the body for HEAD responses).
- Dispatch in `app.js`, per request: security headers → parse URL (malformed
  → 404) → resolve session → mutation guard for `POST/PUT/PATCH/DELETE` →
  `router.match`: handler → run; else for `GET`/`HEAD` on a non-`/api/` path
  → static handler; if nothing served: `allow` → `405 method_not_allowed` +
  `Allow`; else `/api/*` → `404 {"error":"not_found"}`, other → 404 page.
- Errors: a thrown `HttpError` → `sendError(status, code, headers)`; anything
  else → `500 internal` (JSON on `/api/*`, `/login`, `/logout` and every
  non-GET request; plain German text "Interner Fehler." otherwise) and one
  `request_error {method, path, stack}` log line (`path` = pathname only). If
  headers were already sent, the socket is destroyed instead.
- `readJson`: a body is present when `Content-Length > 0` or
  `Transfer-Encoding` is set. No body → resolves `undefined` (body-less
  `POST`/`DELETE` are fine). Body present: `Content-Type` must be
  `application/json` (parameters like `charset` allowed) else
  `415 unsupported_media_type`; > limit → `413 payload_too_large`; invalid
  JSON → `400 invalid_json`. Handlers that require a body treat `undefined`
  or a non-object as `400 invalid_json`.
- Mutation guard (CSRF): for `POST/PUT/PATCH/DELETE`, an `Origin` header, when
  present, must be a parseable URL whose host (`hostname[:port]`, compared
  case-insensitively; scheme ignored, so a TLS proxy without
  `X-Forwarded-Proto` still works) equals the first `X-Forwarded-Host` value,
  or `Host` when that header is absent; `Origin: null`, an unparseable value
  or a mismatch → `403 forbidden_origin` +
  `origin_rejected {origin, host}` log. Missing `Origin` is allowed (curl,
  CLI). No custom header marker; a same-origin
  `fetch(url, { method, keepalive: true, headers: {'Content-Type':'application/json'}, body })`
  passes. `GET`/`HEAD` never mutate.
- JSON conventions: keys camelCase; timestamps ISO-8601 UTC strings named
  `…At` (DB: INTEGER epoch ms); errors strictly `{ "error": "<code>" }`; every
  `sendJson`/`sendError` response carries `Cache-Control: no-store` and
  `Content-Type: application/json; charset=utf-8`.
- Logging: modules log only through the injected `log` (`deps.log`); no
  `console.*` anywhere in `src/` (machine-checked).

### Frontend contract (D5)

- `request(method, path, opts)`: sends JSON when `opts.json` is given
  (`Content-Type: application/json`), `credentials: 'same-origin'`,
  `keepalive` passed through. 2xx → `{ status, data }` (`data` = parsed JSON,
  `null` for 204/empty). Non-2xx → throws `ApiError { status, code,
  retryAfterSec }` with `code` = body `error` or `'unknown'` and
  `retryAfterSec` = the `Retry-After` response header parsed as a
  non-negative integer number of seconds, `null` when absent or not an integer
  (this server never sends the HTTP-date form); network failure →
  `ApiError { status: 0, code: 'network', retryAfterSec: null }`. On `401` with `redirectOn401` (default) it calls
  `toLogin()` before throwing. Progress/beacon-like calls pass
  `redirectOn401: false` and drop the error.
- `toLogin()`: `location.assign('/login?next=' + encodeURIComponent(location.pathname + location.search))`;
  the login page itself never calls it.
- `safeNext(value)` (client) and `safeNext(value)` (server,
  `src/http/security.js`) implement the same rule: accepted only if it starts
  with `/`, not `//` or `/\`, contains no control character or backslash, and
  is ≤ 2048 chars; otherwise `/`.
- `mountShell({ active })`: renders skip link, header, nav, account menu and
  `<main id="main">` into `document.body`, returns `{ main, setActive, me }`;
  `setActive(id)` moves `aria-current` (null clears); `me` resolves with
  `/api/me`. Page scripts append their content to `main`.
- Tokens (`public/css/tokens.css`, P1-owned, later phases never edit):
  `--color-{background,foreground,primary,secondary,accent,muted,border,destructive}`,
  derived `--color-{primary,secondary}-{hover,active}` via
  `color-mix(in srgb, <c>, white 8%)` / `color-mix(in srgb, <c>, black 8%)`,
  `--font-{sans,mono}`, `--text-{xs,sm,md,lg,xl,2xl,3xl}` (12/14/16/20/24/32/48 px),
  `--weight-{regular,semibold,bold}`, `--leading-{body,heading}`,
  `--space-{1,2,3,4,6,8,12,16}` (4/8/12/16/24/32/48/64 px),
  `--radius-{sm,md,lg,full}`, `--shadow-{sm,md}`, layout
  `--bar-height` 64 px, `--bar-height-mobile` 56 px, `--tap-min` 44 px,
  `--content-max` 1280 px, `--border-width` 1 px, `--focus-width` 2 px,
  `--focus-offset` 2 px, `--grid-min` 160 px, `--row-min` 48 px.
- Literal lengths outside `tokens.css`: only the breakpoints 768/1024 px inside
  `@media` preludes, `%`, `vh`/`dvh`/`vw`, `fr`, `0` and `env(...)`. Anything
  else uses a token or `calc()` over tokens (e.g. H3's half-gap
  `calc(50% - 8px)` is written `calc(50% - var(--space-2))`). Machine-checked.
- CSP forbids `style=""` attributes and inline `<style>`/`<script>`; dynamic
  values are set with `el.style.setProperty('--x', value)`.
- Page-private CSS/JS: a page links its own `public/css/<page>.css` and
  `public/js/<page>.js`. P4 replaces `public/js/home.js` (keeping the
  `.home-rows` slot and the empty-state rule above) and may add one
  `<link rel="stylesheet">` line to `public/index.html`; `placeholder.js` is
  never edited. Icons beyond P1's set live in the adding phase's own module,
  built with `createIcon` — `icons.js` is never edited by later phases.

### HTTP surface

| Route | Auth | Behaviour |
|---|---|---|
| `GET /healthz` | none | `200 {"status":"ok"}`; `503 {"error":"db_unavailable"}` if `ping(db)` is false |
| `POST /login` | none | JSON `{username, password}` (both strings, else `400 invalid_json`) → `200 {id, username, role}` + session cookie; a still-valid prior session cookie is revoked only after a successful verify, right before the new session is created (fixation defence; a failed or throttled login never logs anyone out); `401 invalid_credentials`; `429 too_many_attempts` + `Retry-After` (seconds) |
| `POST /logout` | session | deletes the session, clears the cookie, `204`; without a valid session → `401 unauthorized` (cookie cleared too) |
| `GET /api/me` | user | `200 {id, username, role}` |
| `GET /api/users` | admin | `200 [{id, username, role, createdAt}]` ordered by username |
| `POST /api/users` | admin | `{username, password, role?}` (role defaults to `user`) → `201 {id, username, role, createdAt}`; `400 invalid_username\|invalid_password\|invalid_role` (a missing or non-string field yields that field's code; checked in this order); `409 username_taken` |
| `PUT /api/users/:id/password` | admin | `{password}` → `204`; `400 invalid_password`; `404 not_found` (unknown or non-integer id); revokes all of that user's sessions except the caller's current one |
| `PATCH /api/users/:id` | admin | `{role}` → `200 {id, username, role, createdAt}` (same role = no-op 200); `400 invalid_role`; `404 not_found`; `409 cannot_change_own_role\|last_admin` |
| `DELETE /api/users/:id` | admin | body-less → `204`; `404 not_found`; `409 cannot_delete_self\|last_admin`; sessions cascade |
| page routes | see rules | HTML from `public/` |
| static assets | none | `public/` files by extension |

Common errors: `401 unauthorized`, `403 forbidden` (non-admin),
`403 forbidden_origin`, `404 not_found`, `405 method_not_allowed` (+ `Allow`),
`413 payload_too_large` (JSON body > 16 KiB), `415 unsupported_media_type`,
`500 internal` (logged with stack). `POST /login` and `POST /logout` are JSON
endpoints (architecture key flow 5), not form posts. `/healthz` also answers
`HEAD` and carries `Cache-Control: no-store`.

**Page routes and static rules** (`src/http/static.js`):

- `GET|HEAD /` → `public/index.html`; `/<name>` with `name` matching
  `^[a-z][a-z0-9-]*$`, not `index` and not `404` → `public/<name>.html` if it
  exists. P1 pages: `login`, `admin`, `movies`, `series`, `music`,
  `audiobooks`, `images` (+ `/` → `index.html`). Later pages
  (`/series-detail`, `/player`, …) need no server change.
- `login` is public (a logged-in user is redirected `302` to `safeNext(next)`);
  `admin` requires role admin (no session → login redirect, non-admin →
  `302 /`); every other page requires a session (none →
  `302 /login?next=<encodeURIComponent(path+query)>`). Page responses carry
  `Cache-Control: no-store` (they depend on the session).
- Requests naming an `.html` file directly (`/admin.html`) → 404. Other paths
  with an extension are static assets served without session from an allowlist:
  `.css` `text/css; charset=utf-8`, `.js` `text/javascript; charset=utf-8`,
  `.svg` `image/svg+xml`, `.png` `image/png`, `.ico` `image/x-icon`, `.json`
  `application/json`, `.webmanifest` `application/manifest+json`; anything
  else → 404.
- Path safety: decode once (malformed → 404), reject NUL, backslash, `.`/`..`
  segments and any segment starting with `.`, resolve inside `publicDir` and
  verify containment (`resolved.startsWith(publicDir + sep)`) → otherwise 404.
- Unknown non-API path → `404` with `public/404.html` (plain German text
  "Seite nicht gefunden." if absent); unknown `/api/*` → `404 {"error":"not_found"}`.
- Caching of assets: `Cache-Control: no-cache` + `Last-Modified`;
  `If-Modified-Since` ≥ mtime (second precision) → `304`. Files are streamed
  (`fs.createReadStream`); a stream error after headers destroys the socket.

### Data model — migration 001

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,          -- normalized (see rules)
  password_hash TEXT    NOT NULL,                 -- scrypt$N$r$p$saltB64$hashB64
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'user')),
  created_at    INTEGER NOT NULL                  -- epoch ms
) STRICT;
CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,                 -- sha256 hex of the token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);
```

Runner: table `schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT
NULL, applied_at INTEGER NOT NULL) STRICT`, created by the runner itself; files
`^\d{3}-[a-z0-9-]+\.sql$`; a `.sql` file not matching the pattern or a
duplicate number throws `MigrationError` before anything is applied; every
**not-yet-applied** version is applied in ascending order — including numbers
below the highest applied one (gaps allowed; Phases 2–6 merge in any order) —
each file in its own `BEGIN IMMEDIATE … COMMIT` that also contains its
`schema_migrations` insert; on error `ROLLBACK` and throw (server exits 1).
Migration files contain no transaction statements. Each applied file logs
`migration_applied {version, name}`. Connection pragmas: `journal_mode=WAL`,
`foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.

## Prior decisions

| Decision | Rationale | Date |
|---|---|---|
| Config: `MEDIA_ROOT` required, resolved absolute, must be a readable directory; `DATA_DIR` default `./data` (resolved against cwd, created by `openDatabase`), must not lie inside `MEDIA_ROOT`; `HOST` default `0.0.0.0`; `PORT` default 8080, integer 1–65535; `RESCAN_INTERVAL_MIN` default 15, integer 1–1440 (validated now, consumed by Phase 2); `ADMIN_USER`/`ADMIN_PASSWORD` optional but only together; empty string = unset. `requireMediaRoot: false` (CLI only) skips the `MEDIA_ROOT` checks | Constitution config list; a `DATA_DIR` under `MEDIA_ROOT` would write into the read-only media root; recovery must work with the media disk unmounted | 2026-09-26 |
| Config failure: collect all problems, log `config_invalid {problems}` (names and rules, never values), exit 1 before opening the DB | Fail fast, fix everything in one pass | 2026-09-26 |
| Bootstrap: runs after migrations; users table empty + both vars valid → create admin, log `admin_bootstrapped {user}`; empty + vars missing/invalid → `BootstrapError`, log `admin_missing` with guidance "set ADMIN_USER and ADMIN_PASSWORD", exit 1; users exist → no-op, log `admin_env_ignored` if vars are set | No unauthenticated first-run setup page (attack window); env is the constitution's config channel | 2026-09-26 |
| Passwords: scrypt N=2^14, r=8, p=1, 64-byte key, 16-byte random salt, async `crypto.scrypt`, stored as `scrypt$N$r$p$salt$hash` (base64; params travel with the hash); verify with `timingSafeEqual`; unknown usernames and over-long passwords are verified against `DUMMY_HASH` | Prior art (Phase 1); async keeps streams flowing; equal timing avoids username enumeration | 2026-09-26 |
| Password rule: 8–256 characters (code points), no composition rules | NIST SP 800-63B minimum 8; upper bound caps hashing work | 2026-09-26 |
| Username rule: trim, NFC, lower-case, then `^[\p{L}\p{N}._-]{1,32}$` (u); stored normalized, login normalizes the same way | Case-insensitive, umlaut-friendly, safe in URLs/logs | 2026-09-26 |
| User ids use `AUTOINCREMENT` and all tables are `STRICT` | D12: all migrations STRICT; ids are never reused, so logs and stale client state never point at a different person | 2026-09-26 |
| Sessions: 32 random bytes base64url token in cookie `vt_session`; DB stores only its SHA-256 hex; idle lifetime 30 days, sliding; `expires_at` refreshed (and cookie re-sent) only when less than 29 days remain — at most one write per session per day; invalid/expired cookie → anonymous, cookie cleared (`Max-Age=0`) | Household TVs/phones should stay logged in; hashed ids make a DB copy useless for hijacking (OWASP Session Mgmt); minimal SD-card writes | 2026-09-26 |
| Session cleanup: `purgeExpired()` at startup and hourly (`setInterval(...).unref()`); logout, password reset (target's sessions except the caller's), CLI reset (all of the target's sessions) and user deletion (FK cascade) revoke; role changes take effect on the next request because the role is read from `users` per request | No stale privileges, bounded table | 2026-09-26 |
| Login with a still-valid session cookie revokes that session only after the password verified, immediately before creating the new one; a failed or throttled login leaves it untouched | OWASP session fixation guidance; no orphan sessions; a mistyped password on a shared device must not log the current user out (review finding) | 2026-09-26 |
| Cookie: `Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, plus `Secure` when the socket is TLS or the first `X-Forwarded-Proto` value is `https` | Zero-config behind a proxy; a spoofed header only affects the spoofer's own cookie; no new env var needed | 2026-09-26 |
| Login throttle: in-memory, keyed by normalized username; checked before verifying; 5 failures within a sliding 15 min window → `429` + `Retry-After` (seconds, rounded up) until the oldest failure leaves the window; success resets; max 1000 keys (least-recently-failed evicted); lost on restart | OWASP Authentication cheat sheet (throttle per account); IP keys are useless behind a proxy and `X-Forwarded-For` is spoofable | 2026-09-26 |
| CSRF / mutation guard exactly as in "Server contract" (host-only `Origin` match, JSON content type only when a body is present, no custom marker) | OWASP CSRF cheat sheet (Origin + SameSite); JSON content type forces a CORS preflight cross-site; cross-phase decision D4 | 2026-09-26 |
| Security headers on every response: `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`; no HSTS | Enforces "no outbound calls / no inline script" in the browser; `same-origin` referrer keeps D10's player "Zurück" check working; HSTS belongs to the TLS proxy | 2026-09-26 |
| Admin guards: cannot delete self (`cannot_delete_self`), cannot change own role (`cannot_change_own_role`), may reset own password (keeps current session); any delete/demotion that would leave zero admins → `last_admin`; check and write run in one `BEGIN IMMEDIATE` transaction inside `src/db/users.js` | Prevents lock-out, also under concurrent requests; SQL stays in `src/db/` | 2026-09-26 |
| `/healthz` uses `ping(db)` from `src/db/index.js` | SQL only in `src/db/` | 2026-09-26 |
| `POST /logout` without a valid session → `401 unauthorized` (and clears any stale cookie); the frontend treats 204 and 401 alike | Constitution: every route except `/login`, static assets and `/healthz` requires a session — no declared exception needed (D4 "P1 picks one") | 2026-09-26 |
| Server contract (handler/ctx, `createApp`/deps, `Config`, router matching, HEAD, `readJson`, mutation guard, logging, JSON conventions) as specified in "Server contract" | Cross-phase consolidation D4 — every phase codes against it verbatim; `ctx.sessionId` is an additive P1-internal key | 2026-09-26 |
| Router exposes `match()` + `routes()` instead of `handle()`; the app decides between handler, static fallback, 405 and 404 | `GET /login` (page) and `POST /login` (API) share a path; `routes()` lets `test/route-auth.test.js` check every registered route | 2026-09-26 |
| Frontend contract (`api.js`, `shell.js`, tokens, literal-length rule, CSP `setProperty`, page-private files) as specified in "Frontend contract"; `mountShell` additionally returns `me` | Cross-phase consolidation D5; `me` avoids a second `/api/me` fetch on the admin page and is additive | 2026-09-26 |
| `ApiError` carries an additive third field `retryAfterSec: number \| null` parsed from `Retry-After`; `login.js` calls `request('POST', '/login', { json, redirectOn401: false })` | D5-additive (like `me`): the throttle message needs the minute count, which lives only in the header, and the error body stays strictly `{ "error": "<code>" }`; a raw `fetch` in `login.js` would duplicate `request()`; without `redirectOn401: false` a `401 invalid_credentials` would navigate away (review finding) | 2026-09-26 |
| P1 icon set = `logo`, the five categories, `chevron-down`, `users`, `logout`, `alert` | The exports show icons on the account-menu items and the login error line; later phases never edit `icons.js` (D5), so P1 ships every icon its own screens use | 2026-09-26 |
| Input and select fill = `background`; `docs/design.md` Input line amended in this spec PR | design.md said "secondary surface", but every P1 input sits on a `secondary` card where that fill would be invisible; the exports show the `background` fill (review finding) | 2026-09-26 |
| Architecture boundary for `public/` widened to name the JSON auth endpoints and page routes (edit made by the app-assembly issue) | `POST /login`/`POST /logout` are JSON endpoints outside `/api/*` (key flow 5) and pages are served routes; the declared deviation must be complete (review finding) | 2026-09-26 |
| Unregistered `/api/*` paths → `404` and method mismatches → `405` are answered before any session check; the 401 guarantee covers every registered route | They are not routes, so the constitution's session rule is untouched; they reveal no data; dispatch stays one simple match | 2026-09-26 |
| Layout tokens `--border-width`, `--focus-width`, `--focus-offset`, `--grid-min` (160 px, H3), `--row-min` (48 px) ship in P1 | D5: later phases never edit `tokens.css`, so P2/P4/P6 do not collide | 2026-09-26 |
| Page URLs are English kebab-case matching page files (`GET /<name>` → `public/<name>.html`, `*.html` → 404); canonical URLs `/`, `/login`, `/admin`, `/movies`, `/series`, `/series-detail?id=`, `/player?id=`, `/music`, `/audiobooks`, `/images`; nav labels German | Cross-phase consolidation D1; one generic page rule means later phases only add/replace `public/<page>.html` | 2026-09-26 |
| Category placeholders are real files (`public/movies.html` …) sharing `public/js/placeholder.js`; the owning phase replaces its file; nobody edits `nav.js`; nav ids are the plural category ids (`movies, series, music, audiobooks, images`) | D1, D3; no shared nav-config edits between parallel phases | 2026-09-26 |
| Home `/` is P1-owned `public/index.html` + `public/js/home.js` + `public/css/home.css`: heading "Start", `.home-rows` slot, empty state "Willkommen" hidden once a row is mounted; no active nav entry; P4 replaces `home.js` | Cross-phase consolidation D2; copy that stays true before and after P4 | 2026-09-26 |
| Unauthenticated page → `302 /login?next=…`; `next` honoured only via `safeNext` (starts with `/`, not `//` or `/\`, no control chars/backslash, ≤ 2048 chars); frontend `request` redirects to login on `401` unless `redirectOn401: false` | No open redirect; seamless expiry handling | 2026-09-26 |
| Logging: JSON lines via `createLogger` to stdout, `error` level to stderr; events: `startup`, `listening {host, port}`, `config_invalid`, `migration_applied`, `admin_bootstrapped`, `admin_missing`, `admin_env_ignored`, `login_ok {user}`, `login_failed {user, ip}` (`ip` = socket address), `login_throttled {user}`, `logout {user}`, `user_created`, `user_deleted`, `password_reset`, `role_changed` (all `{user, by}`; CLI uses `by: "cli"`), `origin_rejected {origin, host}`, `request_error {method, path, stack}`, `shutdown`; never bodies, headers, passwords, hashes or tokens; redaction as defence in depth; no `console.*` in `src/`; no per-request access log | Constitution "no secrets in logs"; D4 injected logger; proxy does access logs; Pi SD card | 2026-09-26 |
| Entry detection without `import.meta.main`: `src/server.js` and `src/cli/reset-password.js` run their entry block only when `realpathSync(process.argv[1])` equals `realpathSync(fileURLToPath(import.meta.url))` | `import.meta.main` needs Node ≥ 24.2 while `engines` says `>=24`; importing the module in tests must not start anything | 2026-09-26 |
| Graceful shutdown on SIGINT/SIGTERM: `stop()` clears timers, `server.close()` + `closeIdleConnections()`, after 5 s `closeAllConnections()` (open media streams), closes the DB, exit 0; a second signal exits 1 immediately; startup/listen errors exit 1; no global crash handlers — a supervisor restarts (README systemd `Restart=on-failure`) | Clean WAL checkpoint; long streams must not block shutdown | 2026-09-26 |
| `createApp` is separate from the entry so tests run the full stack in-process on port 0; `test/helpers/app.js` exports `startTestApp({ mediaRoot?, now?, ...extra } = {})` → `Promise<{ baseUrl, db, config, deps, createUser(name, pw, role = 'user') → Promise<{id, username, role}>, login(name, pw) → Promise<string /* "vt_session=…" */>, close() }>`; it uses temp `DATA_DIR`/`MEDIA_ROOT` dirs (removed on `close`), runs migrations, no bootstrap, a silent logger (`deps.logLines` collects lines), listens on `127.0.0.1:0`, and `login` creates the session through the session store (no HTTP) | Signals cannot be tested portably (Windows); one shared helper avoids six ad-hoc harnesses; `...extra` lets P2 inject `library` | 2026-09-26 |
| `npm test` = `node --test "test/**/*.test.js"`; tests mirror `src/` (`src/a/b.js` ↔ `test/a/b.test.js`) | Default discovery would execute `test/helpers/*.js` and fixtures as test files; a fixed mirror makes "every module has a test" machine-checkable | 2026-09-26 |
| Machine-checked rules — `test/constitution.test.js`: no `dependencies` key and devDependencies exactly `typescript` + `@types/node`; `process.env` only in `src/config.js`; no `console.` in `src/`; no `child_process`, `eval(` or `new Function` in `src/`/`public/`; no `src/` import from `public/` and vice versa; every `src/**/*.js` has its mirrored test; no `.js/.css/.html` file under `src/`, `public/`, `test/` (fixtures excluded) over 300 lines. `test/frontend-rules.test.js` (scans `public/**/*.{css,js,html}`): `tokens.css` mirrors every design.md colour and the token list above; no hex/`rgb(`/`hsl(` colour outside `tokens.css`; no `px`/`rem`/`em` length outside `tokens.css` except breakpoints in `@media` preludes; `public/favicon.svg` is outside that scan (an SVG favicon cannot read CSS tokens) but every hex colour in it must equal a design.md colour token (checked); no `http(s)://` in `public/` except `http://www.w3.org/2000/svg`; no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`; no `style=` attribute or `setAttribute('style'` and no inline `<script>`/`<style>` in `public/`. `test/route-auth.test.js`: every route from `router.routes()` except `GET /healthz`, `HEAD /healthz`, `POST /login` answers `401 {"error":"unauthorized"}` without a session (`:param` → `1`) | Turns constitution/design rules into verify failures; later phases' routes are covered automatically once registered | 2026-09-26 |
| The ≤ 60-lines-per-function rule is enforced in PR review, not by a test | TypeScript 7 exposes no parser API and a hand-written brace counter would be brittle | 2026-09-26 |
| Frontend libs are unit-tested only where pure: `test/public/api.test.js` covers `request`/`ApiError` (incl. `retryAfterSec`: `Retry-After: 840` → 840, absent/non-integer → `null`, network → `null`; `redirectOn401: false` never calls `toLogin`)/`safeNext` with a stubbed `fetch`/`location`; DOM modules are verified in the browser QA | Node has no DOM and no dependency may be added | 2026-09-26 |
| Timestamps: DB columns are INTEGER epoch ms; API exposes ISO-8601 strings | One convention across phases (D4) | 2026-09-26 |
| Login page keeps the export's footer "Konten werden von der Verwaltung angelegt."; the mobile admin card drops the export's role pill (the select is the only role display) | Footer answers "how do I get an account" (no self-registration); a pill next to an editable select duplicates state | 2026-09-26 |
| Human decision at spec-acceptance gate (H1): account recovery = offline CLI `npm run reset-password -- <username>` (`node --env-file-if-exists=.env src/cli/reset-password.js`): loads config with `requireMediaRoot: false`, opens the DB (works while the server runs — WAL + `busy_timeout`), normalizes the username, prompts "Neues Passwort für {name}: " and "Passwort wiederholen: " without echo (TTY raw mode; plain line read when stdin is not a TTY), validates (8–256), sets the hash, revokes all of that user's sessions, prints "Passwort für {name} gesetzt, {n} Sitzung(en) beendet.", logs `password_reset {user, by: "cli"}`, exit 0; missing argument, unknown user ("Unbekannter Benutzer: {name}"), mismatch ("Passwörter stimmen nicht überein.") or invalid password → message on stderr, exit 1; promotes nothing; own test with injected streams; README recovery section | Recovers a lost last-admin password without losing progress; needs no new env var | 2026-09-26 |
| Human decision at spec-acceptance gate (H2): self-service password change is out of v1; the admin resets passwords; a later `track:adhoc` if wanted | Keeps P1 minimal | 2026-09-26 |
| `src/log.js`: `out`/`err` are typed as a minimal `LogStream = { write(chunk: string): void }`, not `NodeJS.WritableStream` (`process.stdout`/`process.stderr` still satisfy it structurally); a redacted key's whole value is replaced with `"[redacted]"` without recursing further into it, so a matched key holding an object or array is never partially redacted; `Error` values are serialized to `{ message, stack }` at any nesting depth, including inside arrays | Full stream typing would force every test double to implement the whole `Writable` surface; a redacted key's value could itself contain more sensitive data, so replacing it wholesale (vs. recursing in) is the safer default; nested `Error` serialization matches other fields the redaction traversal already recurses into (issue #10 acceptance) | 2026-09-26 |

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

- [ ] `npm run verify` green; `npm ls --omit=dev --all` shows no package;
      `test/constitution.test.js`, `test/frontend-rules.test.js` and
      `test/route-auth.test.js` pass.
- [ ] Unit tests cover the failure cases: config (missing/relative/non-dir
      `MEDIA_ROOT`, `DATA_DIR` inside `MEDIA_ROOT`, bad `PORT`, lone
      `ADMIN_USER`, all problems collected, no value in the message); logger
      (redaction incl. nested keys); migration runner (fresh, idempotent re-run,
      gap below max, duplicate number, bad file name, broken SQL rolls back
      incl. its `schema_migrations` row); scrypt (wrong password, tampered and
      malformed hash string); throttle (6th attempt blocked, `retryAfterSec`,
      window expiry, reset on success, key cap); session store (expiry, sliding
      refresh once per day, revocation, `revokeUser` except, hashed id at rest);
      router (whole-segment, literal beats param, 405 + `Allow`, HEAD fallback,
      duplicate throws, malformed encoding); `readJson` (no body → undefined,
      wrong type → 415, > 16 KiB → 413, bad JSON → 400); static serving
      (`/../package.json`, `/%2e%2e/package.json`, `/%2F..`, backslash, NUL,
      `/.env`, `/admin.html`, `/index`, `/404`, unknown extension → 404; `304`);
      origin check (foreign `Origin` → 403, `Origin: null` → 403, missing
      `Origin` allowed, forwarded host honoured); admin guards (self delete,
      own role, last admin incl. concurrent demotion, non-admin 403); CLI
      (success revokes sessions, unknown user, mismatch, short password, missing
      argument — all with injected streams); frontend `api.js`
      (`ApiError.retryAfterSec` parsing, `redirectOn401: false`, `safeNext`).
- [ ] `start()`/`stop()` test: importing `src/server.js` starts nothing;
      `stop()` resolves within 6 s while a request stream is still open.
- [ ] Start without `MEDIA_ROOT` → exit 1, log names `MEDIA_ROOT`; with
      `DATA_DIR` inside `MEDIA_ROOT` → exit 1.
- [ ] Fresh `DATA_DIR` without `ADMIN_*` → exit 1 with guidance; with them →
      `admin_bootstrapped`; restart → no second admin, `admin_env_ignored`.
- [ ] Without cookie: `/healthz` 200; `/api/me` 401 JSON; `POST /logout` 401;
      `/` → 302 `/login?next=%2F`; `/css/tokens.css` 200; `/admin.html` 404;
      every response has the CSP and `nosniff` headers.
- [ ] Login page matches the exports on both viewports; wrong password shows
      the error (no navigation); the 6th wrong attempt shows the throttle
      message with the minute count ("in 15 Minuten"); `next`
      is honoured, `next=//evil.example` falls back to `/`.
- [ ] Shell: bottom nav on mobile, top nav on desktop; each category entry opens
      its placeholder with the entry active in primary (orange); home shows
      "Start" with the "Willkommen" empty state and no active entry; Tab reaches
      every control (skip link first) with a visible primary (orange) focus
      ring; arrows move within the nav; Escape closes the account menu.
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
- [ ] `npm run reset-password -- <admin>` on the QA instance sets a new
      password; the admin's open browser session is logged out; the new
      password works.
- [ ] Captured logs of a full QA run contain neither the admin password, a
      `vt_session` value nor `scrypt$`.
- [ ] QA-only, Linux host (Pi or WSL): `SIGTERM` stops the process within 6 s
      with exit 0, also while a request is open.
- [ ] `README.md` covers install, config table, first start, systemd unit,
      reverse proxy (Caddy + nginx preserving `Host`, setting
      `X-Forwarded-Proto`), backup (stop, copy `videothek.db*`), recovery via
      `npm run reset-password`; `.env.example` lists all seven variables with
      comments.

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
| Several phases edit `src/http/routes.js`, `src/server.js`, `docs/architecture.md` | One line / one section each; contract fixed here |
| `admin.js` or CSS outgrow 300 lines | Split into page-private modules (`public/js/admin-*.js`) / per-concern CSS files; the line-count test catches it |
| Stitch exports are desktop-canvas renders with off-token shades and a placeholder graphic | Exports are layout reference only; notes above override them; rule tests block raw colours/lengths |
| Later phases pick other page URLs or token names | Contracts fixed here and in the cross-phase decisions D1–D5 |
| The literal-length rule rejects a sibling phase's `calc(50% - 8px)` | Frontend contract names the tokenized form; verify fails fast with the offending file/line |

## Decision log

- 2026-09-26: Spec drafted. Decided zero new env vars: `Secure` cookie is
  auto-detected from TLS / `X-Forwarded-Proto`, session lifetime and throttle
  limits are constants.
- 2026-09-26: Session ids are stored hashed (SHA-256) — OWASP Session
  Management; costs one hash per request.
- 2026-09-26: Page access is enforced server-side (redirects) in addition to
  API `401`/`403`, so HTML for protected pages is never served anonymously.
- 2026-09-26: Migration runner applies gaps below the highest applied version
  because Phases 2–6 are implemented in parallel.
- 2026-09-26: Design produced in Stitch (6 screens); mobile PNGs cropped from
  the desktop canvas Stitch renders; exports reviewed at spec acceptance.
- 2026-09-26: cross-phase consolidation — D1 page URL rule and canonical URLs;
  placeholders replaced by the owning phase, nav never edited.
- 2026-09-26: cross-phase consolidation — D2 home page contract (`index.html`,
  `home.js` placeholder replaced by P4, `.home-rows` slot, empty state only
  without rows, no active nav entry).
- 2026-09-26: cross-phase consolidation — D3 plural category ids as nav ids.
- 2026-09-26: cross-phase consolidation — D4 server contract (handler/ctx,
  `createApp`/deps, `Config`, whole-segment router, HEAD, `readJson` 415 only
  with a body, Origin-only mutation guard, injected JSON logger, JSON
  conventions); `/logout` without session = 401; architecture deviations
  (`src/http/guards.js`, `src/api/auth.js`, `src/cli/`, `src/app.js`,
  `src/log.js`) listed in Scope for the architecture.md update.
- 2026-09-26: cross-phase consolidation — D5 frontend contract (`api.js`,
  `shell.js`, token additions, literal-length rule, CSP `setProperty`,
  off-token shades map to tokens).
- 2026-09-26: cross-phase consolidation — D12 migrations: 001 is STRICT;
  runner inserts `schema_migrations` in the same transaction as the file.
- 2026-09-26: gate decision — H1 account recovery via offline CLI
  `npm run reset-password -- <username>` (`src/cli/reset-password.js`).
- 2026-09-26: gate decision — H2 self-service password change out of v1.
- 2026-09-26: Review findings resolved: entry detection via realpath compare
  instead of `import.meta.main`; `/healthz` and last-admin transaction moved
  into `src/db/`; route-auth, file-length and mirrored-test checks added;
  login footer kept, mobile role pill dropped; `startTestApp` passes
  `{ now, ...extra }`; SIGTERM QA marked Linux-only with a portable `stop()`
  test; function-length rule left to PR review (no TS 7 parser API).
- 2026-09-26: Pre-mortem settled: router `match()`/`routes()` for the shared
  `/login` path and the route-auth test; session-fixation revoke on login;
  `ctx.sessionId`; `mountShell` returns `me`; static MIME allowlist, `/index`
  and `/404` not routable, page `no-store`; home copy "Willkommen"; admin
  status/error copy; CLI `requireMediaRoot: false`; `AUTOINCREMENT` user ids;
  JSON `Cache-Control: no-store` on every JSON response.
- 2026-09-26: Spec-acceptance review findings resolved (D5 additive):
  `ApiError.retryAfterSec` from `Retry-After` for the throttle minute count;
  `login.js` uses `redirectOn401: false`; P1 icon set adds `users`, `logout`,
  `alert`; design.md Input line amended to `background` fill; architecture
  boundary for `public/` widened (auth endpoints, page routes); frontend-rules
  scan scoped to css/js/html with a token-colour check for `favicon.svg`;
  401 guarantee worded for registered routes; prior session revoked only after
  a successful login; missing exports for home/404/dialogs noted.
- 2026-09-26 (#13): `src/auth/{password,validation,rate-limit}.js`
  implemented. `deriveKey` wraps `crypto.scrypt` in a plain `Promise`
  executor instead of `util.promisify` — the promisified overload with an
  options object did not type-check under `tsc --noEmit --strict` (picked the
  3-arg, no-options overload). `DUMMY_HASH` is a hardcoded precomputed
  literal (fixed salt) rather than computed via top-level `await
  hashPassword(...)`, so importing the module carries no scrypt cost and the
  constant is deterministic across runs. `createLoginLimiter`'s LRU eviction
  keys off `Map` iteration order: `fail(key)` deletes-then-re-sets the key to
  move it to the end (most-recently-failed), so `failures.keys().next()`
  yields the least-recently-failed key to evict once `maxKeys` is exceeded;
  `check`/window-pruning never reorder a key so they cannot mask eviction
  order. `check()` returns `retryAfterSec: null` when `allowed` is `true`,
  matching the `number | null` convention used elsewhere in this spec
  (`ApiError.retryAfterSec`).
- 2026-09-26: Issue #22 (`public/js/lib/{dom,icons,api}.js`) implementation
  choices not fixed elsewhere: `el()` treats `null`/`undefined`/`false` attribute
  values as omitted and `true` as a boolean attribute (`setAttribute(key, '')`);
  `class` additionally accepts a `string[]` (falsy entries filtered, joined with
  a space) for conditional classes; children that are `null`/`undefined`/`false`
  are silently skipped so callers can write `cond && el(...)`. Icon path data
  (`icons.js`) is self-authored, minimal, single/double-`<path>` glyphs on the
  24x24 grid colored via `fill="currentColor"` (no stroke icons), since the
  Stitch exports show icons only at thumbnail size with no vector handoff;
  visual fit is confirmed at milestone UI QA once a page mounts them. `api.js`
  treats any body text that fails `JSON.parse` (2xx or error) as `null` /
  `'unknown'` respectively rather than throwing, and `Retry-After` is accepted
  only as a non-negative-integer digit string (`^\d+$`) per the spec's
  "never sends the HTTP-date form" note.
- 2026-09-26: Issue #26 (`README.md`/`.env.example`) implemented — README
  covers install, the config table (incl. `ADMIN_USER`/`ADMIN_PASSWORD`
  validation and the `config_invalid`/`admin_missing` failure paths), first
  start, a systemd unit (`Restart=on-failure`), Caddy and nginx reverse-proxy
  snippets (both preserving the host and setting `X-Forwarded-Proto`), backup
  (stop, copy `videothek.db*`) and recovery via
  `npm run reset-password -- <username>`; `.env.example` blanks
  `ADMIN_PASSWORD` so copying it unedited fails loudly instead of creating an
  admin with a known password. No new design decisions.
- 2026-09-26: Issue #9 `src/config.js` implemented. `MEDIA_ROOT` is validated
  as-given (must already be absolute; unlike `DATA_DIR` it is never resolved
  against `cwd`), so a relative value is its own problem
  (`"MEDIA_ROOT: must be an absolute path"`), distinct from missing
  (`"MEDIA_ROOT: required"`) and from existing-but-invalid
  (`"MEDIA_ROOT: must be a readable directory"`, covering both non-directory
  and unreadable/missing-on-disk). `requireMediaRoot: false` (the CLI path)
  never raises a `MEDIA_ROOT`/`DATA_DIR` problem at all — including the
  "inside `MEDIA_ROOT`" containment check — and passes through an absolute
  `MEDIA_ROOT` value uncontained/unverified so `reset-password` keeps working
  with the media disk unmounted; a relative or unset value yields
  `mediaRoot: ''` in that mode, keeping `Config.mediaRoot` a plain `string`
  (matching this table's row) so every other phase's `string`-typed
  parameters accept it without a cast. `PORT`/`RESCAN_INTERVAL_MIN` accept
  only a bare non-negative integer literal (`^\d+$`, no sign, decimal or
  whitespace) before the range check.
- 2026-09-26: Issue #21 (tokens/base/favicon/frontend-rules test) implemented:
  `favicon.svg` reuses only `--color-secondary` (rounded square) and
  `--color-primary` (play triangle), matching the exports' wordmark mark.
  `.visually-hidden` sizes itself with `var(--border-width)` (exactly 1 px)
  instead of a new raw literal, so the sr-only technique needs no length
  outside `tokens.css`. `test/frontend-rules.test.js` parses `docs/design.md`'s
  front matter directly (regex, no dependency) to keep `tokens.css` verifiably
  in sync; added a regression-guard test after the initial parser silently
  dropped every `color:` entry (each has a trailing `# comment`), which would
  have made the colour-mirror assertions pass vacuously over an empty set.
- 2026-09-26: Issue #15 (`src/http/{router,respond,cookies,guards}.js`)
  implementation notes: `router.js` matches path shape independently of
  method via a literal/param trie, recursively backtracking from a literal
  child to the param child at each segment when the literal subtree yields
  no handler or `{ allow }` candidate at the matched path length — "literal
  beats param" holds only when both would otherwise match the same path
  (equal segment count), not merely because a literal child exists; `{
  allow }` is the union of methods across every subtree that fully matches
  the path, not just the first one found. A duplicate leaf/method collision
  throws even when the colliding pattern text differs (a stricter superset
  of the literal `(method, pattern)` rule); a later pattern reusing a trie
  position under a different `:name` also throws at registration, since one
  node carries exactly one param name. `respond.js`'s `sendNoContent`/
  `redirect` additionally send `Cache-Control: no-store` (only `sendJson`/
  `sendError` were required to) since every call site (`/logout`, deletes,
  login/page redirects) is session-dependent; `readJson` drains an oversized
  body with `req.resume()` instead of `req.destroy()`, so the `413` response
  reaches the client instead of the socket closing first.
- 2026-09-26 (#12): `src/db/{users,sessions}.js` implemented. `UserRow`
  mirrors the raw `users` row verbatim, incl. the snake_case
  `password_hash`/`created_at` keys (no camelCase mapping in the repository
  layer — that is `src/api/users.js`'s job); `getSessionWithUser` does map to
  camelCase (`expiresAt`, nested `user: { id, username, role }`) since it is
  already a joined, computed shape with no single backing row. `node:sqlite`'s
  `StatementSync.get()`/`.all()` type as `Record<string, SQLOutputValue>`
  (a union of `null | number | bigint | string | Uint8Array`), so every column
  read is narrowed to its concrete field type with a per-field JSDoc `@type`
  cast rather than one whole-row cast, to stay correct regardless of
  `Record`-to-named-type assignability in a given TypeScript version.
  `setRoleGuarded`/`deleteUserGuarded` share a `countOtherAdmins(db, id)`
  helper and guard only the case that actually removes the last admin (current
  role `admin`, target role/`DELETE` non-admin, zero *other* admins) — a
  same-role update (incl. the sole admin re-confirming `admin`) is therefore
  never refused, matching the API's "same role = no-op 200". Both guards
  follow `migrate.js`'s rollback shape: `BEGIN IMMEDIATE` inside the `try`, a
  nested `try/catch` around `ROLLBACK` so a failed `BEGIN` itself cannot mask
  the original error. `deleteExpiredSessions` treats `expires_at <= now` as
  expired (inclusive) — a session expiring at exactly `now` is purged rather
  than kept for one more tick. "Last-admin refusal incl. concurrent demotion"
  is tested by driving the guard from two separate `DatabaseSync` connections
  opened on the same `DATA_DIR` (one demotes/deletes and commits, the other
  then attempts the same on the last remaining admin) — real thread-level
  interleaving is not exercisable against a synchronous `node:sqlite` handle
  in a single-threaded test process; the two-connection form still proves the
  guard reads committed DB state rather than an in-process cache.
- 2026-09-26 (#20): `src/cli/reset-password.js` implemented. Runs `migrate(db,
  { log })` itself before calling `resetPassword` (mirroring `server.js`'s
  config → DB → migrate order) so the CLI also works against a `DATA_DIR` the
  server has never started against yet; `migrate` is idempotent so this is a
  no-op on an already-current DB. Prompting uses one persistent reader
  (`createPromptReader`) with a single `'data'` listener kept attached across
  both prompts and an internal buffer, instead of two independent
  one-shot listeners: an initial one-shot-per-prompt version lost the second
  prompt's answer whenever both lines arrived in a single chunk (the normal
  case for a piped shell flushing `printf 'a\nb\n'` at once, and for a
  keystroke typed immediately after Enter on a real TTY) — the first
  listener's `data` handler took only its own line and discarded the rest of
  the chunk, leaving the second prompt awaiting input that would never
  arrive and the process exiting silently (code 0, no error) once stdin hit
  EOF with nothing left keeping the event loop alive. Caught via a manual
  end-to-end run of the built CLI (piped input), not by the unit tests
  (which drove the old one-shot-per-call readers directly and happened not
  to reuse a stale buffer); the regression is now also covered directly by
  `fakeInput` delivering every queued line as one chunk on the single
  listener `createPromptReader` attaches. Messages not fixed elsewhere:
  missing argument → "Benutzername fehlt. Verwendung: npm run
  reset-password -- <username>"; mismatch is checked before the length
  validation (matches the failure-list order in Acceptance/Verification:
  "missing argument, unknown user, mismatch, invalid password"); the invalid-
  password text reuses the admin-API's `invalid_password` copy verbatim for
  one wording across the app. `resetPassword`'s username lookup/messages use
  `normalizeUsername` (trim/NFC/lower-case) so `npm run reset-password --
  " Julia "` still finds `julia`; the success/error text after that point
  uses the stored, already-normalized `user.username` rather than echoing
  the raw argument back. `config` stays a required part of the fixed
  `resetPassword({ args, config, db, input, output, log, isTTY })` signature
  (module-layout table) for parity with the other DI-style contracts (e.g.
  `createApp`) even though the function body does not read it — `main()`'s
  wiring is what actually needs it (`loadConfig(undefined, { requireMediaRoot:
  false })` → `config.dataDir` → `openDatabase`). Entry detection reuses the
  spec's fixed `realpathSync(process.argv[1]) === realpathSync(fileURLToPath(
  import.meta.url))` check (this is its first use in the repo; `src/server.js`
  does not exist yet).
