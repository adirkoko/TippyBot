# Configuration

TippyBot is configured entirely through environment variables, loaded from `.env` by [src/config/bot.config.ts](../src/config/bot.config.ts).

```bash
cp .env.example .env   # Windows PowerShell: copy .env.example .env
```

## Variables

| Variable | Required | Description |
|---|---|---|
| `BOT_HOST` | yes | Server address to connect to |
| `BOT_PORT` | yes | Server port |
| `BOT_USERNAME` | yes | Account username. With `microsoft` auth this can be anything (the real identity comes from the Microsoft login); with `offline` auth this **is** the bot's in-game name |
| `BOT_AUTH` | yes | `microsoft` or `offline` |
| `BOT_PREFIX` | no | Chat command prefix, defaults to `!` |

## Auth modes

* **`microsoft`** — On first connect, mineflayer prints a device-login code and URL (via the `onMsaCode` handler in [src/core/bot.ts](../src/core/bot.ts)). Open the link, enter the code, and sign in with the Microsoft account that owns the Minecraft account. The resulting tokens are cached under `auth_cache/` (`profilesFolder` in the bot config) so you don't have to log in again on every restart.
* **`offline`** — For servers running in offline/cracked mode. No login flow; `BOT_USERNAME` is used directly as the bot's identity.

### `auth_cache/`

This directory holds live Microsoft auth tokens once you've logged in. It's already covered by `.gitignore` — never commit it, and treat its contents like credentials (anyone with those files can act as your Microsoft account's Minecraft session).

## Chat signing (Minecraft 1.19+)

TippyBot does not implement Minecraft's 1.19+ signed-chat cryptography — this is a mineflayer limitation, not something configurable in this project. On servers that enforce secure chat, messages sent by the bot may show up as unverified/"Not Secure". If a server strictly requires signed chat, bot messages may be rejected outright; there's no setting here to change that behavior.
