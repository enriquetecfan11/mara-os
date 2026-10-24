import { Bot, InputFile, type Context } from "grammy"
import { randomUUID } from "node:crypto"
import { appendFile, unlink, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { approvalMessage, sttDisabledMessage, hasApproval, needsApproval } from "./approvals.js"
import { saveTelegramPhoto, saveTelegramFile } from "./telegram-files.js"
import { telegramToken, telegramChatId, uploadsDir, agentDir, timezone, voiceboxEnabled, telegramSendVoiceDefault, sttEnabled, sttLocalEnabled, maraUserName, startupWelcome, llmProviderNames, resolveLlmProvider, checkLlmProvider, type ActiveLlm, type LlmProvider } from "./config.js"
import { getActiveLlm, setActiveProvider, listProviderStatus } from "./providers.js"
import { initMcpClients, closeMcpClients, callServerTool, getConnectedMcpServerNames, getRegisteredToolNames } from "./mcp.js"
import { askPiWithRetry, clearChatHistory, cancelRequest } from "./ollama.js"
import { isOpenAiApi, llmBaseUrl, llmHeaders, llmModelsEndpoint, readLlmError } from "./ollama-http.js"
import { getMemoryManager } from "./memory/index.js"
import { runMemoryMigration } from "./memory/migrate.js"
import { getSkillList, loadSkillsContext, reloadSkills } from "./skills.js"
import { readContextFile } from "./cache.js"
import { info, error as logError, warn } from "./logger.js"
import { generateVoice, transcribeAudio, checkVoicebox } from "./voicebox.js"
import { transcribeLocal } from "./stt.js"
import { wavToOggOpus } from "./audio.js"
import { startUiEvents, closeUiEvents, setState, emitMessage, emitConfirm, emitError, emitSpeakingStarted, emitSpeakingFinished, emitVoiceAudio, setCommandHandler, setAudioHandler, type UiCommand } from "./events.js"
import { buildWelcomeText, sendWelcome, invalidatePings } from "./welcome.js"

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .trim()
}

function formatDateTimeWithOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  }).formatToParts(date)

  const pick = (type: string) => parts.find(part => part.type === type)?.value ?? ""
  const offsetLabel = pick("timeZoneName")
  const offsetMatch = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  const offset = offsetMatch
    ? `${offsetMatch[1]}${offsetMatch[2].padStart(2, "0")}:${(offsetMatch[3] ?? "00").padStart(2, "0")}`
    : "Z"

  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}${offset}`
}

function normalizeContextStatus(filename: string, content: string): "loaded" | "empty" {
  const trimmed = content.trim()
  if (!trimmed) return "empty"

  const base = filename.replace(/\.md$/i, "")
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 1 && new RegExp(`^#\\s*${base}(?:\\.md)?$`, "i").test(lines[0])) {
    return "empty"
  }

  const substantive = lines.filter(line => !new RegExp(`^#\\s*${base}(?:\\.md)?$`, "i").test(line))
  return substantive.length > 0 ? "loaded" : "empty"
}

async function getContextFileState(filename: string): Promise<{ status: "loaded" | "empty" | "not_found"; entries: number }> {
  try {
    const content = await readContextFile(agentDir, filename)
    const status = normalizeContextStatus(filename, content)
    const entries = status === "loaded"
      ? content
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0 && !new RegExp(`^#\\s*${filename.replace(/\.md$/i, "")}(?:\\.md)?$`, "i").test(line))
          .length
      : 0
    return { status, entries }
  } catch {
    return { status: "not_found", entries: 0 }
  }
}

const bot = new Bot(telegramToken)

const chatQueues = new Map<number, Promise<void>>()
const voiceOverrides = new Map<number, boolean>()
const pendingConfirms = new Map<string, { chatId: number; message: string }>()

function wantVoiceFor(chatId: number, isAudioInput: boolean): boolean {
  if (voiceOverrides.has(chatId)) return voiceOverrides.get(chatId)!  // /voz manda
  if (telegramSendVoiceDefault) return true                          // voz global on (compat)
  return isAudioInput                                                // default: imitar entrada
}

