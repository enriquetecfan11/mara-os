import { join } from "node:path"

export interface McpServerConfig {
  name: string
  type?: "http" | "stdio"
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpConfig {
  servers: McpServerConfig[]
}

export const telegramToken = process.env.TELEGRAM_TOKEN!
export const telegramChatId = process.env.TELEGRAM_CHAT_ID!
export const agentDir = join(process.cwd(), "config")
export const skillsDir = join(agentDir, "skills")
export const uploadsDir = join(agentDir, "uploads")
export const memoryPath = join(agentDir, "MEMORY.md")
export const ollamaUrl = process.env.OLLAMA_URL || "http://192.168.1.182:11434"
export const ollamaModel = process.env.OLLAMA_MODEL || "ornith-1.5:9b"
// Tamaño de ventana de contexto por petición. Ollama usa 4096 por defecto si el
// Modelfile no define num_ctx, y las tools MCP se comen ~3k tokens del prompt:
// con el default cualquier mensaje devuelve 400 exceed_context_size_error.
// El modelo (qwen35 9B) admite 262144; bajarlo si el servidor va justo de RAM.
export const ollamaNumCtx = Number(process.env.OLLAMA_NUM_CTX || 16384)
export const timezone = process.env.TIMEZONE || "Europe/Madrid"
// URL del servidor WebSocket "brain" para emitir eventos v1 hacia Mara UI.
// El bridge de mara-ui se conecta a esta misma URL (MARA_BRAIN_WS_URL).
// Vacío = desactivado (Telegram funciona igual). Ej.: ws://0.0.0.0:9000
export const brainWsUrl = process.env.MARA_BRAIN_WS_URL || ""
export const voiceboxUrl = process.env.VOICEBOX_URL || "http://192.168.1.79:17493"
export const voiceboxEnabled = process.env.VOICEBOX_ENABLED === "true"
export const voiceboxProfile = process.env.VOICEBOX_PROFILE || "Mara"
export const voiceboxTranscribeModel = process.env.VOICEBOX_TRANSCRIBE_MODEL || "whisper-turbo"
export const telegramSendVoiceDefault = process.env.TELEGRAM_SEND_VOICE === "true"
// STT local (transformers.js / whisper-WASM). Activado por defecto; se desactiva con STT_LOCAL_ENABLED=false.
// Nombre con el que se etiqueta al usuario en los mensajes espejados a Telegram
// desde el micrófono del navegador/UI (p. ej. "Kike").
export const maraUserName = process.env.MARA_USER_NAME || "Kike"
// Interruptor maestro de transcripción. Con STT_ENABLED=false el bot NO intenta
// transcribir nada: ni descarga el audio, ni carga un modelo whisper, ni llama a
// Voicebox. Responde al instante diciendo que no procesa voz.
// Útil en la Raspberry Pi, donde no hay CPU para whisper y Voicebox no está disponible.
export const sttEnabled = process.env.STT_ENABLED !== "false"
// Local (whisper en la propia máquina) frente a Voicebox (whisper-turbo remoto).
// Solo tiene efecto si STT_ENABLED está activo.
export const sttLocalEnabled = process.env.STT_LOCAL_ENABLED !== "false"
// Modelo whisper para transformers.js (Xenova/*): "Xenova/whisper-tiny" (rápido),
// "Xenova/whisper-base" (equilibrado) o "Xenova/whisper-small" (preciso).
export const sttModel = process.env.STT_MODEL || "Xenova/whisper-tiny"
// Idioma del audio entrante (código ISO, ej. "es"). "auto" para autodetección.
export const sttLanguage = process.env.STT_LANGUAGE || "es"
// Dónde se guardan los pesos de whisper. Por defecto transformers.js los mete en
// node_modules/@xenova/transformers/.cache, que se borra en cada `pnpm install`
// (1,6 GB de volver a bajar) y ocupa espacio en la SD de la Raspberry Pi.
// Apunta a una ruta estable y persistente. Vacío = default de la librería.
export const sttCacheDir = process.env.STT_CACHE_DIR || join(agentDir, "..", "data", "models")
// Mensaje de bienvenida largo al arrancar. Ponlo a "false" para silenciarlo
// (el comando /start y /help siguen mostrándolo bajo demanda).
export const startupWelcome = process.env.STARTUP_WELCOME !== "false"
// Tiempo máximo de una transcripción local (ms). Evita que un STT atascado
// bloquee la cola de mensajes del chat. Por defecto 60 s.
export const sttTimeoutMs = Number(process.env.STT_TIMEOUT_MS || 60000)
