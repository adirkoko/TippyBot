# Web log viewer

TippyBot includes a small, dependency-free web server for viewing every bot
instance's logs. It runs in the same Node.js process as `BotManager`, serves a
vanilla HTML/CSS/JavaScript interface, and streams new entries with
Server-Sent Events (SSE). This first web phase is read-only: it cannot send
commands to a bot or change bot state.

## Starting the server

The web server is enabled by default and starts after `BotManager.startAll()`.
Open:

```text
http://<host-running-tippybot>:3000/
```

The default bind address is `0.0.0.0`, so another device on the same network
can connect using the host machine's LAN address. Set `WEB_HOST=127.0.0.1` if
the viewer should only be reachable from the same machine.

Set `WEB_ENABLED=false` to disable the server completely.

> The built-in server is HTTP, not HTTPS. Use it only on a trusted local
> network, or put it behind an HTTPS reverse proxy before exposing it beyond
> that network. A password and an HttpOnly session cookie protect access, but
> plain HTTP does not encrypt traffic in transit.

## Password setup

Set `WEB_PASSWORD` in the process environment or `.env` to use a password you
choose. If it is absent at startup, TippyBot generates 24 cryptographically
random bytes, encodes them as base64url (normally 32 characters), and appends
one `WEB_PASSWORD=...` line to `.env` using an atomic file replacement.

Existing `.env` content is preserved. The key is never duplicated or
overwritten, and subsequent starts reuse the saved value.

The generated password itself is not printed. Startup writes only a generic
notification directly to stdout. Neither the password nor that notification
is passed to `ILogger` or `LogStore`. Redaction is also applied centrally by
`LogStore` before an entry is written, retained for live subscribers, or sent
to the web UI.

To retrieve an automatically generated password, open the local `.env` file
directly. Do not paste it into chat, issue reports, or logs.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `WEB_ENABLED` | `true` | Set to `false` to disable the web server. |
| `WEB_HOST` | `0.0.0.0` | Address on which the HTTP server listens. |
| `WEB_PORT` | `3000` | HTTP port, from 1 through 65535. |
| `WEB_PASSWORD` | generated | Shared login password; generated once when missing. |
| `WEB_LOGIN_MAX_ATTEMPTS` | `5` | Failed attempts allowed per IP before a temporary lockout. |
| `WEB_LOGIN_LOCKOUT_MS` | `900000` | Lockout duration per IP (15 minutes by default). |
| `LOG_DISK_WARN_MB` | `500` | Per-instance log-directory warning threshold. |
| `LOG_DISK_CHECK_INTERVAL_MS` | `3600000` | Per-instance disk-usage check interval (one hour by default). |

Invalid values fail startup with a specific configuration error rather than
being silently accepted.

## Authentication

`POST /api/login` verifies the shared password with a timing-safe comparison.
Successful login creates a random in-memory session and sends it in an
`HttpOnly`, `SameSite=Strict` cookie. Sessions disappear when the process
restarts. `POST /api/logout` destroys the current session.

Failed logins are tracked by the request's socket IP. Once the configured
limit is reached, that IP is temporarily blocked for the configured lockout
period. TippyBot does not trust `X-Forwarded-For` by default; a reverse proxy
should enforce its own rate limits as well.

Without a valid session, the log page, instance API, history API, and SSE
stream are unavailable. Only the login page and the static assets it needs
are public.

## Log records and categories

Every stored and streamed record includes an ISO timestamp, instance ID,
message, optional metadata, and two independent fields:

* `level`: `info`, `warn`, `error`, or `debug`.
* `category`: `connection`, `permissions`, `modules`, or `storage`.

`connection` covers Mineflayer lifecycle events, `permissions` contains
permission audit records, `modules` contains module/command/task logging, and
`storage` contains log rotation, compression, and disk-threshold notices.

The UI can filter by multiple levels and categories, search text, select and
copy records, or copy the most recent N visible records. Switching the
instance selector closes the old SSE stream and loads the selected instance's
history and live stream.

## Storage, rotation, and pagination

Each instance owns a separate `LogStore` and directory:

```text
logs/<instance-id>/YYYY-MM-DD.jsonl
```

Entries are redacted before the JSON line is written. Opening a new day's
file causes closed daily JSONL files to be compressed with Node's built-in
gzip support:

```text
logs/<instance-id>/YYYY-MM-DD.jsonl.gz
```

History reads and pagination work across both current JSONL and compressed
files. Rotation and compression never delete history.

At the configured interval, each store measures its complete instance
directory. Crossing `LOG_DISK_WARN_MB` creates a `warn` record in the
`storage` category, visible in the same log page. This is an alert only; no
automatic deletion occurs.

## HTTP API

All endpoints below except login require the session cookie:

| Endpoint | Purpose |
|---|---|
| `POST /api/login` | Authenticate and create a session. |
| `POST /api/logout` | Destroy the current session. |
| `GET /api/instances` | Return the instances known to `BotManager`. |
| `GET /api/logs/:id?limit=&before=` | Read a page of history; `before` is the opaque cursor returned by the previous page. |
| `GET /api/logs/:id/stream` | Stream new redacted records as SSE. |

The web layer receives read-only snapshots and `LogStore` access. It never
receives a Mineflayer `Bot` or `IBotContext` and exposes no bot-control route.

## Live smoke checklist

Use a disposable copy of `.env` for first-start checks so an existing chosen
password is not removed accidentally.

1. Start without `WEB_PASSWORD`. Confirm stdout shows only the generic creation
   notice, `.env` gained exactly one assignment, and the value is 32 base64url
   characters.
2. Start again with the same `.env`; confirm neither the file nor password
   changes and no creation notice is printed.
3. Confirm the generated value does not occur in any `.jsonl` or `.jsonl.gz`
   content. Generate a controlled log containing forms such as
   `WEB_PASSWORD=...`, `Authorization: Bearer ...`, and `Code: ABCD-EFGH`, then
   confirm only `[REDACTED]` reaches history and SSE.
4. Verify a failed login, a successful login, logout/revocation, and temporary
   IP lockout after `WEB_LOGIN_MAX_ATTEMPTS` failures.
5. Open the log page, switch between at least two configured instances, and
   produce live `connection`, `permissions`, and `modules` entries. Confirm the
   SSE view follows only the selected instance.
6. Exercise multi-level/category filtering, text search, row multi-selection,
   copy-selected, and copy-last-N. Repeat at a narrow/mobile viewport and, on a
   trusted LAN, from another device using the host's LAN address.
7. Run the automated injected-clock rotation test, or keep a test instance
   across local midnight. Confirm the closed `.jsonl` becomes `.jsonl.gz`, the
   current day remains writable, and pagination crosses both formats.
8. Temporarily lower `LOG_DISK_WARN_MB` and
   `LOG_DISK_CHECK_INTERVAL_MS`, create enough test log data to cross the
   threshold, and confirm one `warn`/`storage` record appears without deleting
   history. Restore production values afterwards.

The automated equivalents run with `npx vitest run`; see [testing.md](testing.md).
