import { writeFile } from "node:fs/promises"
import { agentDir, memoryPath, ollamaUrl, ollamaModel } from "./config.js"
import { ollamaTools, hasMemoryServer, callMcpTool } from "./mcp.js"
import { loadAllSkills, detectSkills, loadSkillsContext } from "./skills.js"
import { readContextFile } from "./cache.js"
import { info, error as logError, debug, warn } from "./logger.js"

interface ChatSession {
  messages: Array<{ role: "user" | "assistant" | "tool", content: string, name?: string, tool_calls?: any[] }>
  lastUsed: number
}

const chatHistories = new Map<number, ChatSession>()
const CHAT_TIMEOUT = 30 * 60 * 1000
const CLEANUP_INTERVAL = 5 * 60 * 1000

export function clearChatHistory(chatId: number) {
  chatHistories.delete(chatId)
  info("Ollama", `Chat history cleared for chat ${chatId}`)
}

const activeControllers = new Map<number, AbortController>()

export function cancelRequest(chatId: number) {
  const controller = activeControllers.get(chatId)
  if (controller) {
    controller.abort()
    activeControllers.delete(chatId)
    info("Ollama", `Request cancelled for chat ${chatId}`)
  }
}

function initCleanupTimer() {
  setInterval(() => {
    const now = Date.now()
    let cleaned = 0
    for (const [chatId, session] of chatHistories) {
      if (now - session.lastUsed > CHAT_TIMEOUT) {
        chatHistories.delete(chatId)
        cleaned++
      }
    }
    if (cleaned > 0) {
      info("Cleanup", `Removed ${cleaned} inactive chat session(s)`)
    }
  }, CLEANUP_INTERVAL)
}

export async function askPi(chatId: number, message: string) {
  const soul = await readContextFile(agentDir, "SOUL.md")
  const user = await readContextFile(agentDir, "USER.md")
  const agents = await readContextFile(agentDir, "AGENTS.md")
  const currentMemory = await readContextFile(agentDir, "MEMORY.md")
  const systemTemplate = await readContextFile(agentDir, "SYSTEM.md")
  debug("Memory", `Loaded MEMORY.md (${currentMemory.length} chars)`)

  const allSkills = await loadAllSkills()
  const detectedSkills = detectSkills(message, allSkills)
  const skillsContext = await loadSkillsContext(detectedSkills)
  if (detectedSkills.length > 0) {
    info("Skills", `Detected: ${detectedSkills.join(", ")}`)
  }

  const timezone = process.env.TIMEZONE || "Europe/Madrid"
  const currentDateTime = new Date().toLocaleString("es-ES", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "medium"
  })
  const systemPrompt = systemTemplate
    .replace("{{DATE_TIME}}", currentDateTime)
    .replace("{{TIMEZONE}}", timezone)
    .replace("{{SOUL}}", soul)
    .replace("{{USER}}", user)
    .replace("{{AGENTS}}", agents)
    .replace("{{MEMORY}}", currentMemory)
    .replace("{{SKILLS}}", skillsContext)
  debug("Prompt", `System prompt ready for chat ${chatId} (${systemPrompt.length} chars)`)

  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, { messages: [], lastUsed: Date.now() })
  }
  const session = chatHistories.get(chatId)!
  session.lastUsed = Date.now()
  const history = session.messages

  history.push({ role: "user", content: message })

  if (history.length > 20) {
    history.shift()
  }

  const controller = new AbortController()
  activeControllers.set(chatId, controller)

  const timeout = setTimeout(() => controller.abort(new Error("Timeout after 60s")), 60000)

  try {
    let loop = true
    let replyText = ""

    while (loop) {
      if (controller.signal.aborted) {
        throw controller.signal.reason || new Error("Request cancelled")
      }

      debug("Ollama", `Sending request to ${ollamaUrl}/api/chat using model: ${ollamaModel} (history size: ${history.length})...`)
      
      const tools = [
        ...(!hasMemoryServer ? [{
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
        }] : []),
        ...ollamaTools
      ]
      debug("Ollama", `Tools available: ${tools.map((tool: any) => tool.function?.name ?? "unknown").join(", ")}`)
      if (!hasMemoryServer) {
        info("Memory", `Using fallback update_memory tool because Engram is not connected`)
      }

      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
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
          tools: tools,
          tool_choice: "required",
          temperature: 0.3
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
    
    history.push({
      role: "assistant",
      content: assistantMessage.content || "",
      ...(assistantMessage.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {})
    })
    
    if (history.length > 20) {
      history.shift()
    }

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      info("Ollama", `Received ${assistantMessage.tool_calls.length} tool call(s)`)

      const toolResults = await Promise.all(
        assistantMessage.tool_calls.map(async (toolCall) => {
          const toolName = toolCall.function.name
          let toolArgs = toolCall.function.arguments

          if (typeof toolArgs === "string") {
            try {
              toolArgs = JSON.parse(toolArgs)
            } catch {
              // Keep as string
            }
          }

          debug("Tool", `Executing tool "${toolName}" with arguments: ${JSON.stringify(toolArgs)}`)

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
              debug("Memory", `Updated MEMORY.md with new contents: ${newMemory.slice(0, 50)}...`)
              resultStr = "Memoria actualizada correctamente."
            } else {
              resultStr = "Error: no se proporcionó contenido para actualizar la memoria."
            }
          } else {
            try {
              resultStr = await callMcpTool(toolName, toolArgs)
            } catch (err: any) {
              logError("MCP", `Error executing tool "${toolName}": ${err}`)
              resultStr = `Error executing tool: ${err?.message || err}`
            }
          }

          return { role: "tool" as const, content: resultStr }
        })
      )

      for (const result of toolResults) {
        history.push(result)
        if (history.length > 20) {
          history.shift()
        }
      }
    } else {
        debug("Ollama", `Final assistant message length: ${assistantMessage.content?.length ?? 0}`)
        const finalContent = assistantMessage.content?.trim() ?? "No he podido generar una respuesta.";
        replyText = finalContent;
        loop = false;
    }
    }

    return replyText || "Memoria actualizada."
  } finally {
    clearTimeout(timeout)
    if (activeControllers.get(chatId) === controller) {
      activeControllers.delete(chatId)
    }
  }
}

export async function askPiWithRetry(chatId: number, message: string, maxRetries = 2): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await askPi(chatId, message)
    } catch (err: any) {
      if (err?.name === "AbortError") throw err
      if (attempt === maxRetries - 1) {
        throw err
      }
      const delay = 1000 * Math.pow(2, attempt)
      warn("Ollama", `Request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms: ${err.message}`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error("Unexpected: askPiWithRetry exhausted retries")
}

initCleanupTimer()
