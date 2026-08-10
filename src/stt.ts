import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@xenova/transformers"
import { readFile } from "node:fs/promises"
import { sttModel, sttLanguage } from "./config.js"
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

export async function transcribeLocal(filePath: string): Promise<string> {
  const buffer = await readFile(filePath)
  debug("STT", `transformers.js transcribe (model=${sttModel}) ${filePath}`)

  const audio = wavToFloat32(buffer)
  const pipe = await getTranscriber()
  const result = (await pipe(audio, {
    language: sttLanguage,
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  })) as { text?: string }

  const text = (result.text ?? "").trim()
  if (!text) throw new Error("Empty transcription")

  info("STT", `Transcribed audio → "${text.slice(0, 80)}"`)
  return text
}