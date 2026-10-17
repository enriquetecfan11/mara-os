# STT local (Whisper vía transformers.js)

Mara transcribe las notas de voz y audios entrantes **en la propia máquina** con Whisper
(vía [transformers.js](https://github.com/huggingface/transformers.js) / ONNX runtime,
**sin compilar nada**), sin depender de Voicebox para el reconocimiento de voz. La
síntesis de voz de salida sigue usando Voicebox (ver
[VOICEBOX_INTEGRATION.md](./VOICEBOX_INTEGRATION.md)).

## Flujo

```
Telegram (nota de voz / audio)
    ↓
bot.ts: handleIncomingAudio()
    ↓  descarga el fichero a un temporal (config/uploads/)
stt.ts: transcribeLocal()
    ↓  ffmpeg → WAV 16kHz mono  →  whisper (transformers.js / ONNX)
texto transcrito
    ↓  se reutiliza como input normal del agente (askPiWithRetry)
Ollama genera respuesta  →  Telegram (texto + audio opcional por Voicebox)
    ↓
se borra el fichero temporal
```

- Detecta `message:voice` (OGG/Opus) y `message:audio` (mp3, m4a, etc.).
- El texto transcrito entra por el **mismo flujo** que un mensaje escrito (incluye chequeo de aprobaciones).
- Si la transcripción falla, responde con un mensaje corto y **no rompe el bot**.
- El temporal se borra siempre al terminar. El WAV intermedio se genera **en memoria** (ffmpeg por pipe), no en disco.
- Cada transcripción tiene un límite de tiempo (`STT_TIMEOUT_MS`, 60 s por defecto); si se supera, el bot responde con un error corto en vez de quedarse colgado.

## Runtime

- **Librería**: `@xenova/transformers` (transformers.js), con el backend ONNX que instala (`onnxruntime-node`). No hay que compilar nada.
- **Modelo**: se auto-descarga y cachea en el primer uso (en el caché de transformers.js, dentro del proyecto). Después la carga es de fracciones de segundo.
- **Conversión de audio**: transformers.js solo acepta PCM en memoria, así que `transcodeToWavPcm()` convierte la entrada a WAV 16 kHz mono con `ffmpeg` (por pipe) cuando no es ya WAV.

## Requisitos del sistema (macOS)

```bash
brew install ffmpeg      # solo para la conversión de audio (OGG/Opus, MP3 → WAV PCM)
```

La primera transcripción descarga el modelo (unos MB para `tiny`); las siguientes son casi inmediatas.

## Configuración (`.env`)

| Variable | Descripción | Default |
|---|---|---|
| `STT_LOCAL_ENABLED` | `true` transcribe local; `false` usa Voicebox como STT | `true` |
| `STT_MODEL` | Modelo de transformers.js: `Xenova/whisper-tiny`, `Xenova/whisper-base` o `Xenova/whisper-small` | `Xenova/whisper-tiny` |
| `STT_LANGUAGE` | Idioma del audio (ISO, ej. `es`). `auto` para autodetección | `es` |
| `STT_TIMEOUT_MS` | Tiempo máximo por transcripción (ms) | `60000` |

- `Xenova/whisper-tiny` (~40 MB): el más rápido, precisión justa. **Recomendado** por defecto.
- `Xenova/whisper-base` (~75 MB): equilibrio velocidad/precisión.
- `Xenova/whisper-small` (~250 MB): más preciso, más lento.

## Warm-up manual (opcional)

No hace falta compilar. Si quieres predescargar el modelo antes del primer mensaje real,
basta con lanzar una transcripción de prueba con `transcribeLocal()` sobre un WAV, o
simplemente enviar una nota de voz en Telegram (la primera vez tarda algo más).

## Prueba rápida

1. `pnpm bot`
2. Envía una **nota de voz** en Telegram.
3. En logs verás `[STT] Transcribed audio → "..."` y el bot responde con el texto transcrito.

## Archivos relevantes

- `src/stt.ts` — `transcribeLocal(filePath)`: transcripción local con transformers.js.
- `src/bot.ts` — `handleIncomingAudio()`: handlers de `message:voice` / `message:audio`.
- `src/telegram-files.ts` — `saveTelegramFile()`: descarga del fichero de Telegram al temporal.
- `src/config.ts` — flags `sttLocalEnabled`, `sttModel`.
