# Integración MCP

## ¿Qué es MCP?

El Model Context Protocol (MCP) es un protocolo que permite a los asistentes de IA conectarse con servicios externos. Mara OS lo usa para que Ollama pueda interactuar con calendario, notas y el sistema operativo.

## Arquitectura MCP

```
Ollama ──▶ mcp.ts ──▶ toolToClientMap (name → Client)
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
      macOS Auto     Calendar      Notes
        (stdio)       (HTTP)       (HTTP)
```

## Inicialización (initMcpClients)

1. Lee `mcp.json` del directorio raíz
2. Para cada servidor configurado:
   - Crea un transporte (StdioClientTransport o StreamableHTTPClientTransport)
   - Crea un `Client` de MCP SDK
   - Conecta al servidor
   - Lista las tools disponibles con `client.listTools()`
   - Registra cada tool en `toolToClientMap` (tool → servidor)
   - Convierte cada tool al formato de Ollama: `{ type: "function", function: { name, description, parameters } }`

## Servidores MCP

Actualmente hay 4 servidores configurados en `mcp.json`:

| Servidor | Tipo | Propósito | Tools |
|---|---|---|---|
| macos_automator | stdio | Automatización del Mac | execute_script, get_scripting_tips |
| calendar | HTTP | Google Calendar (via n8n) | CRUD eventos + disponibilidad |
| notes | HTTP | Notas y tareas (via n8n) | CRUD tareas |

## Despacho de Tools (callMcpTool)

Cuando Ollama hace un tool_call:

1. Se busca el cliente MCP en `toolToClientMap` por el nombre de la tool
2. Se llama a `client.callTool({ name, arguments })` en el servidor correspondiente
3. Se extrae el contenido de texto de la respuesta
4. Se devuelve al bucle de Ollama como resultado

## Cierre Graceful (closeMcpClients)

En señal de parada (SIGINT/SIGTERM):

1. Se itera sobre todos los clientes conectados
2. Se llama a `client.close()` en cada uno
3. Se limpian los mapas y arrays internos

Esto previene errores de procesos hijos al cerrar abruptamente.

## Memoria

La memoria persistente va en SQLite (`data/mara.db`) y no depende de ningún servidor MCP, así que no se pierde si un servidor MCP falla. `MEMORY.md` se mantiene como archivo legacy editable a mano.

Para enchufrar otro almacén, implementa la interfaz `MemoryStore` de `src/memory/types.ts` y regístralo con `registerMemoryStoreFactory()` en `src/memory/memory-manager.ts`. Si además es un servidor MCP, declara su nombre en `MCP_MEMORY_SERVERS` para que cuente como backend de memoria en los logs.

## Añadir un Nuevo Servidor MCP

1. Añade una entrada en `mcp.json`:

```json
{
  "name": "mi-servidor",
  "type": "stdio",
  "command": "/path/to/binary",
  "args": ["--flag", "value"]
}
```

O para servidores HTTP:

```json
{
  "name": "mi-servidor",
  "type": "http",
  "url": "https://ejemplo.com/mcp"
}
```

2. Reinicia el bot. Las tools se registrarán automáticamente.
