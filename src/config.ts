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
export const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434"
export const ollamaModel = process.env.OLLAMA_MODEL || "gemma4:e2b"
export const timezone = process.env.TIMEZONE || "Europe/Madrid"
export const voiceboxUrl = process.env.VOICEBOX_URL || "http://192.168.1.79:17493"
export const voiceboxEnabled = process.env.VOICEBOX_ENABLED === "true"
export const voiceboxProfile = process.env.VOICEBOX_PROFILE || "Mara"
export const voiceboxTranscribeModel = process.env.VOICEBOX_TRANSCRIBE_MODEL || "whisper-turbo"
export const telegramSendVoiceDefault = process.env.TELEGRAM_SEND_VOICE === "true"
// STT local (whisper.cpp / Apple Silicon). Activado por defecto; se desactiva con STT_LOCAL_ENABLED=false.
export const sttLocalEnabled = process.env.STT_LOCAL_ENABLED !== "false"
// Nombre de modelo whisper.cpp: "large-v3-turbo" (mejor precisión, rápido en Apple Silicon)
// o "small" (más ligero). Ver docs/STT_LOCAL.md.
export const sttModel = process.env.STT_MODEL || "large-v3-turbo"
// Idioma del audio entrante (código ISO, ej. "es"). "auto" para autodetección.
export const sttLanguage = process.env.STT_LANGUAGE || "es"
