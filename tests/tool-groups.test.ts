/**
 * Grupos de tools activables con /tools (`src/tool-groups.ts`).
 *
 * Se comprueba que la memoria (Hindsight) nunca se puede apagar, que el estado
 * se persiste y que una tool MCP sin grupo cae en el grupo de su servidor.
 */
import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "mara-tool-groups-"))
const groupsFile = join(dir, "groups.json")
const stateFile = join(dir, "state.json")
writeFileSync(groupsFile, JSON.stringify({ tareas: ["create_task", "list_tasks"], notas: ["create_note"] }))
process.env.TOOL_GROUPS_FILE = groupsFile
process.env.TOOL_GROUPS_STATE_FILE = stateFile

const { ollamaTools, clientsMap, toolToClientMap } = await import("../src/mcp.js")
const { memoryToolSchemas } = await import("../src/memory-tools.js")
const { getActiveTools, isToolEnabled, setToolGroups, listToolGroups } = await import("../src/tool-groups.js")

const names = (tools: any[]) => tools.map((t) => t.function.name).sort()

describe("tool-groups", () => {
  before(() => {
    const fakeClient = {} as any
    clientsMap.set("agentdesk", fakeClient)
    ollamaTools.push(...memoryToolSchemas)
    for (const name of ["create_task", "list_tasks", "create_note", "whoami"]) {
      toolToClientMap.set(name, fakeClient)
      ollamaTools.push({ type: "function", function: { name, description: "", parameters: {} } })
    }
  })

  it("una tool sin grupo cae en el grupo de su servidor", () => {
    assert.deepEqual(
      listToolGroups().map((g) => [g.name, g.tools]),
      [["tareas", 2], ["notas", 1], ["agentdesk", 1]],
    )
  })

  it("apagar todos los grupos deja solo la memoria", () => {
    assert.deepEqual(setToolGroups(["tareas", "notas", "agentdesk"], "off"), { ok: true })
    assert.deepEqual(names(getActiveTools()), ["buscar_recuerdos", "guardar_recuerdo"])
    assert.equal(isToolEnabled("guardar_recuerdo"), true)
    assert.equal(isToolEnabled("create_task"), false)
  })

  it("la memoria no se puede desactivar", () => {
    const result = setToolGroups(["memoria"], "off")
    assert.equal(result.ok, false)
    assert.equal(isToolEnabled("buscar_recuerdos"), true)
  })

  it("rechaza grupos desconocidos sin cambiar nada", () => {
    const before = names(getActiveTools())
    assert.equal(setToolGroups(["tareas", "inventado"], "on").ok, false)
    assert.deepEqual(names(getActiveTools()), before)
  })

  it("solo deja activos los grupos indicados y lo persiste", () => {
    assert.deepEqual(setToolGroups(["notas"], "only"), { ok: true })
    assert.deepEqual(names(getActiveTools()), ["buscar_recuerdos", "create_note", "guardar_recuerdo"])
    const saved = JSON.parse(readFileSync(stateFile, "utf8"))
    assert.deepEqual(saved.disabled, ["agentdesk", "tareas"])
  })
})
