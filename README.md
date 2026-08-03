# TippyBot Framework

TippyBot is a modular framework for building Minecraft bots on top of [mineflayer](https://github.com/PrismarineJS/mineflayer). Instead of one monolithic bot script, behavior is composed from small, self-contained modules — each registering its own chat commands and reusable actions.

For a deeper look at how it's put together, see the docs:

* [docs/architecture.md](docs/architecture.md) — core structure, how the bot boots, and how modules coordinate
* [docs/multi-instance.md](docs/multi-instance.md) — running several independent bots from one process
* [docs/modules.md](docs/modules.md) — built-in modules and how to write your own
* [docs/commands.md](docs/commands.md) — the full command reference: syntax, permission level, arguments, limits, examples
* [docs/permissions.md](docs/permissions.md) — permission levels, Admin config, and custom access groups
* [docs/tasks.md](docs/tasks.md) — the active-task model, `!status`/`!cancel`, and reconnect/disconnect handling
* [docs/configuration.md](docs/configuration.md) — the instance config file, auth modes, and chat signing
* [docs/testing.md](docs/testing.md) — running and writing tests
* [docs/web.md](docs/web.md) — the authenticated dashboard and real-time log viewer, configuration, storage, and security
* [docs/docker.md](docs/docker.md) — running TippyBot as a single Docker container, volumes, and updates

## Requirements

* Node.js 22+ (required by `mineflayer`/`minecraft-protocol`)
* A Minecraft server to connect to

## Install and run

```bash
npm install
cp bots.config.example.json bots.config.json
```

Edit `bots.config.json` with your server and account details (one or more bot instances — see [docs/configuration.md](docs/configuration.md)), then:

```bash
npm run dev
```

A successful connection logs:

```
[steve] [INFO] TippyBot joined the server
```

The authenticated web interface is enabled by default at
`http://<tippybot-host>:3000/`; its log viewer is available at `/logs`. If
`WEB_PASSWORD` is not already configured,
the first start generates one and saves it to `.env` without sending it
through the logging system. See [docs/web.md](docs/web.md) before exposing the
server outside a trusted local network.

To run it as a container instead (recommended for a home server), see
[docs/docker.md](docs/docker.md). All persistent data lives outside the
project directory, at a path you choose:

```bash
cp docker.env.example .env   # set TIPPYBOT_DATA_ROOT to an absolute path
mkdir -p "$TIPPYBOT_DATA_ROOT"/{config,data,auth_cache,logs}
cp bots.config.example.json "$TIPPYBOT_DATA_ROOT/config/bots.config.json"
docker compose up -d --build
```

## Basic usage

Once connected, interact with the bot via in-game chat:

```
!ping
!jump
!come
```

See [docs/commands.md](docs/commands.md) for the full command reference.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
