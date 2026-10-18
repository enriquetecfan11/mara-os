import { ollamaNumCtx } from "./config.js"

/**
 * Opciones que se envían en cada petición a Ollama.
 *
 * `num_ctx` es imprescindible: sin él el servidor usa 4096 tokens (su default
 * cuando el Modelfile no lo define) y las tools MCP + system prompt lo desbordan
 * con facilidad, provocando HTTP 400 "exceeds the available context size".
 */
export function ollamaOptions(extra?: Record<string, unknown>): Record<string, unknown> {
  return { num_ctx: ollamaNumCtx, ...extra }
}

/**
 * Extrae el motivo real de un error de Ollama.
 *
 * El cuerpo útil viene en `{"error": "..."}`, y a veces ese string es a su vez
 * un JSON serializado (lo que hace el runner que sirve el modelo). Sin esto solo
 * se veía "400 Bad Request", que no dice nada.
 */
export async function readOllamaError(res: Response): Promise<string> {
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
    ? `Ollama request failed: ${res.status} ${res.statusText} — ${detail}`
    : `Ollama request failed: ${res.status} ${res.statusText}`
}
