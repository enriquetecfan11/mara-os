# STT local (Whisper en Apple Silicon)

Mara transcribe las notas de voz y audios entrantes **en la propia máquina** con Whisper
(vía [whisper.cpp](https://github.com/ggml-org/whisper.cpp), acelerado con Metal), sin
depender de Voicebox para el reconocimiento de voz. La síntesis de voz de salida sigue
usando Voicebox (ver [VOICEBOX_INTEGRATION.md](./VOICEBOX_INTEGRATION.md)).

## Flujo

```
Telegram (nota de voz / audio)
    ↓
bot.ts: handleIncomingAudio()
    ↓  descarga el fichero a un temporal (config/uploads/)
stt.ts: transcribeLocal()
    ↓  ffmpeg → WAV 16kHz  →  whisper.cpp (modelo local)
texto transcrito
    ↓  se reutiliza como input normal del agente (askPiWithRetry)
Ollama genera respuesta  →  Telegram (texto + audio opcional por Voicebox)
    ↓
se borra el fichero temporal
```

- Detecta `message:voice` (OGG/Opus) y `message:audio` (mp3, m4a, etc.).
- El texto transcrito entra por el **mismo flujo** que un mensaje escrito (incluye chequeo de aprobaciones).
- Si la transcripción falla, responde con un mensaje corto y **no rompe el bot**.
- El temporal se borra siempre al terminar; whisper.cpp elimina el WAV intermedio (`removeWavFileAfterTranscription`).

## Runtime

- **Librería**: `nodejs-whisper` (bindings de whisper.cpp), compilado con Metal en Apple Silicon.
- **Modelo**: se auto-descarga y cachea en el primer uso dentro de `node_modules/nodejs-whisper` (gitignored).
- **Conversión de audio**: whisper.cpp requiere WAV 16kHz mono; `nodejs-whisper` lo convierte internamente con ffmpeg.

## Requisitos del sistema (macOS)

```bash
brew install ffmpeg cmake      # ffmpeg: conversión de audio · cmake: compila whisper.cpp
xcode-select --install         # toolchain de compilación (si no está ya)
```

La primera transcripción tras instalar dependencias compila whisper.cpp y descarga el
modelo (puede tardar); las siguientes son inmediatas.

## Configuración (`.env`)

| Variable | Descripción | Default |
|---|---|---|
| `STT_LOCAL_ENABLED` | `true` transcribe local; `false` usa Voicebox como STT | `true` |
| `STT_MODEL` | Modelo whisper.cpp: `large-v3-turbo` o `small` | `large-v3-turbo` |
| `STT_LANGUAGE` | Idioma del audio (ISO, ej. `es`). `auto` para autodetección | `es` |

- `large-v3-turbo` (~1.6 GB): más preciso y rápido en Apple Silicon (Metal). **Recomendado** para 16 GB.
- `small` (~466 MB): más ligero; menor precisión.

## Warm-up manual (opcional)

Para compilar y descargar el modelo antes del primer mensaje real:

```bash
npx nodejs-whisper download large-v3-turbo
```

## Prueba rápida

1. `pnpm bot`
2. Envía una **nota de voz** en Telegram.
3. En logs verás `[STT] Transcribed audio → "..."` y el bot responde con el texto transcrito.

## Archivos relevantes

- `src/stt.ts` — `transcribeLocal(filePath)`: transcripción local con whisper.cpp.
- `src/bot.ts` — `handleIncomingAudio()`: handlers de `message:voice` / `message:audio`.
- `src/telegram-files.ts` — `saveTelegramFile()`: descarga del fichero de Telegram al temporal.
- `src/config.ts` — flags `sttLocalEnabled`, `sttModel`.
