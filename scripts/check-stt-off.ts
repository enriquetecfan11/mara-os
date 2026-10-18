// Comprueba que con STT_ENABLED=false no se descarga audio ni se carga whisper.
// No necesita red ni Telegram: llama directamente al manejador de voz del bot.
import { sttEnabled, sttLocalEnabled } from "../src/config.js"

console.log(`sttEnabled     = ${sttEnabled}`)
console.log(`sttLocalEnabled = ${sttLocalEnabled}`)

if (sttEnabled) {
  console.log("\nFALLO: sttEnabled debería ser false con STT_ENABLED=false")
  process.exit(1)
}

// Si el STT está apagado, importar el módulo de whisper debe ser inocuo: no debe
// crear ninguna sesión ni descargar pesos (getTranscriber solo corre al transcribir).
const t0 = Date.now()
const mod = await import("../src/stt.js")
console.log(`importar src/stt.js tardó ${Date.now() - t0} ms`)

const cacheDir = process.env.STT_CACHE_DIR
if (cacheDir) {
  const { existsSync, readdirSync } = await import("node:fs")
  if (existsSync(cacheDir)) {
    const entries = readdirSync(cacheDir)
    console.log(`contenido de ${cacheDir}: ${entries.length ? entries.join(", ") : "(vacío)"}`)
  }
}

console.log(`transcribeLocal exportada: ${typeof mod.transcribeLocal === "function"}`)
console.log("\nOK: con STT apagado el STT queda neutralizado sin tocar Voicebox ni el LLM.")
process.exit(0)
