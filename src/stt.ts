import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@xenova/transformers"
import { readFile } from "node:fs/promises"
import { sttModel, sttLanguage, sttTimeoutMs } from "./config.js"
import { transcodeToWavPcm } from "./audio.js"
import { debug, info, error as logError } from "./logger.js"

// STT en Windows vía transformers.js (whisper en WebAssembly/ONNX).
// No requiere cmake ni compilar nada: descarga el modelo en el primer uso y
// transcribe sobre CPU/WASM. Ideal para pruebas rápidas desde el navegador.

let transcriber: AutomaticSpeechRecognitionPipeline | null = null

async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriber) return transcriber
  debug("STT", `Cargando whisper (${sttModel})…`)
  transcriber = (await pipeline(
    "automatic-speech-recognition",
    sttModel,
  )) as unknown as AutomaticSpeechRecognitionPipeline
  info("STT", `whisper ${sttModel} listo`)
  return transcriber
}

/**
 * Extrae las muestras PCM de un WAV PCM-16 (mono/stéreo) como Float32Array
 * normalizado a [-1, 1], que es lo que espera whisper de transformers.js.
 */
function wavToFloat32(data: Buffer): Float32Array {
  if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Formato de audio no soportado (se espera WAV PCM)")
  }
  const channels = data.readUInt16LE(22)
  const bitsPerSample = data.readUInt16LE(34)

  let dataOffset = -1
  let dataSize = 0
  for (let i = 12; i < data.length - 8; ) {
    const id = data.toString("ascii", i, i + 4)
    const size = data.readUInt32LE(i + 4)
    if (id === "data") {
      dataOffset = i + 8
      dataSize = size
      break
    }
    i += 8 + size + (size % 2)
  }
  if (dataOffset < 0) throw new Error("Chunk 'data' no encontrado")

  // ffmpeg, al escribir WAV por un pipe (no buscable), no puede reescribir el
  // tamaño real del chunk 'data' y lo deja en 0xFFFFFFFF. Si nos fiáramos de él
  // reservaríamos ~2.147M muestras (~8 GB de Float32Array) y el proceso se queda
  // sin memoria (parece un cuelgue). Lo acotamos a los bytes que hay de verdad.
  const available = data.length - dataOffset
  if (dataSize <= 0 || dataSize > available) {
    dataSize = available
  }

  const sampleCount = Math.floor(dataSize / (bitsPerSample / 8)) / channels
  const out = new Float32Array(Math.floor(sampleCount))
  for (let s = 0; s < out.length; s++) {
    const byteIndex = dataOffset + s * channels * (bitsPerSample / 8)
    if (byteIndex > data.length - 2) break
    let sample = data.readInt16LE(byteIndex) / 0x7fff
    if (sample > 1) sample = 1
    if (sample < -1) sample = -1
    out[s] = sample
  }
  return out
}

function isWavPcm(data: Buffer): boolean {
  return data.length >= 12 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE"
}

/** Ejecuta una promesa con límite de tiempo; limpia el timer para no dejar el proceso vivo. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
}

export async function transcribeLocal(filePath: string): Promise<string> {
  const raw = await readFile(filePath)
  // Telegram entrega las notas de voz en OGG/Opus (y los ficheros de audio en
  // MP3), pero whisper de transformers.js solo acepta PCM. Transcodificamos a
  // WAV 16 kHz mono con ffmpeg cuando la entrada no es ya WAV.
  const wav = isWavPcm(raw) ? raw : await transcodeToWavPcm(raw)
  debug("STT", `transformers.js transcribe (model=${sttModel}) ${filePath}`)

  const audio = wavToFloat32(wav)
  const pipe = await getTranscriber()
  const result = (await withTimeout(
    pipe(audio, {
      language: sttLanguage,
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    }),
    sttTimeoutMs,
    `Transcripción local excedió ${Math.round(sttTimeoutMs / 1000)}s (ajusta STT_TIMEOUT_MS)`,
  )) as { text?: string }

  const text = (result.text ?? "").trim()
  if (!text) throw new Error("Empty transcription")

  info("STT", `Transcribed audio → "${text.slice(0, 80)}"`)
  return text
}