# Mara OS — Referencia rápida

Asistente personal vía Telegram + LLM externo (Ollama, Unsloth Studio o Groq) + MCP.

## Comandos

`/start` `/reset` `/help` `/status` — básicos  
`/modelo` `/modelo groq` — estado y cambio de proveedor de inferencia en caliente  
`/skill lista` `/skill <nombre>` `/skill recargar` — skills  
`/cancel` — cancela lo que esté procesando  
`/memory [query]` — busca recuerdos en la memoria persistente  
`/memory forget <id>` — olvida un recuerdo  
`/feedback <texto>` — envía opinión

## Qué sabe hacer

- **Calendario** — crear/ver/modificar/eliminar eventos Google Calendar
- **Notas/Tareas** — crear/ver/completar/eliminar
- **Mac** — ejecutar AppleScript/JXA (abrir apps, scripts, etc.)
- **Memoria** — Hindsight (retain/recall) con espejo y respaldo SQLite
- **Skills** — detección automática por keywords (calendario, notas, automatización, memoria)
- **Fotos** — recibe imágenes, las procesa con contexto

## Cómo funciona

1. Llega mensaje → cola por chat (evita race conditions)
2. Muestra "escribiendo..." cada 4s
3. Arma system prompt con SOUL + USER + AGENTS + MEMORY + skills detectados
4. Envía al proveedor activo (`/modelo`, por defecto `LLM_PROVIDER`) con `temperature: 0.3`, timeout 60s
5. Si el modelo pide tools → las ejecuta en paralelo y sigue iterando
6. Si responde texto → lo limpia de markdown y responde

## Stack

**Bot:** grammy (TypeScript)  
**LLM:** proveedor conmutable en caliente con `/modelo` (`unsloth` / `groq` / `ollama` / `openai`); `LLM_PROVIDER` es solo el valor inicial  
**MCP:** 3 servidores — macos_automator, calendar (n8n), notes (n8n) = 13 tools  
**Memoria:** SQLite local con FTS5 (`data/mara.db`), zero LLM. `MEMORY.md` como archivo legacy  
**STT:** desactivado por defecto (`STT_ENABLED=false`)  
**Contexto:** 5 archivos markdown cacheados por mtime

## Scripts

- `npm run bot` — arrancar
- `npm run typecheck` — verificar tipos
- `npm run reset-bot` — limpiar memoria
- `npm run reset-memory` — restaurar MEMORY.md de git

## Archivos clave

| Archivo | Qué es |
|---------|--------|
| `src/bot.ts` | Handler de Telegram + comandos |
| `src/ollama.ts` | Llamadas al LLM + reintentos + cancelación |
| `src/ollama-http.ts` | Endpoints, auth y cuerpos de ambos dialectos (ollama / openai) |
| `src/mcp.ts` | Conexión a servidores MCP |
| `config/SYSTEM.md` | Plantilla del system prompt |
| `config/SOUL.md` | Personalidad de Mara |
| `config/USER.md` | Perfil de Kike |
| `config/AGENTS.md` | Reglas operativas |
| `config/skills/` | Skills (calendario, notas, automatización, memoria) |
| `mcp.json` | Definición de servidores MCP |
| `data/mara.db` | Base de datos de memoria persistente (SQLite) |
