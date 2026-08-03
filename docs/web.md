# Web dashboard, log viewer, and bot management

TippyBot includes a small, dependency-free web server with a dashboard for
all bot instances, a focused real-time log viewer, and a `/bots` page for
managing instances. It runs in the same Node.js process as `BotManager`,
serves a vanilla HTML/CSS/JavaScript interface, and uses Server-Sent Events
(SSE) for live updates on the pages that have them.

**Dashboard and the log viewer are strictly read-only** — neither can send a
command to a bot or change its state. **`/bots` is the one exception**: it can
add, edit, delete, connect, disconnect, and restart instances, and it is the
only page that can. Every one of those actions goes through `BotManager`'s
own coordinated methods (never a raw `IBotInstanceHandle`) — see
[multi-instance.md](multi-instance.md#botmanager-instance-lifecycle) — so
overlapping requests on the same or different instances are always
serialized correctly, and `bots.config.json` is never written unless the
in-memory result actually matches it.

## Starting the server

The web server is enabled by default and starts after `BotManager.startAll()`.
Open:

```text
http://<host-running-tippybot>:3000/
```

`/` is the multi-instance dashboard, `/logs` is the detailed log viewer, and
`/bots` manages instances (see [below](#bots-page-instance-management)). The
shared navigation switches between all three, and selecting a dashboard card
opens `/logs?instance=<id>` with that instance selected.

The default bind address is `0.0.0.0`, so another device on the same network
can connect using the host machine's LAN address. Set `WEB_HOST=127.0.0.1` if
the viewer should only be reachable from the same machine.

Set `WEB_ENABLED=false` to disable the server completely.

> The built-in server is HTTP, not HTTPS. Use it only on a trusted local
> network, or put it behind an HTTPS reverse proxy before exposing it beyond
> that network. A password and an HttpOnly session cookie protect access, but
> plain HTTP does not encrypt traffic in transit.

When every browser connection is made through HTTPS (typically at a reverse
proxy), set `WEB_SECURE_COOKIES=true`. This adds the `Secure` flag to session
cookies. Do not enable it for direct HTTP access because browsers will then
refuse to send the session cookie. TippyBot deliberately does not infer this
setting from `X-Forwarded-Proto`, which is unsafe unless proxy trust is
explicitly configured.

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
| `WEB_SECURE_COOKIES` | `false` | Add `Secure` to session cookies; enable only for HTTPS access. |
| `WEB_DASHBOARD_INTERVAL_MS` | `2000` | Interval between complete dashboard snapshot broadcasts. |
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

Without a valid session, the dashboard, log page, `/bots` page, every API, and
every SSE stream are unavailable. Only the login page and the static assets it
needs are public.

**The shared password is a single privilege tier.** There is no separate,
higher-privilege credential for `/bots` — the same session that can view logs
can also add, edit, delete, connect, disconnect, and restart every configured
instance. This is a deliberate scope increase from a read-only interface: a
leaked or guessed `WEB_PASSWORD` now grants full control over bot instances,
not just visibility into them. It does not introduce a new attack surface
beyond that scope increase (the same session cookie, `SameSite=Strict`,
timing-safe password check, and per-IP lockout protect all three pages
equally) — but it does mean `WEB_PASSWORD` should be treated with the same
care as any other credential that can act on your Minecraft accounts and
servers.

## Dashboard

The home page displays every instance returned by `BotManager.getInstances()`
at once. Each card is built from the instance's read-only `getSnapshot()` and
shows identity, connection status, uptime, ping, health, food, position,
dimension, active task, and the last error. Live-only fields display `—` while
the instance is not online. The summary reports online, reconnecting, and
errored instance counts.

The page first loads `GET /api/dashboard`, then receives a refreshed
`{ instances: BotInstanceSnapshot[] }` envelope over SSE every
`WEB_DASHBOARD_INTERVAL_MS`. Slow clients retain only the newest pending state
instead of accumulating obsolete snapshots.
Session validity is rechecked while the stream is open, and all timers are
released when the connection closes.

Before a snapshot leaves the server, `lastError.message` is passed through the
same central redaction utility used by log persistence. The returned object is
a detached copy; the handle's source snapshot is never mutated.

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

## `/bots` page: instance management

`/bots` lists every instance `BotManager` knows about and is the only page
that can change one. It loads `GET /api/bots` once and re-fetches the full
list after every action completes (success or failure) — there is no SSE
stream for this page yet; status changes made from *outside* `/bots` (a
crash, a manual restart from the API, another browser tab) only become
visible on the next load or manual retry. Adding SSE here later, matching the
Dashboard's pattern, is a natural follow-up if that gap matters in practice.

**List columns**: `id`, status (including `disconnected`, styled distinctly
from the other four statuses), `host:port`, `username`, `auth`, and
`autoConnect`. A truncated, already-redacted `lastError` is shown under the
`id` when present, with the full (still redacted) message in a tooltip. The
page has its own loading, empty, and load-error states (with a retry button),
independent of Dashboard/Logs.

**Add / Edit** open the same dialog, populated from the current row when
editing. All of `IBotConfig`'s fields are editable: `id`, `host`, `port`,
`username`, `auth`, `commandPrefix`, `admins` (comma-separated in the UI,
split and normalized by `normalizeAdminList` on the server exactly like
`bots.config.json`), `profilesFolder`, and `autoConnect`. **`id` cannot be
changed** — the field is disabled while editing, and the server rejects a
body whose `id` disagrees with the URL's `:id` with `400` before validation
even runs (see [routes/bots.ts](../src/web/routes/bots.ts)). Changing `auth`
between `microsoft` and `offline` shows a non-blocking inline warning: the
existing `auth_cache/<id>/` tokens are not deleted and may be orphaned or
need a fresh device-code login.

**Connect / Disconnect / Restart** buttons are enabled based on the row's
current status: Connect is disabled while already connecting/online/
reconnecting, Disconnect is disabled while already disconnected/errored, and
Restart is always enabled (it works from any status, including `errored`).
Every action button for a row is disabled for the duration of any request
already in flight for that instance — including a second click on the same
button — so a double-click can never send the same request twice or race two
different actions against each other.

**Delete** opens a confirm dialog naming the instance and stating plainly
that its `data/`, `logs/`, and `auth_cache/` directories are **not** deleted
— only its entry in `bots.config.json` is removed, after it's disconnected.
See [multi-instance.md](multi-instance.md#botmanager-instance-lifecycle) for
why that ordering (disconnect, then save, then forget) is safe under a
failure at any step.

**Errors** (`400` validation, `404` unknown id, `409` invalid for the current
state) are read from the JSON error body and shown without a page reload:
inline in the Add/Edit dialog (which stays open so the input can be
corrected) for form submissions, or as a toast for the quick actions
(connect/disconnect/restart/delete). No response ever includes anything
beyond `BotSummary`'s fixed field list — never an auth token, never
`auth_cache` file content; `auth` itself is only ever the mode string
`'microsoft' | 'offline'`, not a credential.

Every render on this page — table rows, error messages, dialog content —
uses `textContent`/`createElement`, the same as Dashboard and Logs; nothing
ever goes through `innerHTML` with server- or user-supplied data.

## HTTP API

All endpoints below except login require the session cookie:

| Endpoint | Purpose |
|---|---|
| `POST /api/login` | Authenticate and create a session. |
| `POST /api/logout` | Destroy the current session. |
| `GET /api/dashboard` | Return `{ instances: BotInstanceSnapshot[] }` with the current state. |
| `GET /api/dashboard/stream` | Stream refreshed `{ instances: [...] }` envelopes with SSE. |
| `GET /api/instances` | Return the instances known to `BotManager`. |
| `GET /api/logs/:id?limit=&before=` | Read a page of history; `before` is the opaque cursor returned by the previous page. |
| `GET /api/logs/:id/stream` | Stream new redacted records as SSE. |
| `GET /api/bots` | Return `{ instances: BotSummary[] }` — config fields plus current status for every instance. |
| `POST /api/bots` | Create a new instance. `201` with the created `BotSummary`, `400` on validation failure, `409` on a duplicate `id`. |
| `PUT /api/bots/:id` | Replace an instance's config. `200` with the updated `BotSummary`, `400` (including an `id` change), `404` if unknown. |
| `DELETE /api/bots/:id` | Disconnect (if active), remove from `bots.config.json`, and stop its `LogStore` — never deletes `data/`, `logs/`, or `auth_cache/`. `204`, or `404` if unknown. |
| `POST /api/bots/:id/connect` | `200` with the updated `BotSummary`, `404` if unknown, `409` if already connecting/online/reconnecting. |
| `POST /api/bots/:id/disconnect` | `200` with the updated `BotSummary`, `404` if unknown, `409` if already disconnected/errored. |
| `POST /api/bots/:id/restart` | Disconnects first only if active, then connects; works from any status. `200` with the updated `BotSummary`, `404` if unknown. |

Dashboard's and the log viewer's routes receive read-only snapshots and
`LogStore` access and never receive a Mineflayer `Bot` or `IBotContext`. The
`/bots` routes are the only ones that can change instance state, and they do
so exclusively through `BotManager`'s `addInstance`/`removeInstance`/
`updateInstance`/`connectInstance`/`disconnectInstance`/`restartInstance` —
never a raw handle, never mineflayer directly (see
[src/web/routes/bots.ts](../src/web/routes/bots.ts)).

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
5. Open `/`, verify multiple instance cards and summary counts across online,
   connecting, reconnecting, and errored states. Confirm offline live fields
   show `—`, active-task runtime is rendered, and errored cards emphasize the
   redacted last error.
6. Follow a dashboard card to `/logs?instance=<id>` and confirm the query
   parameter selects that instance ahead of any previous `sessionStorage`
   choice. Navigate between Dashboard and Logs in both directions.
7. Open the log page, switch between at least two configured instances, and
   produce live `connection`, `permissions`, and `modules` entries. Confirm the
   SSE view follows only the selected instance.
8. Exercise multi-level/category filtering, text search, row multi-selection,
   copy-selected, and copy-last-N. Repeat at a narrow/mobile viewport and, on a
   trusted LAN, from another device using the host's LAN address. Check RTL,
   light/dark color schemes, and reduced-motion mode on both pages.
9. Disconnect and reconnect the dashboard stream, then expire/logout its
   session. Confirm live updates resume cleanly and expiry returns to login.
10. Run the automated injected-clock rotation test, or keep a test instance
   across local midnight. Confirm the closed `.jsonl` becomes `.jsonl.gz`, the
   current day remains writable, and pagination crosses both formats.
11. Temporarily lower `LOG_DISK_WARN_MB` and
   `LOG_DISK_CHECK_INTERVAL_MS`, create enough test log data to cross the
   threshold, and confirm one `warn`/`storage` record appears without deleting
   history. Restore production values afterwards.
12. Configure at least two instances in `bots.config.json`, one with
   `autoConnect: true` and one with `autoConnect: false` (or omitted, to also
   cover the default). Start the process and confirm on `/bots` (and via
   `GET /api/bots`) that the `true` instance is connecting/online/reconnecting
   while the `false` instance stays `disconnected` and never attempts a
   connection on its own.
13. From `/bots`: add a new instance (with admins as a comma-separated list),
   confirm it appears immediately after the action completes and that
   `bots.config.json` gained it; edit an existing instance's `host`/`port` and
   confirm it reconnects to the new target only if it was already
   connected; attempt to edit its `id` and confirm the field is disabled and a
   same-`id` submission is required; change `auth` between `microsoft` and
   `offline` and confirm the non-blocking warning appears/disappears correctly.
14. Manually connect, disconnect, and restart an instance from `/bots` and
   confirm the status and button enabled/disabled state update correctly
   after each; double-click an action button and confirm only one request is
   sent (no duplicate connect/disconnect, no duplicate instance on Add).
15. Delete an instance from `/bots` via the confirm dialog and confirm: the
   dialog names the instance and states data/logs/auth_cache are not
   deleted; the instance disappears from the list and `bots.config.json`;
   its `data/<id>/`, `logs/<id>/`, and `auth_cache/<id>/` directories are
   still present on disk afterward.
16. Trigger each error class from `/bots` and confirm it displays without a
   page reload: `400` (e.g. an invalid port or a malformed admin username),
   `404` (act on an id that was just deleted in another tab), `409` (connect
   an already-connecting instance, or add a duplicate `id`).
17. Restart the whole process (or `docker compose restart` — see
   [docker.md](docker.md)) after making changes from `/bots`, and confirm
   every add/edit/delete survived the restart and each instance's
   `autoConnect` value is respected on the fresh boot.
18. Confirm Dashboard and Logs still expose no management action anywhere —
   only `/bots` does — and that the `Bots` nav link is present and correct on
   all three pages.

The automated equivalents run with `npx vitest run`; see [testing.md](testing.md).
