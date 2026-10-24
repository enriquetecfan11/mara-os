/**
 * Comprobación READ-ONLY de Hindsight.
 *
 * Verifica, sin escribir ni modificar nada en el servidor:
 *   1. Salud y versión de la API.
 *   2. Que el banco configurado existe y es accesible.
 *   3. Que `recall` responde (una consulta de prueba, no crea recuerdos).
 *   4. Estado local: memorias en SQLite y cambios pendientes de sincronizar.
 *
 * Uso:
 *   pnpm check:hindsight
 *   HINDSIGHT_API_URL=http://127.0.0.1:8888 pnpm check:hindsight
 */

import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  agentDir,
  hindsightApiUrl,
  hindsightBankId,
  hindsightApiKey,
  hindsightTenant,
  hindsightHealthTimeoutMs,
} from "../src/config.js"

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []
const apiUrl = hindsightApiUrl.replace(/\/+$/, "")

function headers(hasBody = false): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" }
  if (hasBody) h["Content-Type"] = "application/json"
  if (hindsightApiKey) h.Authorization = `Bearer ${hindsightApiKey}`
  return h
}

async function get(path: string, timeoutMs = hindsightHealthTimeoutMs): Promise<{ status: number; body: any }> {
  const res = await fetch(`${apiUrl}${path}`, {
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    // texto plano
  }
  return { status: res.status, body }
}

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? "✅" : "❌"} ${name}: ${detail}`)
}

function getDbPath(): string {
  if (existsSync("/var/lib/mara/memory")) return "/var/lib/mara/memory/mara.db"
  return join(agentDir, "..", "data", "mara.db")
}

async function main(): Promise<void> {
  console.log(`Hindsight: ${apiUrl} · banco "${hindsightBankId}" · tenant "${hindsightTenant}"\n`)

  try {
    const health = await get("/health")
    record(
      "Salud",
      health.status === 200 && health.body?.status === "healthy",
      health.status === 200 ? `status=${health.body?.status} db=${health.body?.database}` : `HTTP ${health.status}`,
    )
  } catch (err) {
    record("Salud", false, err instanceof Error ? err.message : String(err))
    finish()
    return
  }

  try {
    const version = await get("/version")
    record(
      "Versión",
      version.status === 200,
      version.status === 200 ? `API ${version.body?.api_version}` : `HTTP ${version.status}`,
    )
  } catch (err) {
    record("Versión", false, err instanceof Error ? err.message : String(err))
  }

  try {
    const config = await get(`/v1/${encodeURIComponent(hindsightTenant)}/banks/${encodeURIComponent(hindsightBankId)}/config`)
    record(
      "Banco",
      config.status === 200,
      config.status === 200 ? `"${hindsightBankId}" accesible` : `HTTP ${config.status} (¿existe el banco?)`,
    )
  } catch (err) {
    record("Banco", false, err instanceof Error ? err.message : String(err))
  }

  try {
    const stats = await get(`/v1/${encodeURIComponent(hindsightTenant)}/banks/${encodeURIComponent(hindsightBankId)}/stats`)
    record(
      "Stats",
      stats.status === 200,
      stats.status === 200 ? JSON.stringify(stats.body).slice(0, 200) : `HTTP ${stats.status}`,
    )
  } catch (err) {
    record("Stats", false, err instanceof Error ? err.message : String(err))
  }

  try {
    const res = await fetch(
      `${apiUrl}/v1/${encodeURIComponent(hindsightTenant)}/banks/${encodeURIComponent(hindsightBankId)}/memories/recall`,
      {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ query: "comprobación de conectividad", budget: "low", max_tokens: 256 }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    const body = await res.json().catch(() => ({}))
    record(
      "Recall (solo lectura)",
      res.ok,
      res.ok ? `${Array.isArray(body.results) ? body.results.length : 0} resultados` : `HTTP ${res.status}`,
    )
  } catch (err) {
    record("Recall (solo lectura)", false, err instanceof Error ? err.message : String(err))
  }

  checkLocalState()
  finish()
}

function checkLocalState(): void {
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) {
    record("SQLite local", true, `sin base de datos todavía (${dbPath})`)
    return
  }

  try {
    const db = new Database(dbPath, { readonly: true })
    const count = (table: string, where = ""): number => {
      try {
        return (db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${where}`).get() as { total: number }).total
      } catch {
        // Tabla aún no creada (la base de datos no se ha abierto con esta versión).
        return 0
      }
    }
    const memories = count("memories")
    const tombstones = count("memory_tombstones")
    const pending = count("memory_sync", "WHERE completed_at IS NULL")
    db.close()

    record(
      "SQLite local",
      true,
      `${memories} memorias · ${tombstones} olvidadas · ${pending} pendientes de sincronizar`,
    )
    record(
      "Outbox",
      pending === 0,
      pending === 0
        ? "todo sincronizado con Hindsight"
        : `${pending} cambios esperando (se reintentan solos)`,
    )
  } catch (err) {
    record("SQLite local", false, err instanceof Error ? err.message : String(err))
  }
}

function finish(): void {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`Error inesperado: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
