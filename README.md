# TippyBot Framework

TippyBot is a modular framework for building Minecraft bots on top of mineflayer. It is designed for developers who want a clean, extensible, and maintainable architecture.

## Principles

* Clear separation of concerns
* Type-safe module development (TypeScript)
* Reusable actions and commands
* Simple extensibility

## Purpose

* Not a single-purpose bot
* Features added as modules
* Complex behavior built from simple components
* Adaptable to different servers and playstyles

## High-Level Structure

* **core** – bot creation, lifecycle management, action and command registries
* **interfaces** – framework contracts for modules, actions, and commands
* **modules** – self-contained feature plugins
* **utils** – shared helper functions
* **config** – server and account configuration

## Included Modules

* `chat-basic` – basic test commands
* `navigation` – movement and navigation
* `sign-trapdoor` – sign and trapdoor interaction (`!s`)
* `seq` – action sequence execution

## Running the Bot

### Requirements

* Node.js 18+
* Compatible Minecraft server

### Installation and Startup

1. Install dependencies:
```bash
npm install
```

2. Configure your environment (see [Configuration](#configuration-env) below)

3. Start the bot:
```bash
npm run dev
```

### Configuration (.env)

This project uses environment variables for server/account settings.

1. Copy the example file:
   ```bash
   cp .env.example .env
   ```

   (On Windows PowerShell:)
   ```powershell
   copy .env.example .env
   ```

2. Edit `.env` and set your values (host, port, username, auth, etc.).

### Successful connection output

```
TippyBot joined the server
```

## In-Game Usage

Interact via chat commands, for example:

* `!jump`
* `!come`
* `!seq jump | wait 500 | jump`

## Signed Chat

Chat signing is disabled by default (`chatSigning: false`) to avoid issues in Minecraft 1.19+. Bot messages may appear as unverified.

## Extending the Framework

* Create a module under `src/modules`
* Implement `IModule`
* Register actions and commands in `init`

## License

MIT
