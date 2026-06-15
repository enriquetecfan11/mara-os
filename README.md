# Pocket Agent

Companion app for a talk about building a small personal agent on top of Telegram and the Pi Agent runtime.

The project is intentionally small. It is not a production-ready assistant; it is a readable reference implementation for understanding how a chat channel, an agent runtime, context files, memory, skills and simple approval rules fit together.

## What It Does

- Receives text messages from Telegram.
- Sends each turn to Pi Agent.
- Loads persistent agent context from the user's config directory.
- Supports local skills through `SKILL.md` files.
- Downloads Telegram images and passes their local path to the agent.
- Loads a simple `MEMORY.md` file on every turn.
- Requires an explicit `Confirmo` prefix before publishing to X.

## Requirements

- Node.js.
- pnpm.
- A Telegram bot token.
- Pi Agent configured locally.
- Optional X/Twitter API credentials if you want to use the bundled X publishing skill.

## Install

```bash
pnpm install
cp .env.example .env
```

Set your Telegram token in `.env`:

```bash
TELEGRAM_TOKEN=your_telegram_bot_token
```

If you want to publish to X, also provide:

```bash
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

## User Config Directory

The agent reads its durable configuration from:

```txt
~/.config/agente-bolsillo/
```

Create the directory before running the bot:

```bash
mkdir -p ~/.config/agente-bolsillo/skills
```

The repository includes reference files in `config/`. Copy them to your user config directory and adapt them:

```bash
cp -R config/* ~/.config/agente-bolsillo/
```

You also need to create a `SOUL.md` file:

```txt
~/.config/agente-bolsillo/SOUL.md
```

## Context Files

### `SOUL.md`

Defines the agent's personality and stable communication style.

Use it for things that should remain true across conversations:

- tone
- personality
- response style
- general behavioral preferences

### `USER.md`

Describes who the agent works for.

Use it for stable personal context:

- name
- relevant work
- preferences
- recurring personal details

Keep it short. This file is loaded as context, so it should contain useful facts rather than a biography.

### `AGENTS.md`

Defines how the agent should behave in this specific environment.

Use it for channel and runtime rules:

- Telegram formatting expectations
- when to save memories
- how to handle external actions
- what needs explicit confirmation

### `MEMORY.md`

Stores durable facts learned over time.

The bot reads this file on every turn and adds it to the prompt. The agent can update it when instructed by `AGENTS.md` and when the user asks it to remember something.

Keep memories brief and concrete.

## Skills

Skills live under:

```txt
~/.config/agente-bolsillo/skills/
```

Each skill is a folder with a `SKILL.md` file:

```txt
~/.config/agente-bolsillo/skills/
  my-skill/
    SKILL.md
    scripts/
```

The bot only exposes skills from that folder. This keeps the demo isolated from any other Pi or Codex skills installed on the machine.

## Bundled X Skill

The reference config includes an `x-publish` skill:

```txt
~/.config/agente-bolsillo/skills/x-publish/SKILL.md
```

It uses a small TypeScript script to publish text posts, and optionally images, through the X API.

To publish from Telegram, the message must start with:

```txt
Confirmo
```

Example:

```txt
Confirmo publica en X: Probando mi agente de bolsillo desde Telegram.
```

This is a deliberately simple approval guard. Full agent systems usually implement this kind of boundary with tool policies, sandboxing and runtime permission prompts.

## Images

If you send a photo to the Telegram bot, it downloads the image to:

```txt
~/.config/agente-bolsillo/uploads/
```

The agent receives the local path, so a skill can use the image later.

## Run

```bash
pnpm bot
```

If your X credentials are defined in your shell profile, make sure they are loaded before starting the bot:

```bash
source ~/.zshrc
pnpm bot
```

## Project Structure

```txt
src/
  bot.ts              Telegram + Pi Agent wiring
  approvals.ts        Minimal confirmation guard
  telegram-files.ts   Telegram image download helper

config/
  AGENTS.md           Reference channel/runtime rules
  USER.md             Reference user context
  MEMORY.md           Reference memory file
  skills/             Reference skills
```

## Notes

This project is designed to be read during a live explanation. The implementation favors clarity over completeness.

For a production assistant, you would probably add stronger permission handling, persistent session storage, better observability, secret management, tests and a real deployment story.
