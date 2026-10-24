import { ollamaNumCtx, type ActiveLlm } from "./config.js"
import { getActiveLlm } from "./providers.js"

/**
 * Capa de compatibilidad con los dos dialectos de servidor de inferencia:
 *
 *   - "ollama": API nativa (`/api/chat`, `/api/generate`, `/api/tags`).
 *   - "openai": API OpenAI-compatible (`/v1/chat/completions`, `/v1/models`),
 *     que es lo que hablan Unsloth Studio, Groq, vLLM, llama.cpp server, LM Studio…
 *
 * El resto del código no debería construir URLs ni cuerpos a mano: usa estas
 * funciones, que por defecto hablan con el proveedor activo (`/modelo`). Las
 * que aceptan un `ActiveLlm` sirven para probar un proveedor antes de activarlo.
 */
export function isOpenAiApi(llm: ActiveLlm = getActiveLlm()): boolean {
  return llm.dialect === "openai"
}

/** Un tool call ya normalizado, venga del dialecto que venga. */
export interface LlmToolCall {
  /** Identificador del tool call (OpenAI lo exige para emparejar el resultado). */
  id: string
  name: string
  /** Argumentos ya parseados a objeto (si el modelo devolvió un string JSON). */
  arguments: unknown
}

/**
 * Mensaje del historial. `tool_calls` y `tool_call_id` solo los usa el dialecto
 * OpenAI; Ollama ignora los campos que no conoce, así que se pueden enviar
 * siempre sin ramificar el flujo del chat.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** URL base sin barra final (para no generar `//api/chat`). */
export function llmBaseUrl(llm: ActiveLlm = getActiveLlm()): string {
  return llm.url.replace(/\/+$/, "")
}

export function llmChatEndpoint(llm: ActiveLlm = getActiveLlm()): string {
  return `${llmBaseUrl(llm)}${isOpenAiApi(llm) ? "/v1/chat/completions" : "/api/chat"}`
}

/** Endpoint de salud/listado de modelos, el que use el dialecto activo. */
export function llmModelsEndpoint(llm: ActiveLlm = getActiveLlm()): string {
  return `${llmBaseUrl(llm)}${isOpenAiApi(llm) ? "/v1/models" : "/api/tags"}`
}

export function llmHeaders(json = false, llm: ActiveLlm = getActiveLlm()): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (json) headers["Content-Type"] = "application/json"
  if (llm.apiKey) headers.Authorization = `Bearer ${llm.apiKey}`
  return headers
}

/**
 * Opciones que se envían a Ollama en cada petición.
 *
 * `num_ctx` es imprescindible: sin él el servidor usa 4096 tokens (su default
 * cuando el Modelfile no lo define) y las tools MCP + system prompt lo desbordan
 * con facilidad, provocando HTTP 400 "exceeds the available context size".
 *
 * No aplica al dialecto OpenAI, donde `num_ctx` no existe: el contexto lo fija
 * el modelo cargado en el servidor.
 */
export function ollamaOptions(extra?: Record<string, unknown>): Record<string, unknown> {
  return { num_ctx: ollamaNumCtx, ...extra }
}

export interface LlmChatParams {
  model?: string
  messages: LlmMessage[]
  /** Tools en formato OpenAI (`{type:"function", function:{...}}`), válido en ambos dialectos. */
  tools?: unknown[]
  temperature?: number
  /** Tope de tokens de salida (dialecto OpenAI y `num_predict` de Ollama). */
  maxTokens?: number
  /**
   * Fuerza que el modelo llame a una tool. Solo se aplica al dialecto Ollama:
   * en OpenAI `tool_choice: "required"` obligaría a llamar a una tool incluso en
   * una conversación normal y rompería el chat.
   */
  requireTool?: boolean
  /** Pide salida JSON (para el extractor de memorias). */
  json?: boolean
}

