import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  agentDir,
  checkLlmProvider,
  defaultLlmProvider,
  llmProviderNames,
  resolveLlmProvider,
  type ActiveLlm,
  type LlmDialect,
  type LlmProvider,
} from "./config.js"
import { info, warn } from "./logger.js"

/**
 * Proveedor de inferencia activo en tiempo de ejecución.
 *
 * El proveedor se cambia con el comando `/modelo` de Telegram (o `/modelo groq`),
 * así que no puede ser una constante de configuración: aquí vive el estado y se
 * persiste en disco para sobrevivir a los reinicios.
 *
 * Precedencia al arrancar:
 *   1. El último guardado con `/modelo` (`data/llm-provider.json`).
 *   2. `LLM_PROVIDER` del .env.
 *   3. Deducido de `OLLAMA_API` (comportamiento anterior a los proveedores).
 */
const statePath = process.env.LLM_STATE_FILE || join(agentDir, "..", "data", "llm-provider.json")

let active: ActiveLlm | undefined

function isProvider(value: unknown): value is LlmProvider {
  return typeof value === "string" && (llmProviderNames as string[]).includes(value)
}

function loadStoredProvider(): LlmProvider {
  try {
    if (!existsSync(statePath)) return defaultLlmProvider
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { provider?: unknown }
    if (isProvider(parsed.provider)) return parsed.provider
    warn("Inference", `Proveedor desconocido en ${statePath}: ${String(parsed.provider)}`)
  } catch (err) {
    warn("Inference", `No se pudo leer ${statePath}: ${err}`)
  }
  return defaultLlmProvider
}

function persist(provider: LlmProvider): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(
      statePath,
      `${JSON.stringify({ provider, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    )
  } catch (err) {
    warn("Inference", `No se pudo guardar el proveedor en ${statePath}: ${err}`)
  }
}

/** Proveedor activo. Se resuelve la primera vez y a partir de ahí lo manda `/modelo`. */
export function getActiveLlm(): ActiveLlm {
  if (!active) {
    const stored = loadStoredProvider()
    const check = checkLlmProvider(stored)
    // Un proveedor guardado puede quedarse sin configurar (p. ej. te llevas la
    // API key). En ese caso no dejamos el bot mudo: se cae al de por defecto.
    if (!check.ok) {
      warn("Inference", `Proveedor "${stored}" no disponible (${check.reason}); uso "${defaultLlmProvider}"`)
      active = resolveLlmProvider(defaultLlmProvider)
    } else {
      active = resolveLlmProvider(stored)
    }
    info("Inference", `Proveedor activo: ${active.provider} (${active.dialect}) ${active.url} · ${active.model}`)
  }
  return active
}

export function getActiveProviderName(): LlmProvider {
  return getActiveLlm().provider
}

/**
 * Cambia el proveedor activo y lo guarda. Lanza si el proveedor no existe o le
 * falta configuración; quien llama decide si antes conviene comprobar que
 * responde (lo hace el comando `/modelo`).
 */
export function setActiveProvider(provider: LlmProvider): ActiveLlm {
  if (!isProvider(provider)) {
    throw new Error(`proveedor desconocido "${provider}"`)
  }
  const check = checkLlmProvider(provider)
  if (!check.ok) {
    throw new Error(check.reason ?? `el proveedor "${provider}" no está configurado`)
  }
  active = resolveLlmProvider(provider)
  persist(provider)
  info("Inference", `Proveedor cambiado a ${active.provider} (${active.dialect}) · ${active.model}`)
  return active
}

export interface ProviderStatus {
  provider: LlmProvider
  active: boolean
  configured: boolean
  reason?: string
  url: string
  model: string
  dialect: LlmDialect
}

/** Estado de todos los proveedores, para `/modelo` sin argumentos. */
export function listProviderStatus(): ProviderStatus[] {
  const current = getActiveProviderName()
  return llmProviderNames.map((provider) => {
    const resolved = resolveLlmProvider(provider)
    const check = checkLlmProvider(provider)
    return {
      provider,
      active: provider === current,
      configured: check.ok,
      reason: check.reason,
      url: resolved.url,
      model: resolved.model,
      dialect: resolved.dialect,
    }
  })
}