// Notifica a Mara UI (mara:confirm) cuando una acción requiere aprobación.
// Solo emite el evento; Telegram mantiene su flujo actual con el mensaje "Confirmo".
function emitConfirmRequest(message: string, chatId: number): void {
  const id = randomUUID()
  pendingConfirms.set(id, { chatId, message })
  emitConfirm({
    id,
    title: "Confirmación requerida",
    message: message.slice(0, 300),
    action: "Acción externa (fuera de Telegram)",
  })
}

// Genera y envía la respuesta como NOTA DE VOZ (OGG/Opus). Devuelve true si se envió audio.
// No aplica si el texto es muy largo; si Voicebox o la transcodificación fallan, no rompe.
async function trySendVoice(ctx: Context, text: string): Promise<boolean> {
  if (text.length > 500) return false
  const action = startAction(ctx.chat!.id, "record_voice")
  try {
    // El ciclo de habla (voice.speaking.*) lo emiten generateVoice/finally.
    const wav = await generateVoice(text)
    try {
      const ogg = await wavToOggOpus(wav)
      await ctx.replyWithVoice(new InputFile(ogg, "respuesta.ogg"))
    } catch (convErr) {
      // Sin ffmpeg/opus: enviamos el WAV como audio normal en vez de romper.
      logError("Bot", `Voice transcode failed, sending WAV: ${convErr}`)
      await ctx.replyWithAudio(new InputFile(wav, "respuesta.wav"))
    }
    return true
  } catch (err) {
    logError("Bot", `Failed to send voice: ${err}`)
    return false
  } finally {
    stopAction(action)
  }
}

// Envía SIEMPRE el texto (respuesta inmediata) y, además, audio cuando corresponde:
// por defecto solo si la entrada fue audio; override con /voz on|off o TELEGRAM_SEND_VOICE.
async function deliverReply(ctx: Context, text: string, isAudioInput: boolean): Promise<void> {
  await ctx.reply(text)
  if (voiceboxEnabled && wantVoiceFor(ctx.chat!.id, isAudioInput)) {
    await trySendVoice(ctx, text)
  }
}

function enqueue(chatId: number, fn: () => Promise<void>): Promise<void> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId)
  })
  chatQueues.set(chatId, next)
  return next
}

// Mantiene visible una "chat action" (typing, record_voice, ...) reenviándola cada 4s,
// ya que Telegram la caduca a los ~5s. La primera se envía de inmediato.
function startAction(chatId: number, action: "typing" | "record_voice") {
  bot.api.sendChatAction(chatId, action).catch(() => {})
  const interval = setInterval(() => {
    bot.api.sendChatAction(chatId, action).catch(() => {})
  }, 4000)
  return interval
}

function stopAction(interval: ReturnType<typeof setInterval>) {
  clearInterval(interval)
}

function startTyping(chatId: number) {
  return startAction(chatId, "typing")
}

function stopTyping(interval: ReturnType<typeof setInterval>) {
  stopAction(interval)
}

/**
 * ¿La transcripción contiene voz real? Descarta clips donde whisper solo
 * detectó música, ruido o silencio (los marca entre corchetes como
 * "[Música]", "[♪]"), o donde no haya palabra hablada. Evita que el mic
 * capte la propia salida de audio y genere bucles de respuestas.
 */
function isMeaningfulTranscription(transcript: string): boolean {
  const normalized = transcript.replace(/[\[\]\W_]+/g, " ").trim()
  if (!normalized) return false
  const words = normalized.split(/\s+/).filter((w) => w.length >= 2)
  if (words.length < 2) return false
  if (/^\s*[♪♫]/.test(transcript)) return false
  return true
}

bot.catch(async (err) => {
  const ctx = err.ctx
  logError("Bot", `Error while handling update ${ctx.update.update_id}: ${err.error}`)
  setState("error")
  emitError(String(err.error))
  try {
    await ctx.reply("Ups, ocurrió un error al procesar tu mensaje. Inténtalo de nuevo.")
  } catch {
    // ignore reply errors
  }
})

bot.command("start", async (ctx) => {
  clearChatHistory(ctx.chat.id)
  const welcome = await buildWelcomeText(ctx.from?.first_name || maraUserName)
  await sendWelcome(ctx.chat.id, welcome, (id, text) => bot.api.sendMessage(id, text))
})

