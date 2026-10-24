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
| `LLM_PROVIDER` | Proveedor **inicial**: `unsloth` (LAN), `groq` (nube), `ollama` (nativo) u `openai` (genérico). El activo se cambia en caliente con `/modelo` y manda el guardado | se deduce de `OLLAMA_API` (`openai` → `unsloth`, si no `ollama`) |
| `LLM_STATE_FILE` | Dónde se persiste el proveedor elegido con `/modelo` | `data/llm-provider.json` |
| `OLLAMA_API` | Dialecto del servidor local: `ollama` (`/api/chat`) u `openai` (`/v1/chat/completions`) | `ollama` |
| `OLLAMA_URL` | URL del servidor local | `http://192.168.1.182:11434` |
| `OLLAMA_MODEL` | Modelo del servidor local | `ornith-1.5:9b` |
| `OLLAMA_API_KEY` | API key del servidor local (`Authorization: Bearer`). Vacío = sin auth | — |
| `OLLAMA_NUM_CTX` | Ventana de contexto por petición. Solo dialecto `ollama` | `16384` |
| `GROQ_API_URL` | Base de la API de Groq (incluye `/openai`) | `https://api.groq.com/openai` |
| `GROQ_MODEL` | Modelo de Groq | `qwen/qwen3.8-27b` |
| `GROQ_API_KEY` | API key de Groq (`Authorization: Bearer`) | — |
| `LLM_API_URL` | Override de URL para cualquier proveedor | — |
| `LLM_MODEL` | Override de modelo para cualquier proveedor | — |
| `LLM_API_KEY` | Override de API key para cualquier proveedor | — |
| `LLM_MAX_TOKENS` | Tope de tokens por respuesta | `4096` en `groq`, `2048` en el resto |
| `TIMEZONE` | Zona horaria para fechas | `Europe/Madrid` |
| `LOG_LEVEL` | Nivel de logging (`debug`, `info`, `warn`, `error`) | `info` |
| `STARTUP_WELCOME` | Envía el mensaje de bienvenida largo (estado + comandos) al arrancar. `false` lo silencia | `true` |

## Cambiar de proveedor en caliente

El proveedor activo no es una constante: se cambia desde Telegram sin reiniciar.

```
/modelo              → estado de los cuatro, marcando el activo
/modelo groq         → comprueba que responde y lo activa
/modelo unsloth      → vuelve al servidor de la LAN
/modelo ollama       → Ollama nativo
/modelo openai       → servidor genérico (exige LLM_API_URL)
```

Antes de activar, el bot llama al listado de modelos del candidato (`/v1/models`
o `/api/tags`) y comprueba que el modelo configurado está ahí; si falla, **no
cambia** y explica el motivo. Al activarlo se escribe `data/llm-provider.json`,
así que el proveedor elegido sobrevive a los reinicios.

Precedencia al arrancar:

1. Lo guardado por `/modelo` (`LLM_STATE_FILE`, por defecto `data/llm-provider.json`).
2. `LLM_PROVIDER` del `.env`.
3. Deducido de `OLLAMA_API` (`openai` → `unsloth`, si no `ollama`).

Si el proveedor guardado se queda sin configurar (por ejemplo, borras
`GROQ_API_KEY`), el bot avisa en el log y arranca con `LLM_PROVIDER` en vez de
quedarse mudo. Borra `data/llm-provider.json` para volver al valor del `.env`.

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
| `STT_LOCAL_ENABLED` | Transcribe local con Whisper (transformers.js / ONNX, sin compilar). `false` usa Voicebox como STT | `true` |
| `STT_MODEL` | Modelo whisper de transformers.js: `Xenova/whisper-tiny` (rápido), `Xenova/whisper-base` (equilibrado) o `Xenova/whisper-small` (preciso) | `Xenova/whisper-tiny` |
| `STT_LANGUAGE` | Idioma del audio entrante (ISO, ej. `es`). `auto` para autodetección | `es` |
| `STT_TIMEOUT_MS` | Tiempo máximo de una transcripción local (ms). Evita que un STT atascado bloquee la cola de mensajes | `60000` |
| `VOICEBOX_TRANSCRIBE_MODEL` | Modelo de transcripción de Voicebox (solo si `STT_LOCAL_ENABLED=false`) | `whisper-turbo` |

Ver detalle en [STT local (Whisper)](../STT_LOCAL.md).

## Integración con Mara UI (protocolo de eventos v1)

| Variable | Descripción | Default |
|---|---|---|
| `MARA_BRAIN_WS_URL` | URL del servidor WebSocket "brain" que emite eventos v1 hacia Mara UI (el bridge de mara-ui se conecta a esta misma URL). Vacío = desactivado | — |

