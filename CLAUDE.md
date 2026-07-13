# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**Mara OS** is a personal assistant bot that combines Telegram messaging, local LLM inference via Ollama, and MCP (Model Context Protocol) tool integration. The bot maintains persistent context through markdown config files, integrates with external services via MCP, and supports skills-based behavior detection.

### Key Architecture

The flow for each user message is:
1. **Telegram bot** (bot.ts) receives message → checks approvals
2. **Ollama integration** (ollama.ts) builds system prompt from context files + detected skills, sends to Ollama with tool schemas
3. **MCP layer** (mcp.ts) dispatches Ollama's `tool_calls` to appropriate MCP servers (calendar, notes, automations, etc.)
4. **Loop**: Tool results feed back into chat history; Ollama may call more tools before returning final text response
5. Response sent back to Telegram

## Commands

### Development
```bash
pnpm bot              # Run the bot locally with .env variables
pnpm typecheck        # Check TypeScript without building
pnpm reset-bot        # Clear chat memory (empties MEMORY.md)
pnpm reset-memory     # Restore MEMORY.md to git state
```

## Project Structure

### Core Modules (src/)

- **bot.ts**: Telegram bot handler. Commands: `/start`, `/help`, `/status`, `/reset`, `/skill`. Message handler orchestrates approval checks and calls to `askPi()`.
  
- **ollama.ts**: Ollama API integration. 
  - `askPi()`: Main function that constructs system prompt (from SYSTEM.md template with dynamic values), sends request with `tool_choice: "required"` and `temperature: 0.3` to ensure tool-calling, parses `tool_calls`, and dispatches via `callMcpTool()`. Maintains per-chat history up to 20 messages.
  - Loop continues if tool_calls present; exits when assistant response has no tool_calls.

- **mcp.ts**: MCP client initialization and tool dispatch.
  - `initMcpClients()`: Reads `mcp.json`, connects to each server (stdio or HTTP), collects all tools into `ollamaTools` array formatted for Ollama's API.
  - `callMcpTool()`: Looks up client from `toolToClientMap`, calls tool, extracts text from MCP response.
  - `hasMemoryServer`: Flag indicating if "engram" memory server is available; if not, falls back to file-based `update_memory` tool.

- **skills.ts**: Dynamic skill detection and context loading.
  - Each skill is a markdown file in `config/skills/` with frontmatter (`name`, `keywords`).
  - `detectSkills()`: Matches user message keywords against all skills; auto-detection is always active.
  - `loadSkillsContext()`: Returns matched skill markdown bodies appended to system prompt (text instruction only, does NOT filter tool schemas).

- **config.ts**: Environment variable bindings. Read from `.env` or fallback defaults. No secrets should be hardcoded.

- **approvals.ts**: Basic security approval flow. Checks if message contains keywords requiring user confirmation.

- **telegram-files.ts**: Helper to download Telegram photo/file attachments to `uploads/`.

### Configuration (config/)

- **SYSTEM.md**: System prompt template with placeholders `{{DATE_TIME}}`, `{{TIMEZONE}}`, `{{SOUL}}`, `{{USER}}`, `{{AGENTS}}`, `{{MEMORY}}`, `{{SKILLS}}`. Language enforcement and tool-calling instruction happen here.

- **SOUL.md**: Agent personality and communication style (immutable persona of Mara).

- **USER.md**: Stable user context (preferences, tech stack, location, etc.). Prepended to system prompt every request.

- **AGENTS.md**: Operational rules (e.g., formatting constraints for Telegram, memory management policies, security boundaries).

- **MEMORY.md**: Persistent memory file used as fallback when no MCP memory server is available. Lightweight durable facts.

- **skills/**: Directory of skill markdown files (e.g., `calendario.md`, `notas.md`, `automatizacion.md`, `memoria.md`). Each defines keywords and tool usage instructions for that domain.

### External Configuration

- **mcp.json**: Array of MCP server configs (name, type: "http" or "stdio", url or command, args, env).
  
- **.env**: Runtime variables — `TELEGRAM_TOKEN`, `OLLAMA_URL`, `OLLAMA_MODEL`, `TIMEZONE`. Model defaults to `ornith:9b` (9B parameter size, reliable tool-calling). Ignored by git.

## Ollama Integration Details

**Request format** (src/ollama.ts:84-97):
- `model`, `messages` (system + history), `stream: false`, `tools`, `tool_choice: "required"`, `temperature: 0.3`
- Tools passed as `{ type: "function", function: { name, description, parameters } }` — OpenAI-compatible schema

**Response parsing** (src/ollama.ts:102-182):
- Response includes `message.content` (text) and optional `message.tool_calls` array.
- If `tool_calls` present and length > 0, loop through each, call `callMcpTool()`, append result as `role: "tool"` message, continue loop.
- If no tool_calls, return `content` as final answer to Telegram.

**Key constraints**:
- History capped at 20 messages per chat ID (lines 44–45, 123–124)
- System prompt language enforcement: **"Responde SIEMPRE en español, NUNCA en inglés"** must stay at the top
- `temperature: 0.3` reduces non-determinism for small quantized models; `tool_choice: "required"` forces tool-calling when tools are available

## Common Tasks

### Adding a New Skill
1. Create `config/skills/newskill.md` with frontmatter and markdown body
2. Frontmatter: `name: newskill`, `keywords: [comma, separated, list]`
3. Body: Plain markdown with tool usage instructions (e.g., "cuando pida X, usa Tool_Y con parámetro Z")
4. No code change needed; auto-detection via keyword matching in user message

### Adding a New MCP Server
1. Add entry to `mcp.json` with `name`, `type`, and `url` (http) or `command`/`args` (stdio)
2. Restart bot; `initMcpClients()` will connect, list tools, and register them
3. Tools automatically available to Ollama for tool-calling; can be scoped via skills if desired

### Updating System Prompt / Context
- Edit `SYSTEM.md` (template) for structure or language enforcement
- Edit `SOUL.md`, `USER.md`, `AGENTS.md`, or `MEMORY.md` to change personality, user info, rules, or facts
- No bot restart needed; files are read fresh on each message

### Debugging Tool-Calling Issues
- Check logs for `[Ollama] Tools available: ...` to confirm tool schema is sent
- Check for `[Ollama] Received tool calls:` or `[Ollama] Final assistant message length:` to see if model called tools
- If model responds with text instead of tool_calls: model (Ollama choice) may be unreliable; `ornith:9b` is recommended
- Ensure `SYSTEM.md` starts with language enforcement line; ensure `temperature: 0.3` and `tool_choice: "required"` are set in request (line 95–96 of ollama.ts)

## Dependencies

- **grammy**: Telegram bot framework (v1.38+)
- **@modelcontextprotocol/sdk**: MCP client for connecting to external servers (v1.29+)
- **tsx**: TypeScript runner for Node.js (dev)
- **typescript**: Type checking (dev)

## Notes

- All persistent config is in `.md` files (human-readable, version-controlable)
- `.env` is gitignored; each developer has their own secrets
- No unit tests currently; code is straightforward enough for manual verification
- Spanish is the primary language; agent always responds in Spanish by system prompt enforcement
