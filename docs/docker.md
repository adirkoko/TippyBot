# Docker

TippyBot can run as a single Docker container: one process, all configured
bot instances (see [multi-instance.md](multi-instance.md)) plus the [web log
viewer](web.md), all inside it. This is the recommended way to run it on a
home server.

All persistent state lives **outside the project directory**, under a host
path you choose (`TIPPYBOT_DATA_ROOT`) -- rebuilding or replacing the project
checkout never touches it.

## Two different `.env` files -- do not confuse them

Docker involves two separate `.env`-named files with unrelated jobs:

| File | Read by | Contains |
|---|---|---|
| `.env` in the **project root** (next to `docker-compose.yml`), copied from `docker.env.example` | Docker Compose itself, for `${VARS}` substitution in `docker-compose.yml` | `TIPPYBOT_DATA_ROOT`, optionally `PUID`/`PGID` |
| `.env` in **`$TIPPYBOT_DATA_ROOT/config/`** | The TippyBot application, via `dotenv/config` | `WEB_PASSWORD`, `WEB_HOST`, and everything else in [.env.example](../.env.example) |

The project-root one only ever holds the handful of variables below. Nothing
application-specific belongs there, and nothing in the second file is read by
Compose.

## First run

```bash
cp docker.env.example .env
```

Edit `.env` and set `TIPPYBOT_DATA_ROOT` to an absolute path outside the
project directory, e.g. `/srv/tippybot`.

```bash
mkdir -p "$TIPPYBOT_DATA_ROOT"/{config,data,auth_cache,logs}
cp bots.config.example.json "$TIPPYBOT_DATA_ROOT/config/bots.config.json"
```

Creating these directories yourself first matters: if you skip this and let
Docker auto-create them as bind-mount targets, they end up owned by `root`,
and the container (running as an unprivileged UID -- see below) won't be able
to write to them. Creating them as your own user avoids that entirely when
`PUID`/`PGID` match your account (the default, 1000:1000, is that account on
most single-user Linux installs).

