import { Bot } from "grammy"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { approvalMessage, hasApproval, needsApproval } from "./approvals.js"
import { saveTelegramPhoto } from "./telegram-files.js"
import { telegramToken, uploadsDir, ollamaUrl, ollamaModel, agentDir } from "./config.js"
import { initMcpClients, closeMcpClients, callServerTool } from "./mcp.js"
import { askPiWithRetry, clearChatHistory, cancelRequest } from "./ollama.js"
import { getSkillList, loadSkillsContext, reloadSkills } from "./skills.js"
import { readContextFile } from "./cache.js"
import { info, error as logError } from "./logger.js"

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

const bot = new Bot(telegramToken)

const chatQueues = new Map<number, Promise<void>>()

function enqueue(chatId: number, fn: () => Promise<void>): Promise<void> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId)
  })
  chatQueues.set(chatId, next)
  return next
}

function startTyping(chatId: number) {
  const interval = setInterval(() => {
    bot.api.sendChatAction(chatId, "typing").catch(() => {})
  }, 4000)
  return interval
}

function stopTyping(interval: ReturnType<typeof setInterval>) {
  clearInterval(interval)
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
      await ctx.reply(stripMarkdown(answer))
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
      await ctx.reply(stripMarkdown(answer))
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
    } finally {
      stopTyping(typing)
    }
  })
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
  info("Bot", "Starting Telegram bot...")
  bot.start().catch((err) => {
    logError("Bot", `Failed to start: ${err}`)
  })
  bot.api.getMe().then((me) => {
    info("Bot", `Bot @${me.username} is running successfully!`)
  }).catch((err) => {
    logError("Bot", `Failed to get bot info: ${err}`)
  })
}

start()
