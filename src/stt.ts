import { resolve } from "node:path"
import { nodewhisper } from "nodejs-whisper"
import { sttModel, sttLanguage } from "./config.js"
import { debug, info, error as logError } from "./logger.js"

// STT local en esta máquina (Apple Silicon) vía whisper.cpp (nodejs-whisper).
// - Convierte el audio a WAV 16kHz internamente (requiere ffmpeg en el sistema).
// - Auto-descarga y cachea el modelo en el primer uso.
export async function transcribeLocal(filePath: string): Promise<string> {
  const absPath = resolve(filePath)
  debug("STT", `whisper.cpp transcribe (model=${sttModel}) ${absPath}`)

  const raw = await nodewhisper(absPath, {
    modelName: sttModel,
    autoDownloadModelName: sttModel,
    removeWavFileAfterTranscription: true,
    logger: { log: () => {}, debug: () => {}, error: (...a: unknown[]) => logError("STT", a.join(" ")) },
    whisperOptions: {
      language: sttLanguage,
      outputInText: false,
      outputInSrt: false,
      outputInVtt: false,
      outputInCsv: false,
      outputInJson: false,
      outputInJsonFull: false,
      outputInLrc: false,
      outputInWords: false,
      splitOnWord: false,
      translateToEnglish: false,
      wordTimestamps: false,
    },
  })

  const text = stripTimestamps(String(raw)).trim()
  if (!text) throw new Error("Empty transcription")

  info("STT", `Transcribed audio → "${text.slice(0, 80)}"`)
  return text
}

// whisper.cpp emite líneas tipo "[00:00:00.000 --> 00:00:02.000]  texto".
// Quitamos el prefijo de timestamps y unimos el texto en una sola cadena.
function stripTimestamps(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[\d:.\s>-]+\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
}
