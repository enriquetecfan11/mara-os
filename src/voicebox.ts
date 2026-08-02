import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { voiceboxUrl, voiceboxProfile, voiceboxEnabled, voiceboxTranscribeModel } from "./config.js"
import { debug, info, error as logError } from "./logger.js"

let cachedProfileId: string | null = null

export async function checkVoicebox(): Promise<boolean> {
  if (!voiceboxEnabled) {
    info("Voicebox", "Disabled in config, skipping health check")
    return true
  }

  try {
    const res = await fetch(`${voiceboxUrl}/health`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { status?: string }
    info("Voicebox", `Ping OK — status: ${data.status || "healthy"}`)
    return true
  } catch (err) {
    logError("Voicebox", `Ping FAILED — Voicebox no responde en ${voiceboxUrl}: ${err}`)
    info("Voicebox", "El bot seguirá funcionando sin síntesis de voz hasta que Voicebox esté disponible.")
    return false
  }
}

export async function resolveProfileId(): Promise<string> {
  if (cachedProfileId) return cachedProfileId

  try {
    debug("Voicebox", `GET /profiles`)
    const res = await fetch(`${voiceboxUrl}/profiles`, {
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }

    const profiles = (await res.json()) as Array<{ id: string; name: string }>
    const found = profiles.find((p) => p.name.toLowerCase() === voiceboxProfile.toLowerCase())

    if (!found) {
      const names = profiles.map((p) => p.name).join(", ")
      throw new Error(`Profile "${voiceboxProfile}" not found. Available: ${names}`)
    }

    cachedProfileId = found.id
    info("Voicebox", `Resolved profile "${voiceboxProfile}" → ${found.id}`)
    return found.id
  } catch (err) {
    logError("Voicebox", `resolveProfileId failed: ${err}`)
    throw err
  }
}

// Descarga el audio haciendo polling a GET /audio/{id} como source of truth:
// mientras la generación esté en curso el endpoint responde 404/500/error de
// red; cuando el audio existe responde 200/206 con los bytes WAV.
async function pollAudio(generationId: string, maxWaitMs: number = 120000): Promise<Buffer> {
  const startTime = Date.now()
  const pollInterval = 1000

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const res = await fetch(`${voiceboxUrl}/audio/${generationId}`, {
        signal: AbortSignal.timeout(10000),
      })

      if (res.status === 200 || res.status === 206) {
        const buffer = Buffer.from(await res.arrayBuffer())
        info("Voicebox", `Audio ready: ${buffer.length} bytes`)
        return buffer
      }

      debug("Voicebox", `polling /audio/${generationId}: HTTP ${res.status}, waiting...`)
    } catch (err) {
      // Error de red o timeout puntual: seguimos esperando hasta el límite.
      debug("Voicebox", `polling /audio/${generationId}: ${err}, waiting...`)
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  throw new Error(`Audio not ready after ${maxWaitMs}ms`)
}

// Transcribe un archivo de audio local usando Voicebox (whisper).
// POST /transcribe con multipart/form-data: audio=@archivo, model=whisper-turbo.
export async function transcribeAudio(filePath: string): Promise<string> {
  const buffer = await readFile(filePath)

  const form = new FormData()
  form.append("audio", new Blob([buffer]), basename(filePath))
  form.append("model", voiceboxTranscribeModel)

  debug("Voicebox", `POST /transcribe (${buffer.length} bytes, model=${voiceboxTranscribeModel})`)
  const res = await fetch(`${voiceboxUrl}/transcribe`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120000),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    logError("Voicebox", `POST /transcribe failed: HTTP ${res.status} | ${body.slice(0, 200)}`)
    throw new Error(`HTTP ${res.status}`)
  }

  const data = (await res.json()) as { text?: string; transcription?: string }
  const text = (data.text || data.transcription || "").trim()

  if (!text) {
    throw new Error("Empty transcription")
  }

  info("Voicebox", `Transcribed audio → "${text.slice(0, 80)}"`)
  return text
}

export async function generateVoice(text: string): Promise<Buffer> {
  try {
    const profileId = await resolveProfileId()

    debug("Voicebox", `POST /generate (${text.length} chars)`)
    const generateRes = await fetch(`${voiceboxUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        profile_id: profileId,
        text,
        engine: "kokoro",
        language: "es",
      }),
    })

    const responseText = await generateRes.text()
    const contentType = generateRes.headers.get("content-type") || "unknown"

    if (!generateRes.ok) {
      logError(
        "Voicebox",
        `POST /generate failed: HTTP ${generateRes.status} | Content-Type: ${contentType} | Body: ${responseText.slice(0, 200)}`
      )
      throw new Error(`HTTP ${generateRes.status}`)
    }

    debug("Voicebox", `Response: ${contentType} | ${responseText.slice(0, 100)}`)

    // La respuesta puede ser JSON puro o SSE ("data: {...}"): extraemos el id
    // sin asumir formato, aceptando tanto `id` como `generation_id`.
    let generationId: string | undefined

    try {
      const data = JSON.parse(responseText) as { id?: string; generation_id?: string }
      generationId = data.id || data.generation_id
    } catch {
      const match = responseText.match(/['""]?(id|generation_id)['""]?\s*:\s*['""]([^'""\n]+)['""]/i)
      if (match) {
        generationId = match[2]
      }
    }

    if (!generationId) {
      logError("Voicebox", `Could not extract generation ID from response: ${responseText.slice(0, 300)}`)
      throw new Error("No generation ID found in response")
    }

    info("Voicebox", `Generation started: ${generationId}`)

    // Source of truth: polling directo a /audio/{id} hasta 200/206.
    return await pollAudio(generationId)
  } catch (err) {
    logError("Voicebox", `generateVoice: ${err}`)
    throw err
  }
}
