# Variables de Entorno

El bot se configura mediante variables de entorno en un archivo `.env` (gitignorado).

## Variables Obligatorias

| Variable | Descripción | Ejemplo |
|---|---|---|
| `TELEGRAM_TOKEN` | Token del bot de Telegram (de @BotFather) | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |

## Variables Opcionales

| Variable | Descripción | Default |
|---|---|---|
| `TELEGRAM_CHAT_ID` | Chat ID para notificaciones de inicio | — |
| `OLLAMA_URL` | URL del servidor Ollama | `http://localhost:11434` |
| `OLLAMA_MODEL` | Modelo de Ollama a usar | `gemma4:e2b` |
| `TIMEZONE` | Zona horaria para fechas | `Europe/Madrid` |
| `LOG_LEVEL` | Nivel de logging (`debug`, `info`, `warn`, `error`) | `info` |

## Archivo .env

```env
TELEGRAM_TOKEN=tu_token_de_telegram
TELEGRAM_CHAT_ID=123456789
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:e2b
TIMEZONE=Europe/Madrid
```

## Configuración Inicial

```bash
cp .env.example .env
# Editar .env con tus credenciales
```

## Notas

- `TELEGRAM_TOKEN` es obligatorio para que el bot funcione.
- El modelo de Ollama debe soportar tool calling. Modelos recomendados: `gemma4:e2b`, `ornith:9b`.
- `LOG_LEVEL=debug` es útil para depuración de tool_calls y diagnóstico.
