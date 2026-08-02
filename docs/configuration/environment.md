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

## Voz de salida (Voicebox TTS)

| Variable | Descripción | Default |
|---|---|---|
| `VOICEBOX_URL` | URL del servidor Voicebox | `http://192.168.1.79:17493` |
| `VOICEBOX_ENABLED` | Habilita la síntesis de voz de salida (`true`/`false`) | `false` |
| `VOICEBOX_PROFILE` | Nombre del perfil de voz | `Mara` |
| `TELEGRAM_SEND_VOICE` | `true` añade voz a **todas** las respuestas (también a las de texto). Con `false`, solo se añade voz cuando la entrada fue audio | `false` |

> El **texto se envía siempre**. Además, se añade una **nota de voz** (OGG/Opus, `replyWithVoice`) cuando la entrada fue una nota de voz/audio (o si `/voz on` / `TELEGRAM_SEND_VOICE=true`). Se omite el audio en respuestas de más de 500 caracteres. `/voz on|off` es override por chat.

## Voz de entrada (STT — transcripción de audio)

| Variable | Descripción | Default |
|---|---|---|
| `STT_LOCAL_ENABLED` | Transcribe local con Whisper (whisper.cpp, Apple Silicon). `false` usa Voicebox como STT | `true` |
| `STT_MODEL` | Modelo whisper.cpp: `large-v3-turbo` (recomendado, Apple Silicon) o `small` (ligero) | `large-v3-turbo` |
| `STT_LANGUAGE` | Idioma del audio entrante (ISO, ej. `es`). `auto` para autodetección | `es` |
| `VOICEBOX_TRANSCRIBE_MODEL` | Modelo de transcripción de Voicebox (solo si `STT_LOCAL_ENABLED=false`) | `whisper-turbo` |

Ver detalle en [STT local (Whisper)](../STT_LOCAL.md).

## Archivo .env

```env
TELEGRAM_TOKEN=tu_token_de_telegram
TELEGRAM_CHAT_ID=123456789
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=gemma4:e2b
TIMEZONE=Europe/Madrid

# Voz de salida (Voicebox TTS)
VOICEBOX_URL=http://192.168.1.79:17493
VOICEBOX_ENABLED=true
VOICEBOX_PROFILE=Mara
TELEGRAM_SEND_VOICE=true

# Voz de entrada (STT local con Whisper en Apple Silicon)
STT_LOCAL_ENABLED=true
STT_MODEL=large-v3-turbo
STT_LANGUAGE=es
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
