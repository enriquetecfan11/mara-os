import { getActiveLlm } from "./providers.js"
import { callMcpTool } from "./mcp.js"
import { getActiveTools, isToolEnabled } from "./tool-groups.js"
import { detectRememberRequest, saveMemory } from "./memory-tools.js"
import { loadAllSkills, detectSkills, loadSkillsContext } from "./skills.js"
import { readContextFile } from "./cache.js"
import { info, error as logError, debug, warn } from "./logger.js"
import {
  assistantToolCallMessage,
  llmChatBody,
  llmChatEndpoint,
  llmHeaders,
  llmModelsEndpoint,
  parseLlmChat,
  readLlmError,
  toolResultMessage,
  type LlmMessage,
} from "./ollama-http.js"
import { getMemoryManager, initializeMemory } from "./memory/index.js"
import { buildContext } from "./memory/context-builder.js"
import { extractAndStoreMemories } from "./memory/memory-extractor.js"

/**
 * Ping de salud al servidor de inferencia. Timeout corto y no lanza: devuelve
 * false si no responde (ni si la API key es incorrecta). Pensado para
 * diagnósticos (mensaje de arranque, /help), no para el flujo de chat.
 */
export async function pingOllama(timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(llmModelsEndpoint(), {
      headers: llmHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    })
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

export async function clearChatHistory(chatId: number): Promise<void> {
  chatSessions.delete(chatId)
  // El historial que ve el LLM sale de SQLite (buildContext), no de chatSessions:
  // sin esto /reset no borraba nada. La memoria a largo plazo no se toca.
  await getMemoryManager().clearConversation(chatId)
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

  // "Recuerda que…" se guarda aquí, sin esperar a que el modelo use la tool.
  let rememberNote = ""
  const explicitFact = detectRememberRequest(message)
  if (explicitFact) {
    try {
      // "Kike dice:" evita que Hindsight atribuya el dato al asistente.
      const result = await saveMemory(`Kike dice: ${explicitFact}`, "other", 0.9)
      info("Memory", `Petición explícita guardada: "${explicitFact}"`)
      rememberNote = `\n\nSISTEMA: el dato "${explicitFact}" ya está guardado en tu memoria a largo plazo (Hindsight). ${result} Confírmaselo a Kike en una frase y no llames a guardar_recuerdo.`
    } catch (err) {
      warn("Memory", `No se pudo guardar la petición explícita: ${err}`)
    }
  }

  const { systemPrompt: baseSystemPrompt, recentMessages } = await buildContext(memoryManager, {
    chatId,
    userMessage: message,
    maxConversationTokens: MAX_CONVERSATION_TOKENS,
    maxMemoryTokens: MAX_MEMORY_TOKENS,
    memorySearchLimit: MEMORY_SEARCH_LIMIT,
  })
  // Va en el system prompt y no como mensaje aparte: algunas plantillas de chat
  // (Qwen) rechazan mensajes system que no estén al principio.
  const systemPrompt = baseSystemPrompt + rememberNote

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
    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      ...recentMessages.map((m) => ({ role: m.role as LlmMessage["role"], content: m.content })),
    ]

    // Tope de rondas de tool calling para no quedarnos colgados en un bucle
    // (el modelo puede seguir pidiendo tools indefinidamente).
    const MAX_TOOL_ROUNDS = 8

    while (loop) {
      if (controller.signal.aborted) {
        throw controller.signal.reason || new Error("Request cancelled")
      }

      debug("Ollama", `Sending request to ${llmChatEndpoint()} using model: ${getActiveLlm().model} (${messages.length} messages)...`)

      const response = await fetch(llmChatEndpoint(), {
        method: "POST",
        headers: llmHeaders(true),
        signal: controller.signal,
        body: JSON.stringify(
          llmChatBody({
            messages,
            tools: getActiveTools(),
            temperature: 0.3,
            requireTool: true,
          }),
        ),
      })

      if (!response.ok) {
        throw new Error(await readLlmError(response))
      }

      const { content: assistantContent, toolCalls } = parseLlmChat(await response.json())

      if (toolCalls.length > 0) {
        if (toolRounds >= MAX_TOOL_ROUNDS) {
          warn("Ollama", `Reached the limit of ${MAX_TOOL_ROUNDS} tool rounds; stopping to avoid a loop`)
          break
        }
        toolRounds++

        info("Ollama", `Received ${toolCalls.length} tool call(s)`)

        // La assistant message (con sus tool_calls) debe volver al historial:
        // si no, el modelo no puede asociar cada resultado con su tool call.
        // En el dialecto OpenAI esto es obligatorio (400 si falta).
        messages.push(assistantToolCallMessage(toolCalls, assistantContent))

        const toolResults = await Promise.all(
          toolCalls.map(async (toolCall) => {
            const toolName = toolCall.name
            const toolArgs = toolCall.arguments

            debug("Tool", `Executing tool "${toolName}" with arguments: ${JSON.stringify(toolArgs)}`)

            // Un grupo apagado con /tools no se envía al LLM, pero el modelo
            // puede pedir la tool igualmente (alucinación o historial previo).
            if (!isToolEnabled(toolName)) {
              return toolResultMessage(toolCall, `Herramienta "${toolName}" desactivada con /tools`)
            }

            try {
              const resultStr = await callMcpTool(toolName, toolArgs)
              return toolResultMessage(toolCall, resultStr)
            } catch (err: any) {
              logError("MCP", `Error executing tool "${toolName}": ${err}`)
              return toolResultMessage(toolCall, `Error executing tool: ${err?.message || err}`)
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
        debug("Ollama", `Final assistant message length: ${assistantContent.length}`)
        replyText = assistantContent.trim() || "No he podido generar una respuesta."

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