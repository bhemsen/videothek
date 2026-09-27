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

An empty value is treated the same as an unset variable. If the configuration
is invalid or incomplete, the process exits with code `1` before it starts
listening and logs one line naming every problem — never the value that
caused it. On an empty database, a missing or invalid `ADMIN_USER`/
`ADMIN_PASSWORD` pair additionally prevents the admin account from being
created: the process logs `admin_missing` with guidance to set both and
exits with code `1`.

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
