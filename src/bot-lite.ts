import { Bot, InputFile, type Context } from "grammy"
import { randomUUID } from "node:crypto"
import { appendFile, unlink, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { approvalMessage, sttDisabledMessage, hasApproval, needsApproval } from "./approvals.js"
import { saveTelegramPhoto, saveTelegramFile } from "./telegram-files.js"
import { telegramToken, telegramChatId, uploadsDir, ollamaUrl, ollamaModel, agentDir, timezone, voiceboxEnabled, telegramSendVoiceDefault, sttEnabled, sttLocalEnabled, maraUserName } from "./config.js"
import { askPiWithRetry, clearChatHistory, cancelRequest } from "./ollama.js"
import { readContextFile } from "./cache.js"
import { info, error as logError, warn } from "./logger.js"
import { generateVoice, transcribeAudio } from "./voicebox.js"
import { transcribeLocal } from "./stt.js"
import { wavToOggOpus } from "./audio.js"
import { startUiEvents, closeUiEvents, setState, emitMessage, emitConfirm, emitError, emitSpeakingStarted, emitSpeakingFinished, emitVoiceAudio, setCommandHandler, setAudioHandler, type UiCommand, type ConfirmRequest } from "./events.js"

const pendingConfirms = new Map<string, { chatId: number; message: string }>()

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, "").trim())
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .trim()
}

function wantVoiceFor(chatId: number, isAudioInput: boolean): boolean {
  if (voiceboxEnabled && telegramSendVoiceDefault) return true
  return isAudioInput
}

function emitConfirmRequest(message: string, chatId: number): void {
  const id = randomUUID()
  pendingConfirms.set(id, { chatId, message })
  emitConfirm({
    id,
    title: "Confirmación requerida",
    message: message.slice(0, 300),
    action: "Acción externa (fuera de Telegram)",
  })
}

async function trySendVoice(ctx: Context, text: string): Promise<boolean> {
  if (text.length > 500) return false
  try {
    // El ciclo de habla (voice.speaking.*) lo emiten generateVoice/finally.
    const wav = await generateVoice(text)
    try {
      const ogg = await wavToOggOpus(wav)
      await ctx.replyWithVoice(new InputFile(ogg, "respuesta.ogg"))
    } catch {
      await ctx.replyWithAudio(new InputFile(wav, "respuesta.wav"))
    }
    return true
  } catch (err) {
    logError("Bot", `Failed to send voice: ${err}`)
    return false
  }
}

async function deliverReply(ctx: Context, text: string, isAudioInput: boolean): Promise<void> {
  await ctx.reply(text)
  if (voiceboxEnabled && wantVoiceFor(ctx.chat!.id, isAudioInput)) {
    await trySendVoice(ctx, text)
  }
}

const chatQueues = new Map<number, Promise<void>>()

function enqueue(chatId: number, fn: () => Promise<void>): Promise<void> {
  const prev = chatQueues.get(chatId) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId)
  })
  chatQueues.set(chatId, next)
  return next
}

function startTyping(chatId: number) {
  const bot_ = bot as any
  bot_.api.sendChatAction(chatId, "typing").catch(() => {})
  const interval = setInterval(() => {
    bot_.api.sendChatAction(chatId, "typing").catch(() => {})
  }, 4000)
  return interval
}

function stopTyping(interval: ReturnType<typeof setInterval>) {
  clearInterval(interval)
}

/**
 * ¿La transcripción contiene voz real? Descarta clips donde whisper solo
 * detectó música, ruido o silencio (los marca entre corchetes como
 * "[Música]", "[♪]"), o donde no haya palabra hablada. Evita que el mic
 * capte la propia salida de audio y genere bucles de respuestas.
 */
function isMeaningfulTranscription(transcript: string): boolean {
  const normalized = transcript.replace(/[\[\]\W_]+/g, " ").trim()
  if (!normalized) return false
  const words = normalized.split(/\s+/).filter((w) => w.length >= 2)
  if (words.length < 2) return false
  if (/^\s*[♪♫]/.test(transcript)) return false
  return true
}

const bot = new Bot(telegramToken)

