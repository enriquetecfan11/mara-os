# Servidores MCP

## Archivo de Configuración: mcp.json

```json
{
  "servers": [
    {
      "name": "engram",
      "type": "stdio",
      "command": "/Users/enriquetecfan/.local/bin/uv",
      "args": ["--directory", "/Users/enriquetecfan/Engram", "run", "engram-server"]
    },
    {
      "name": "macos_automator",
      "type": "stdio",
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "--package", "@steipete/macos-automator-mcp", "macos-automator-mcp"]
    },
    { "name": "calendar", "type": "http", "url": "https://core-n8n.832gky.easypanel.host/mcp/calendar" },
    { "name": "notes", "type": "http", "url": "https://core-n8n.832gky.easypanel.host/mcp/agents-notes" }
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

## Servidores Actuales

### Engram (memoria persistente)

- **Tipo**: stdio
- **Tecnología**: SQLite + FTS5
- **Propósito**: Memoria persistente con búsqueda de texto completo
- **Tools**: 14 tools para recordar, olvidar, buscar y gestionar memoria

### macOS Automator

- **Tipo**: stdio
- **Tecnología**: @steipete/macos-automator-mcp
- **Propósito**: Automatización del Mac mediante AppleScript/JXA
- **Tools**: `execute_script`, `get_scripting_tips`

### Calendar (Google Calendar via n8n)

- **Tipo**: HTTP
- **URL**: `https://core-n8n.832gky.easypanel.host/mcp/calendar`
- **Propósito**: Gestión del calendario de Google de Kike
- **Tools**: Get_all_Events, Create_an_event, Reschedule_Event, Delete_Calendar_Event, Check_Availability

### Notes (notas y tareas via n8n)

- **Tipo**: HTTP
- **URL**: `https://core-n8n.832gky.easypanel.host/mcp/agents-notes`
- **Propósito**: Gestión de notas y tareas
- **Tools**: Create_a_Task, Get_a_Task, Get_many_Tasks, Delete_a_Task, Complete_a_Task

## Añadir un Nuevo Servidor

1. Añade una entrada en `mcp.json`
2. Reinicia el bot
3. Las tools se registrarán automáticamente en `initMcpClients()`
