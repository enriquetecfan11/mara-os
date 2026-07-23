# Arquitectura de Mara OS

## Visión General

Mara OS es un asistente personal que conecta Telegram, un LLM local (Ollama) y servicios externos a través del protocolo MCP (Model Context Protocol).

## Componentes Principales

```
┌─────────────────────────────────────────────────────────────┐
│                     Telegram (Usuario)                       │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    bot.ts (Handler)                          │
│  • Recibe mensajes de texto y fotos                         │
│  • Encola peticiones por chat (evita race conditions)       │
│  • Muestra "escribiendo..." cada 4s                         │
│  • Limpia markdown de las respuestas                        │
│  • Maneja comandos: /start, /help, /status, /reset, etc.    │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    ollama.ts (Orquestador)                   │
│  • Construye system prompt desde SYSTEM.md + placeholders    │
│  • Detecta skills relevantes al mensaje                     │
│  • Envía a Ollama con tool_choice: required                 │
│  • Bucle: tool_calls → ejecución MCP → historial → repetir  │
│  • Timeout: 60s | Retry: backoff exponencial                │
│  • Mantiene historial por chat (máx 20 mensajes)            │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    mcp.ts (Dispatcher)                       │
│  • Conecta servidores MCP (stdio y HTTP)                    │
│  • Registra tools disponibles                                │
│  • Despacha tool_calls al servidor correspondiente           │
│  • Fallback a MEMORY.md si Engram no está disponible         │
└──┬──────────┬──────────┬──────────┬─────────────────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌────────┐ ┌───────┐
│Engram│ │  Mac   │ │Calendar│ │ Notes │
│(mem.)│ │  Auto  │ │ (n8n)  │ │ (n8n) │
└──────┘ └────────┘ └────────┘ └───────┘
```

## Stack Tecnológico

| Componente | Tecnología |
|---|---|
| Bot | grammy (TypeScript) |
| LLM | Ollama (modelo local) |
| Conexión MCP | @modelcontextprotocol/sdk |
| Memoria | Engram (SQLite) o MEMORY.md |
| Servidores MCP | 4 (Engram, macOS, Calendar, Notes) |

## Optimaciones

- **Caché de archivos**: Los contextos (SOUL, USER, AGENTS, SYSTEM, MEMORY) se cachean por mtime. Reduce 40-60ms → ~1ms por request.
- **Ejecución paralela de tools**: Múltiples tool_calls se ejecutan concurrentemente con Promise.all().
- **Timeout**: 30s en requests a Ollama para evitar hangs.
- **Retry**: Backoff exponencial (1s, 2s, 4s) para fallos transitorios.
- **Limpieza de sesiones**: Sesiones inactivas se eliminan tras 30 minutos.
- **Cola por chat**: Los mensajes se procesan secuencialmente dentro de cada chat.
