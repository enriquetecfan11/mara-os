# Depuración

## Logging

El sistema de logging (logger.ts) soporta 4 niveles:

| Nivel | Color | Uso |
|---|---|---|
| debug | Gris | Información detallada de diagnóstico |
| info | Cyan | Eventos normales del sistema |
| warn | Amarillo | Advertencias y reintentos |
| error | Rojo | Errores que requieren atención |

### Activar Logging Detallado

```bash
LOG_LEVEL=debug pnpm bot
```

### Formato de Log

```
[14:32:55] [INFO] [Bot] Starting Telegram bot...
[14:32:55] [DEBUG] [Ollama] Sending request to http://192.168.1.182:11434/api/chat...
[14:32:55] [INFO] [Skills] Detected: calendario, notas
```

## Depuración de Tool Calling

### Verificar que las Tools se Envían

Busca en los logs:
```
[Ollama] Tools available: Get_all_Events, Create_an_event, Check_Availability, ...
```

Si no aparece, comprueba que `mcp.json` tiene servidores configurados y que el bot se conectó correctamente.

### Verificar que el Modelo Llama Tools

Busca en los logs:
```
[Ollama] Received 2 tool call(s)
[Tool] Executing tool "Get_all_Events" with arguments: {...}
```

Si el modelo responde con texto en lugar de tool_calls:

1. Asegúrate de que `SYSTEM.md` empieza con "Responde SIEMPRE en español, NUNCA en inglés"
2. Asegúrate de que `temperature: 0.3` y `tool_choice: "required"` están configurados en `ollama.ts`
3. El modelo puede no ser fiable para tool calling. Prueba con `gemma4:e2b` o `ornith-1.5:9b`.

### Verificar Conexión MCP

Busca en los logs:
```
[MCP] Connected to server "calendar"
[MCP] Server "calendar" tools: Date_Time1, Create_an_event, ...
[MCP] Loaded 2 client(s) and 11 tool(s) for Ollama
```

## Problemas Comunes

### Ollama no responde

```
[Ollama] Ping FAILED — Ollama no responde en http://192.168.1.182:11434
```

Solución: Asegúrate de que Ollama está corriendo (`ollama serve`).

### Tool devuelve error

```
[Error executing tool: ...]
```

Ollama devuelve el error exacto al usuario. Revisa que el servidor MCP correspondiente esté funcionando.

### Timeout

Si el modelo tarda más de 60s, la request se cancela. Esto puede pasar con consultas complejas o si Ollama está sobrecargado.

### Sin Tools Registradas

Si `[MCP] Servers configured: ...` no aparece, revisa que `mcp.json` tenga el formato correcto y que las rutas a los ejecutables existan.

### Fallos de Conexión a Servidores HTTP MCP

Los servidores HTTP (calendar, notes) apuntan a un servicio n8n externo. Si no están accesibles, esas tools no estarán disponibles pero el resto del bot sigue funcionando.

## Memoria

- Si conectaste un servidor MCP de memoria (decláralo en `MCP_MEMORY_SERVERS`): `[Memory] Memory mode: MCP memory server`
- Por defecto: `[Memory] Memory mode: SQLite (data/mara.db)`
