// Mensaje de bienvenida largo de Mara OS: estado real del sistema + catálogo
// de estados y comandos. Se usa al arrancar y también en /start y /help, para
// no duplicar la lista de comandos en varios sitios.
//
// Telegram limita cada mensaje a 4096 caracteres, así que el texto se trocea
// por líneas y se encadena en varios mensajes si hace falta.

import {
  maraUserName,
  timezone,
  voiceboxEnabled,
  voiceboxUrl,
  telegramSendVoiceDefault,
  sttLocalEnabled,
  sttModel,
  sttLanguage,
  brainWsUrl,
  hindsightBankId,
} from "./config.js"
import { getActiveLlm } from "./providers.js"
import { getMcpStatus } from "./mcp.js"
import { isUiEnabled, getConnectedClientCount } from "./events.js"
import { pingOllama } from "./ollama.js"
import { checkVoicebox } from "./voicebox.js"
import { getMemoryManager } from "./memory/index.js"
import { getSkillList } from "./skills.js"
import { error as logError } from "./logger.js"

/** Margen de seguridad bajo el límite de 4096 caracteres de Telegram. */
const CHUNK_LIMIT = 3900
const PING_CACHE_MS = 30_000
const SEND_GAP_MS = 300

export type SendMessageFn = (chatId: number, text: string) => Promise<unknown>

const RULE_WIDTH = 30

let pingCache: { at: number; ollama: boolean; voicebox: boolean } | null = null

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function heading(title: string): string {
  const tail = "─".repeat(Math.max(3, RULE_WIDTH - title.length - 4))
  return `── ${title} ${tail}`
}

/** Pings a Ollama y Voicebox con caché de 30 s (para no castigar /help). */
async function getPings(): Promise<{ ollama: boolean; voicebox: boolean }> {
  const now = Date.now()
  if (pingCache && now - pingCache.at < PING_CACHE_MS) {
    return { ollama: pingCache.ollama, voicebox: pingCache.voicebox }
  }
  const [ollama, voicebox] = await Promise.all([pingOllama(), checkVoicebox()])
  pingCache = { at: now, ollama, voicebox }
  return { ollama, voicebox }
}

/** Invalida la caché de pings; se llama tras cambiar de proveedor con `/modelo`. */
export function invalidatePings(): void {
  pingCache = null
}

function describeMcp(): string[] {
  const status = getMcpStatus()
  const connected = new Set(status.connected)

  if (status.configured.length === 0) {
    return ["(ningún servidor configurado)"]
  }

  const lines: string[] = []
  for (const name of status.configured) {
    const isUp = connected.has(name)
    const tools = status.toolsByServer[name] ?? 0
    const detail = isUp ? `${tools} tool(s)` : "no conectado"
    lines.push(`${isUp ? "✅" : "❌"} ${name.padEnd(16)} ${detail}`)
  }

  const totalTools = Object.values(status.toolsByServer).reduce((sum, n) => sum + n, 0)
  lines.push(`Total: ${status.connected.length}/${status.configured.length} servidores · ${totalTools} tools`)
  return lines
}

async function describeMemory(): Promise<string[]> {
  try {
    const manager = getMemoryManager()
    const backend =
      manager.getBackendType() === "hindsight"
        ? `Hindsight (banco ${hindsightBankId}) + SQLite local`
        : manager.getBackendType() === "sqlite"
          ? "SQLite (data/mara.db)"
          : "custom store"
    const entries = await manager.list(1000)
    const count = entries.length === 1000 ? "1000+" : String(entries.length)
    const lines = [`Backend:    ${backend}`, `Recuerdos:  ${count}`]

    if (manager.getBackendType() === "hindsight") {
      const state = manager.isHindsightAvailable() ? "✅ operativo" : "❌ no responde (respaldo SQLite)"
      lines.push(`Hindsight:  ${state}`)
      const pending = manager.getPendingSyncCount()
      if (pending > 0) lines.push(`Pendientes: ${pending} sin sincronizar`)
    }

    return lines
  } catch (err) {
    logError("Welcome", `No se pudo leer la memoria: ${err}`)
    return ["Backend:    (no disponible)"]
  }
}

function describeVoice(voiceboxUp: boolean): string[] {
  const voicebox = !voiceboxEnabled
    ? "desactivado (VOICEBOX_ENABLED=false)"
    : voiceboxUp
      ? `✅ operativo (${voiceboxUrl})`
      : `❌ no responde (${voiceboxUrl})`

  const stt = sttLocalEnabled
    ? `local · ${sttModel} (${sttLanguage})`
    : "Voicebox (STT) · " + sttModel

  const output = telegramSendVoiceDefault ? "activada (todas las respuestas)" : "auto (solo si entra audio)"

  return [`Voicebox:   ${voicebox}`, `Entrada:    ${stt}`, `Salida:     ${output}`]
}