bot.command("reset", async (ctx) => {
  clearChatHistory(ctx.chat.id)
  await ctx.reply("Historial limpio. Empezamos de cero.")
})

bot.command("help", async (ctx) => {
  const welcome = await buildWelcomeText(ctx.from?.first_name || maraUserName)
  await sendWelcome(ctx.chat.id, welcome, (id, text) => bot.api.sendMessage(id, text))
})

bot.command("status", async (ctx) => {
  const llm = getActiveLlm()
  const fileNames = ["SOUL.md", "USER.md", "AGENTS.md", "MEMORY.md"]
  const fileStats: string[] = []
  for (const name of fileNames) {
    try {
      const content = await readContextFile(agentDir, name)
      const preview = content.slice(0, 60).replace(/\n/g, " ")
      fileStats.push(`  ${name}: ${content.length} chars`)
      fileStats.push(`    Preview: "${preview}..."`)
    } catch {
      fileStats.push(`  ${name}: (no existe)`)
    }
  }

  const skills = await getSkillList()
  const now = new Date().toLocaleString("es-ES", {
    timeZone: process.env.TIMEZONE || "Europe/Madrid",
    dateStyle: "full",
    timeStyle: "medium"
  })

  const lines = [
    "Estado del sistema",
    "",
    `Fecha: ${now}`,
    `Proveedor: ${llm.provider} (${llm.dialect})`,
    `Modelo: ${llm.model}`,
    `Servidor: ${llm.url}`,
    "",
    "Archivos de contexto:",
    ...fileStats,
    "",
    `Skills (${skills.length}):`,
    ...skills.map(s => `  - ${s}`),
  ]

  await ctx.reply(lines.join("\n"))
})

/** Estado de todos los proveedores, para `/modelo` sin argumentos. */
function describeProviders(): string[] {
  const llm = getActiveLlm()
  const lines = ["Proveedor de inferencia", ""]
  for (const p of listProviderStatus()) {
    const missing = p.configured ? "" : ` — sin configurar (${p.reason})`
    lines.push(`${p.active ? "▶" : " "} ${p.provider} [${p.dialect}]${missing}`)
    lines.push(`    ${p.url}`)
    lines.push(`    ${p.model}`)
  }
  lines.push("")
  lines.push(`Activo: ${llm.provider}`)
  lines.push(`Cambiar: /modelo ${llmProviderNames.join(" | ")}`)
  return lines
}

/**
 * Comprueba que un proveedor responde antes de activarlo: listado de modelos
 * (`/v1/models` o `/api/tags`) y que el modelo configurado esté ahí. No manda una
 * petición de chat para no gastar tokens ni cargar el modelo en el servidor.
 */
