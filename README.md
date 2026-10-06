# Videothek

Dependency-free, self-hosted media streaming for one household. A single
Node.js process reads movies, series, music, audiobooks and pictures directly
from a disk on your server and makes them browsable and playable in the
browser, with per-user resume across devices.

## Requirements

- Node.js 24 or newer
- A directory with your media files, readable by the process
- No database server, no other runtime dependencies — `npm ls --omit=dev --all`
  shows no packages

## Install

```sh
npm ci
```

## Configuration

Copy `.env.example` to `.env` and adjust it. Configuration is read once at
startup from environment variables only:

| Variable | Default | Rules |
| --- | --- | --- |
| `MEDIA_ROOT` | *(required)* | Path to your media library. Resolved to an absolute path; must already exist and be a readable directory. Never written to. |
| `DATA_DIR` | `./data` | Where the SQLite database lives (users, sessions, playback progress, library index). Resolved against the current working directory, created automatically. Must **not** be inside `MEDIA_ROOT`. |
| `HOST` | `0.0.0.0` | Bind address for the HTTP server. |
| `PORT` | `8080` | Integer, 1–65535. |
| `RESCAN_INTERVAL_MIN` | `15` | Integer, 1–1440. How often (in minutes) the library is fully rescanned as a backstop, in addition to picking up changes as they happen. |
| `ADMIN_USER` | *(unset)* | Username for the initial admin account. Must be set together with `ADMIN_PASSWORD` — setting only one is a config error (`config_invalid`, exit 1 before the database opens). 1–32 characters: letters, digits, `.`, `-`, `_` (normalized: trimmed, NFC, lower-cased). Used only while no account exists yet; ignored (logged as `admin_env_ignored` if still set) after the first admin has been created. |
| `ADMIN_PASSWORD` | *(unset)* | Password for the initial admin account (8–256 characters). Must be set together with `ADMIN_USER` — same rules apply. |
| `CONVERTER_CMD` | *(unset)* | Command to run for on-demand conversion of not-playable items, e.g. `/usr/bin/node /opt/converter/cli.js`. Unset or empty disables the whole conversion feature — no control is shown, `POST` answers `503 conversion_disabled`, no child process is ever started. Split on whitespace (no quoting/escaping); the first token must be an absolute path (on Windows, a drive letter or UNC prefix — see "Conversion" below); 1–32 tokens. Not checked for existence: a missing converter fails jobs, never startup. |
| `CONVERT_DIR` | `<DATA_DIR>/converted` | Directory for verified conversion copies. Must not overlap `MEDIA_ROOT` in either direction, and must not lie inside this app's `public/` directory. Created automatically when the feature is used. |

An empty value is treated the same as an unset variable. If the configuration
is invalid or incomplete, the process exits with code `1` before it starts
listening and logs one line naming every problem — never the value that
caused it. On an empty database, a missing or invalid `ADMIN_USER`/
`ADMIN_PASSWORD` pair additionally prevents the admin account from being
created: the process logs `admin_missing` with guidance to set both and
exits with code `1`.

## Conversion (on-demand)

Setting `CONVERTER_CMD` lets an admin convert a not-playable movie, episode,
music track or audiobook file into a browser-safe copy, stored under
`CONVERT_DIR` — `MEDIA_ROOT` itself is never touched. Minimum converter
version: `bhemsen/converter` v3.2.0 (`--json`, `--to web`); v3.3.0 or newer is
needed for converted subtitles (see below). A few operational notes:

- **No spaces in `CONVERTER_CMD`.** Tokens are split on whitespace with no
  quoting. On Windows, point at a path without spaces, or use the 8.3 short
  name (e.g. `C:\PROGRA~1\nodejs\node.exe`); the same applies to any argument
  you add, such as `--sample-dir`.
- **On Windows, the first token must be an `.exe` with a drive letter or UNC
  prefix** (`X:\...`, `X:/...` or `\\server\...`) — since Node's `spawn`
  refuses `.bat`/`.cmd` shims without a shell (`EINVAL`), which would fail
  every job as `converter_unavailable`.
