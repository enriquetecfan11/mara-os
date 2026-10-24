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
pnpm test             # Memory tests (Node test runner + fake Hindsight server)
pnpm check:hindsight  # Read-only Hindsight health/bank/recall check
pnpm reset-bot        # Clear chat memory (empties MEMORY.md)
pnpm reset-memory     # Restore MEMORY.md to git state
```

## Project Structure

### Core Modules (src/)

- **logger.ts**: Structured logging with colors, timestamps, and log levels.
  - `log()`, `info()`, `debug()`, `warn()`, `error()`: Main logging functions
  - Color-coded output: cyan (info), gray (debug), yellow (warn), red (error)
  - Timestamps in HH:MM:SS format; output: `[14:32:55] [INFO] [Module] message`
  - Log level filtering via `LOG_LEVEL` env var (default: "info"). Set `LOG_LEVEL=debug` to see all logs

- **cache.ts**: Mtime-based file caching for context files (SOUL, USER, AGENTS, SYSTEM).
  - `readContextFile()`: Reads file from disk once, caches in memory. On subsequent reads, checks mtime; if unchanged, returns cached content. Automatically invalidates when file changes.
  - Reduces per-request latency: 40-60ms (5 file reads) → 1ms (cache hits)

- **bot.ts**: Telegram bot handler. Commands: `/start`, `/help`, `/status`, `/modelo`, `/tools`, `/reset`, `/skill`. `/start` and `/help` render the shared long welcome message built in `welcome.ts` (live system status + states + command catalogue). `/modelo [proveedor]` lists the inference providers or switches the active one at runtime (pings the candidate first). Message handler orchestrates approval checks and calls to `askPi()`.

- **tool-groups.ts**: tool groups toggled with `/tools`. Groups come from `config/tool-groups.json` (name → tool list, re-read on every call); an MCP tool in no group falls into a group named after its server. `getActiveTools()` is what `askPi()` sends to the LLM and always includes the memory tools from `memory-tools.ts` (`guardar_recuerdo`, `buscar_recuerdos`): memory cannot be disabled. Groups start **disabled**; enabled ones persist to `data/tool-groups.json` (`TOOL_GROUPS_STATE_FILE`, `enabled` list).

- **providers.ts**: runtime inference provider state. `getActiveLlm()` (stored choice → `LLM_PROVIDER` → derived from `OLLAMA_API`), `setActiveProvider()` (validates config, resolves and persists to `data/llm-provider.json`), `listProviderStatus()` (for `/modelo`).
  - **Graceful shutdown**: Listens for SIGINT (Ctrl+C) and SIGTERM signals. Closes MCP clients cleanly (prevents unhandled errors from child processes), then stops bot without errors.
  - **Voice/audio input**: `message:voice` and `message:audio` handlers download the file to a temp path, transcribe it (`handleIncomingAudio()`), feed the transcript through the normal agent flow (same as a typed message, including approval checks), then delete the temp file. On transcription failure it replies with a short error and does not crash.
  - **Reply modality (`deliverReply()`)**: the text reply is **always** sent first (immediate); a voice reply is added on top when `wantVoiceFor()` says so — by default only for voice/audio input (`/voz on|off` per-chat override wins, else `TELEGRAM_SEND_VOICE=true` forces global voice-on, else mirror the input). Voice output goes through Voicebox TTS and is transcoded WAV→OGG/Opus (`src/audio.ts:wavToOggOpus`, ffmpeg) so it arrives as a real Telegram **voice note** (`replyWithVoice`); falls back to `replyWithAudio` WAV if ffmpeg/opus is unavailable, and is skipped for replies >500 chars. `trySendVoice()` shows a `record_voice` chat action while generating.

- **stt.ts**: Local speech-to-text via Whisper on transformers.js/ONNX (`@xenova/transformers`) — no native build step.
  - `transcribeLocal(filePath)`: converts non-WAV audio to 16 kHz mono PCM WAV (ffmpeg, in memory via `transcodeToWavPcm()`) and runs Whisper. Model auto-downloads/caches on first use. Language forced to `STT_LANGUAGE` (default `es`). Returns plain text; throws on empty output. Bounded by `STT_TIMEOUT_MS` (default 60 s) so a stalled inference can't block the chat queue.
  - Used by `bot.ts` when `STT_LOCAL_ENABLED` (default true); otherwise falls back to Voicebox `transcribeAudio()`.
  - System deps: `ffmpeg` only (for audio conversion). See `docs/STT_LOCAL.md`.

- **voicebox.ts**: Voicebox REST client. `generateVoice()` (TTS output), `transcribeAudio()` (remote STT fallback), `checkVoicebox()` (startup health check). See `docs/VOICEBOX_INTEGRATION.md`.
  
- **ollama.ts**: Ollama API integration. 
  - `askPi()`: Main function that constructs system prompt (from SYSTEM.md template with dynamic values), sends request with `tool_choice: "required"`, `temperature: 0.3`, and 30-second timeout to ensure tool-calling and fail-fast behavior. Parses `tool_calls` and dispatches via `callMcpTool()`. Maintains per-chat history up to 20 messages.
  - Loop continues if tool_calls present; exits when assistant response has no tool_calls.
  - **Timeout**: 30 seconds (AbortSignal.timeout) prevents hang if Ollama becomes unresponsive.
  - **Parallel tool execution**: Multiple tool_calls are executed concurrently with Promise.all(), reducing latency by ~3x when multiple tools are called.
  - `askPiWithRetry()`: Wrapper around `askPi()` with exponential backoff retry logic (1s, 2s, 4s). Improves resilience to temporary Ollama failures.
  - **Chat session cleanup**: Inactive chat sessions are auto-removed after 30 minutes to prevent memory leaks. Cleanup runs every 5 minutes.

- **mcp.ts**: MCP client initialization and tool dispatch.
  - `initMcpClients()`: Reads `mcp.json`, connects to **all servers in parallel** (Promise.allSettled) with a **15s timeout per server** (Promise.race + AbortSignal.timeout). Bot starts even if servers are unreachable. HTTP transports get `AbortSignal.timeout` on requestInit.
  - `callMcpTool()`: Looks up client from `toolToClientMap`, calls tool, extracts text from MCP response.
  - `closeMcpClients()`: Gracefully disconnects all MCP servers (used on SIGINT/SIGTERM). Prevents unhandled errors from child processes.
  - `hasMemoryServer`: Flag indicating whether one of the MCP servers declared in `MCP_MEMORY_SERVERS` connected. Empty by default. With Hindsight enabled, an MCP memory server is only a manual tool, never the `MemoryManager` backend.

- **obsidian.ts** + `scripts/import-obsidian.ts` (`pnpm import:obsidian <vault>`): imports an Obsidian vault into a separate Hindsight bank (`HINDSIGHT_NOTES_BANK_ID`, default `obsidian`), one document per note (`obsidian:<path>`, re-import replaces), skipping unchanged notes via `data/obsidian-import.json`. Mara queries it with the always-on `buscar_en_notas` tool (`memory-tools.ts`).

- **memory/**: Long-term memory subsystem.
  - `memory-manager.ts`: Single public API (`remember`, `rememberMany`, `search`, `forget`, `list`, `get`) and backend selection: `custom` factory > `hindsight` (when `HINDSIGHT_ENABLED=true`) > `sqlite`.
  - `conversation-store.ts`: SQLite conversation history (short term). Unaffected by Hindsight.
  - `memory-extractor.ts`: Background LLM extraction after each reply. Filters by `MEMORY_MIN_IMPORTANCE`, debounces per chat (`MEMORY_EXTRACTION_MIN_INTERVAL_MS`), batches into one `retain`.
  - `context-builder.ts`: Builds the system prompt and injects top-5 memories into `{{MEMORY}}`.
  - `stores/sqlite.ts`: FTS5 backend, dedupe, soft-forget tombstones.
  - `stores/hindsight.ts`: REST adapter (retain/recall/list/get/PATCH invalidate) with timeouts, optional Bearer auth and a 30s circuit breaker. Never calls the bank-wide DELETE.
  - `stores/resilient.ts`: Composes Hindsight + SQLite + outbox. Writes locally first, retains with stable `document_id = mara-<localId>`, retries failures.
  - `sync-queue.ts`: Persistent `memory_sync` outbox with exponential backoff and permanent-failure handling.

- **events.ts**: WebSocket "brain" server for Mara UI (protocolo de eventos v1).
  - `startUiEvents()`: Listens on `MARA_BRAIN_WS_URL` (empty = disabled). Non-blocking; accepts new connections anytime.
  - `emit(type, data)`: Broadcasts v1 envelope `{ type, version, timestamp, data }` to all connected clients.
  - `setState(state)`: Dedup `mara:state` transitions (`idle`/`listening`/`thinking`/`speaking`/`seeing`/`error`/`offline`).
  - `emitMessage(text)`: `mara:message` with response text.
  - `emitSpeakingStarted()` / `emitSpeakingFinished()`: `voice.speaking.started` / `voice.speaking.finished` around TTS generation (emitted by `generateVoice`); decoupled from Telegram.
  - `emitVoiceAudio(text, wav)`: `voice.audio` with WAV in base64 so the UI can play Mara's reply back (browser-mic flow).
  - `emitConfirm(request)`: `mara:confirm` for approval flow.
  - Re-sync: sends current state, last message, and network status to each newly connected client.

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

- **MEMORY.md**: Legacy static memory file. Dynamic memories live in Hindsight (mirrored in SQLite) and are injected into `{{MEMORY}}` via `MemoryManager.search()`. Not auto-migrated while Hindsight is enabled.

- **skills/**: Directory of skill markdown files (e.g., `calendario.md`, `notas.md`, `automatizacion.md`, `memoria.md`). Each defines keywords and tool usage instructions for that domain.

### External Configuration

- **mcp.json**: Array of MCP server configs (name, type: "http" or "stdio", url or command, args, env).
  
- **.env**: Runtime variables — `TELEGRAM_TOKEN`, `OLLAMA_API`, `OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_API_KEY`, `TIMEZONE`, voice output (`VOICEBOX_URL`, `VOICEBOX_ENABLED`, `VOICEBOX_PROFILE`, `TELEGRAM_SEND_VOICE`), and voice input / STT (`STT_LOCAL_ENABLED`, `STT_MODEL`, `STT_LANGUAGE`, `STT_TIMEOUT_MS`), plus the startup welcome flag (`STARTUP_WELCOME`). Model defaults to `ornith-1.5:9b` (9B parameter size, reliable tool-calling). Full table in `docs/configuration/environment.md`. Ignored by git.

## Inference Server Integration Details

**Providers** (`src/config.ts` + `src/providers.ts`). `LLM_PROVIDER` is only the *initial* provider; the active one is runtime state changed by `/modelo` and persisted to `data/llm-provider.json` (`LLM_STATE_FILE`). `resolveLlmProvider(name)` returns the `ActiveLlm` (`url` / `model` / `apiKey` / `dialect` / `maxTokens`), and every `ollama-http.ts` helper takes an optional `ActiveLlm` — default `getActiveLlm()`:
- `unsloth` — Unsloth Studio on the LAN, from `OLLAMA_URL` / `OLLAMA_MODEL` / `OLLAMA_API_KEY`.
- `groq` — Groq Cloud, from `GROQ_API_URL` (default `https://api.groq.com/openai`) / `GROQ_MODEL` / `GROQ_API_KEY`.
- `ollama` — native Ollama on the LAN, same `OLLAMA_*` vars.
- `openai` — any other OpenAI-compatible server; requires `LLM_API_URL`.
- Unset: derived from `OLLAMA_API` (`openai` → `unsloth`, else `ollama`), i.e. the pre-provider behaviour.
- `LLM_API_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_MAX_TOKENS` override whatever the provider resolved. Never read `OLLAMA_*` outside `src/config.ts`.