function describeUi(): string[] {
  if (!brainWsUrl) return ["Bridge WS:  desactivado (MARA_BRAIN_WS_URL vacío)"]
  if (!isUiEnabled()) return [`Bridge WS:  ⚠️ no arrancó (${brainWsUrl})`]
  return [`Bridge WS:  ✅ activo · ${getConnectedClientCount()} cliente(s) · ${brainWsUrl}`]
}

function describeStates(): string[] {
  return [
    "idle         reposo, esperando mensaje",
    "listening    escuchando el micrófono",
    "thinking     procesando tu petición",
    "speaking     reproduciendo la respuesta",
    "seeing       analizando una imagen",
    "error        último error registrado",
    "offline      motor (Ollama) no disponible",
  ]
}

function describeCommands(): string[] {
  return [
    "/start      este mensaje de bienvenida",
    "/help       esta ayuda",
    "/status     fecha, modelo y ficheros de contexto",
    "/modelo     proveedor de inferencia (sin args: estado)",
    "/context    contexto de ejecución y memoria",
    "/reset      limpia el historial de la conversación",
    "/cancel     detiene la petición en curso",
    "/memory     <texto> | list | forget <id>",
    "/skill      lista | <nombre> | recargar",
    "/voz        on | off (salida de voz)",
    "/feedback   <texto> (tu opinión sobre el bot)",
  ]
}

function describeCapabilities(): string[] {
  return [
    "• Conversación con memoria persistente",
    "• Calendario, notas y tareas (vía MCP)",
    "• Fotos: las analizo y las describo",
    "• Notas de voz y micrófono del navegador",
    "• Automatización del Mac",
  ]
}

export async function buildWelcomeText(greetName: string = maraUserName, botUsername?: string): Promise<string> {
  const { ollama, voicebox } = await getPings()
  const skills = await getSkillList()
  const memoryLines = await describeMemory()
  const llm = getActiveLlm()

  const now = new Date().toLocaleString("es-ES", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "medium",
  })

  const engineLine = ollama
    ? `✅ accesible (${llm.url})`
    : `❌ no responde (${llm.url})`

  const skillLines = skills.length > 0
    ? skills.map((s) => `• ${s}`)
    : ["(ninguno)"]

  const lines: string[] = [
    "🤖 Mara OS",
    `Hola ${greetName}!`,
    botUsername ? `Bot:       @${botUsername}` : "",
    `Fecha:     ${now}`,
    `Zona:      ${timezone}`,
    "",
    heading("Motor"),
    `Proveedor: ${llm.provider} (${llm.dialect})`,
    `Modelo:    ${llm.model}`,
    `Servidor:  ${engineLine}`,
    "",
    heading("Herramientas (MCP)"),
    ...describeMcp(),
    "",
    heading("Memoria"),
    ...memoryLines,
    "",
    heading("Voz"),
    ...describeVoice(voicebox),
    "",
    heading("Interfaz (Mara UI)"),
    ...describeUi(),
    "",
    heading("Estados"),
    ...describeStates(),
    "",
    heading("Comandos"),
    ...describeCommands(),
    "",
    heading("Capacidades"),
    ...describeCapabilities(),
    "",
    `${heading(`Skills (${skills.length})`)}`,
    ...skillLines,
    "",
    "Escribe /help para ver esto mismo cuando quieras.",
  ]

  // Quita líneas vacías de relleno (p. ej. la del bot sin username).
  return lines.filter((line, index) => !(line === "" && lines[index - 1] === "")).join("\n")
}

/** Parte el texto por líneas en trozos de como máximo `limit` caracteres. */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let current = ""

  for (const line of text.split("\n")) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current)
        current = ""
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit))
      }
      continue
    }

    const candidate = current ? `${current}\n${line}` : line
    if (candidate.length > limit) {
      chunks.push(current)
      current = line
    } else {
      current = candidate
    }
  }

  if (current) chunks.push(current)
  return chunks
}

/**
 * Envía el texto troceado a Telegram. Devuelve cuántos mensajes envió.
 * `sendMessage` se inyecta para no acoplar este módulo al bot (evita ciclos).
 */
export async function sendWelcome(chatId: number, text: string, sendMessage: SendMessageFn): Promise<number> {
  const chunks = chunkText(text)
  for (let i = 0; i < chunks.length; i++) {
    try {
      await sendMessage(chatId, chunks[i])
    } catch (err) {
      logError("Welcome", `No se pudo enviar el bloque ${i + 1}/${chunks.length}: ${err}`)
      throw err
    }
    if (i < chunks.length - 1) await delay(SEND_GAP_MS)
  }
  return chunks.length
}
