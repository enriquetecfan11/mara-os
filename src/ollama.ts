import { ollamaUrl, ollamaModel } from "./config.js"
import { ollamaTools, callMcpTool } from "./mcp.js"
import { loadAllSkills, detectSkills, loadSkillsContext } from "./skills.js"
import { readContextFile } from "./cache.js"
import { info, error as logError, debug, warn } from "./logger.js"
import { ollamaOptions, readOllamaError } from "./ollama-http.js"
import { getMemoryManager, initializeMemory } from "./memory/index.js"
import { buildContext } from "./memory/context-builder.js"
import { extractAndStoreMemories } from "./memory/memory-extractor.js"

/**
 * Ping de salud a Ollama. Timeout corto y no lanza: devuelve false si no
 * responde. Pensado para diagnósticos (mensaje de arranque, /help), no para el
 * flujo de chat.
 */
export async function pingOllama(timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

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
    let toolRounds = 0

    // Vive FUERA del bucle: cada ronda de tool calling tiene que ir añadiendo
    // la respuesta del asistente y el resultado de las tools. Si se reconstruyera
    // desde `recentMessages` en cada iteración, el modelo nunca vería los
    // resultados y volvería a pedir la misma tool en bucle hasta el timeout.
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      ...recentMessages.map((m) => ({ role: m.role, content: m.content })),
    ]

    // Tope de rondas de tool calling para no quedarnos colgados en un bucle
    // (el modelo puede seguir pidiendo tools indefinidamente).
    const MAX_TOOL_ROUNDS = 8

    while (loop) {
      if (controller.signal.aborted) {
        throw controller.signal.reason || new Error("Request cancelled")
      }

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
          options: ollamaOptions(),
        }),
      })

      if (!response.ok) {
        throw new Error(await readOllamaError(response))
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
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          warn("Ollama", `Reached the limit of ${MAX_TOOL_ROUNDS} tool rounds; stopping to avoid a loop`)
          break
        }
        toolRounds++

        info("Ollama", `Received ${assistantMessage.tool_calls.length} tool call(s)`)

        // La assistant message (con sus tool_calls) debe volver al historial:
        // si no, el modelo no puede asociar cada resultado con su tool call.
        messages.push({
          role: "assistant",
          content: assistantMessage.content ?? "",
        })

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
          messages.push(result)
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

/**
 * ¿Merece la pena reintentar? Los fallos transitorios (red, timeout) sí; los
 * deterministas (p. ej. errores de SQLite) fallarán igual, así que no perdemos
 * tiempo ni ensuciamos los logs reintentándolos.
 */
function isRetryable(err: any): boolean {
  if (err?.name === "SqliteError") return false
  if (typeof err?.code === "string" && err.code.startsWith("SQLITE_")) return false
  return true
}

export async function askPiWithRetry(chatId: number, message: string, maxRetries = 2): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await askPi(chatId, message)
    } catch (err: any) {
      if (err?.name === "AbortError") throw err
      if (!isRetryable(err)) throw err
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