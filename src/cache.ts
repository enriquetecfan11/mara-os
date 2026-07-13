import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

interface CacheEntry {
  content: string
  mtime: number
}

const contextCache = new Map<string, CacheEntry>()

export async function readContextFile(agentDir: string, filename: string): Promise<string> {
  const path = join(agentDir, filename)

  try {
    const fileStat = await stat(path)
    const mtime = fileStat.mtime.getTime()
    const cached = contextCache.get(filename)

    if (cached && cached.mtime === mtime) {
      return cached.content
    }

    const content = await readFile(path, "utf8")
    contextCache.set(filename, { content, mtime })
    return content
  } catch (err) {
    contextCache.delete(filename)
    throw err
  }
}

export function clearCache(): void {
  contextCache.clear()
}