- **Keep copies fresh with `mv`/`rsync -t`, not `cp`.** A copy is considered
  fresh only while the source's size and modification time still match what
  was recorded when it was converted. Plain `cp` gives the source a new
  mtime and makes its copy stale (still on disk, just not served); `mv` or
  `rsync -t` preserve the timestamp.
- **Deleting the database orphans copies.** Removing the database file under
  `DATA_DIR` (see "Medienordner" above) forgets all conversion state; the
  copies already written under `CONVERT_DIR` are no longer served and can be
  deleted by hand.
- **CONVERT_DIR nur zusammen mit den Kopien verschieben.** Changing
  `CONVERT_DIR` without moving the existing copies along with it makes them
  unreachable (their database rows stay `playable`, but `/media/:id` then
  answers `404` until the item is converted again).
- **Run the service as a user with read-only access to `MEDIA_ROOT`.** This
  is the only enforcement that also covers the converter child process — the
  converter is trusted code: it runs as the same OS user as videothek and can
  read everything that user can.
- **Priority: nice 19, optional idle I/O class.** The converter runs at the
  lowest CPU priority (`nice` 19, set right after the start; on Windows the
  lowest priority class), so concurrent streams are protected on weak
  hardware. Whether this also lowers disk I/O depends on the kernel's I/O
  scheduler (`mq-deadline`, common for Pi USB disks, ignores it). For an idle
  I/O class prefix the command, e.g.
  `CONVERTER_CMD=/usr/bin/ionice -c3 /usr/bin/node /opt/converter/cli.js`
  (absolute path, no spaces in the tokens). If lowering the priority fails,
  the job still runs and `conversion_priority_failed` is logged.
- **`CONVERT_DIR` must not lie inside `public/`**, since static files there
  are served without a session; the config rejects this, and the conversion
  queue additionally rejects a symlink into `public/` by realpath.
- **Graceful shutdown only stops the converter through videothek's own
  shutdown handling.** On POSIX the converter runs detached in its own process
  group, and every signal videothek sends (stop, cancel, kill escalation)
  reaches the whole group, so no `ffmpeg` survives. If videothek itself
  crashes, a running converter keeps going until it finishes or the service
  is stopped: systemd's default `KillMode=control-group` ends it with the
  unit, and stopping a container ends every process in it. Under Docker, run
  with `--init` (or tini) when videothek is PID 1 — that is for reaping
  zombie processes only, not for the group.
- **Cancel.** In the admin "Konvertierung" panel, "Abbrechen" ends a queued
  conversion at once and stops a running one (the converter's process group
  gets `SIGTERM`, then `SIGKILL`); either way the item shows
  "Vom Admin abgebrochen" and can be converted again. There is no per-job
  timeout — cancel a hung job by hand.
- **Converted subtitles.** With converter v3.3.0 or newer, the WebVTT
  subtitle sidecars it reports are checked and stored with the copy (at most
  20, each up to 5 MiB) and listed after the subtitles found next to the
  source. With v3.2.0 the copy works, but embedded subtitles are lost.
- **Cleanup.** After every completed library scan (and never while a job
  runs) videothek tidies `CONVERT_DIR`, touching only its own 64-character
  hex directories there: copies whose source changed, leftovers of failed
  jobs, copies whose file disappeared and unreferenced directories are
  removed. When a source vanishes, its copy is kept for a fixed 30 days
  (no setting) and removed afterwards; if the source returns, nothing is
  lost. Without `CONVERTER_CMD` nothing is cleaned up.
- **Unmounted-disk guard.** If rows record copies but `CONVERT_DIR` holds no
  hex directory or not one referenced copy file (disk not mounted, or
  `CONVERT_DIR` moved without its copies), the cleanup skips reconciling
  missing copies and removing orphans and logs `conversion_cleanup_skipped`
  — so a moved `CONVERT_DIR` is never reconciled automatically; restore the
  copies or point `CONVERT_DIR` back.
