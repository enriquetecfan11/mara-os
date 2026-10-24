import { memoryMinImportance, memoryExtractionMinIntervalMs } from "../config.js"
import { MemoryManager } from "./memory-manager.js"
import { ExtractionResult, ExtractedMemory, MemoryType, NewMemoryEntry } from "./types.js"
import { info, debug, error as logError, warn } from "../logger.js"
import { llmChatBody, llmChatEndpoint, llmHeaders, parseLlmChat, readLlmError } from "../ollama-http.js"

/** Máximo de hechos guardados por conversación analizada. */
const MAX_MEMORIES_PER_RUN = 5

/**
 * Tope de la llamada de extracción. Corre en segundo plano: si el servidor de
 * inferencia se atasca, no debe quedar una petición colgada indefinidamente.
 */
const EXTRACTION_TIMEOUT_MS = 60_000

/**
 * Última extracción por chat. Evita lanzar una llamada al LLM por cada
 * mensaje: en una ráfaga de mensajes solo se analiza la conversación una vez
 * cada MEMORY_EXTRACTION_MIN_INTERVAL_MS.
 */
const lastExtractionAt = new Map<number, number>()

const EXTRACTION_PROMPT = `Eres un extractor de memoria para un asistente personal. Analiza la conversación y extrae SOLO información que sea útil recordar a largo plazo.

Tipos de memoria válidos:
- preference: preferencias del usuario (comida, horarios, forma de trabajo)
- personal_fact: hechos personales (nombre de familiares, mascotas, alergias, fechas importantes)
- project: proyectos en los que trabaja el usuario
- decision: decisiones importantes tomadas
- person: personas relevantes (contactos, amigos, familia)
- place: lugares importantes (casa, trabajo, sitios favoritos)
- routine: rutinas habituales
- important_event: eventos importantes (cumpleaños, aniversarios, citas médicas)
- skill_knowledge: conocimientos técnicos o habilidades del usuario
- other: otro tipo de información relevante

NO extraigas:
- Saludos, despedidas, frases de cortesía
- Información circunstancial irrelevante
- Respuestas del asistente que no sean hechos sobre el usuario
- Duplicados evidentes de información ya conocida
- Opiniones subjetivas sin valor factual

Devuelve JSON estructurado:
{
  "memories": [
    {
      "content": "Hecho concreto y específico",
      "type": "tipo_de_memoria",
      "importance": 0.8
    }
  ]
}

Importance: 0.1-1.0 (1.0 = crítico, 0.5 = relevante, 0.1 = menor)

Conversación a analizar:
{{CONVERSATION}}

Respuesta (SOLO JSON):`

function buildExtractionPrompt(conversation: string): string {
  return EXTRACTION_PROMPT.replace("{{CONVERSATION}}", conversation)
}

async function callOllamaForExtraction(prompt: string): Promise<string> {
  const response = await fetch(llmChatEndpoint(), {
    method: "POST",
    headers: llmHeaders(true),
    body: JSON.stringify(
      llmChatBody({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        // Presupuesto corto: son como mucho 5 hechos en JSON.
        maxTokens: 1024,
        json: true,
      }),
    ),
    signal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(await readLlmError(response))
  }

  return parseLlmChat(await response.json()).content
}

export async function extractMemories(
  memoryManager: MemoryManager,
  chatId: number,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  if (memoryExtractionMinIntervalMs > 0) {
    const last = lastExtractionAt.get(chatId) ?? 0
    const elapsed = Date.now() - last
    if (elapsed < memoryExtractionMinIntervalMs) {
      debug(
        "MemoryExtractor",
        `Extracción omitida para ${chatId}: ${memoryExtractionMinIntervalMs - elapsed}ms hasta la siguiente`,
      )
      return
    }
    lastExtractionAt.set(chatId, Date.now())
  }

  try {
    const recentMessages = await memoryManager.getRecentConversation(chatId, 4000)
    const conversationText = recentMessages
      .map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content}`)
      .join("\n")

    const prompt = buildExtractionPrompt(conversationText)
    const response = await callOllamaForExtraction(prompt)

    let result: ExtractionResult
    try {
      result = JSON.parse(response)
    } catch {
      debug("MemoryExtractor", "Failed to parse extraction JSON")
      return
    }

    if (!result.memories || !Array.isArray(result.memories) || result.memories.length === 0) {
      debug("MemoryExtractor", "No memories extracted")
      return
    }

    const now = Date.now()
    const candidates = result.memories
      .filter((mem) => isValidMemory(mem))
      // Solo lo suficientemente relevante: no memorizamos charla circunstancial.
      .filter((mem) => mem.importance >= memoryMinImportance)
      .slice(0, MAX_MEMORIES_PER_RUN)

    if (candidates.length === 0) {
      debug("MemoryExtractor", `No memories above importance ${memoryMinImportance}`)
      return
    }

    const entries: NewMemoryEntry[] = candidates.map((mem) => ({
      content: mem.content.trim(),
      type: mem.type,
      importance: Math.max(0.1, Math.min(1, mem.importance)),
      source: "conversation",
      metadata: { extractedFrom: chatId, extractedAt: now },
    }))

    try {
      const saved = await memoryManager.rememberMany(entries)
      debug("MemoryExtractor", `Stored ${saved.length}/${candidates.length} memories (batch)`)
      for (const mem of candidates) {
        debug("MemoryExtractor", `Extracted: ${mem.content.slice(0, 50)}... (${mem.type}, ${mem.importance})`)
      }
    } catch (err) {
      warn("MemoryExtractor", `Failed to store extracted memories: ${err}`)
    }
  } catch (err) {
    logError("MemoryExtractor", `Extraction failed: ${err}`)
  }
}

function isValidMemory(mem: any): mem is ExtractedMemory {
  return (
    mem &&
    typeof mem.content === "string" &&
    mem.content.trim().length > 0 &&
    typeof mem.type === "string" &&
    ["preference", "personal_fact", "project", "decision", "person", "place", "routine", "important_event", "skill_knowledge", "other"].includes(mem.type) &&
    typeof mem.importance === "number" &&
    mem.importance >= 0.1 &&
    mem.importance <= 1.0
  )
}

export async function extractAndStoreMemories(
  memoryManager: MemoryManager,
  chatId: number,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
  setImmediate(() => {
    extractMemories(memoryManager, chatId, userMessage, assistantMessage).catch((err) => {
      logError("MemoryExtractor", `Background extraction failed: ${err}`)
    })
  })
}