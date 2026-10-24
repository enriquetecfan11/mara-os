# Servidores MCP

## Archivo de Configuración: mcp.json

```json
{
  "servers": [
    {
      "name": "agentdesk",
      "type": "http",
      "url": "${AGENTDESK_MCP_URL:-http://192.168.1.196:3000/api/mcp}",
      "headers": { "Authorization": "Bearer ${AGENTDESK_MCP_TOKEN}" }
    }
  ]
}
```

## Formato

### Servidores STDIO

```json
{
  "name": "identificador-unico",
  "type": "stdio",
  "command": "/ruta/al/ejecutable",
  "args": ["--arg1", "valor1"],
  "env": { "VAR": "valor" }
}
```

| Campo | Descripción | Obligatorio |
|---|---|---|
| `name` | Identificador único del servidor | Sí |
| `type` | `"stdio"` para subprocesos | Sí |
| `command` | Ruta al ejecutable | Sí |
| `args` | Argumentos de línea de comandos | No |
| `env` | Variables de entorno adicionales | No |

### Servidores HTTP

```json
{
  "name": "identificador-unico",
  "type": "http",
  "url": "https://ejemplo.com/mcp"
}
```

| Campo | Descripción | Obligatorio |
|---|---|---|
| `name` | Identificador único del servidor | Sí |
| `type` | `"http"` para conexiones HTTP | Sí |
| `url` | URL del endpoint MCP | Sí |
| `headers` | Cabeceras extra (p. ej. `Authorization`). Admiten `${VAR}` para no guardar secretos en el repo | No |

## Servidores Actuales

### AgentDesk

- **Tipo**: HTTP (streamable)
- **URL**: `AGENTDESK_MCP_URL` (por defecto `http://192.168.1.196:3000/api/mcp`, el homelab)
- **Auth**: `Authorization: Bearer ${AGENTDESK_MCP_TOKEN}`. El token va en `.env`, nunca en `mcp.json`.
- **Propósito**: tareas, notas, proyectos y delegaciones del espacio de trabajo de AgentDesk
- **Tools**: whoami, get_queue, create_task, update_task, list_tasks, get_task, list_notes, get_note, create_note, upsert_note, … (33 en total)

### Memoria (no es MCP)

`guardar_recuerdo` y `buscar_recuerdos` son tools nativas (`src/memory-tools.ts`)
que se registran junto a las de MCP y se resuelven contra Hindsight vía
`MemoryManager`. Ver [Gestión de memoria](../operations/memory-management.md#tools-del-llm).

## Añadir un Nuevo Servidor

1. Añade una entrada en `mcp.json`
2. Reinicia el bot
3. Las tools se registrarán automáticamente en `initMcpClients()`