bot.catch(async (err) => {
  const ctx = err.ctx
  logError("Bot", `Error while handling update ${ctx.update.update_id}: ${err.error}`)
  setState("error")
  emitError(String(err.error))
  try {
    await ctx.reply("Ups, ocurrió un error al procesar tu mensaje. Inténtalo de nuevo.")
  } catch { /* ignore */ }
})

bot.command("start", async (ctx) => {
  clearChatHistory(ctx.chat.id)
  const name = ctx.from?.first_name || "there"
  await ctx.reply(`Hola ${name}! Soy Mara, tu asistente personal.\n\nPuedo ayudarte con preguntas, tareas y mas.\nEscribe /help para ver todo lo que puedo hacer.`)
})

bot.command("reset", async (ctx) => {
  clearChatHistory(ctx.chat.id)
  await ctx.reply("Historial limpio. Empezamos de cero.")
})

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Mara OS (lite)\n\n" +
    "Comandos:\n" +
    "  /start — Reiniciar conversación\n" +
    "  /help — Esta ayuda\n" +
    "  /reset — Limpiar historial\n" +
    "  /cancel — Cancelar operación\n"
  )
})

bot.command("cancel", async (ctx) => {
  cancelRequest(ctx.chat.id)
  await ctx.reply("Operación cancelada.")
})

bot.on("message:text", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  info("Telegram", `Received text from @${username}: "${ctx.message.text.slice(0, 100)}"`)

  if (needsApproval(ctx.message.text) && !hasApproval(ctx.message.text)) {
    emitConfirmRequest(ctx.message.text, ctx.chat.id)
    await ctx.reply(approvalMessage)
    return
  }

  await enqueue(ctx.chat.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat.id)
    try {
      setState("thinking")
      const answer = await askPiWithRetry(ctx.chat.id, ctx.message.text)
      const stripped = stripMarkdown(answer)
      stopTyping(typing)
      emitMessage(stripped)
      await deliverReply(ctx, stripped, false)
      setState("idle")
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
    } catch (err: any) {
      logError("Bot", `Failed to process message: ${err}`)
      setState("error")
      emitError(err?.message)
    } finally {
      stopTyping(typing)
    }
  })
})

bot.on("message:photo", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  const caption = ctx.message.caption ?? "Kike ha enviado una imagen."
  info("Telegram", `Received photo from @${username}`)

  if (needsApproval(caption) && !hasApproval(caption)) {
    emitConfirmRequest(caption, ctx.chat.id)
    await ctx.reply(approvalMessage)
    return
  }

  await enqueue(ctx.chat.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat.id)
    try {
      setState("seeing")
      const photo = ctx.message.photo.at(-1)!
      const imagePath = await saveTelegramPhoto(bot, telegramToken, photo.file_id, uploadsDir)
      info("Telegram", `Photo saved to: ${imagePath}`)

      setState("thinking")
      const answer = await askPiWithRetry(ctx.chat.id, `${caption}\n\nImagen local: ${imagePath}`)
      const stripped = stripMarkdown(answer)
      stopTyping(typing)
      emitMessage(stripped)
      await deliverReply(ctx, stripped, false)
      setState("idle")
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
    } catch (err: any) {
      logError("Bot", `Failed to process photo: ${err}`)
      setState("error")
      emitError(err?.message)
    } finally {
      stopTyping(typing)
    }
  })
})

