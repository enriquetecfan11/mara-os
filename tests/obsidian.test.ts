/**
 * Lectura del vault de Obsidian para importarlo a Hindsight (`src/obsidian.ts`).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listVaultNotes, noteContent, noteDocumentId, stripFrontmatter } from "../src/obsidian.js"

const LONG = "Contenido suficientemente largo para que la nota cuente como útil."

describe("obsidian", () => {
  it("quita el frontmatter y añade el título", () => {
    const raw = `---\ntags: [ia]\ncreated: 2026-01-01\n---\n${LONG}`
    assert.equal(stripFrontmatter(raw), LONG)
    assert.equal(noteContent(raw, "ia/Agentes.md"), `# Agentes\n\n${LONG}`)
    assert.equal(stripFrontmatter(LONG), LONG)
  })

  it("descarta notas casi vacías", () => {
    assert.equal(noteContent("---\ntags: []\n---\nhola", "x.md"), null)
  })

  it("recorre el vault saltando .obsidian, templates y no-markdown", () => {
    const vault = mkdtempSync(join(tmpdir(), "mara-vault-"))
    for (const dir of [".obsidian", "templates", "ia/sub", "personal"]) mkdirSync(join(vault, dir), { recursive: true })
    writeFileSync(join(vault, ".obsidian", "conf.md"), LONG)
    writeFileSync(join(vault, "templates", "diaria.md"), LONG)
    writeFileSync(join(vault, "ia", "sub", "Agentes.md"), LONG)
    writeFileSync(join(vault, "ia", "imagen.png"), "x")
    writeFileSync(join(vault, "personal", "Casa.md"), LONG)
    writeFileSync(join(vault, "personal", "vacia.md"), "")

    assert.deepEqual(listVaultNotes(vault).map((n) => n.path), ["ia/sub/Agentes.md", "personal/Casa.md"])
    assert.deepEqual(listVaultNotes(vault, ["personal"]).map((n) => n.path), ["personal/Casa.md"])
  })

  it("el document_id es estable por ruta", () => {
    assert.equal(noteDocumentId("ia/Agentes.md"), "obsidian:ia/Agentes.md")
  })
})
