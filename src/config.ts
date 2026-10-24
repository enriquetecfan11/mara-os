import { join } from "node:path"

export interface McpServerConfig {
  name: string
  type?: "http" | "stdio"
  url?: string
  /** Cabeceras extra para servidores http (admite ${VAR}, p. ej. un Bearer). */
  headers?: Record<string, string>
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
// === Proveedor de inferencia ===
// Mara OS no ejecuta el LLM: habla con un servidor. `LLM_PROVIDER` elige cuál.
//   "unsloth" → Unsloth Studio en la LAN (API OpenAI-compatible)  [OLLAMA_*]
//   "groq"    → Groq Cloud (API OpenAI-compatible)                 [GROQ_*]
//   "ollama"  → Ollama nativo en la LAN                            [OLLAMA_*]
//   "openai"  → cualquier otro servidor OpenAI-compatible          [LLM_*]
// Sin `LLM_PROVIDER` se mantiene el comportamiento anterior: OLLAMA_* tal cual.
export type LlmProvider = "unsloth" | "groq" | "ollama" | "openai"
export type LlmDialect = "ollama" | "openai"

const envTrim = (name: string): string => (process.env[name] || "").trim()

// Servidor local: Unsloth Studio (dialecto openai) u Ollama nativo.
export const ollamaUrl = envTrim("OLLAMA_URL") || "http://192.168.1.182:11434"
export const ollamaModel = envTrim("OLLAMA_MODEL") || "ornith-1.5:9b"
// Dialecto del servidor local.
//   "ollama" → /api/chat y /api/generate (Ollama nativo).
//   "openai" → /v1/chat/completions (Unsloth Studio, vLLM, llama.cpp server,
//              LM Studio…). Cualquier servidor OpenAI-compatible va por aquí.
export const ollamaApi: LlmDialect = envTrim("OLLAMA_API").toLowerCase() === "openai" ? "openai" : "ollama"
// API key del servidor local, se envía como Authorization: Bearer <key>.
// Vacío = sin cabecera (Ollama por defecto no pide auth).
export const ollamaApiKey = envTrim("OLLAMA_API_KEY")
// Tamaño de ventana de contexto por petición. Ollama usa 4096 por defecto si el
// Modelfile no define num_ctx, y las tools MCP se comen ~3k tokens del prompt:
// con el default cualquier mensaje devuelve 400 exceed_context_size_error.
// Solo dialecto "ollama": en "openai" el contexto lo fija el modelo del servidor.
export const ollamaNumCtx = Number(process.env.OLLAMA_NUM_CTX || 16384)

// Groq Cloud. La base incluye /openai porque sus rutas son
// https://api.groq.com/openai/v1/chat/completions.
export const groqApiUrl = envTrim("GROQ_API_URL") || "https://api.groq.com/openai"
export const groqModel = envTrim("GROQ_MODEL") || "qwen/qwen3.8-27b"
export const groqApiKey = envTrim("GROQ_API_KEY")

// Overrides genéricos, válidos para cualquier proveedor.
const llmUrlOverride = envTrim("LLM_API_URL")
const llmModelOverride = envTrim("LLM_MODEL")
const llmApiKeyOverride = envTrim("LLM_API_KEY")

/** Proveedor por defecto al arrancar, si no hay uno guardado por `/modelo`. */
export const defaultLlmProvider: LlmProvider = (() => {
  const raw = envTrim("LLM_PROVIDER").toLowerCase()
  if (raw === "unsloth" || raw === "groq" || raw === "ollama" || raw === "openai") return raw
  // Sin LLM_PROVIDER: se deduce del dialecto configurado para el servidor local.
  return ollamaApi === "openai" ? "unsloth" : "ollama"
})()

export interface ActiveLlm {
  provider: LlmProvider
  url: string
  model: string
  apiKey: string
  dialect: LlmDialect
  /** Tope de tokens de salida (solo dialecto openai). */
  maxTokens: number
}

/** Tope de tokens del servidor local: `LLM_MAX_TOKENS` > `OLLAMA_MAX_TOKENS` > 2048. */
function localMaxTokens(): number {
  return envNumber("LLM_MAX_TOKENS", envNumber("OLLAMA_MAX_TOKENS", 2048))
}

/** Datos de conexión de un proveedor, sin tocar el que esté activo. */
export function resolveLlmProvider(provider: LlmProvider): ActiveLlm {
  if (provider === "groq") {
    return {
      provider,
      // Límite de Groq para qwen3.8-27b: 16k de salida. 4k deja aire al tool calling.
      url: (llmUrlOverride || groqApiUrl).replace(/\/+$/, ""),
      model: llmModelOverride || groqModel,
      apiKey: llmApiKeyOverride || groqApiKey,
      dialect: "openai",
      maxTokens: envNumber("LLM_MAX_TOKENS", 4096),
    }
  }
  // unsloth / openai / ollama comparten servidor local y credenciales.
  return {
    provider,
    url: (llmUrlOverride || ollamaUrl).replace(/\/+$/, ""),
    model: llmModelOverride || ollamaModel,
    apiKey: llmApiKeyOverride || ollamaApiKey,
    dialect: provider === "ollama" ? "ollama" : "openai",
    maxTokens: localMaxTokens(),
  }
}

/** Todos los proveedores soportados, en el orden en que se listan. */
export const llmProviderNames: LlmProvider[] = ["unsloth", "groq", "ollama", "openai"]

/** ¿Está el proveedor configurado? Devuelve el motivo si le falta algo. */
export function checkLlmProvider(provider: LlmProvider): { ok: boolean; reason?: string } {
  if (provider === "groq") {
    const key = llmApiKeyOverride || groqApiKey
    if (!key) return { ok: false, reason: "falta GROQ_API_KEY en el .env" }
  }
  if (provider === "openai" && !llmUrlOverride) {
    return { ok: false, reason: "falta LLM_API_URL en el .env" }
  }
  return { ok: true }
}
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

function envNumber(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  if (value > 0) return value
  return allowZero && value === 0 ? 0 : fallback
}

// === Hindsight (memoria a largo plazo) ===
// Hindsight es el backend principal cuando HINDSIGHT_ENABLED=true. Si está
// desactivado, Mara OS sigue usando SQLite exactamente igual que antes.
// El servidor Hindsight vive en la LAN; este proceso NO ejecuta ningún LLM.
export const hindsightEnabled =
  process.env.HINDSIGHT_ENABLED === "true" || process.env.HINDSIGHT_ENABLED === "1"
export const hindsightApiUrl =
  process.env.HINDSIGHT_API_URL || "http://192.168.1.196:8888"
export const hindsightBankId = process.env.HINDSIGHT_BANK_ID || "mara-os"
// Opcional: si el servidor Hindsight tiene habilitada la autenticación por API
// key, se envía como Authorization: Bearer <key>. Vacío = sin cabecera.
export const hindsightApiKey = process.env.HINDSIGHT_API_KEY || ""
export const hindsightTenant = process.env.HINDSIGHT_TENANT || "default"
// Timeout para recall/list/get. Las consultas de chat no deben esperar más.
export const hindsightTimeoutMs = envNumber("HINDSIGHT_TIMEOUT_MS", 8000)
// retain ejecuta extracción con LLM en el servidor; necesita más margen.
export const hindsightRetainTimeoutMs = envNumber("HINDSIGHT_RETAIN_TIMEOUT_MS", 25000)
export const hindsightHealthTimeoutMs = envNumber("HINDSIGHT_HEALTH_TIMEOUT_MS", 2500)
// Cuántos recuerdos pendientes se reintentan por pasada y cada cuánto.
export const hindsightSyncBatchSize = envNumber("HINDSIGHT_SYNC_BATCH_SIZE", 10)
export const hindsightSyncIntervalMs = envNumber("HINDSIGHT_SYNC_INTERVAL_MS", 60000, true)
// Umbral mínimo para guardar un recuerdo extraído. Evita memorizar charla
// circunstancial que el extractor haya puntuado bajo.
export const memoryMinImportance = envNumber("MEMORY_MIN_IMPORTANCE", 0.5)
// Como mínimo, una extracción por chat cada N ms (0 lo desactiva).
export const memoryExtractionMinIntervalMs = envNumber("MEMORY_EXTRACTION_MIN_INTERVAL_MS", 60000, true)
