# Configuration

TippyBot runs one or more bot instances from a single structured config file, `bots.config.json`, loaded by [src/config/instances.ts](../src/config/instances.ts).

```bash
cp bots.config.example.json bots.config.json
```

Then edit `bots.config.json` with your server and account details. See [multi-instance.md](multi-instance.md) for how multiple instances relate to each other and how their data stays isolated.

`.env` is no longer where bot instances are configured — see [.env.example](../.env.example). It is reserved for process-wide settings: the optional instance-config path override, Web authentication/listening options, login lockout policy, and log-storage thresholds.

## `bots.config.json`

```json
{
  "instances": [
    {
      "id": "steve",
      "host": "your.server.address",
      "port": 25565,
      "username": "SteveBot",
      "auth": "microsoft",
      "commandPrefix": "!",
      "admins": ["PlayerOne"],
      "autoConnect": true
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique identifier for this instance. 1-32 characters, letters/digits/`_`/`-` only. Namespaces this instance's `data/`, `auth_cache/`, `logs/`, and console label — see [multi-instance.md](multi-instance.md) |
| `host` | no | Server address to connect to. Absent (alongside `port`) makes this instance "unconfigured" — it exists and, for `microsoft` auth, can be signed in, but `connect()`/`autoConnect`/reconnect are all no-ops until a host is set. See [Unconfigured instances](multi-instance.md#microsoft-authentication) |
| `port` | no | Server port. Defaults to `25565` whenever `host` is given without one; stays absent alongside an absent `host` |
| `username` | depends | Account username. With `offline` auth this **is** the bot's in-game name and stays required. With `microsoft` auth the real identity comes from the Microsoft login, so this is only ever a technical placeholder — the `/bots` form doesn't ask for it at all, and it defaults to `id` when absent |
| `auth` | yes | `microsoft` or `offline` |
| `commandPrefix` | no | Chat command prefix, defaults to `!` |
| `admins` | no | Minecraft usernames granted permanent `Admin` access on this instance. See [Admins](#admins) below |
| `profilesFolder` | no | Where Microsoft auth tokens are cached, defaults to `./auth_cache/<id>` |
| `msaCacheKey` | no | Internal, stable identity used only as the local sign-in cache key for `microsoft` auth — never shown to the user, unrelated to the account's real Minecraft name. Defaults to the resolved `username`, so an instance saved before this field existed keeps its existing cached token. Meaningless for `offline` auth. See [Microsoft authentication](multi-instance.md#microsoft-authentication) |
| `autoConnect` | no | Whether this instance connects automatically at boot (or immediately after being added). **Defaults to `true` when the field is absent** — every `bots.config.json` written before this field existed keeps auto-connecting exactly as before. Set to `false` to keep an instance registered but disconnected until something explicitly connects it (see [multi-instance.md](multi-instance.md#botmanager-instance-lifecycle) and [web.md](web.md#bots-page-instance-management)). This file-level default is separate from the `/bots` **form's** default, which is unchecked for a newly *created* instance regardless of this field — see [web.md](web.md#bots-page-instance-management) |

The whole file is validated at startup — a missing/malformed field, an invalid `id`, or a duplicate `id` across instances fails fast with a specific error rather than starting with bad state. `BOTS_CONFIG_PATH` (in `.env`) can override the config file's location; it defaults to `./bots.config.json`.

The same validation rules apply whether an instance comes from this file at
boot or from the `/bots` page's Add/Edit forms at runtime — both go through
`validateInstance()` ([src/config/instances.ts](../src/config/instances.ts)).
Adding, editing, or removing an instance through `/bots` writes back to this
same file (atomically) instead of requiring a manual edit; see
[web.md](web.md#bots-page-instance-management) for what that page can and
cannot do.

## Auth modes

* **`microsoft`** — Signing in no longer requires a connection attempt: the `/bots` page's **Authenticate** button runs the device-code flow standalone, independent of `host`/`port` (see [multi-instance.md](multi-instance.md#microsoft-authentication) for the full flow and how it relates to `connect()`). Connecting a `microsoft` instance that has no cached token yet still triggers the same device-code flow inline (via mineflayer's own `onMsaCode` handler in [src/core/bot.ts](../src/core/bot.ts)), tagged with the instance's `id`. Either way, open the link, enter the code, and sign in with the Microsoft account that owns the Minecraft account. The resulting tokens are cached under `auth_cache/<id>/` (`profilesFolder` in the instance config, keyed internally by `msaCacheKey`) so you don't have to log in again on every restart or every time `host`/`port` changes.
* **`offline`** — For servers running in offline/cracked mode. No login flow, no Microsoft controls on `/bots` at all; `username` is used directly as the bot's identity.

### `auth_cache/`

This directory holds live Microsoft auth tokens once you've logged in, one subdirectory per instance `id`. It's already covered by `.gitignore` — never commit it, and treat its contents like credentials (anyone with those files can act as your Microsoft account's Minecraft session).

## Admins

Each instance's `admins` list is parsed by [src/config/admins.ts](../src/config/admins.ts): trimmed, lowercased, deduped, and validated as Minecraft usernames — an invalid entry fails the bot at startup rather than silently being dropped. This list is the sole source of truth for who has `Admin` access on that instance; it's loaded once into memory and is never written back to disk or mutable via chat. See [permissions.md](permissions.md) for the full permission model.

## Process-wide web and log settings

The bot connection fields above remain in `bots.config.json`. Settings shared
by the whole process (`WEB_*`, login lockout values, and `LOG_DISK_*`) live in
`.env`. See [web.md](web.md) for the complete table, one-time password behavior,
HTTP security guidance, and daily per-instance log storage.

## Chat signing (Minecraft 1.19+)

TippyBot does not implement Minecraft's 1.19+ signed-chat cryptography — this is a mineflayer limitation, not something configurable in this project. On servers that enforce secure chat, messages sent by the bot may show up as unverified/"Not Secure". If a server strictly requires signed chat, bot messages may be rejected outright; there's no setting here to change that behavior.
