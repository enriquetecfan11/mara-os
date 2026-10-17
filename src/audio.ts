import { spawn } from "node:child_process"

// Transcodifica el WAV de Voicebox → OGG/Opus para enviarlo como NOTA DE VOZ de Telegram
// (replyWithVoice), en vez de como archivo de música (replyWithAudio).
// Requiere ffmpeg con libopus. Si falla, el llamador cae a enviar el WAV.
export function wavToOggOpus(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "wav", "-i", "pipe:0",
      "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1",
      "-f", "ogg", "pipe:1",
    ])

    const out: Buffer[] = []
    const err: Buffer[] = []
    ff.stdout.on("data", (d: Buffer) => out.push(d))
    ff.stderr.on("data", (d: Buffer) => err.push(d))
    ff.on("error", reject) // ffmpeg no instalado / no en PATH
    ff.on("close", (code) => {
      if (code === 0 && out.length > 0) {
        resolve(Buffer.concat(out))
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`))
      }
    })

    ff.stdin.on("error", () => {}) // evita EPIPE si ffmpeg cierra stdin antes de tiempo
    ff.stdin.end(wav)
  })
}

// Transcodifica audio arbitrario (OGG/Opus de Telegram, MP3, M4A…) → WAV PCM
// 16 kHz mono, que es el formato que espera el STT local (whisper). Requiere
// ffmpeg en el PATH, igual que wavToOggOpus. Si falla, el llamador propaga el error.
export function transcodeToWavPcm(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      "-f", "wav", "pipe:1",
    ])

    const out: Buffer[] = []
    const err: Buffer[] = []
    ff.stdout.on("data", (d: Buffer) => out.push(d))
    ff.stderr.on("data", (d: Buffer) => err.push(d))
    ff.on("error", reject) // ffmpeg no instalado / no en PATH
    ff.on("close", (code) => {
      if (code === 0 && out.length > 0) {
        resolve(Buffer.concat(out))
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`))
      }
    })

    ff.stdin.on("error", () => {}) // evita EPIPE si ffmpeg cierra stdin antes de tiempo
    ff.stdin.end(input)
  })
}
