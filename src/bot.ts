import { Bot } from "grammy"
import { approvalMessage, hasApproval, needsApproval } from "./approvals.js"
import { saveTelegramPhoto } from "./telegram-files.js"
import { telegramToken, uploadsDir, ollamaUrl, ollamaModel, agentDir } from "./config.js"
import { initMcpClients, closeMcpClients } from "./mcp.js"
import { askPi, clearChatHistory } from "./ollama.js"
import { getSkillList, loadSkillsContext, reloadSkills } from "./skills.js"
import { readContextFile } from "./cache.js"
import { info, error as logError } from "./logger.js"

const bot = new Bot(telegramToken)

bot.catch((err) => {
  const ctx = err.ctx
  logError("Bot", `Error while handling update ${ctx.update.update_id}: ${err.error}`)
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
    "  /skill lista \u2014 Ver skills disponibles",
    "  /skill nombre \u2014 Cargar un skill especifico",
    "  /skill recargar \u2014 Recargar skills desde disco",
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

bot.on("message:text", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  info("Telegram", `Received text from @${username}: "${ctx.message.text}"`)

  if (needsApproval(ctx.message.text) && !hasApproval(ctx.message.text)) {
    info("Telegram", "Message requires approval. Sending approval warning.")
    await ctx.reply(approvalMessage)
    return
  }

  const answer = await askPi(ctx.chat.id, ctx.message.text)
  await ctx.reply(answer)
  info("Telegram", `Replied to @${username}`)
})

bot.on("message:photo", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  const caption = ctx.message.caption ?? "Kike ha enviado una imagen."
  info("Telegram", `Received photo from @${username} with caption: "${caption}"`)

  if (needsApproval(caption) && !hasApproval(caption)) {
    info("Telegram", "Photo message requires approval. Sending approval warning.")
    await ctx.reply(approvalMessage)
    return
  }

  const photo = ctx.message.photo.at(-1)!
  info("Telegram", "Downloading photo...")
  const imagePath = await saveTelegramPhoto(bot, telegramToken, photo.file_id, uploadsDir)
  info("Telegram", `Photo saved to: ${imagePath}`)

  const answer = await askPi(ctx.chat.id, `${caption}\n\nImagen local: ${imagePath}`)
  await ctx.reply(answer)
  info("Telegram", `Replied to @${username}`)
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
