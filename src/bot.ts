import { Bot, InputFile, type Context } from "grammy"
import { appendFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import { approvalMessage, hasApproval, needsApproval } from "./approvals.js"
import { saveTelegramPhoto, saveTelegramFile } from "./telegram-files.js"
import { telegramToken, telegramChatId, uploadsDir, ollamaUrl, ollamaModel, agentDir, timezone, voiceboxEnabled, telegramSendVoiceDefault, sttLocalEnabled } from "./config.js"
import { initMcpClients, closeMcpClients, callServerTool, getConnectedMcpServerNames, getRegisteredToolNames, getMemoryMode } from "./mcp.js"
import { askPiWithRetry, clearChatHistory, cancelRequest, getChatHistoryMessageCount } from "./ollama.js"
import { getSkillList, loadSkillsContext, reloadSkills } from "./skills.js"
import { readContextFile } from "./cache.js"
import { info, error as logError } from "./logger.js"
import { generateVoice, transcribeAudio, checkVoicebox } from "./voicebox.js"
import { transcribeLocal } from "./stt.js"
import { wavToOggOpus } from "./audio.js"

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

function wantVoiceFor(chatId: number, isAudioInput: boolean): boolean {
  if (voiceOverrides.has(chatId)) return voiceOverrides.get(chatId)!  // /voz manda
  if (telegramSendVoiceDefault) return true                          // voz global on (compat)
  return isAudioInput                                                // default: imitar entrada
}

// Genera y envía la respuesta como NOTA DE VOZ (OGG/Opus). Devuelve true si se envió audio.
// No aplica si el texto es muy largo; si Voicebox o la transcodificación fallan, no rompe.
async function trySendVoice(ctx: Context, text: string): Promise<boolean> {
  if (text.length > 500) return false
  const action = startAction(ctx.chat!.id, "record_voice")
  try {
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

bot.catch(async (err) => {
  const ctx = err.ctx
  logError("Bot", `Error while handling update ${ctx.update.update_id}: ${err.error}`)
  try {
    await ctx.reply("Ups, ocurrió un error al procesar tu mensaje. Inténtalo de nuevo.")
  } catch {
    // ignore reply errors
  }
})

bot.command("start", async (ctx) => {
  clearChatHistory(ctx.chat.id)
  const name = ctx.from?.first_name || "there"
  await ctx.reply(
    `Hola ${name}! Soy Mara, tu asistente personal.\n\n` +
    `Puedo ayudarte con tu calendario, notas, tareas y mas.\n` +
    `Escribe /help para ver todo lo que puedo hacer.`
  )
})

bot.command("reset", async (ctx) => {
  clearChatHistory(ctx.chat.id)
  await ctx.reply("Historial limpio. Empezamos de cero.")
})

bot.command("help", async (ctx) => {
  const skills = await getSkillList()
  const skillList = skills.length > 0
    ? skills.map(s => `  - ${s}`).join("\n")
    : "  (ninguno)"

  const fileNames = ["SOUL.md", "USER.md", "AGENTS.md", "MEMORY.md"]
  const fileStats: string[] = []
  for (const name of fileNames) {
    try {
      const content = await readContextFile(agentDir, name)
      fileStats.push(`  ${name}: ${content.length} chars`)
    } catch {
      fileStats.push(`  ${name}: (no existe)`)
    }
  }

  const lines = [
    "Mara OS \u2014 Asistente personal de Kike",
    "",
    "Modelo:",
    `  ${ollamaModel} (${ollamaUrl})`,
    "",
    "Contexto:",
    ...fileStats,
    "",
    "Que puedo hacer:",
    "  \u2022 Responder preguntas y mantener conversacion",
    "  \u2022 Gestionar tu calendario (reuniones, citas, recordatorios)",
    "  \u2022 Crear y administrar notas y tareas",
    "  \u2022 Automatizar el Mac (abrir apps, ejecutar scripts)",
    "  \u2022 Recordar datos importantes (memoria persistente)",
    "  \u2022 Procesar fotos que me envies",
    "",
    "Comandos:",
    "  /help \u2014 Mostrar esta ayuda",
    "  /status \u2014 Ver estado del sistema",
    "  /cancel \u2014 Cancelar operacion en curso",
    "  /memory \u2014 Buscar recuerdos (ej: /memory que dije ayer)",
    "  /memory forget <id> \u2014 Olvidar un recuerdo",
    "  /skill lista \u2014 Ver skills disponibles",
    "  /skill nombre \u2014 Cargar un skill especifico",
    "  /skill recargar \u2014 Recargar skills desde disco",
    "  /context \u2014 Ver contexto de ejecucion actual",
    "  /voz on | /voz off \u2014 Activar/desactivar salida de voz",
    "  /feedback <texto> \u2014 Enviar opinion sobre el bot",
    "",
    `Skills (${skills.length}):`,
    skillList,
  ]

  await ctx.reply(lines.join("\n"))
})

bot.command("status", async (ctx) => {
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
    `Modelo: ${ollamaModel}`,
    `Ollama: ${ollamaUrl}`,
    "",
    "Archivos de contexto:",
    ...fileStats,
    "",
    `Skills (${skills.length}):`,
    ...skills.map(s => `  - ${s}`),
  ]

  await ctx.reply(lines.join("\n"))
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
  const historyCount = getChatHistoryMessageCount(ctx.chat.id)
  const connectedResources = getConnectedMcpServerNames()
  const tools = getRegisteredToolNames()
  const datetime = formatDateTimeWithOffset(new Date(), timezone)

  const lines = [
    "execution_context:",
    `  datetime: "${datetime}"`,
    `  timezone: "${timezone}"`,
    "",
    "  context_files:",
    ...fileStates.map(file => `    ${file.name}: ${file.status}`),
    "",
    "  conversation:",
    `    messages: ${historyCount}`,
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
    "",
    "  memory:",
    `    status: ${memoryStatus}`,
    `    mode: ${getMemoryMode()}`,
    `    entries: ${memoryEntries}`,
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
  const query = args.join(" ")

  const typing = startTyping(ctx.chat.id)
  try {
    if (query.startsWith("forget ")) {
      const id = query.slice(7).trim()
      const result = await callServerTool("engram", "forget", { id })
      await ctx.reply(stripMarkdown(result || "Olvidado."))
    } else {
      const result = await callServerTool("engram", "recall", { query: query || "recuerdos recientes" })
      await ctx.reply(stripMarkdown(result || "No tengo recuerdos sobre eso."))
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
    await ctx.reply("Usa: /voz on | /voz off")
  }
})

bot.on("message:text", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  info("Telegram", `Received text from @${username}: "${ctx.message.text.slice(0, 100)}"`)

  if (needsApproval(ctx.message.text) && !hasApproval(ctx.message.text)) {
    info("Telegram", "Message requires approval. Sending approval warning.")
    await ctx.reply(approvalMessage)
    return
  }

  await enqueue(ctx.chat.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat.id)
    try {
      const answer = await askPiWithRetry(ctx.chat.id, ctx.message.text)
      const stripped = stripMarkdown(answer)
      stopTyping(typing) // ya tenemos la respuesta; deliverReply gestiona su propio indicador de voz
      await deliverReply(ctx, stripped, false)
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
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
    await ctx.reply(approvalMessage)
    return
  }

  await enqueue(ctx.chat.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat.id)
    try {
      const photo = ctx.message.photo.at(-1)!
      info("Telegram", "Downloading photo...")
      const imagePath = await saveTelegramPhoto(bot, telegramToken, photo.file_id, uploadsDir)
      info("Telegram", `Photo saved to: ${imagePath}`)

      const answer = await askPiWithRetry(ctx.chat.id, `${caption}\n\nImagen local: ${imagePath}`)
      const stripped = stripMarkdown(answer)
      stopTyping(typing)
      await deliverReply(ctx, stripped, false)
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
    } finally {
      stopTyping(typing)
    }
  })
})

async function handleIncomingAudio(ctx: Context, fileId: string, ext: string) {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  info("Telegram", `Received audio from @${username}`)

  await enqueue(ctx.chat!.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat!.id)
    let audioPath: string | undefined
    try {
      info("Telegram", "Downloading audio...")
      audioPath = await saveTelegramFile(bot, telegramToken, fileId, uploadsDir, ext)

      let transcript: string
      try {
        transcript = sttLocalEnabled
          ? await transcribeLocal(audioPath)
          : await transcribeAudio(audioPath)
      } catch (err) {
        logError("Telegram", `Transcription failed: ${err}`)
        await ctx.reply("No pude entender el audio. Prueba de nuevo o escríbeme el mensaje.")
        return
      }

      info("Telegram", `Transcript: "${transcript.slice(0, 100)}"`)

      if (needsApproval(transcript) && !hasApproval(transcript)) {
        info("Telegram", "Transcribed message requires approval. Sending approval warning.")
        await ctx.reply(approvalMessage)
        return
      }

      const answer = await askPiWithRetry(ctx.chat!.id, transcript)
      const stripped = stripMarkdown(answer)
      stopTyping(typing)
      await deliverReply(ctx, stripped, true)
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
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
    const res = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { version: string }
    info("Ollama", `Ping OK \u2014 version: ${data.version}`)
    return true
  } catch (err) {
    logError("Ollama", `Ping FAILED \u2014 Ollama no responde en ${ollamaUrl}: ${err}`)
    info("Ollama", "El bot arrancara pero las consultas fallaran hasta que Ollama este disponible.")
    return false
  }
}

async function gracefulShutdown(signal: string) {
  info("Bot", `Received ${signal}, shutting down gracefully...`)
  await closeMcpClients()
  bot.stop()
  info("Bot", "Bot stopped.")
  process.exit(0)
}

async function start() {
  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))

  await initMcpClients()
  info("Bot", `Telegram token present: ${telegramToken ? "yes" : "no"}`)
  info("Bot", `Ollama endpoint: ${ollamaUrl}`)
  await checkOllama()
  await checkVoicebox()
  info("Bot", "Starting Telegram bot...")
  bot.start().catch((err) => {
    logError("Bot", `Failed to start: ${err}`)
  })
  bot.api.getMe().then((me) => {
    info("Bot", `Bot @${me.username} is running successfully!`)
    if (telegramChatId) {
      const now = new Date().toLocaleString("es-ES", { timeZone: process.env.TIMEZONE || "Europe/Madrid", dateStyle: "full", timeStyle: "medium" })
      bot.api.sendMessage(telegramChatId, `🤖 Mara OS iniciado\n✅ Bot @${me.username} corriendo\n🕐 ${now}`).catch((err) => logError("Bot", `Failed to send startup message: ${err}`))
    }
  }).catch((err) => {
    logError("Bot", `Failed to get bot info: ${err}`)
  })
}

start()