- El servidor es **no-bloqueante**: si el bridge no está disponible, mara-os sigue funcionando (Telegram no se ve afectado).
- El servidor **no se reconecta**: acepta nuevas conexiones cuando el bridge vuelve, y re-sincroniza estado, último mensaje y estado de red con cada cliente.
- Ejemplo: `MARA_BRAIN_WS_URL=ws://0.0.0.0:9000` (`0.0.0.0` para que el bridge lo alcance en red; `localhost` para solo local).

Eventos emitidos: `mara:state` (`idle`/`listening`/`thinking`/`speaking`/`seeing`/`error`/`offline`), `mara:message`, `mara:network`, `mara:confirm`. Ver el [README](../../README.md#integración-con-mara-ui) y `src/events.ts`.

## Memoria a largo plazo (Hindsight)

| Variable | Descripción | Default |
|---|---|---|
| `HINDSIGHT_ENABLED` | Activa Hindsight como memoria principal. Ausente o `false` = solo SQLite | `false` |
| `HINDSIGHT_API_URL` | URL de la API (no del panel) | `http://192.168.1.196:8888` |
| `HINDSIGHT_BANK_ID` | Banco de memoria | `mara-os` |
| `HINDSIGHT_API_KEY` | API key opcional; se envía como `Authorization: Bearer` | — |
| `HINDSIGHT_TENANT` | Tenant de la ruta `/v1/<tenant>/...` | `default` |
| `HINDSIGHT_TIMEOUT_MS` | Timeout de recall/list/get | `8000` |
| `HINDSIGHT_RETAIN_TIMEOUT_MS` | Timeout de retain (extrae hechos con LLM en el servidor) | `25000` |
| `HINDSIGHT_HEALTH_TIMEOUT_MS` | Timeout de salud y comprobación del banco | `2500` |
| `HINDSIGHT_SYNC_BATCH_SIZE` | Cambios de outbox reintentados por pasada | `10` |
| `HINDSIGHT_SYNC_INTERVAL_MS` | Cada cuánto se vacía la outbox. `0` = sin timer | `60000` |
| `MEMORY_MIN_IMPORTANCE` | Importancia mínima (0-1) para guardar un hecho extraído | `0.5` |
| `MEMORY_EXTRACTION_MIN_INTERVAL_MS` | Mínimo entre extracciones del mismo chat. `0` = sin límite | `60000` |

SQLite sigue guardando el historial y actúa como respaldo si Hindsight no
responde. Detalle en [Sistema de memoria](../memory-system.md).

## Archivo .env

```env
TELEGRAM_TOKEN=tu_token_de_telegram
TELEGRAM_CHAT_ID=123456789
# unsloth (LAN) | groq (nube) | ollama | openai
LLM_PROVIDER=unsloth
OLLAMA_API=openai
OLLAMA_URL=http://192.168.1.79:8888
OLLAMA_MODEL=unsloth/Qwen3.5-4B-MTP-GGUF
OLLAMA_API_KEY=sk-tu-token
GROQ_API_URL=https://api.groq.com/openai
GROQ_MODEL=qwen/qwen3.8-27b
GROQ_API_KEY=
TIMEZONE=Europe/Madrid

# Mensaje de bienvenida largo al arrancar (false para silenciarlo)
# STARTUP_WELCOME=true

# Voz de salida (Voicebox TTS)
VOICEBOX_URL=http://192.168.1.79:17493
VOICEBOX_ENABLED=true
VOICEBOX_PROFILE=Mara
TELEGRAM_SEND_VOICE=true

# Voz de entrada (STT local con Whisper vía transformers.js)
STT_LOCAL_ENABLED=true
STT_MODEL=Xenova/whisper-tiny
STT_LANGUAGE=es

# Integración con Mara UI (protocolo de eventos v1). Vacío = desactivado.
# El bridge de mara-ui se conecta a esta misma URL.
MARA_BRAIN_WS_URL=ws://0.0.0.0:9000

# Memoria a largo plazo con Hindsight (servidor en la LAN, sin LLM local)
HINDSIGHT_ENABLED=true
HINDSIGHT_API_URL=http://192.168.1.196:8888
HINDSIGHT_BANK_ID=mara-os
# HINDSIGHT_API_KEY=
```

## Configuración Inicial

```bash
cp .env.example .env
# Editar .env con tus credenciales
```

## Notas

- `TELEGRAM_TOKEN` es obligatorio para que el bot funcione.
- El modelo de Ollama debe soportar tool calling. Modelo recomendado: `ornith-1.5:9b`.
- `LOG_LEVEL=debug` es útil para depuración de tool_calls y diagnóstico.
