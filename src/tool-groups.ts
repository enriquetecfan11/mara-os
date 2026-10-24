// Grupos de tools activables con /tools.
//
// Los grupos se definen en config/tool-groups.json (nombre → lista de tools).
// Una tool MCP que no esté en ningún grupo cae en un grupo con el nombre de su
// servidor, para que una tool nueva no desaparezca sin avisar. Las tools de
// memoria (Hindsight) no pertenecen a ningún grupo: están siempre activas.
//
// El estado (grupos desactivados) vive en data/tool-groups.json, igual que el
// proveedor de /modelo, y sobrevive a reinicios.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { agentDir } from "./config.js"
import { ollamaTools, getToolServerName } from "./mcp.js"
import { isMemoryTool } from "./memory-tools.js"
import { warn } from "./logger.js"

/** Nombre reservado: la memoria no se puede desactivar. */
export const MEMORY_GROUP = "memoria"

const groupsPath = process.env.TOOL_GROUPS_FILE || join(agentDir, "tool-groups.json")
const statePath = process.env.TOOL_GROUPS_STATE_FILE || join(agentDir, "..", "data", "tool-groups.json")

let disabled: Set<string> | undefined

/** Se lee en cada llamada: editar el JSON no requiere reiniciar el bot. */
function loadGroupDefinitions(): Record<string, string[]> {
  try {
    if (!existsSync(groupsPath)) return {}
    const parsed = JSON.parse(readFileSync(groupsPath, "utf8")) as Record<string, unknown>
    const groups: Record<string, string[]> = {}
    for (const [name, tools] of Object.entries(parsed)) {
      if (name === MEMORY_GROUP || !Array.isArray(tools)) continue
      groups[name] = tools.filter((t): t is string => typeof t === "string")
    }
    return groups
  } catch (err) {
    warn("Tools", `No se pudo leer ${groupsPath}: ${err}`)
    return {}
  }
}

function getDisabled(): Set<string> {
  if (disabled) return disabled
  disabled = new Set()
  try {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { disabled?: unknown }
      if (Array.isArray(parsed.disabled)) {
        for (const name of parsed.disabled) {
          if (typeof name === "string" && name !== MEMORY_GROUP) disabled.add(name)
        }
      }
    }
  } catch (err) {
    warn("Tools", `No se pudo leer ${statePath}: ${err}`)
  }
  return disabled
}

function persist(): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(
      statePath,
      `${JSON.stringify({ disabled: [...getDisabled()].sort(), updatedAt: new Date().toISOString() }, null, 2)}\n`,
    )
  } catch (err) {
    warn("Tools", `No se pudo guardar el estado en ${statePath}: ${err}`)
  }
}

function toolName(tool: any): string {
  return tool?.function?.name ?? ""
}

/** Grupo al que pertenece una tool registrada (undefined = memoria). */
function groupOf(name: string, groups: Record<string, string[]>): string | undefined {
  if (isMemoryTool(name)) return undefined
  for (const [group, tools] of Object.entries(groups)) {
    if (tools.includes(name)) return group
  }
  return getToolServerName(name) ?? "otras"
}

export interface ToolGroupStatus {
  name: string
  enabled: boolean
  tools: number
}

/** Grupos con tools registradas ahora mismo, en el orden del JSON. */
export function listToolGroups(): ToolGroupStatus[] {
  const groups = loadGroupDefinitions()
  const counts = new Map<string, number>(Object.keys(groups).map((g) => [g, 0]))
  for (const tool of ollamaTools) {
    const group = groupOf(toolName(tool), groups)
    if (group) counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  const off = getDisabled()
  return [...counts]
    .filter(([, tools]) => tools > 0)
    .map(([name, tools]) => ({ name, enabled: !off.has(name), tools }))
}

export function isToolEnabled(name: string): boolean {
  const group = groupOf(name, loadGroupDefinitions())
  return group === undefined || !getDisabled().has(group)
}

/** Tools que se envían al LLM. Las de memoria van siempre. */
export function getActiveTools(): any[] {
  const groups = loadGroupDefinitions()
  const off = getDisabled()
  return ollamaTools.filter((tool) => {
    const group = groupOf(toolName(tool), groups)
    return group === undefined || !off.has(group)
  })
}

export type SetGroupsResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Activa o desactiva grupos. Con `only`, deja activos solo los indicados.
 * Rechaza "memoria" y nombres desconocidos sin cambiar nada.
 */
export function setToolGroups(names: string[], mode: "on" | "off" | "only"): SetGroupsResult {
  if (names.includes(MEMORY_GROUP)) {
    return { ok: false, reason: "La memoria (Hindsight) está siempre activa y no se puede desactivar." }
  }
  const known = listToolGroups().map((g) => g.name)
  const unknown = names.filter((n) => !known.includes(n))
  if (unknown.length > 0) {
    return { ok: false, reason: `Grupo desconocido: ${unknown.join(", ")}\nGrupos: ${known.join(" | ")}` }
  }

  const off = getDisabled()
  if (mode === "only") {
    off.clear()
    for (const name of known) if (!names.includes(name)) off.add(name)
  } else {
    for (const name of names) {
      if (mode === "off") off.add(name)
      else off.delete(name)
    }
  }
  persist()
  return { ok: true }
}

/** Líneas para /tools y para el mensaje de bienvenida. */
export function describeToolGroups(): string[] {
  const groups = listToolGroups()
  const memoryTools = ollamaTools.filter((tool) => isMemoryTool(toolName(tool))).length
  const lines = [`🔒 ${MEMORY_GROUP.padEnd(14)} ${memoryTools} tools (siempre activa)`]
  for (const g of groups) {
    lines.push(`${g.enabled ? "✅" : "❌"} ${g.name.padEnd(14)} ${g.tools} tools`)
  }
  lines.push(`Activas: ${getActiveTools().length} de ${ollamaTools.length}`)
  return lines
}
