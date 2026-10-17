import { WebSocketServer, WebSocket } from "ws"
import { brainWsUrl } from "./config.js"
import { info, warn, error as logError, debug } from "./logger.js"

export const PROTOCOL_VERSION = 1

/** Estado visual de Mara. No confundir con el estado técnico del dispositivo. */
export type MaraState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "seeing"
  | "error"
  | "offline"

/** Sobre v1 del protocolo de eventos de Mara UI. */
export interface MaraEventEnvelope<T = unknown> {
  type: string
  version: number
  timestamp: number
  data: T
}

/** Solicitud de confirmación de una acción crítica. */
export interface ConfirmRequest {
  id: string
  title: string
  message: string
  action: string
}

/** Comandos que la UI envía al brain. */
export type UiCommand =
  | { type: "mara:interrupt" }
  | { type: "mara:start-listening" }
  | { type: "mara:stop-listening" }
  | { type: "mara:confirm-response"; data: { id: string; accepted: boolean } }
  | { type: "mara:settings"; data: { volume?: number; brightness?: number; microphone?: boolean; camera?: boolean; wakeWord?: boolean } }
  | { type: "mara:audio-start"; data: { sampleRate?: number; channels?: number } }
  | { type: "mara:audio-stop"; data?: unknown }

type CommandHandler = (command: UiCommand) => void

/** Recibe audio PCM del micrófono del navegador ensamblado como WAV. */
type AudioHandler = (wav: Buffer, sampleRate: number, channels: number) => void

/** Estado de captura de micrófono del navegador, por socket. */
interface AudioBufferState {
  sampleRate: number
  channels: number
  chunks: Buffer[]
}

let server: WebSocketServer | null = null
let enabled = false
const clients = new Set<WebSocket>()
const audioBuffers = new Map<WebSocket, AudioBufferState>()

let audioHandler: AudioHandler | null = null

let lastState: MaraState = "idle"
let lastMessage: string | null = null
let lastNetworkConnected: boolean | null = null

let commandHandler: CommandHandler | null = null

function makeEnvelope(type: string, data: unknown): MaraEventEnvelope {
  return { type, version: PROTOCOL_VERSION, timestamp: Date.now(), data }
}

function send(socket: WebSocket, envelope: MaraEventEnvelope): void {
  if (socket.readyState !== WebSocket.OPEN) return
  try {
    socket.send(JSON.stringify(envelope))
  } catch (err) {
    logError("Events", `Failed to send event to client: ${err}`)
  }
}

function broadcast(envelope: MaraEventEnvelope): void {
  if (!enabled || clients.size === 0) return
  const data = JSON.stringify(envelope)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data)
      } catch (err) {
        logError("Events", `Failed to broadcast event: ${err}`)
      }
    }
  }
}

function syncClient(socket: WebSocket): void {
  send(socket, makeEnvelope("mara:state", { state: lastState }))
  if (lastMessage) {
    send(socket, makeEnvelope("mara:message", { text: lastMessage }))
  }
  if (lastNetworkConnected !== null) {
    send(socket, makeEnvelope("mara:network", { connected: lastNetworkConnected }))
  }
}

function handleIncomingMessage(raw: string): void {
  try {
    const msg = JSON.parse(raw) as UiCommand
    if (typeof msg?.type !== "string") return
    debug("Events", `UI command: ${msg.type}`)
    commandHandler?.(msg)
  } catch {
    // Payload no JSON o inválido: se ignora.
  }
}

function wavHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const buf = Buffer.alloc(44)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write("WAVE", 8)
  buf.write("fmt ", 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * 2, 28) // byte rate
  buf.writeUInt16LE(channels * 2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write("data", 36)
  buf.writeUInt32LE(dataBytes, 40)
  return buf
}

/**
 * Acumula el audio PCM del micrófono del navegador reenviado por el bridge.
 * Al recibir mara:audio-stop ensambla el WAV y se lo entrega al audioHandler
 * registrado por el bot (que lo transcribe y responde).
 */
function registerAudioSession(socket: WebSocket, data: unknown): void {
  const d = (data ?? {}) as Record<string, unknown>
  audioBuffers.set(socket, {
    sampleRate: Number(d.sampleRate) || 16000,
    channels: Number(d.channels) || 1,
    chunks: [] as Buffer[],
  })
}

function pushAudioFrame(socket: WebSocket, frame: Buffer): void {
  let state = audioBuffers.get(socket)
  if (!state) {
    state = { sampleRate: 16000, channels: 1, chunks: [] }
    audioBuffers.set(socket, state)
  }
  state.chunks.push(frame)
}

function flushAudioSession(socket: WebSocket): void {
  const state = audioBuffers.get(socket)
  audioBuffers.delete(socket)
  if (!state || state.chunks.length === 0) {
    if (state) info("Events", "Audio del navegador vacío, se ignora")
    return
  }

  const dataBytes = state.chunks.reduce((n, c) => n + c.length, 0)
  const wav = Buffer.concat([wavHeader(dataBytes, state.sampleRate, state.channels), ...state.chunks])
  info("Events", `Audio del navegador recibido (${wav.length} bytes, ${state.sampleRate} Hz)`)
  audioHandler?.(wav, state.sampleRate, state.channels)
}