async function pingProvider(llm: ActiveLlm): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(llmModelsEndpoint(llm), {
      headers: llmHeaders(false, llm),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { ok: false, detail: await readLlmError(res) }

    const data = (await res.json()) as any
    const names: string[] = isOpenAiApi(llm)
      ? (data?.data ?? []).map((m: any) => String(m.id ?? "")).filter(Boolean)
      : (data?.models ?? []).map((m: any) => String(m.name ?? m.model ?? "")).filter(Boolean)

    const wanted = llm.model.toLowerCase()
    if (names.length > 0 && !names.some((n) => {
      const name = n.toLowerCase()
      return name === wanted || name === `${wanted}:latest`
    })) {
      return { ok: false, detail: `el modelo "${llm.model}" no está en el servidor` }
    }
    return { ok: true, detail: `${names.length} modelo(s) disponibles` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

bot.command("modelo", async (ctx) => {
  const arg = (ctx.match ?? "").trim().toLowerCase()

  if (!arg) {
    await ctx.reply(describeProviders().join("\n"))
    return
  }

  if (!(llmProviderNames as string[]).includes(arg)) {
    await ctx.reply(`Proveedor desconocido: "${arg}"\nUsa: ${llmProviderNames.join(" | ")}`)
    return
  }
  const provider = arg as LlmProvider

  if (getActiveLlm().provider === provider) {
    await ctx.reply(`Ya está activo ${provider} (${getActiveLlm().model}).`)
    return
  }

  const missing = checkLlmProvider(provider)
  if (!missing.ok) {
    await ctx.reply(`No puedo activar ${provider}: ${missing.reason}`)
    return
  }

  const candidate = resolveLlmProvider(provider)
  await bot.api.sendChatAction(ctx.chat.id, "typing")
  info("Inference", `Probando ${provider} (${candidate.url}) antes de activarlo…`)
  const ping = await pingProvider(candidate)
  if (!ping.ok) {
    warn("Inference", `No se activa ${provider}: ${ping.detail}`)
    await ctx.reply(`No cambio a ${provider}: no responde o no tiene el modelo.\n${ping.detail}\n\nSigue activo ${getActiveLlm().provider}.`)
    return
  }

  const active = setActiveProvider(provider)
  invalidatePings()
  await checkOllama()
  await ctx.reply([
    `Proveedor activo: ${active.provider}`,
    `Modelo: ${active.model}`,
    `Servidor: ${active.url}`,
    `(${ping.detail})`,
  ].join("\n"))
})

bot.command("context", async (ctx) => {
  const fileNames = ["USER.md", "SOUL.md", "AGENTS.md", "MEMORY.md"] as const
  const fileStates: Array<{ name: string, status: "loaded" | "empty" | "not_found" }> = []
  let memoryEntries = 0
  let memoryStatus: "loaded" | "empty" | "not_found" = "not_found"

  for (const name of fileNames) {
    const state = await getContextFileState(name)
    fileStates.push({ name, status: state.status })
    if (name === "MEMORY.md") {
      memoryEntries = state.entries
      memoryStatus = state.status
    }
  }

  const skills = await getSkillList()
  const connectedResources = getConnectedMcpServerNames()
  const tools = getRegisteredToolNames()
  const datetime = formatDateTimeWithOffset(new Date(), timezone)

  const memoryManager = getMemoryManager()
  const memoryBackend = memoryManager.getBackendType()
  const longTermMemories = await memoryManager.list(1, 0)
  const pendingSync = memoryManager.getPendingSyncCount()

  const lines = [
    "execution_context:",
    `  datetime: "${datetime}"`,
    `  timezone: "${timezone}"`,
    "",
    "  context_files:",
    ...fileStates.map(file => `    ${file.name}: ${file.status}`),
    "",
    "  conversation:",
    `    backend: persistent (SQLite)`,
    "",
    "  skills:",
    ...(skills.length > 0 ? skills.map(skill => `    - ${skill}`) : ["    - none"]),
    "",
    "  tools:",
    ...(tools.length > 0 ? tools.map(tool => `    - ${tool}`) : ["    - none"]),
    "",
    "  external_resources:",
    ...(connectedResources.length > 0 ? connectedResources.map(resource => `    - ${resource}`) : ["    - none"]),
    "",
    "  sources_used_in_current_request:",
    "    - local_context",
    "    - conversation_history",
    "    - long_term_memory",
    "",
    "  memory:",
    `    backend: ${memoryBackend}`,
    `    long_term_entries: ${longTermMemories.length}`,
    `    legacy_memory_md: ${memoryStatus} (${memoryEntries} lines)`,
    ...(memoryBackend === "hindsight"
      ? [
          `    hindsight_available: ${memoryManager.isHindsightAvailable()}`,
          `    pending_sync: ${pendingSync}`,
        ]
      : []),
  ]

  await ctx.reply(lines.join("\n"))
})

bot.command("skill", async (ctx) => {
  const text = ctx.message?.text
  if (!text) return

  const args = text.split(" ").slice(1)
  const subcommand = args[0]?.toLowerCase()

  if (!subcommand || subcommand === "lista") {
    const skills = await getSkillList()
    if (skills.length === 0) {
      await ctx.reply("No hay skills instalados.")
      return
    }
    const list = skills.map(s => `- /skill ${s}`).join("\n")
    await ctx.reply(`Skills disponibles:\n${list}\n\nAuto-deteccion activa por keywords.`)
    return
  }

  if (subcommand === "recargar") {
    await reloadSkills()
    await ctx.reply("Skills recargados.")
    return
  }

  const skills = await getSkillList()
  if (skills.includes(subcommand)) {
    const context = await loadSkillsContext([subcommand])
    await ctx.reply(`Skill "${subcommand}" cargado.\n\n${context}`)
    return
  }

  await ctx.reply(`Skill "${subcommand}" no encontrado.\nUsa /skill lista para ver disponibles.`)
})

bot.command("cancel", async (ctx) => {
  cancelRequest(ctx.chat.id)
  await ctx.reply("Operación cancelada.")
})

bot.command("memory", async (ctx) => {
  const text = ctx.message?.text ?? ""
  const args = text.split(" ").slice(1)
  const subcommand = args[0]?.toLowerCase()
  const query = args.slice(1).join(" ")

  const typing = startTyping(ctx.chat.id)
  const memoryManager = getMemoryManager()
  try {
    if (subcommand === "forget") {
      const id = query.trim()
      if (!id) {
        await ctx.reply("Uso: /memory forget <id>")
        return
      }
      const success = await memoryManager.forget(id)
      await ctx.reply(success ? "Recuerdo eliminado." : "No se encontró el recuerdo.")
    } else if (subcommand === "search" || subcommand === "find") {
      const searchQuery = query || "recuerdos recientes"
      const result = await memoryManager.search({ query: searchQuery, limit: 10 })
      if (result.entries.length === 0) {
        await ctx.reply("No hay recuerdos que coincidan.")
        return
      }
      const lines = result.entries.map(
        (e) => `- ${e.id}: [${e.type}] ${e.content} (importancia: ${e.importance.toFixed(1)})`
      )
      await ctx.reply(lines.join("\n"))
    } else if (subcommand === "list") {
      const entries = await memoryManager.list(20, 0)
      if (entries.length === 0) {
        await ctx.reply("No hay recuerdos almacenados.")
        return
      }
      const lines = entries.map(
        (e) => `- ${e.id}: [${e.type}] ${e.content} (importancia: ${e.importance.toFixed(1)})`
      )
      await ctx.reply(lines.join("\n"))
    } else {
      const searchQuery = subcommand ? `${subcommand} ${query}`.trim() : "recuerdos recientes"
      const result = await memoryManager.search({ query: searchQuery, limit: 5 })
      if (result.entries.length === 0) {
        await ctx.reply("No tengo recuerdos sobre eso.")
        return
      }
      const lines = result.entries.map(
        (e) => `- [${e.type}] ${e.content} (importancia: ${e.importance.toFixed(1)})`
      )
      await ctx.reply(lines.join("\n"))
    }
  } catch (err: any) {
    await ctx.reply(`Error al consultar memoria: ${err.message}`)
  } finally {
    stopTyping(typing)
  }
})

bot.command("feedback", async (ctx) => {
  const text = ctx.message?.text ?? ""
  const feedback = text.split(" ").slice(1).join(" ").trim()
  if (!feedback) {
    await ctx.reply("Usa: /feedback <tu opinión>")
    return
  }
  const feedbackPath = join(agentDir, "FEEDBACK.log")
  const timestamp = new Date().toISOString()
  await appendFile(feedbackPath, `[${timestamp}] ${ctx.from?.username || "anon"}: ${feedback}\n`)
  await ctx.reply("Gracias por tu feedback!")
})

bot.command("voz", async (ctx) => {
  const arg = (ctx.message?.text ?? "").split(" ")[1]?.toLowerCase()
  if (arg === "on") {
    voiceOverrides.set(ctx.chat.id, true)
    await ctx.reply("Voz activada para este chat.")
  } else if (arg === "off") {
    voiceOverrides.set(ctx.chat.id, false)
    await ctx.reply("Voz desactivada para este chat.")
  } else {
    const actual = wantVoiceFor(ctx.chat.id, false)
    await ctx.reply(
      `Salida de voz en este chat: ${actual ? "activada" : "desactivada"}.\n` +
      `Usa: /voz on | /voz off`
    )
  }
})

bot.on("message:text", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  info("Telegram", `Received text from @${username}: "${ctx.message.text.slice(0, 100)}"`)

  if (needsApproval(ctx.message.text) && !hasApproval(ctx.message.text)) {
    info("Telegram", "Message requires approval. Sending approval warning.")
    emitConfirmRequest(ctx.message.text, ctx.chat.id)
    await ctx.reply(approvalMessage)
    return
  }

  await enqueue(ctx.chat.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat.id)
    try {
      setState("thinking")
      const answer = await askPiWithRetry(ctx.chat.id, ctx.message.text)
      const stripped = stripMarkdown(answer)
      stopTyping(typing) // ya tenemos la respuesta; deliverReply gestiona su propio indicador de voz
      emitMessage(stripped)
      await deliverReply(ctx, stripped, false)
      setState("idle")
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
    } catch (err: any) {
      logError("Bot", `Failed to process message: ${err}`)
      setState("error")
      emitError(err?.message)
    } finally {
      stopTyping(typing)
    }
  })
})