- **Log events.** Warnings: `conversion_priority_failed { key, code }` (lowering
  the converter's priority failed; the job continues),
  `conversion_signal_failed { key, code }` (a signal to the converter's group
  failed, `code` = the first errno); `conversion_cleanup_skipped { reason }`
  (`convert_dir_empty` or `no_copy_found`). Info: `conversion_cleanup
  { purged, stripped, reconciled, orphans, missing, cleared }`, logged
  when a pass changed anything. Error: `conversion_cleanup_failed { code }`
  (an unexpected filesystem error aborted the rest of the pass).

## Medienordner

Lege deine Dateien innerhalb von `MEDIA_ROOT` in einem dieser Ordner ab
(Groß-/Kleinschreibung ist egal; mehrere Namen je Kategorie können gleichzeitig
verwendet werden):

| Kategorie | Ordnernamen |
| --- | --- |
| Filme | `Filme`, `Movies` |
| Serien | `Serien`, `Series`, `TV` |
| Musik | `Musik`, `Music` |
| Hörbücher | `Hörbücher`, `Hoerbuecher`, `Audiobooks` |
| Bilder | `Bilder`, `Pictures`, `Photos` |

Dateien direkt unter `MEDIA_ROOT` oder in anderen Ordnern werden ignoriert.
Versteckte Dateien/Ordner (Name beginnt mit `.`), bekannte NAS-/System-Ordner
(`@eaDir`, `#recycle`, `System Volume Information`, …) und Symlinks werden nie
eingelesen oder überwacht.

Empfohlene Benennung für eine zuverlässige Titel-/Jahr- bzw.
Serie-/Staffel-/Folge-Erkennung:

- **Filme:** `Titel (Jahr).ext`, z. B. `Inception (2010).mp4`, oder ein
  Unterordner `Titel (Jahr)/` mit der Videodatei darin.
- **Serien:** ein Ordner pro Serie, darin optional `Staffel N` (oder
  `Season N`), Dateien mit `SxxEyy` im Namen, z. B.
  `Serien/Dark/Staffel 1/Dark S01E01 - Geheimnisse.mp4`. Ein Ordner
  `Specials` wird als Staffel 0 geführt; Folgen ohne erkennbare
  Staffel/Nummer erscheinen unter „Weitere Folgen“.

Dateiformate, die der Browser nicht direkt abspielen kann (z. B. MKV, AVI,
HEVC-in-MP4), werden trotzdem angezeigt, aber als „Nicht abspielbar“
markiert.

Um eine Kategorie absichtlich zu leeren, genügt es nicht, ihren Ordner nur
leerzuräumen oder zu entfernen: ein Kategorie-Ordner, der plötzlich fehlt,
unlesbar oder leer ist, obwohl noch Einträge dafür indiziert sind, wird als
möglicher Einhängefehler behandelt — sein bisheriger Index bleibt absichtlich
erhalten, statt gelöscht zu werden. Um eine Kategorie wirklich zu leeren:
entweder eine einzelne Mediendatei darin stehen lassen, oder den Dienst
stoppen und die Datenbankdatei unter `DATA_DIR` löschen (siehe „Backup“) —
beim nächsten Start wird die gesamte Bibliothek neu eingelesen.

**Achtung:** Die Datenbankdatei enthält nicht nur den Bibliotheksindex,
sondern auch alle Konten, Sitzungen und den gesamten Wiedergabefortschritt
aller Nutzer — all das geht beim Löschen verloren. Beim nächsten Start
existiert kein Konto mehr: `ADMIN_USER`/`ADMIN_PASSWORD` müssen gesetzt sein,
damit das Admin-Konto neu angelegt wird (siehe „First start“), und alle
weiteren Konten muss der Admin neu erstellen. Vorher ein Backup anlegen; im
Zweifel ist „eine Datei stehen lassen“ der schonendere Weg.

## First start

1. `npm ci`
2. Copy `.env.example` to `.env`, point `MEDIA_ROOT` at your media directory,
   and set `ADMIN_USER` / `ADMIN_PASSWORD` — they are only used for this first
   start and create exactly one admin account.
3. Start the server:

   ```sh
   npm start
   ```

   This reads `.env` (via `--env-file-if-exists`) and serves the app on
   `HOST:PORT`.
4. Open `http://<host>:<port>/` in a browser and log in with the admin
   account you just created.

`GET /healthz` answers `200 {"status":"ok"}` without a session and is useful
as a liveness check for a supervisor or reverse proxy.

## Running as a service (systemd)

Example unit, e.g. `/etc/systemd/system/videothek.service` (adjust the user
and paths to your setup):

```ini
[Unit]
Description=Videothek media server
After=network.target

[Service]
Type=simple
User=videothek
WorkingDirectory=/opt/videothek
ExecStart=/usr/bin/node --env-file-if-exists=.env src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now videothek
```

A `SIGTERM` (sent by `systemctl stop`) shuts the process down gracefully: it
stops accepting new connections, lets in-flight requests (including open
media streams) finish for a few seconds, then exits.

## Reverse proxy

Videothek speaks plain HTTP only; put a reverse proxy in front for TLS. The
proxy **must** preserve the original host, either by forwarding `Host`
unchanged or by setting `X-Forwarded-Host` (which takes precedence) —
otherwise every state-changing request is rejected as cross-origin
(`403 forbidden_origin`, logged as `origin_rejected`). It should also set
`X-Forwarded-Proto` — otherwise the session cookie never gets marked
`Secure` (functionality is unaffected either way).

### Caddy

```
videothek.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy preserves `Host` and sets `X-Forwarded-Proto` by default, so no extra
configuration is needed.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name videothek.example.com;
    # ssl_certificate / ssl_certificate_key: see your certificate setup.

    location / {
        proxy_pass http://127.0.0.1:8080;
        # $http_host keeps the port too, so this also works on a non-default
        # port (e.g. `listen 8443`); $host alone would drop it.
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
    }
}
```

## Backup

Everything that cannot be rebuilt by rescanning `MEDIA_ROOT` — accounts,
sessions, playback progress — lives in the SQLite database under `DATA_DIR`.
To back it up:

1. Stop the service, so pending writes are checkpointed cleanly.
2. Copy `videothek.db*` (the database file plus its `-wal`/`-shm` sidecars, if
   present) from `DATA_DIR` to your backup location.
3. Start the service again.

To restore, stop the service, put the backed-up files back into `DATA_DIR`,
and start the service.

## Account recovery

A lost password — including the last admin's — is recoverable offline,
without starting the server:

```sh
npm run reset-password -- <username>
```

You are prompted for a new password twice (not echoed to the terminal); on
success it is set and every existing session of that user is ended, so any
device that was logged in has to sign in again with the new password. The
command exits non-zero with a message on stderr for an unknown username, a
password confirmation mismatch, or a password outside the 8–256 character
range.

## Bilder

Pictures and videos under a `Bilder`/`Pictures`/`Photos` folder in your
`MEDIA_ROOT` are browsable as a folder gallery at `/images`, with EXIF-based
thumbnails and a lightbox for viewing images and playing videos inline.

Displayable image formats: `jpg`/`jpeg`/`jfif`, `png`, `gif`, `webp`, `avif`,
`bmp`. Formats the browser cannot display — including `heic`/`heif`, `tif`/
`tiff`, `jxl` and `svg` — are listed with a "Nicht anzeigbar" badge instead of
a preview; videos follow the same direct-play compatibility rules as the
`Filme`/`Serien` categories, with non-playable ones marked "Nicht abspielbar".

**HEIC/HEIF photos (iPhone):** iOS stores photos as HEIC by default, which no
browser can display. Either take new photos with **Settings → Camera →
Formats → "Maximale Kompatibilität"** so the camera saves JPEG instead, or
export existing HEIC photos as JPEG (e.g. via the Fotos app's Share → "Foto
kopieren" after switching the camera setting, or a conversion tool) before
copying them into `MEDIA_ROOT`.

Videos placed inside picture folders (e.g. a phone's `VID_*.mp4`) play inline
in the lightbox next to the photos, using the same playability check as the
`Filme`/`Serien` categories.

## Development

- `npm run verify` — type check (`tsc --noEmit`) plus the test suite; run
  before every commit.
- `npm test` — test suite only.
- `npm ls --omit=dev --all` shows no packages: the project has no runtime
  dependencies.