/** Cuerpo de una petición de chat en el dialecto configurado. */
export function llmChatBody(params: LlmChatParams, llm: ActiveLlm = getActiveLlm()): Record<string, unknown> {
  const model = params.model ?? llm.model
  const tools = params.tools ?? []
  const temperature = params.temperature ?? 0.3
  const maxTokens = params.maxTokens ?? llm.maxTokens

  if (isOpenAiApi(llm)) {
    const body: Record<string, unknown> = {
      model,
      messages: params.messages,
      stream: false,
      temperature,
      max_tokens: maxTokens,
    }
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = "auto"
    }
    if (params.json) body.response_format = { type: "json_object" }
    return body
  }

  const body: Record<string, unknown> = {
    model,
    messages: params.messages,
    stream: false,
    temperature,
    options: ollamaOptions({ num_predict: maxTokens }),
  }
  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = params.requireTool ? "required" : "auto"
  }
  if (params.json) body.format = "json"
  return body
}

/** Normaliza la respuesta de `/api/chat` y `/v1/chat/completions`. */
export function parseLlmChat(data: any, llm: ActiveLlm = getActiveLlm()): { content: string; toolCalls: LlmToolCall[] } {
  const message = isOpenAiApi(llm) ? data?.choices?.[0]?.message : data?.message

  const content = typeof message?.content === "string" ? message.content : ""
  const rawCalls: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : []

  const toolCalls: LlmToolCall[] = rawCalls
    .map((call, index) => {
      const fn = call?.function ?? {}
      let args = fn.arguments
      if (typeof args === "string") {
        try {
          args = JSON.parse(args)
        } catch {
          /* se deja el string tal cual */
        }
      }
      return {
        id: typeof call?.id === "string" && call.id ? call.id : `call_${index}`,
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: args,
      }
    })
    .filter((call) => call.name.length > 0)

  return { content, toolCalls }
}

/**
 * Mensaje de asistente que pide tools. Debe volver al historial con sus
 * `tool_calls` para que el modelo pueda emparejar cada resultado: en el dialecto
 * OpenAI el `tool_call_id` es obligatorio y sin esto el servidor devuelve 400.
 */
export function assistantToolCallMessage(toolCalls: LlmToolCall[], content = ""): LlmMessage {
  return {
    role: "assistant",
    content,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    })),
  }
}

/** Mensaje con el resultado de una tool, emparejado por id. */
export function toolResultMessage(toolCall: LlmToolCall, content: string): LlmMessage {
  const message: LlmMessage = { role: "tool", content }
  if (toolCall.id) message.tool_call_id = toolCall.id
  return message
}

/**
 * Extrae el motivo real de un error del servidor de inferencia.
 *
 * Ollama devuelve `{"error": "..."}`, y a veces ese string es a su vez un JSON
 * serializado (lo que hace el runner que sirve el modelo). El dialecto OpenAI
 * devuelve `{"error": {"message": "..."}}`. Sin esto solo se veía
 * "400 Bad Request", que no dice nada.
 */
export async function readLlmError(res: Response): Promise<string> {
  let detail: string
  try {
    const body = await res.text()
    try {
      const parsed = JSON.parse(body) as { error?: unknown }
      let err = parsed?.error
      // El error puede venir como JSON anidado dentro del string.
      if (typeof err === "string") {
        try {
          err = JSON.parse(err)
        } catch {
          /* no es JSON anidado, nos vale el string */
        }
      }
      if (err && typeof err === "object" && "message" in err) {
        detail = String((err as { message: unknown }).message)
      } else if (err) {
        detail = String(err)
      } else {
        detail = body
      }
    } catch {
      detail = body
    }
  } catch {
    detail = "(cuerpo de respuesta ilegible)"
  }

  detail = detail.replace(/\s+/g, " ").trim()
  return detail
    ? `LLM request failed: ${res.status} ${res.statusText} — ${detail}`
    : `LLM request failed: ${res.status} ${res.statusText}`
}