bot.on("message:photo", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  const caption = ctx.message.caption ?? "Kike ha enviado una imagen."
  info("Telegram", `Received photo from @${username}`)

  if (needsApproval(caption) && !hasApproval(caption)) {
    info("Telegram", "Photo message requires approval. Sending approval warning.")
    emitConfirmRequest(caption, ctx.chat.id)
    await ctx.reply(approvalMessage)
    return
  }

  await enqueue(ctx.chat.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat.id)
    try {
      setState("seeing")
      const photo = ctx.message.photo.at(-1)!
      info("Telegram", "Downloading photo...")
      const imagePath = await saveTelegramPhoto(bot, telegramToken, photo.file_id, uploadsDir)
      info("Telegram", `Photo saved to: ${imagePath}`)

      setState("thinking")
      const answer = await askPiWithRetry(ctx.chat.id, `${caption}\n\nImagen local: ${imagePath}`)
      const stripped = stripMarkdown(answer)
      stopTyping(typing)
      emitMessage(stripped)
      await deliverReply(ctx, stripped, false)
      setState("idle")
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
    } catch (err: any) {
      logError("Bot", `Failed to process photo: ${err}`)
      setState("error")
      emitError(err?.message)
    } finally {
      stopTyping(typing)
    }
  })
})

async function handleIncomingAudio(ctx: Context, fileId: string, ext: string) {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  info("Telegram", `Received audio from @${username}`)

  // STT apagado: no descargamos ni transcribimos, contestamos al momento.
  if (!sttEnabled) {
    info("Telegram", "STT disabled; replying without transcription")
    setState("idle")
    await ctx.reply(sttDisabledMessage)
    return
  }

  await enqueue(ctx.chat!.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat!.id)
    let audioPath: string | undefined
    try {
      setState("listening")
      info("Telegram", "Downloading audio...")
      audioPath = await saveTelegramFile(bot, telegramToken, fileId, uploadsDir, ext)

      let transcript: string
      try {
        transcript = sttLocalEnabled
          ? await transcribeLocal(audioPath)
          : await transcribeAudio(audioPath)
      } catch (err) {
        logError("Telegram", `Transcription failed: ${err}`)
        setState("error")
        await ctx.reply("No pude entender el audio. Prueba de nuevo o escríbeme el mensaje.")
        return
      }

      info("Telegram", `Transcript: "${transcript.slice(0, 100)}"`)

      if (needsApproval(transcript) && !hasApproval(transcript)) {
        info("Telegram", "Transcribed message requires approval. Sending approval warning.")
        emitConfirmRequest(transcript, ctx.chat!.id)
        await ctx.reply(approvalMessage)
        return
      }

      setState("thinking")
      const answer = await askPiWithRetry(ctx.chat!.id, transcript)
      const stripped = stripMarkdown(answer)
      stopTyping(typing)
      emitMessage(stripped)
      await deliverReply(ctx, stripped, true)
      setState("idle")
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
    } catch (err: any) {
      logError("Bot", `Failed to process audio: ${err}`)
      setState("error")
      emitError(err?.message)
    } finally {
      stopTyping(typing)
      if (audioPath) {
        await unlink(audioPath).catch(() => {})
      }
    }
  })
}

