import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Bot } from "grammy"
import { approvalMessage, hasApproval, needsApproval } from "./approvals.js"
import { saveTelegramPhoto } from "./telegram-files.js"
import { telegramToken, uploadsDir, ollamaUrl, ollamaModel, agentDir } from "./config.js"
import { initMcpClients } from "./mcp.js"
import { askPi } from "./ollama.js"

const bot = new Bot(telegramToken)

bot.catch((err) => {
  const ctx = err.ctx
  console.error(`[Error] Error while handling update ${ctx.update.update_id}:`, err.error)
})

bot.command("help", async (ctx) => {
  const fileNames = ["SOUL.md", "USER.md", "AGENTS.md", "MEMORY.md"]
  const fileStats: string[] = []
  for (const name of fileNames) {
    try {
      const content = await readFile(join(agentDir, name), "utf8")
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
  ]

  await ctx.reply(lines.join("\n"))
})

bot.command("status", async (ctx) => {
  const fileNames = ["SOUL.md", "USER.md", "AGENTS.md", "MEMORY.md"]
  const fileStats: string[] = []
  for (const name of fileNames) {
    try {
      const content = await readFile(join(agentDir, name), "utf8")
      const preview = content.slice(0, 60).replace(/\n/g, " ")
      fileStats.push(`  ${name}: ${content.length} chars`)
      fileStats.push(`    Preview: "${preview}..."`)
    } catch {
      fileStats.push(`  ${name}: (no existe)`)
    }
  }

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
  ]

  await ctx.reply(lines.join("\n"))
})

bot.on("message:text", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  console.log(`[Telegram] Received text from @${username}: "${ctx.message.text}"`)

  if (needsApproval(ctx.message.text) && !hasApproval(ctx.message.text)) {
    console.log(`[Telegram] Message requires approval. Sending approval warning.`)
    await ctx.reply(approvalMessage)
    return
  }

  const answer = await askPi(ctx.chat.id, ctx.message.text)
  await ctx.reply(answer)
  console.log(`[Telegram] Replied to @${username}`)
})

bot.on("message:photo", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  const caption = ctx.message.caption ?? "Kike ha enviado una imagen."
  console.log(`[Telegram] Received photo from @${username} with caption: "${caption}"`)

  if (needsApproval(caption) && !hasApproval(caption)) {
    console.log(`[Telegram] Photo message requires approval. Sending approval warning.`)
    await ctx.reply(approvalMessage)
    return
  }

  const photo = ctx.message.photo.at(-1)!
  console.log(`[Telegram] Downloading photo...`)
  const imagePath = await saveTelegramPhoto(bot, telegramToken, photo.file_id, uploadsDir)
  console.log(`[Telegram] Photo saved to: ${imagePath}`)

  const answer = await askPi(ctx.chat.id, `${caption}\n\nImagen local: ${imagePath}`)
  await ctx.reply(answer)
  console.log(`[Telegram] Replied to @${username}`)
})

async function checkOllama() {
  try {
    const res = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { version: string }
    console.log(`[Ollama] Ping OK \u2014 version: ${data.version}`)
    return true
  } catch (err) {
    console.error(`[Ollama] Ping FAILED \u2014 Ollama no responde en ${ollamaUrl}:`, err)
    console.warn("[Ollama] El bot arrancara pero las consultas fallaran hasta que Ollama este disponible.")
    return false
  }
}

async function start() {
  await initMcpClients()
  console.log(`[Bot] Telegram token present: ${telegramToken ? "yes" : "no"}`)
  console.log(`[Bot] Ollama endpoint: ${ollamaUrl}`)
  await checkOllama()
  console.log("[Bot] Starting Telegram bot...")
  bot.start().catch((err) => {
    console.error("[Bot] Failed to start:", err)
  })
  bot.api.getMe().then((me) => {
    console.log(`[Bot] Bot @${me.username} is running successfully!`)
  }).catch((err) => {
    console.error("[Bot] Failed to get bot info:", err)
  })
}

start()
