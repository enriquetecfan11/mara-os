/**
 * Detección de "recuerda que…" (`src/memory-tools.ts`): el bot guarda esas
 * peticiones en Hindsight sin depender de que el modelo llame a la tool.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { detectRememberRequest } from "../src/memory-tools.js"

describe("detectRememberRequest", () => {
  it("extrae el dato de las peticiones explícitas", () => {
    assert.equal(detectRememberRequest("Recuerda que vivo en Madrid"), "vivo en Madrid")
    assert.equal(detectRememberRequest("recuerda que mi escudería favorita es Ferrari."), "mi escudería favorita es Ferrari")
    assert.equal(detectRememberRequest("Mara, apunta que el wifi es Casa5G"), "el wifi es Casa5G")
    assert.equal(detectRememberRequest("No olvides que soy alérgico al marisco"), "soy alérgico al marisco")
    assert.equal(detectRememberRequest("Acuérdate de que mi madre se llama Carmen"), "mi madre se llama Carmen")
    assert.equal(detectRememberRequest("Guarda en tu memoria: me gusta el café solo"), "me gusta el café solo")
  })

  it("ignora preguntas, recordatorios y mensajes normales", () => {
    assert.equal(detectRememberRequest("¿Recuerdas dónde vivo?"), null)
    assert.equal(detectRememberRequest("Recuerda que vivo en Madrid?"), null)
    assert.equal(detectRememberRequest("Recuérdame mañana llamar al médico"), null)
    assert.equal(detectRememberRequest("¿Cuál es mi escudería favorita?"), null)
    assert.equal(detectRememberRequest("Hola Mara"), null)
    assert.equal(detectRememberRequest("Recuerda"), null)
  })
})