bot.on("message:voice", async (ctx) => {
  await handleIncomingAudio(ctx, ctx.message.voice.file_id, "ogg")
})

bot.on("message:audio", async (ctx) => {
  await handleIncomingAudio(ctx, ctx.message.audio.file_id, "mp3")
})

async function checkOllama() {
  try {
    const res = await fetch(llmModelsEndpoint(), { headers: llmHeaders(), signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    if (isOpenAiApi()) {
      const data = (await res.json()) as { data?: Array<{ id?: string }> }
      const names = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
      info("Ollama", `Ping OK \u2014 API OpenAI-compatible, ${names.length} modelo(s): ${names.slice(0, 3).join(", ")}`)
    } else {
      const version = await fetch(`${llmBaseUrl()}/api/version`, { signal: AbortSignal.timeout(5000) })
      const data = (await version.json()) as { version?: string }
      info("Ollama", `Ping OK \u2014 version: ${data.version ?? "desconocida"}`)
    }
    return true
  } catch (err) {
    logError("Ollama", `Ping FAILED \u2014 el servidor no responde en ${llmBaseUrl()}: ${err}`)
    info("Ollama", "El bot arrancara pero las consultas fallaran hasta que el servidor este disponible.")
    setState("offline")
    return false
  }
}

function registerCommandHandler(): void {
  setCommandHandler((cmd: UiCommand) => {
    const chatId = telegramChatId ? Number(telegramChatId) : 0

    switch (cmd.type) {
      case "mara:interrupt":
        info("Events", "UI interrupt received")
        cancelRequest(chatId)
        break

      case "mara:confirm-response": {
        const pending = pendingConfirms.get(cmd.data.id)
        if (!pending) {
          warn("Events", `Confirm ${cmd.data.id} not found or already resolved`)
          return
        }
        pendingConfirms.delete(cmd.data.id)
        if (cmd.data.accepted) {
          info("Events", `Confirm ${cmd.data.id} accepted — processing`)
          const confirmedMessage = `Confirmo ${pending.message}`
          enqueue(pending.chatId, async () => {
            const typing = startTyping(pending.chatId)
            try {
              setState("thinking")
              const answer = await askPiWithRetry(pending.chatId, confirmedMessage)
              const stripped = stripMarkdown(answer)
              stopTyping(typing)
              emitMessage(stripped)
              await bot.api.sendMessage(pending.chatId, stripped)
              setState("idle")
            } catch (err: any) {
              logError("Bot", `Failed to process confirmed message: ${err}`)
              setState("error")
              emitError(err?.message)
            } finally {
              stopTyping(typing)
            }
          })
        } else {
          info("Events", `Confirm ${cmd.data.id} rejected`)
          bot.api.sendMessage(pending.chatId, "Acción cancelada.").catch(() => {})
        }
        break
      }

      case "mara:start-listening":
        info("Events", "UI start-listening received")
        setState("listening")
        break

      case "mara:stop-listening":
        info("Events", "UI stop-listening received")
        setState("idle")
        break

      case "mara:settings":
        info("Events", `UI settings: ${JSON.stringify(cmd.data)}`)
        break
    }
  })
}

// Procesa audio PCM del micrófono del navegador (reenviado por el bridge):
// lo transcribe y responde por el mismo flujo que un mensaje de Telegram.
async function handleBrowserAudio(wav: Buffer): Promise<void> {
  const chatId = telegramChatId ? Number(telegramChatId) : 0
  const audioPath = join(uploadsDir, `browser-${Date.now()}.wav`)
  let transcript: string | undefined
  const t0 = Date.now()

  // STT apagado: ni siquiera escribimos el clip a disco ni cargamos whisper.
  if (!sttEnabled) {
    info("Telegram", `[mic] STT disabled; ${wav.length} bytes descartados`)
    setState("idle")
    emitError(sttDisabledMessage)
    return
  }

  await enqueue(chatId, async () => {
    try {
      await mkdir(uploadsDir, { recursive: true })
      await writeFile(audioPath, wav)
      const durSec = wav.length / 32000
      info("Telegram", `[mic] clip: ${wav.length} bytes (${durSec.toFixed(2)}s), ruta=${audioPath}`)
      // Procesando: pasamos a thinking (no a listening, que rearmaría el mic del navegador y causaría bucle).
      setState("thinking")
      try {
        transcript = sttLocalEnabled
          ? await transcribeLocal(audioPath)
          : await transcribeAudio(audioPath)
        info("Telegram", `[mic] transcripción (${((Date.now() - t0) / 1000).toFixed(2)}s): "${transcript}"`)
      } catch (err) {
        logError("Telegram", `[mic] transcription failed: ${err}`)
        setState("error")
        emitError("No pude entender el audio del micrófono del navegador.")
        return
      }

      // Filtro de realimentación: si whisper no detectó voz (solo música,
      // ruido o silencio, marcado con [...]), no procesamos ese clip para
      // evitar bucles donde el mic captura la propia salida de audio.
      const meaningful = isMeaningfulTranscription(transcript)
      info("Telegram", `[mic] ¿voz real? ${meaningful ? "SÍ" : "NO"} → ${meaningful ? "procesando" : "ignorando clip"}`)
      if (!meaningful) {
        info("Telegram", `[mic] Ignored (sin voz): "${transcript}"`)
        setState("idle")
        return
      }

      setState("thinking")
      info("Telegram", `[mic] enviando a Ollama (${transcript.slice(0, 60)})…`)
      const answer = await askPiWithRetry(chatId, transcript)
      const stripped = stripMarkdown(answer)
      info("Telegram", `[mic] respuesta Ollama (${((Date.now() - t0) / 1000).toFixed(2)}s): "${stripped.slice(0, 80)}"`)
      emitMessage(stripped)
      if (telegramChatId) {
        // Espejado a Telegram: transcripción del usuario + respuesta de Mara.
        const mirrored = `🎤 ${maraUserName}: ${transcript}\n\nMara: ${stripped}`
        await bot.api.sendMessage(chatId, mirrored)
        info("Telegram", `[mic] Enviado a Telegram (chat ${chatId})`)
      } else {
        warn("Telegram", "[mic] TELEGRAM_CHAT_ID no configurado: no se envió la transcripción/respuesta a Telegram")
      }
      // Respuesta de voz para la propia UI: generamos el TTS y se lo mandamos
      // para que lo reproduzca en el dispositivo. Orquestamos el ciclo de habla
      // aquí para que la UI siga en "speaking" mientras reproduce el audio.
      if (voiceboxEnabled) {
        try {
          emitSpeakingStarted()
          const wav = await generateVoice(stripped, false)
          emitVoiceAudio(stripped, wav)
          emitSpeakingFinished()
          info("Telegram", `[mic] Voz generada para la UI (${wav.length} bytes)`)
        } catch (err) {
          logError("Bot", `[mic] TTS para la UI falló: ${err}`)
          emitSpeakingFinished()
        }
      }
      setState("idle")
      info("Telegram", `[mic] Replied to browser audio (audio)`)
    } catch (err: any) {
      logError("Bot", `[mic] Failed to process browser audio: ${err}`)
      setState("error")
      emitError(err?.message)
    } finally {
      await unlink(audioPath).catch(() => {})
    }
  })
}

function registerAudioHandler(): void {
  setAudioHandler((wav) => {
    void handleBrowserAudio(wav)
  })
}

async function gracefulShutdown(signal: string) {
  info("Bot", `Received ${signal}, shutting down gracefully...`)
  await closeMcpClients()
  const memoryManager = getMemoryManager()
  await memoryManager.close()
  closeUiEvents()
  bot.stop()
  info("Bot", "Bot stopped.")
  process.exit(0)
}

async function start() {
  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))

  startUiEvents()
  registerCommandHandler()
  registerAudioHandler()
  await initMcpClients()
  await runMemoryMigration()
  info("Bot", `Telegram token present: ${telegramToken ? "yes" : "no"}`)
  const llm = getActiveLlm()
  info("Bot", `Inference: ${llm.provider} (${llm.dialect}) ${llm.url} · model ${llm.model}`)
  await checkOllama()
  await checkVoicebox()
  info("Bot", "Starting Telegram bot...")

  try {
    const me = await bot.api.getMe()
    info("Bot", `Bot @${me.username} is running successfully!`)
    if (telegramChatId && startupWelcome) {
      const welcome = await buildWelcomeText(maraUserName, me.username)
      const sent = await sendWelcome(Number(telegramChatId), welcome, (id, text) => bot.api.sendMessage(id, text))
      info("Bot", `Startup message sent to chat ${telegramChatId} (${sent} mensaje(s))`)
    } else if (!startupWelcome) {
      info("Bot", "Startup welcome disabled (STARTUP_WELCOME=false)")
    }
  } catch (err) {
    logError("Bot", `Failed to start: ${err}`)
  }

  bot.start().catch((err) => {
    logError("Bot", `Bot polling failed: ${err}`)
  })
}

start()