function handleIncomingBinary(socket: WebSocket, raw: Buffer, isBinary: boolean): void {
  if (isBinary) {
    pushAudioFrame(socket, raw)
    return
  }

  const text = raw.toString()
  try {
    const msg = JSON.parse(text) as UiCommand
    if (typeof msg?.type !== "string") return

    if (msg.type === "mara:audio-start") {
      registerAudioSession(socket, (msg as { data?: unknown }).data)
      return
    }
    if (msg.type === "mara:audio-stop") {
      flushAudioSession(socket)
      return
    }

    debug("Events", `UI command: ${msg.type}`)
    commandHandler?.(msg)
  } catch {
    // Payload no JSON o inválido: se ignora.
  }
}

/** Registra un handler para comandos entrantes de la UI. */
export function setCommandHandler(handler: CommandHandler): void {
  commandHandler = handler
}

/** Registra un handler para audio PCM del navegador (recibe un WAV 16 kHz mono). */
export function setAudioHandler(handler: AudioHandler): void {
  audioHandler = handler
}

/** Arranca el servidor WebSocket "brain". No-bloqueante; si falla, log + no-op. */
export function startUiEvents(): void {
  if (!brainWsUrl) {
    warn("Events", "MARA_BRAIN_WS_URL vacío, eventos hacia Mara UI desactivados")
    return
  }

  try {
    const url = new URL(brainWsUrl)
    const host = url.hostname || "0.0.0.0"
    const port = Number(url.port || 9000)

    server = new WebSocketServer({ host, port })
    server.on("connection", (socket) => {
      clients.add(socket)
      info("Events", `Mara UI client connected (${clients.size} active)`)
      syncClient(socket)
      socket.on("message", (raw, isBinary) => {
        handleIncomingBinary(socket, raw as Buffer, isBinary)
      })
      socket.on("close", () => {
        clients.delete(socket)
        audioBuffers.delete(socket)
        info("Events", `Mara UI client disconnected (${clients.size} active)`)
      })
    })
    server.on("listening", () => {
      enabled = true
      lastNetworkConnected = true
      info("Events", `Mara UI brain listening on ws://${host}:${port}`)
      emit("mara:network", { connected: true })
    })
    server.on("error", (err: NodeJS.ErrnoException) => {
      enabled = false
      if (err.code === "EADDRINUSE") {
        warn("Events", `Port ${port} in use — another brain instance running? Events disabled.`)
      } else {
        logError("Events", `WebSocket server error: ${err}`)
      }
    })
  } catch (err) {
    enabled = false
    logError("Events", `No se pudo iniciar el WebSocket brain en ${brainWsUrl}: ${err}`)
  }
}

/** Emite un envelope v1 a todos los clientes conectados. No-bloqueante. */
export function emit(type: string, data: unknown): void {
  if (!enabled) return
  broadcast(makeEnvelope(type, data))
}

/** Cambia el estado visual de Mara (dedup: omite si no cambió). */
export function setState(state: MaraState): void {
  if (!enabled || state === lastState) return
  lastState = state
  emit("mara:state", { state })
}

/**
 * Ciclo de habla (TTS). Eventos dedicados emitidos alrededor de la síntesis
 * de voz, desacoplados de Telegram: cualquier canal de salida que genere voz
 * los dispara. Actualizan lastState para que la sincronización de nuevos
 * clientes (mara:state) refleje el estado correcto mientras se habla.
 */
export function emitSpeakingStarted(): void {
  lastState = "speaking"
  emit("voice.speaking.started", {})
}

export function emitSpeakingFinished(): void {
  lastState = "idle"
  emit("voice.speaking.finished", {})
}

/**
 * Reproducción de voz hacia la UI (respuesta para el micrófono del navegador).
 * Envía el WAV en base64 dentro de un evento JSON para que viaje limpio por el
 * bridge y la UI lo repita con su propia salida de audio.
 */
export function emitVoiceAudio(text: string, audio: Buffer): void {
  emit("voice.audio", { text, audio: audio.toString("base64") })
}

/** Emite la respuesta actual de Mara como mara:message. */
export function emitMessage(text: string): void {
  lastMessage = text
  emit("mara:message", { text })
}

/** Estado de red del transporte hacia la UI (mara:network). */
export function emitNetwork(connected: boolean): void {
  lastNetworkConnected = connected
  emit("mara:network", { connected })
}

/** Solicitud de confirmación de acción crítica (mara:confirm). */
export function emitConfirm(request: ConfirmRequest): void {
  emit("mara:confirm", request)
}

/** Error transitorio (mara:error). También deja el estado visual en "error". */
export function emitError(message?: string): void {
  lastState = "error"
  emit("mara:error", { message })
}

export function getState(): MaraState {
  return lastState
}

export function isUiEnabled(): boolean {
  return enabled
}

/** Número de clientes (Mara UI) conectados ahora mismo al brain. */
export function getConnectedClientCount(): number {
  return clients.size
}

/** Cierra el servidor WebSocket (usado en shutdown limpio). */
export function closeUiEvents(): void {
  enabled = false
  for (const client of clients) {
    try {
      client.close()
    } catch {
      // ignore
    }
  }
  clients.clear()
  if (server) {
    try {
      server.close()
    } catch (err) {
      logError("Events", `Error closing WebSocket server: ${err}`)
    }
    server = null
  }
}
