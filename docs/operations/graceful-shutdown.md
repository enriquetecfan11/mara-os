# Apagado Graceful

El bot maneja señales de terminación (SIGINT, SIGTERM) para un cierre limpio.

## Mecanismo

En `bot.ts`:

```typescript
async function gracefulShutdown(signal: string) {
  info("Bot", `Received ${signal}, shutting down gracefully...`)
  await closeMcpClients()
  bot.stop()
  info("Bot", "Bot stopped.")
  process.exit(0)
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"))
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
```

## Secuencia de Cierre

1. **Recibir señal**: SIGINT (Ctrl+C) o SIGTERM
2. **Cerrar MCP clients**: `closeMcpClients()` desconecta gracefulmente todos los servidores MCP, previniendo errores como el traceback de Python de Engram
3. **Detener bot de Telegram**: `bot.stop()` de grammy
4. **Salir**: `process.exit(0)` con código de éxito

## Cierre de MCP Clients

En `mcp.ts`:

```typescript
export async function closeMcpClients(): Promise<void> {
  for (const [name, client] of clientsMap) {
    info("MCP", `Disconnecting from server "${name}"...`)
    await client.close()
  }
  clientsMap.clear()
  toolToClientMap.clear()
  ollamaTools = []
}
```

## Importancia

- Previene que procesos hijo (servidores MCP stdio) queden huérfanos
- Evita errores visuales en la terminal al cerrar
- Asegura una parada limpia que no requiere intervención manual
