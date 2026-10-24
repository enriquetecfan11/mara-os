/**
 * Lectura del vault de Obsidian para importarlo a Hindsight (`src/obsidian.ts`).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMassDeletion, listVaultNotes, noteContent, noteDocumentId, notesToDelete, stripFrontmatter } from "../src/obsidian.js"

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

  it("detecta las notas borradas del vault", () => {
    const remote = ["ia/Agentes.md", "ia/Viejo.md", "personal/Casa.md", "personal/Movida.md"]
    const vault = ["ia/Agentes.md", "personal/Casa.md", "personal/sub/Movida.md"]
    assert.deepEqual(notesToDelete(remote, vault), ["ia/Viejo.md", "personal/Movida.md"])
  })

  it("con --folder solo borra dentro de esas carpetas", () => {
    const remote = ["ia/Agentes.md", "ia/Viejo.md", "personal/Casa.md"]
    // Importando solo "ia", personal/Casa.md no está en la lista local pero no se toca.
    assert.deepEqual(notesToDelete(remote, ["ia/Agentes.md"], ["ia"]), ["ia/Viejo.md"])
    assert.deepEqual(notesToDelete(remote, ["ia/Agentes.md"], ["ia/"]), ["ia/Viejo.md"])
    // "ia" no debe casar con "ia-vieja/…".
    assert.deepEqual(notesToDelete(["ia-vieja/X.md"], [], ["ia"]), [])
  })

  it("frena los borrados masivos", () => {
    assert.equal(isMassDeletion(5, 6), false) // pocos: se permite aunque sea casi todo
    assert.equal(isMassDeletion(20, 230), false)
    assert.equal(isMassDeletion(200, 230), true) // vault vacío o mal montado
  })
})
