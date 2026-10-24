# Arquitectura de Mara OS

## Visión General

Mara OS es un asistente personal que conecta Telegram, un LLM local (Ollama) y servicios externos a través del protocolo MCP (Model Context Protocol).

## Componentes Principales

```
┌─────────────────────────────────────────────────────────────┐
│                    Telegram (Usuario)                       │
└───────────────────┬─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    bot.ts (Handler)                          │
│  • Recibe mensajes de texto, fotos y audio                  │
│  • Encola peticiones por chat (evita race conditions)       │
│  • Muestra "escribiendo..." cada 4s                         │
│  • Limpia markdown de las respuestas                        │
│  • Maneja comandos: /start, /help, /status, /reset, etc.    │
│  • Emite estados/eventos a events.ts (Mara UI)              │
└───────┬──────────────────────────────┬──────────────────────┘
        │                              │
        ▼                              ▼
┌───────────────────────────┐  ┌──────────────────────────────┐
│   events.ts (Mara UI)     │  │   ollama.ts (Orquestador)    │
│  • Servidor WS "brain"     │  │  • Construye system prompt   │
│  • Protocolo v1 envelopes  │  │  • tool_choice: required     │
│  • No-bloqueante/re-sync   │  │  • Bucle tools → historial   │
│  • events → bridge → UI    │  │  • Timeout 60s + retry       │
└───────────────────────────┘  └──────────────┬───────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    mcp.ts (Dispatcher)                       │
│  • Conecta servidores MCP (stdio y HTTP)                    │
│  • Registra tools disponibles                                │
│  • Despacha tool_calls al servidor correspondiente           │
│  • Memoria en SQLite, sin depender de MCP                   │
└──┬──────────┬──────────┬──────────┬─────────────────────────┘
   │          │          │
   ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌───────┐
│  Mac   │ │Calendar│ │ Notes │
│  Auto  │ │ (n8n)  │ │ (n8n) │
└────────┘ └────────┘ └───────┘
```

## Stack Tecnológico

| Componente | Tecnología |
|---|---|
| Bot | grammy (TypeScript) |
| LLM | Ollama (modelo local) |
| Conexión MCP | @modelcontextprotocol/sdk |
| Memoria | Hindsight (largo plazo) + SQLite (historial, espejo y respaldo) |
| Servidores MCP | 3 (macOS, Calendar, Notes) |

## Optimaciones

- **Caché de archivos**: Los contextos (SOUL, USER, AGENTS, SYSTEM) se cachean por mtime. Reduce 40-60ms → ~1ms por request.
- **Ejecución paralela de tools**: Múltiples tool_calls se ejecutan concurrentemente con Promise.all().
- **Timeout**: 30s en requests a Ollama para evitar hangs.
- **Retry**: Backoff exponencial (1s, 2s, 4s) para fallos transitorios.
- **Limpieza de sesiones**: Sesiones inactivas se eliminan tras 30 minutos.
- **Cola por chat**: Los mensajes se procesan secuencialmente dentro de cada chat.