Edit `$TIPPYBOT_DATA_ROOT/config/bots.config.json` with your server/account
details (see [configuration.md](configuration.md)). A
`$TIPPYBOT_DATA_ROOT/config/.env` is optional -- `WEB_PASSWORD` generates
itself on first start if you don't provide one (see
[web.md](web.md#password-setup)).

```bash
docker compose up -d --build
```

Open `http://<host-running-tippybot>:3000/`. If `.env` didn't exist yet, check
`docker compose logs` for the one-time password-creation notice, then read the
generated value from `$TIPPYBOT_DATA_ROOT/config/.env`.

## Updating

```bash
git pull
docker compose up -d --build
```

Rebuilding and recreating the container is safe: everything that needs to
survive a restart lives under `$TIPPYBOT_DATA_ROOT`, entirely outside the
project checkout and the container's own writable layer.

## Volumes

`docker-compose.yml` requires `TIPPYBOT_DATA_ROOT` (the `up`/`build` commands
fail with a clear error if it's unset) and mounts whole directories under it,
not individual files:

| Host | Container | Contains |
|---|---|---|
| `$TIPPYBOT_DATA_ROOT/config` | `/app/config` | `.env`, `bots.config.json` |
| `$TIPPYBOT_DATA_ROOT/data` | `/app/data` | Per-instance permissions/homes |
| `$TIPPYBOT_DATA_ROOT/auth_cache` | `/app/auth_cache` | Microsoft auth tokens |
| `$TIPPYBOT_DATA_ROOT/logs` | `/app/logs` | Per-instance log storage (see [web.md](web.md#storage-rotation-and-pagination)) |

**`auth_cache` in particular must persist.** Losing it means every
`microsoft`-auth instance has to redo the device-code login on next start.

### Why `config` is one mounted directory, not two mounted files

`.env`'s auto-generated-password write ([envFile.ts](../src/config/envFile.ts))
writes a temp file and renames it onto `.env` -- an atomic rename that
requires both files to be on the same filesystem. Bind-mounting `.env` on its
own (`-v $TIPPYBOT_DATA_ROOT/config/.env:/app/.env`) puts it on a different
mount than the temp file, which Docker/Linux treats as a cross-device rename
and fails outright. Mounting `config` as one directory keeps the temp file and
`.env` on the same mount, so the rename always succeeds. `bots.config.json`
lives alongside it in the same directory purely for convenience -- it's
read-only to the app.

The container points at both files inside that mount via two environment
variables baked into the image:

```text
BOTS_CONFIG_PATH=/app/config/bots.config.json
DOTENV_CONFIG_PATH=/app/config/.env
```

`BOTS_CONFIG_PATH` was already a supported override (see
[configuration.md](configuration.md)). `DOTENV_CONFIG_PATH` is read by both
dotenv's own preload (`import 'dotenv/config'` in
[src/index.ts](../src/index.ts)) and by `ensureWebPassword()`'s default path,
so there's a single source of truth for where the application's `.env` lives
inside the container -- outside Docker, where this variable is unset, both
fall back to `.env` in the working directory exactly as before.

## Permissions (`PUID`/`PGID`)

The container runs as `${PUID:-1000}:${PGID:-1000}` (set in
`docker-compose.yml`), not as whatever user the image bakes in -- so every
file it writes under `$TIPPYBOT_DATA_ROOT` is owned by a UID/GID you control
on the host, not an arbitrary one from inside the image.

* If you created `$TIPPYBOT_DATA_ROOT` as your own regular user and left
  `PUID`/`PGID` at the default, this works with no extra steps on most
  single-user Linux installs (first regular user is UID/GID 1000).
* If it doesn't -- e.g. a NAS account, or a shared server -- set `PUID`/`PGID`
  in the project-root `.env` to match `id -u` / `id -g` for the account that
  should own these files, or `chown -R <uid>:<gid> "$TIPPYBOT_DATA_ROOT"`
  once to match whatever `PUID`/`PGID` you chose.
* On Docker Desktop (Windows/Mac), the bind-mount layer maps permissions for
  you and `PUID`/`PGID` rarely matters -- this mainly matters on a native
  Linux Docker host, which is the common case for a home server.

## Networking

The image's default `WEB_HOST=0.0.0.0` must stay as-is inside Docker --
`127.0.0.1` inside a container is not reachable through a published port at
all. Docker's own port mapping (`ports: ["3000:3000"]` in
`docker-compose.yml`) is what controls whether the viewer is reachable from
other devices on your network; see [web.md](web.md) for the security
implications of that before exposing it beyond a trusted LAN.

## Health check

The image's `HEALTHCHECK` only confirms the web server's TCP port accepts a
connection -- no HTTP request, no authentication, and no change to the
application. It assumes `WEB_ENABLED=true` (the default). If you disable the
web UI, remove or replace the `HEALTHCHECK` line in the `Dockerfile`, since
nothing will be listening on that port anymore.

## Image

Multi-stage build (`Dockerfile`): a `builder` stage installs dependencies and
runs `npm run build`, then the `runtime` stage installs only production
dependencies and copies `dist/` plus the web UI's static assets
(`src/web/public`, which `tsc` doesn't copy on its own). The image bakes in a
non-root `tippybot` user as a default, but the effective runtime identity is
whatever `docker-compose.yml`'s `user:` (`PUID`/`PGID`) resolves to -- see
above. Based on `node:22-alpine` (mineflayer and minecraft-protocol both
require Node 22+); TippyBot has no native/`node-gyp` dependencies, so Alpine's
musl libc builds cleanly.

There is no CI and no image registry involved -- building happens locally via
`docker compose build`, consistent with how the rest of this project avoids
CI/GitHub Actions.

## Live smoke checklist

1. `mkdir -p "$TIPPYBOT_DATA_ROOT"/{config,data,auth_cache,logs}` as your own
   user, then `docker compose up -d --build` with no
   `$TIPPYBOT_DATA_ROOT/config/.env` present. Confirm the password-creation
   notice in `docker compose logs`, no permission errors, and that
   `$TIPPYBOT_DATA_ROOT/config/.env` now contains exactly one new
   `WEB_PASSWORD=...` line, owned by the expected `PUID`/`PGID`.
2. `docker compose down` then `docker compose up -d` again. Confirm no new
   password is generated and the same value still works to log in.
3. Add a second instance to `bots.config.json`, restart, and confirm `data`,
   `auth_cache`, and `logs` under `$TIPPYBOT_DATA_ROOT` each gained a
   subdirectory per instance `id` on the host.
4. Run `docker compose up -d --build` again (simulating an update) and confirm
   all four directories are untouched -- rebuilding the image never resets
   persistent state.
5. From another device on the same network, open
   `http://<host-lan-address>:3000/` and confirm the log viewer loads and the
   SSE stream connects.
6. `docker inspect --format='{{.State.Health.Status}}' <container>` reports
   `healthy` once the web server is up.
7. Unset `TIPPYBOT_DATA_ROOT` and confirm `docker compose up` fails immediately
   with a clear error instead of silently mounting an unexpected host path.
