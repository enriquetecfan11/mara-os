/**
 * Diagnóstico del servidor de inferencia.
 *
 * Comprueba, en el mismo orden que necesita el bot:
 *   1. Conectividad (y auth, si hay API key).
 *   2. Que el modelo configurado existe en el servidor.
 *   3. Que responde texto.
 *   4. Que hace tool calling (imprescindible para los MCP).
 *
 * Habla el dialecto que diga `OLLAMA_API`:
 *   - "ollama" (por defecto): /api/tags y /api/chat.
 *   - "openai": /v1/models y /v1/chat/completions.
 *
 * Uso:  pnpm check:ollama
 * Sale con código 0 si todo va bien, 1 si algo falla.
 */

import { getActiveLlm } from "../src/providers.js"
import {
  isOpenAiApi,
  llmBaseUrl,
  llmChatBody,
  llmChatEndpoint,
  llmHeaders,
  llmModelsEndpoint,
  parseLlmChat,
  readLlmError,
} from "../src/ollama-http.js"

/** Proveedor activo: el guardado por `/modelo` o el de `LLM_PROVIDER`. */
const llm = getActiveLlm()

const TIMEOUT_PING_MS = 5_000
const TIMEOUT_CHAT_MS = 120_000

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const GRAY = "\x1b[90m"

let failures = 0
let serverModels: string[] = []

function ok(label: string, detail = ""): void {
  const suffix = detail ? ` ${GRAY}${detail}${RESET}` : ""
  console.log(`${GREEN}✔${RESET} ${label}${suffix}`)
}

function ko(label: string, detail = ""): void {
  failures++
  const suffix = detail ? ` ${GRAY}${detail}${RESET}` : ""
  console.log(`${RED}✘${RESET} ${label}${suffix}`)
}

function infoLine(label: string, detail = ""): void {
  const suffix = detail ? ` ${GRAY}${detail}${RESET}` : ""
  console.log(`${GRAY}·${RESET} ${label}${suffix}`)
}

async function checkConnectivity(): Promise<boolean> {
  try {
    const res = await fetch(llmModelsEndpoint(), {
      headers: llmHeaders(),
      signal: AbortSignal.timeout(TIMEOUT_PING_MS),
    })

    if (!res.ok) {
      ko("Conectividad", `${llmBaseUrl()} respondió HTTP ${res.status} — ${await readLlmError(res)}`)
      if (res.status === 401 || res.status === 403) {
        const keyVar = llm.provider === "groq" ? "GROQ_API_KEY" : "OLLAMA_API_KEY"
        console.log(`  ${GRAY}El servidor pide autenticación: define ${keyVar} en el .env (o LLM_API_KEY).${RESET}`)
      }
      return false
    }

    const data = (await res.json()) as any
    serverModels = isOpenAiApi()
      ? (data.data ?? []).map((m: any) => String(m.id ?? "")).filter(Boolean)
      : (data.models ?? []).map((m: any) => String(m.name ?? m.model ?? "")).filter(Boolean)

    let apiLabel = "API OpenAI-compatible"
    if (!isOpenAiApi()) {
      let version = "desconocida"
      try {
        const v = await fetch(`${llmBaseUrl()}/api/version`, { signal: AbortSignal.timeout(TIMEOUT_PING_MS) })
        if (v.ok) version = ((await v.json()) as { version?: string }).version ?? version
      } catch {
        /* la versión es informativa, no bloquea */
      }
      apiLabel = `Ollama ${version}`
    }

    ok("Conectividad", `${llmBaseUrl()} (${apiLabel}${llm.apiKey ? ", auth OK" : ""})`)
    return true
  } catch (err) {
    ko("Conectividad", `no responde en ${llmBaseUrl()} — ${(err as Error).message}`)
    console.log(`  ${GRAY}¿Está el servidor de inferencia levantado y accesible en red?${RESET}`)
    return false
  }
}

