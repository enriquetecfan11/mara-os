# Gestión de Memoria

## Dos Modos de Memoria

El bot soporta dos sistemas de memoria persistente, con detección automática:

### 1. Engram (MCP - SQLite)

Cuando el servidor MCP `engram` está conectado:

- Base de datos SQLite con FTS5 (búsqueda de texto completo)
- 14 tools de memoria: recordar, olvidar, buscar, recall, etc.
- Operaciones vía protocolo MCP
- Persistencia en `~/.engram/engram.db`
- No usa el LLM para buscar, solo SQL

### 2. MEMORY.md (Fallback - Archivo)

Cuando Engram no está disponible:

- Archivo markdown en `config/MEMORY.md`
- Se escribe completo cada vez que se actualiza
- Tool virtual `update_memory` que sobrescribe el archivo
- Lectura en cada request (con caché por mtime)

## Detección Automática

En `mcp.ts`:

```typescript
const memoryServerNames = new Set(["engram"])
let hasMemoryServer = false
```

Si el servidor "engram" se conecta exitosamente, `hasMemoryServer = true` y se usan sus tools nativas. Si no, se inyecta la tool `update_memory` como fallback.

## Tool Fallback: update_memory

Cuando Engram no está disponible, `ollama.ts` añade automáticamente la tool `update_memory` a la lista de tools disponibles:

```typescript
!hasMemoryServer ? [{
  type: "function",
  function: {
    name: "update_memory",
    description: "Updates the MEMORY.md file with new or updated facts.",
    parameters: { ... }
  }
}] : []
```

La ejecución escribe directamente en el archivo:

```typescript
await writeFile(memoryPath, newMemory, "utf8")
```

## Comandos

- `/memory [query]` — Buscar recuerdos (usa Engram si está disponible)
- `/memory forget <id>` — Olvidar un recuerdo específico
- `/reset` — Limpia el historial de conversación (no afecta memoria persistente)
- `pnpm reset-bot` — Vacía MEMORY.md
- `pnpm reset-memory` — Restaura MEMORY.md del estado de git

## Ver Estado de la Memoria

```bash
# En los logs de inicio:
[Memory] Memory mode: engram
# o
[Memory] Memory mode: fallback MEMORY.md
```

O envía `/status` al bot.