**Two dialects, one client** (`src/ollama-http.ts`). `isOpenAiApi(llm)` / `llm.dialect` picks it:
- `ollama`: `POST {url}/api/chat`, health `GET /api/tags`.
- `openai`: `POST {url}/v1/chat/completions`, health `GET /v1/models`. This covers Groq, Unsloth Studio, vLLM, llama.cpp server and LM Studio.
- `llm.apiKey` adds `Authorization: Bearer <key>` to every request.

**Request format** (`llmChatBody()` in `src/ollama-http.ts`):
- `model`, `messages` (system + history), `stream: false`, `tools`, `temperature: 0.3`
- Tools passed as `{ type: "function", function: { name, description, parameters } }` — identical in both dialects
- `tool_choice`: `"required"` in dialect `ollama` (when `requireTool`), `"auto"` in dialect `openai` — `"required"` would force a tool call even in normal chat
- `options: { num_ctx }` only in dialect `ollama`; `max_tokens` / `response_format: { type: "json_object" }` only in `openai`

**Response parsing** (`parseLlmChat()` in `src/ollama-http.ts`):
- Normalizes `message.content` / `message.tool_calls` (ollama) and `choices[0].message.content` / `.tool_calls` (openai) into `{ content, toolCalls }`.
- Assistant messages with `tool_calls` go back into the history via `assistantToolCallMessage()`, and each result via `toolResultMessage()` (adds `tool_call_id`). The OpenAI dialect returns 400 without this pairing.
- If `tool_calls` present and length > 0, loop through each, call `callMcpTool()`, append result, continue loop. Otherwise return `content` as the final answer.

