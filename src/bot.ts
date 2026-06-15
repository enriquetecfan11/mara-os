import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Bot } from "grammy"
import { approvalMessage, hasApproval, needsApproval } from "./approvals.js"
import { saveTelegramPhoto } from "./telegram-files.js"

const telegramToken = process.env.TELEGRAM_TOKEN!
const bot = new Bot(telegramToken)
const agentDir = join(process.cwd(), "config")
const skillsDir = join(agentDir, "skills")
const uploadsDir = join(agentDir, "uploads")
const memoryPath = join(agentDir, "MEMORY.md")

const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434"
const ollamaModel = process.env.OLLAMA_MODEL || "gemma4:e2b"

const chatHistories = new Map<number, Array<{ role: "user" | "assistant", content: string }>>()

async function askPi(chatId: number, message: string) {
  const soul = await readFile(join(agentDir, "SOUL.md"), "utf8")
  const user = await readFile(join(agentDir, "USER.md"), "utf8")
  const agents = await readFile(join(agentDir, "AGENTS.md"), "utf8")
  const currentMemory = await readFile(memoryPath, "utf8")

  const timezone = process.env.TIMEZONE || "Europe/Madrid"
  const currentDateTime = new Date().toLocaleString("es-ES", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "medium"
  })
  const systemPrompt = `Fecha y hora actual: ${currentDateTime} (Zona horaria: ${timezone})\n\nSOUL:\n${soul}\n\nUSER:\n${user}\n\nAGENTS:\n${agents}\n\nMEMORY:\n${currentMemory}`

  // Retrieve or initialize history for this chat
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, [])
  }
  const history = chatHistories.get(chatId)!

  // Add current message to history
  history.push({ role: "user", content: message })

  // Keep last 20 messages in context to avoid token bloat
  if (history.length > 20) {
    history.shift()
  }

  console.log(`[Ollama] Sending request to ${ollamaUrl}/api/chat using model: ${ollamaModel} (history size: ${history.length})...`)
  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...history,
      ],
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "update_memory",
            description: "Updates the MEMORY.md file with new or updated facts. Write the entire updated content of the MEMORY.md file.",
            parameters: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: "The complete, updated content for the MEMORY.md file."
                }
              },
              required: ["content"]
            }
          }
        }
      ]
    }),
  })

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as {
    message: {
      role: string
      content: string
      tool_calls?: Array<{
        function: {
          name: string
          arguments: any
        }
      }>
    }
  }

  // Handle tool calls if any
  if (data.message.tool_calls && data.message.tool_calls.length > 0) {
    for (const toolCall of data.message.tool_calls) {
      if (toolCall.function.name === "update_memory") {
        let newMemory = ""
        const args = toolCall.function.arguments
        if (typeof args === "string") {
          try {
            const parsed = JSON.parse(args)
            newMemory = parsed.content
          } catch {
            newMemory = args
          }
        } else if (args && typeof args === "object" && "content" in args) {
          newMemory = args.content
        }

        if (newMemory) {
          await writeFile(memoryPath, newMemory, "utf8")
          console.log(`[Memory] Updated MEMORY.md with new contents: ${newMemory}`)
        }
      }
    }
  }

  const replyText = data.message.content?.trim() || ""
  console.log(`[Ollama] Received response (${replyText.length} characters)`)

  // Add bot response to history
  if (replyText) {
    history.push({ role: "assistant", content: replyText })
    if (history.length > 20) {
      history.shift()
    }
  }

  return replyText || "Memoria actualizada."
}

bot.catch((err) => {
  const ctx = err.ctx
  console.error(`[Error] Error while handling update ${ctx.update.update_id}:`, err.error)
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

console.log("[Bot] Starting Telegram bot...")
bot.start().catch((err) => {
  console.error("[Bot] Failed to start:", err)
})
bot.api.getMe().then((me) => {
  console.log(`[Bot] Bot @${me.username} is running successfully!`)
}).catch((err) => {
  console.error("[Bot] Failed to get bot info:", err)
})
