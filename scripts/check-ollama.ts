// Comprobación completa del backend de Ollama antes de arrancar Mara OS.
// Verifica, en orden: conectividad, que el modelo existe y que responde a
// chat y a tool calling (el bot depende del tool calling para los MCP).
//
// Uso:  pnpm check:ollama
// Sale con código 0 si todo va bien, 1 si algo falla.

import { ollamaUrl, ollamaModel } from "../src/config.js"
import { ollamaOptions, readOllamaError } from "../src/ollama-http.js"

const TIMEOUT_PING_MS = 5_000
const TIMEOUT_MODELS_MS = 10_000
const TIMEOUT_CHAT_MS = 120_000

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const GREEN = "\x1b[32m"
const RED = "\x1b[31m"
const GRAY = "\x1b[90m"

let failures = 0

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

async function checkVersion(): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl}/api/version`, {
      signal: AbortSignal.timeout(TIMEOUT_PING_MS),
    })
    if (!res.ok) {
      ko("Conectividad", `${ollamaUrl} respondió HTTP ${res.status}`)
      return false
    }
    const data = (await res.json()) as { version?: string }
    ok("Conectividad", `${ollamaUrl} (Ollama ${data.version ?? "desconocida"})`)
    return true
  } catch (err) {
    ko("Conectividad", `no responde en ${ollamaUrl} — ${(err as Error).message}`)
    console.log(`  ${GRAY}¿Está el servidor Ollama levantado y accesible en red?${RESET}`)
    return false
  }
}

async function checkModelPresent(): Promise<boolean> {
  let names: string[] = []
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(TIMEOUT_MODELS_MS),
    })
    if (!res.ok) {
      ko("Lista de modelos", `HTTP ${res.status}`)
      return false
    }
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
    names = (data.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean)
  } catch (err) {
    ko("Lista de modelos", `error consultando /api/tags — ${(err as Error).message}`)
    return false
  }

  const found = names.some((n) => n === ollamaModel || n === `${ollamaModel}:latest`)
  if (found) {
    ok("Modelo disponible", `${ollamaModel} (${names.length} modelo(s) en el servidor)`)
    return true
  }

  ko("Modelo disponible", `"${ollamaModel}" no está en el servidor`)
  console.log(`  ${GRAY}Modelos encontrados: ${names.join(", ") || "(ninguno)"}${RESET}`)
  console.log(`  ${GRAY}Descárgalo en el servidor con: ollama pull ${ollamaModel}${RESET}`)
  return false
}

interface ChatResponse {
  message?: {
    content?: string
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>
  }
  error?: string
}

async function chat(body: Record<string, unknown>): Promise<{ data: ChatResponse; ms: number }> {
  const t0 = Date.now()
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_CHAT_MS),
    body: JSON.stringify({ model: ollamaModel, stream: false, options: ollamaOptions(), ...body }),
  })
  const ms = Date.now() - t0
  if (!res.ok) {
    throw new Error(await readOllamaError(res))
  }
  return { data: (await res.json()) as ChatResponse, ms }
}

async function checkTextReply(): Promise<boolean> {
  try {
    const { data, ms } = await chat({
      messages: [{ role: "user", content: "Responde solo con la palabra: listo" }],
      temperature: 0.3,
    })
    const text = data.message?.content?.trim() ?? ""
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
    const { data, ms } = await chat({
      messages: [{ role: "user", content: "¿Qué hora es en Madrid? Usa la herramienta." }],
      tools,
      tool_choice: "required",
      temperature: 0.3,
    })
    const calls = data.message?.tool_calls ?? []
    if (calls.length === 0) {
      ko("Tool calling", "el modelo respondió sin tool_calls")
      console.log(`  ${GRAY}El bot necesita tool calling para usar los MCP (calendar, notes…).${RESET}`)
      return false
    }
    const name = calls[0]?.function?.name ?? "(sin nombre)"
    ok("Tool calling", `${ms} ms · llamó a "${name}"${calls.length > 1 ? ` (+${calls.length - 1} más)` : ""}`)
    return true
  } catch (err) {
    ko("Tool calling", `error — ${(err as Error).message}`)
    return false
  }
}

async function main(): Promise<void> {
  console.log(`${BOLD}Comprobando Ollama${RESET}`)
  infoLine("URL", ollamaUrl)
  infoLine("Modelo", ollamaModel)
  console.log()

  const reachable = await checkVersion()
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
    console.log(`${GREEN}${BOLD}OK — Ollama está listo para Mara OS.${RESET}`)
    process.exit(0)
  }
  console.log(`${RED}${BOLD}KO — ${failures} comprobación(es) fallida(s).${RESET}`)
  process.exit(1)
}

main().catch((err) => {
  console.log(`${RED}Error inesperado:${RESET} ${(err as Error).message}`)
  process.exit(1)
})
