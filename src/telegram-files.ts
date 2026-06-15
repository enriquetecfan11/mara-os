import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Bot } from "grammy"

export async function saveTelegramPhoto(bot: Bot, token: string, fileId: string, uploadsDir: string) {
  const file = await bot.api.getFile(fileId)
  if (!file.file_path) throw new Error("Telegram file has no path")

  await mkdir(uploadsDir, { recursive: true })

  const extension = file.file_path.split(".").at(-1) ?? "jpg"
  const imagePath = join(uploadsDir, `${Date.now()}.${extension}`)
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
  const response = await fetch(url)

  if (!response.ok) throw new Error(`Telegram download failed: ${response.status}`)

  await writeFile(imagePath, Buffer.from(await response.arrayBuffer()))
  return imagePath
}