bot.on("message:voice", async (ctx) => {
  const username = ctx.from?.username || ctx.from?.first_name || "Unknown"
  info("Telegram", `Received voice from @${username}`)

  // STT apagado: no descargamos ni transcribimos, contestamos al momento.
  if (!sttEnabled) {
    info("Telegram", "STT disabled; replying without transcription")
    setState("idle")
    await ctx.reply(sttDisabledMessage)
    return
  }

  await enqueue(ctx.chat!.id, async () => {
    const t0 = Date.now()
    const typing = startTyping(ctx.chat!.id)
    let audioPath: string | undefined
    try {
      setState("listening")
      audioPath = await saveTelegramFile(bot, telegramToken, ctx.message.voice.file_id, uploadsDir, "ogg")

      let transcript: string
      try {
        transcript = sttLocalEnabled
          ? await transcribeLocal(audioPath)
          : await transcribeAudio(audioPath)
      } catch {
        setState("error")
        await ctx.reply("No pude entender el audio. Prueba de nuevo o escríbeme.")
        return
      }

      if (needsApproval(transcript) && !hasApproval(transcript)) {
        emitConfirmRequest(transcript, ctx.chat!.id)
        await ctx.reply(approvalMessage)
        return
      }

      setState("thinking")
      const answer = await askPiWithRetry(ctx.chat!.id, transcript)
      const stripped = stripMarkdown(answer)
      stopTyping(typing)
      emitMessage(stripped)
      await deliverReply(ctx, stripped, true)
      setState("idle")
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      info("Telegram", `Replied to @${username} (${elapsed}s)`)
    } catch (err: any) {
      logError("Bot", `Failed to process voice: ${err}`)
      setState("error")
      emitError(err?.message)
    } finally {
      stopTyping(typing)
      if (audioPath) await unlink(audioPath).catch(() => {})
    }
  })
})

function registerCommandHandler(): void {
  setCommandHandler((cmd: UiCommand) => {
    const chatId = telegramChatId ? Number(telegramChatId) : 0

    switch (cmd.type) {
      case "mara:interrupt":
        info("Events", "UI interrupt received")
        cancelRequest(chatId)
        break

      case "mara:confirm-response": {
        const pending = pendingConfirms.get(cmd.data.id)
        if (!pending) {
          warn("Events", `Confirm ${cmd.data.id} not found or already resolved`)
          return
        }
        pendingConfirms.delete(cmd.data.id)
        if (cmd.data.accepted) {
          info("Events", `Confirm ${cmd.data.id} accepted — processing`)
          const confirmedMessage = `Confirmo ${pending.message}`
          enqueue(pending.chatId, async () => {
            const typing = startTyping(pending.chatId)
            try {
              setState("thinking")
              const answer = await askPiWithRetry(pending.chatId, confirmedMessage)
              const stripped = stripMarkdown(answer)
              stopTyping(typing)
              emitMessage(stripped)
              await bot.api.sendMessage(pending.chatId, stripped)
              setState("idle")
            } catch (err: any) {
              logError("Bot", `Failed to process confirmed message: ${err}`)
              setState("error")
              emitError(err?.message)
            } finally {
              stopTyping(typing)
            }
          })
        } else {
          info("Events", `Confirm ${cmd.data.id} rejected`)
          bot.api.sendMessage(pending.chatId, "Acción cancelada.").catch(() => {})
        }
        break
      }

      case "mara:start-listening":
        info("Events", "UI start-listening received")
        setState("listening")
        break

      case "mara:stop-listening":
        info("Events", "UI stop-listening received")
        setState("idle")
        break

      case "mara:settings":
        info("Events", `UI settings: ${JSON.stringify(cmd.data)}`)
        break
    }
  })
}

