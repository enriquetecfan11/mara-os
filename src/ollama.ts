import { ollamaUrl, ollamaModel } from "./config.js"
import { ollamaTools, callMcpTool } from "./mcp.js"
import { loadAllSkills, detectSkills, loadSkillsContext } from "./skills.js"
import { readContextFile } from "./cache.js"
import { info, error as logError, debug, warn } from "./logger.js"
import { getMemoryManager, initializeMemory } from "./memory/index.js"
import { buildContext } from "./memory/context-builder.js"
import { extractAndStoreMemories } from "./memory/memory-extractor.js"

interface ChatSession {
  lastUsed: number
}

const chatSessions = new Map<number, ChatSession>()
const CHAT_TIMEOUT = 30 * 60 * 1000
const CLEANUP_INTERVAL = 5 * 60 * 1000

const MAX_CONVERSATION_TOKENS = 6000
const MAX_MEMORY_TOKENS = 1500
const MEMORY_SEARCH_LIMIT = 5

export function clearChatHistory(chatId: number) {
  chatSessions.delete(chatId)
  info("Ollama", `Chat session cleared for chat ${chatId}`)
}

export function getChatHistoryMessageCount(chatId: number): number {
  return 0
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
    for (const [chatId, session] of chatSessions) {
      if (now - session.lastUsed > CHAT_TIMEOUT) {
        chatSessions.delete(chatId)
        cleaned++
      }
    }
    if (cleaned > 0) {
      info("Cleanup", `Removed ${cleaned} inactive chat session(s)`)
    }
  }, CLEANUP_INTERVAL)
}

export async function askPi(chatId: number, message: string) {
  const memoryManager = await initializeMemory()

  if (!chatSessions.has(chatId)) {
    chatSessions.set(chatId, { lastUsed: Date.now() })
  }
  const session = chatSessions.get(chatId)!
  session.lastUsed = Date.now()

  await memoryManager.addConversationMessage(chatId, {
    role: "user",
    content: message,
    timestamp: Date.now(),
  })

  const { systemPrompt, recentMessages } = await buildContext(memoryManager, {
    chatId,
    userMessage: message,
    maxConversationTokens: MAX_CONVERSATION_TOKENS,
    maxMemoryTokens: MAX_MEMORY_TOKENS,
    memorySearchLimit: MEMORY_SEARCH_LIMIT,
  })

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

      const messages = [
        { role: "system" as const, content: systemPrompt },
        ...recentMessages.map((m) => ({ role: m.role as "user" | "assistant" | "tool", content: m.content })),
      ]

      debug("Ollama", `Sending request to ${ollamaUrl}/api/chat using model: ${ollamaModel} (${messages.length} messages)...`)

      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: ollamaModel,
          messages,
          stream: false,
          tools: ollamaTools,
          tool_choice: ollamaTools.length > 0 ? "required" : "none",
          temperature: 0.3,
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

            try {
              const resultStr = await callMcpTool(toolName, toolArgs)
              return { role: "tool" as const, content: resultStr }
            } catch (err: any) {
              logError("MCP", `Error executing tool "${toolName}": ${err}`)
              return { role: "tool" as const, content: `Error executing tool: ${err?.message || err}` }
            }
          })
        )

        for (const result of toolResults) {
          await memoryManager.addConversationMessage(chatId, {
            role: "tool",
            content: result.content,
            timestamp: Date.now(),
          })
        }
      } else {
        debug("Ollama", `Final assistant message length: ${assistantMessage.content?.length ?? 0}`)
        replyText = assistantMessage.content?.trim() ?? "No he podido generar una respuesta."

        await memoryManager.addConversationMessage(chatId, {
          role: "assistant",
          content: replyText,
          timestamp: Date.now(),
        })

        extractAndStoreMemories(memoryManager, chatId, message, replyText)

        loop = false
      }
    }

    return replyText
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