async function checkModelPresent(): Promise<boolean> {
  if (serverModels.length === 0) {
    ko("Modelo disponible", "el servidor no devolvió ningún modelo")
    return false
  }

  // En servidores OpenAI-compatibles el id puede llevar el quant detrás de ":"
  // (ej. "unsloth/Qwen3.5-4B-MTP-GGUF:UD-Q4_K_XL").
  const found = serverModels.some(
    (n) => n === llm.model || n === `${llm.model}:latest` || (isOpenAiApi() && n.startsWith(`${llm.model}:`)),
  )

  if (found) {
    ok("Modelo disponible", `${llm.model} (${serverModels.length} modelo(s) en el servidor)`)
    return true
  }

  ko("Modelo disponible", `"${llm.model}" no está en el servidor`)
  console.log(`  ${GRAY}Modelos encontrados: ${serverModels.join(", ")}${RESET}`)
  if (llm.provider === "ollama") {
    console.log(`  ${GRAY}Descárgalo en el servidor con: ollama pull ${llm.model}${RESET}`)
  } else if (llm.provider === "groq") {
    console.log(`  ${GRAY}Comprueba el id exacto en https://console.groq.com/docs/models${RESET}`)
  }
  return false
}

async function chat(body: Record<string, unknown>): Promise<{ content: string; toolCalls: ReturnType<typeof parseLlmChat>["toolCalls"]; ms: number }> {
  const t0 = Date.now()
  const res = await fetch(llmChatEndpoint(), {
    method: "POST",
    headers: llmHeaders(true),
    signal: AbortSignal.timeout(TIMEOUT_CHAT_MS),
    body: JSON.stringify(body),
  })
  const ms = Date.now() - t0
  if (!res.ok) {
    throw new Error(await readLlmError(res))
  }
  const parsed = parseLlmChat(await res.json())
  return { ...parsed, ms }
}

async function checkTextReply(): Promise<boolean> {
  try {
    const { content, ms } = await chat(
      llmChatBody({
        messages: [{ role: "user", content: "Responde solo con la palabra: listo" }],
        temperature: 0.3,
      }),
    )
    const text = content.trim()
    if (!text) {
      ko("Respuesta de texto", "el modelo devolvió contenido vacío")
      return false
    }
    ok("Respuesta de texto", `${ms} ms · "${text.slice(0, 40)}"`)
    return true
  } catch (err) {
    ko("Respuesta de texto", `error — ${(err as Error).message}`)
    return false
  }
}

async function checkToolCalling(): Promise<boolean> {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_time",
        description: "Devuelve la hora actual en una zona horaria",
        parameters: {
          type: "object",
          properties: { tz: { type: "string", description: "Zona horaria, ej. Europe/Madrid" } },
          required: ["tz"],
        },
      },
    },
  ]

  try {
    const { toolCalls, ms } = await chat(
      llmChatBody({
        messages: [{ role: "user", content: "¿Qué hora es en Madrid? Usa la herramienta." }],
        tools,
        temperature: 0.3,
        requireTool: true,
      }),
    )

    if (toolCalls.length === 0) {
      ko("Tool calling", "el modelo respondió sin tool_calls")
      console.log(`  ${GRAY}El bot necesita tool calling para usar los MCP (calendar, notes…).${RESET}`)
      return false
    }

    const name = toolCalls[0]?.name ?? "(sin nombre)"
    ok("Tool calling", `${ms} ms · llamó a "${name}"${toolCalls.length > 1 ? ` (+${toolCalls.length - 1} más)` : ""}`)
    return true
  } catch (err) {
    ko("Tool calling", `error — ${(err as Error).message}`)
    return false
  }
}

async function main(): Promise<void> {
  console.log(`${BOLD}Comprobando servidor de inferencia${RESET}`)
  infoLine("Proveedor", llm.provider)
  infoLine("Dialecto", llm.dialect === "openai" ? "openai (/v1/chat/completions)" : "ollama (/api/chat)")
  infoLine("URL", llmBaseUrl())
  infoLine("Modelo", llm.model)
  infoLine("API key", llm.apiKey ? "configurada" : "(ninguna)")
  console.log()

  const reachable = await checkConnectivity()
  if (!reachable) {
    finish()
    return
  }

  const hasModel = await checkModelPresent()
  if (!hasModel) {
    console.log(`\n${GRAY}Sin el modelo no se puede probar chat ni tools.${RESET}`)
    finish()
    return
  }

  console.log(`\n${GRAY}La primera petición puede tardar: el modelo se carga en memoria.${RESET}`)
  await checkTextReply()
  await checkToolCalling()

  finish()
}

function finish(): void {
  console.log()
  if (failures === 0) {
    console.log(`${GREEN}${BOLD}OK — el servidor está listo para Mara OS.${RESET}`)
    process.exit(0)
  }
  console.log(`${RED}${BOLD}KO — ${failures} comprobación(es) fallida(s).${RESET}`)
  process.exit(1)
}

main().catch((err) => {
  console.log(`${RED}Error inesperado:${RESET} ${(err as Error).message}`)
  process.exit(1)
})
