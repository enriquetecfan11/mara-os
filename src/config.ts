import { join } from "node:path"

export interface McpServerConfig {
  name: string
  type?: "http" | "stdio"
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpConfig {
  servers: McpServerConfig[]
}

export const telegramToken = process.env.TELEGRAM_TOKEN!
export const agentDir = join(process.cwd(), "config")
export const skillsDir = join(agentDir, "skills")
export const uploadsDir = join(agentDir, "uploads")
export const memoryPath = join(agentDir, "MEMORY.md")
export const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434"
export const ollamaModel = process.env.OLLAMA_MODEL || "gemma4:e2b"