// Procesa audio PCM del micrófono del navegador (reenviado por el bridge):
// lo transcribe y responde por el mismo flujo que un mensaje de Telegram.
async function handleBrowserAudio(wav: Buffer): Promise<void> {
  const chatId = telegramChatId ? Number(telegramChatId) : 0
  const audioPath = join(uploadsDir, `browser-${Date.now()}.wav`)
  let transcript: string | undefined
  const t0 = Date.now()

  // STT apagado: ni siquiera escribimos el clip a disco ni cargamos whisper.
  if (!sttEnabled) {
    info("Telegram", `[mic] STT disabled; ${wav.length} bytes descartados`)
    setState("idle")
    emitError(sttDisabledMessage)
    return
  }

  await enqueue(chatId, async () => {
    try {
      await mkdir(uploadsDir, { recursive: true })
      await writeFile(audioPath, wav)
      // 16000 Hz mono PCM16 → bytes/2/16000 = segundos
      const durSec = wav.length / 32000
      info("Telegram", `[mic] clip: ${wav.length} bytes (${durSec.toFixed(2)}s), ruta=${audioPath}`)
      // Procesando: pasamos a thinking (no a listening, que rearmaría el mic del navegador y causaría bucle).
      setState("thinking")
      try {
        transcript = sttLocalEnabled
          ? await transcribeLocal(audioPath)
          : await transcribeAudio(audioPath)
        info("Telegram", `[mic] transcripción (${((Date.now() - t0) / 1000).toFixed(2)}s): "${transcript}"`)
      } catch (err) {
        logError("Telegram", `[mic] transcription failed: ${err}`)
        setState("error")
        emitError("No pude entender el audio del micrófono del navegador.")
        return
      }

      // Filtro de realimentación: si whisper no detectó voz (solo música,
      // ruido o silencio, marcado con [...]), no procesamos ese clip para
      // evitar bucles donde el mic captura la propia salida de audio.
      const meaningful = isMeaningfulTranscription(transcript)
      info("Telegram", `[mic] ¿voz real? ${meaningful ? "SÍ" : "NO"} → ${meaningful ? "procesando" : "ignorando clip"}`)
      if (!meaningful) {
        info("Telegram", `[mic] Ignored (sin voz): "${transcript}"`)
        setState("idle")
        return
      }

      setState("thinking")
      info("Telegram", `[mic] enviando a Ollama (${transcript.slice(0, 60)})…`)
      const answer = await askPiWithRetry(chatId, transcript)
      const stripped = stripMarkdown(answer)
      info("Telegram", `[mic] respuesta Ollama (${((Date.now() - t0) / 1000).toFixed(2)}s): "${stripped.slice(0, 80)}"`)
      emitMessage(stripped)
      if (telegramChatId) {
        // Espejado a Telegram: transcripción del usuario + respuesta de Mara.
        const mirrored = `🎤 ${maraUserName}: ${transcript}\n\nMara: ${stripped}`
        await bot.api.sendMessage(chatId, mirrored)
        info("Telegram", `[mic] Enviado a Telegram (chat ${chatId})`)
      } else {
        warn("Telegram", "[mic] TELEGRAM_CHAT_ID no configurado: no se envió la transcripción/respuesta a Telegram")
      }
      // Respuesta de voz para la propia UI: generamos el TTS y se lo mandamos
      // para que lo reproduzca en el dispositivo. Orquestamos el ciclo de habla
      // aquí para que la UI siga en "speaking" mientras reproduce el audio.
      if (voiceboxEnabled) {
        try {
          emitSpeakingStarted()
          const wav = await generateVoice(stripped, false)
          emitVoiceAudio(stripped, wav)
          emitSpeakingFinished()
          info("Telegram", `[mic] Voz generada para la UI (${wav.length} bytes)`)
        } catch (err) {
          logError("Bot", `[mic] TTS para la UI falló: ${err}`)
          emitSpeakingFinished()
        }
      }
      setState("idle")
      info("Telegram", `[mic] Replied to browser audio (audio)`)
    } catch (err: any) {
      logError("Bot", `[mic] Failed to process browser audio: ${err}`)
      setState("error")
      emitError(err?.message)
    } finally {
      await unlink(audioPath).catch(() => {})
    }
  })
}

function registerAudioHandler(): void {
  setAudioHandler((wav) => {
    void handleBrowserAudio(wav)
  })
}

async function gracefulShutdown(signal: string) {
  info("Bot", `Received ${signal}, shutting down...`)
  closeUiEvents()
  bot.stop()
  process.exit(0)
}

async function start() {
  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))

  startUiEvents()
  registerCommandHandler()
  registerAudioHandler()

  info("Bot", `Ollama: ${ollamaUrl} | Model: ${ollamaModel}`)
  try {
    const res = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { version: string }
    info("Ollama", `Ping OK — v${data.version}`)
  } catch {
    warn("Ollama", `No responde en ${ollamaUrl}. El bot arrancará pero las consultas fallarán.`)
    setState("offline")
  }

  try {
    const me = await bot.api.getMe()
    info("Bot", `Bot @${me.username} running!`)
    if (telegramChatId) {
      const now = new Date().toLocaleString("es-ES", { timeZone: timezone, dateStyle: "full", timeStyle: "medium" })
      await bot.api.sendMessage(telegramChatId, `🤖 Mara OS (lite) iniciado\n✅ @${me.username}\n🕐 ${now}`)
    }
  } catch (err) {
    logError("Bot", `Failed to start: ${err}`)
  }

  bot.start()
}

start()
