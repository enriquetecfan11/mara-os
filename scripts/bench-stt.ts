// Compara modelos STT sobre una nota de voz real: mismo camino que producción.
// Útil para medir en la Raspberry Pi antes de fijar STT_MODEL.
//
// Uso: node --env-file-if-exists=.env --import tsx scripts/bench-stt.ts <modelo> [quantized]
//   pnpm bench:stt Xenova/whisper-small
import { pipeline, env } from "@xenova/transformers"
import { readFile } from "node:fs/promises"
import { mkdirSync } from "node:fs"
import { sttCacheDir } from "../src/config.js"
import { transcodeToWavPcm } from "../src/audio.js"

const MODEL = process.argv[2] ?? "Xenova/whisper-tiny"
const QUANT = process.argv[3] === "quantized"
const SAMPLE = process.argv[4] ?? "config/uploads/1792230504752.oga"

// Respeta la misma cache que src/stt.ts: fuera de node_modules.
if (sttCacheDir) {
  mkdirSync(sttCacheDir, { recursive: true })
  env.cacheDir = sttCacheDir
  console.log(`cache: ${sttCacheDir}`)
}

function wavToFloat32(data: Buffer): Float32Array {
  const channels = data.readUInt16LE(22)
  const bitsPerSample = data.readUInt16LE(34)
  let dataOffset = -1, dataSize = 0
  for (let i = 12; i < data.length - 8; ) {
    const id = data.toString("ascii", i, i + 4)
    const size = data.readUInt32LE(i + 4)
    if (id === "data") { dataOffset = i + 8; dataSize = size; break }
    i += 8 + size + (size % 2)
  }
  const available = data.length - dataOffset
  if (dataSize <= 0 || dataSize > available) dataSize = available
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

const raw = await readFile(SAMPLE)
const audio = wavToFloat32(await transcodeToWavPcm(raw))

console.log(`\n### ${MODEL} quantized=${QUANT}`)
console.log(`audio: ${(audio.length / 16000).toFixed(2)}s`)

const tLoad = Date.now()
const pipe: any = await pipeline("automatic-speech-recognition", MODEL, { quantized: QUANT })
const loadMs = Date.now() - tLoad

const t0 = Date.now()
const res = await pipe(audio, {
  language: "es",
  task: "transcribe",
  chunk_length_s: 30,
  stride_length_s: 5,
  return_timestamps: false,
})
const inferMs = Date.now() - t0

console.log(`carga: ${(loadMs / 1000).toFixed(1)}s | inferencia: ${(inferMs / 1000).toFixed(1)}s (${(inferMs / 1000 / (audio.length / 16000)).toFixed(2)}x realtime)`)
console.log(`TEXTO: ${JSON.stringify((res.text ?? "").trim())}`)
process.exit(0)
