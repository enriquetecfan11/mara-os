# Ejecución

## Requisitos

- Node.js v18+
- pnpm o npm
- Bot de Telegram (crear con @BotFather)
- Un servidor de inferencia accesible: Ollama o Unsloth Studio en la LAN, o una API key de Groq

## Instalación

```bash
# Clonar el repositorio
git clone <repo>
cd agente-bolsillo

# Instalar dependencias
pnpm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con TELEGRAM_TOKEN y los datos del proveedor (LLM_PROVIDER es el inicial)
```

## Verificar el proveedor de inferencia

Antes de arrancar el bot, comprueba que el backend de inferencia responde (conectividad, modelo y tool calling):

```bash
pnpm check:llm
```

Si todo va bien termina con `OK — el servidor está listo para Mara OS` (código de salida 0). Ver [Testing](../development/testing.md).

## Iniciar el Bot

```bash
pnpm bot
```

El bot:
1. Conecta a los servidores MCP configurados en `mcp.json`
2. Verifica que el proveedor de inferencia esté accesible (`/modelo` permite cambiarlo en caliente)
3. Inicia el bot de Telegram con `bot.start()`
4. Envía un mensaje de inicio al `TELEGRAM_CHAT_ID` si está configurado

## Verificar que Funciona

- Envía `/start` al bot de Telegram
- Envía `/status` para ver el estado del sistema
- Envía `/modelo` para ver el proveedor activo y `/modelo groq` para cambiarlo sin reiniciar
- Envía un mensaje normal, ej: "Hola, ¿qué puedes hacer?"

## Detener el Bot

```bash
Ctrl+C
```

El bot maneja SIGINT y SIGTERM:
1. Cierra gracefulmente los clientes MCP
2. Detiene el bot de Telegram
3. Sale sin errores

## Logs

Por defecto: `LOG_LEVEL=info`

Para ver más detalles:
```bash
LOG_LEVEL=debug pnpm bot
```

## Mantenimiento

### Limpiar Memoria

```bash
pnpm reset-bot      # Vacía MEMORY.md
pnpm reset-memory   # Restaura MEMORY.md de git
```

### Modificar Contexto en Caliente

Edita los archivos en `config/` sin reiniciar el bot. Los cambios se reflejan en el siguiente mensaje.
