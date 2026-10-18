import { ollamaUrl, ollamaModel } from "../config.js"
import { MemoryManager } from "./memory-manager.js"
import { ExtractionResult, ExtractedMemory, MemoryType } from "./types.js"
import { info, debug, error as logError, warn } from "../logger.js"
import { ollamaOptions, readOllamaError } from "../ollama-http.js"

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
  const response = await fetch(`${ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      prompt,
      stream: false,
      temperature: 0.1,
      format: "json",
      options: ollamaOptions(),
    }),
  })

  if (!response.ok) {
    throw new Error(await readOllamaError(response))
  }

  const data = await response.json()
  return data.response
}

export async function extractMemories(
  memoryManager: MemoryManager,
  chatId: number,
  userMessage: string,
  assistantMessage: string
): Promise<void> {
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

    for (const mem of result.memories) {
      if (!isValidMemory(mem)) continue

      try {
        await memoryManager.remember(
          mem.content,
          mem.type,
          Math.max(0.1, Math.min(1, mem.importance)),
          "conversation",
          { extractedFrom: chatId, extractedAt: Date.now() }
        )
        debug("MemoryExtractor", `Extracted: ${mem.content.slice(0, 50)}... (${mem.type}, ${mem.importance})`)
      } catch (err) {
        warn("MemoryExtractor", `Failed to store extracted memory: ${err}`)
      }
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