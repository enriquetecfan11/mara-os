import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Bot } from "grammy"
import { approvalMessage, hasApproval, needsApproval } from "./approvals.js"
import { saveTelegramPhoto } from "./telegram-files.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const telegramToken = process.env.TELEGRAM_TOKEN!
const bot = new Bot(telegramToken)
const agentDir = join(process.cwd(), "config")
const skillsDir = join(agentDir, "skills")
const uploadsDir = join(agentDir, "uploads")
const memoryPath = join(agentDir, "MEMORY.md")

const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434"
const ollamaModel = process.env.OLLAMA_MODEL || "gemma4:e2b"

const chatHistories = new Map<number, Array<{ role: "user" | "assistant" | "tool", content: string, name?: string, tool_calls?: any[] }>>()

interface McpServerConfig {
  name: string
  url: string
}

interface McpConfig {
  servers: McpServerConfig[]
}

const clientsMap = new Map<string, Client>()
const toolToClientMap = new Map<string, Client>()
let ollamaTools: Array<any> = []

async function initMcpClients() {
  try {
    const mcpConfigPath = join(process.cwd(), "mcp.json")
    const mcpConfigContent = await readFile(mcpConfigPath, "utf8")
    const mcpConfig = JSON.parse(mcpConfigContent) as McpConfig

    for (const server of mcpConfig.servers) {
      console.log(`[MCP] Connecting to server "${server.name}" at ${server.url}...`)
      try {
        const transport = new StreamableHTTPClientTransport(new URL(server.url))
        const client = new Client(
          { name: `mara-os-client-${server.name}`, version: "1.0.0" },
          { capabilities: {} }
        )
        await client.connect(transport)
        clientsMap.set(server.name, client)
        console.log(`[MCP] Connected to server "${server.name}"`)

        const toolsResult = await client.listTools()
        console.log(`[MCP] Server "${server.name}" tools:`, toolsResult.tools.map(t => t.name))
        
        for (const tool of toolsResult.tools) {
          toolToClientMap.set(tool.name, client)
          
          ollamaTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || "",
              parameters: tool.inputSchema || {
                type: "object",
                properties: {}
              }
            }
          })
        }
      } catch (err) {
        console.error(`[MCP] Failed to connect to server "${server.name}":`, err)
      }
    }
  } catch (err) {
    console.error(`[MCP] Error reading or parsing mcp.json:`, err)
  }
}

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

  let loop = true
  let replyText = ""

  while (loop) {
    console.log(`[Ollama] Sending request to ${ollamaUrl}/api/chat using model: ${ollamaModel} (history size: ${history.length})...`)
    
    const tools = [
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
      },
      ...ollamaTools
    ]

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
        tools: tools
      }),
    })

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as {
      message: {
        role: "assistant"
        content: string
        tool_calls?: Array<{
          function: {
            name: string
            arguments: any
          }
        }>
      }
    }

    const assistantMessage = data.message
    
    // Store assistant response in history
    history.push({
      role: "assistant",
      content: assistantMessage.content || "",
      ...(assistantMessage.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {})
    })
    
    if (history.length > 20) {
      history.shift()
    }

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      console.log(`[Ollama] Received tool calls:`, JSON.stringify(assistantMessage.tool_calls))
      
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name
        let toolArgs = toolCall.function.arguments

        if (typeof toolArgs === "string") {
          try {
            toolArgs = JSON.parse(toolArgs)
          } catch {
            // Keep as string
          }
        }

        console.log(`[Tool] Executing tool "${toolName}" with arguments:`, toolArgs)

        let resultStr = ""
        if (toolName === "update_memory") {
          let newMemory = ""
          if (toolArgs && typeof toolArgs === "object" && "content" in toolArgs) {
            newMemory = toolArgs.content
          } else if (typeof toolArgs === "string") {
            newMemory = toolArgs
          }
          if (newMemory) {
            await writeFile(memoryPath, newMemory, "utf8")
            console.log(`[Memory] Updated MEMORY.md with new contents: ${newMemory}`)
            resultStr = "Memoria actualizada correctamente."
          } else {
            resultStr = "Error: no se proporcionó contenido para actualizar la memoria."
          }
        } else {
          const client = toolToClientMap.get(toolName)
          if (client) {
            try {
              console.log(`[MCP] Calling tool "${toolName}" on server...`)
              const callResult = await client.callTool({
                name: toolName,
                arguments: toolArgs
              })
              resultStr = JSON.stringify(callResult)
              console.log(`[MCP] Tool "${toolName}" returned:`, resultStr)
            } catch (err: any) {
              console.error(`[MCP] Error executing tool "${toolName}":`, err)
              resultStr = `Error executing tool: ${err?.message || err}`
            }
          } else {
            console.error(`[Tool] Tool "${toolName}" client not found`)
            resultStr = `Error: Tool "${toolName}" client not found.`
          }
        }

        // Push tool result to history as required by the agentic loop
        history.push({
          role: "tool",
          content: JSON.stringify(resultStr)
        })

        if (history.length > 20) {
          history.shift()
        }
      }
    } else {
        // Final assistant message without tool calls – exit loop
        console.log("[Debug] Final message:", JSON.stringify(assistantMessage));
        const finalContent = assistantMessage.content?.trim() ?? "No he podido generar una respuesta.";
        replyText = finalContent;
        loop = false;
        // Continue to loop termination
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

async function start() {
  await initMcpClients()
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