**Key constraints**:
- History capped at 20 messages per chat ID (lines 44–45, 123–124)
- System prompt language enforcement: **"Responde SIEMPRE en español, NUNCA en inglés"** must stay at the top
- `temperature: 0.3` reduces non-determinism for small quantized models

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
- Edit `SOUL.md`, `USER.md`, `AGENTS.md` to change personality, user info, or rules
- `MEMORY.md` is legacy/static; do not add dynamic memories there (use `/memory` or let the extractor work)
- No bot restart needed; files are read fresh on each message

### Debugging Tool-Calling Issues
- Check logs for `[Ollama] Tools available: ...` to confirm tool schema is sent
- Check for `[Ollama] Received tool calls:` or `[Ollama] Final assistant message length:` to see if model called tools
- If model responds with text instead of tool_calls: model (Ollama choice) may be unreliable; `ornith-1.5:9b` is recommended
- Ensure `SYSTEM.md` starts with language enforcement line; ensure `temperature: 0.3` and `tool_choice: "required"` are set in request (line 95–96 of ollama.ts)

## Dependencies

- **grammy**: Telegram bot framework (v1.38+)
- **@modelcontextprotocol/sdk**: MCP client for connecting to external servers (v1.29+)
- **tsx**: TypeScript runner for Node.js (dev)
- **typescript**: Type checking (dev)

## Optimizations

The codebase includes several performance and reliability optimizations:

**Latency**:
- Context file caching (mtime-based): ~40-60ms → ~1ms per request (cache hits)
- Parallel tool execution: ~3x faster when model calls multiple tools

**Reliability**:
- 30-second timeout on Ollama requests prevents indefinite hangs
- Exponential backoff retry logic for transient failures
- Auto-cleanup of inactive chat sessions prevents memory leaks

## Notes

- All persistent config is in `.md` files (human-readable, version-controlable)
- `.env` is gitignored; each developer has their own secrets
- No unit tests currently; code is straightforward enough for manual verification
- Spanish is the primary language; agent always responds in Spanish by system prompt enforcement
