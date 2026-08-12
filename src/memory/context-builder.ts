import { readContextFile } from "../cache.js"
import { agentDir } from "../config.js"
import { MemoryManager } from "./memory-manager.js"
import { info, debug } from "../logger.js"

export interface ContextBuilderOptions {
  chatId: number
  userMessage: string
  maxConversationTokens: number
  maxMemoryTokens: number
  memorySearchLimit: number
}

export interface BuiltContext {
  systemPrompt: string
  recentMessages: Array<{ role: string; content: string }>
  memoryContext: string
  skillsContext: string
}

export async function buildContext(
  memoryManager: MemoryManager,
  options: ContextBuilderOptions
): Promise<BuiltContext> {
  const { chatId, userMessage, maxConversationTokens, maxMemoryTokens, memorySearchLimit } = options

  const [soul, user, agents, systemTemplate, skillsContext] = await Promise.all([
    readContextFile(agentDir, "SOUL.md"),
    readContextFile(agentDir, "USER.md"),
    readContextFile(agentDir, "AGENTS.md"),
    readContextFile(agentDir, "SYSTEM.md"),
    buildSkillsContext(userMessage),
  ])

  const recentMessages = await memoryManager.getRecentConversation(chatId, maxConversationTokens)

  const memorySearch = await memoryManager.search({
    query: userMessage,
    limit: memorySearchLimit,
    minImportance: 0.3,
  })

  const memoryContext = formatMemoryContext(memorySearch.entries, maxMemoryTokens)

  const timezone = process.env.TIMEZONE || "Europe/Madrid"
  const currentDateTime = new Date().toLocaleString("es-ES", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "medium",
  })

  const systemPrompt = systemTemplate
    .replace("{{DATE_TIME}}", currentDateTime)
    .replace("{{TIMEZONE}}", timezone)
    .replace("{{SOUL}}", soul)
    .replace("{{USER}}", user)
    .replace("{{AGENTS}}", agents)
    .replace("{{MEMORY}}", memoryContext)
    .replace("{{SKILLS}}", skillsContext)

  debug("ContextBuilder", `Built context: ${systemPrompt.length} chars system, ${recentMessages.length} recent messages, ${memorySearch.entries.length} memories`)

  return {
    systemPrompt,
    recentMessages: recentMessages.map((m) => ({ role: m.role, content: m.content })),
    memoryContext,
    skillsContext,
  }
}

async function buildSkillsContext(userMessage: string): Promise<string> {
  const { loadAllSkills, detectSkills, loadSkillsContext } = await import("../skills.js")
  const allSkills = await loadAllSkills()
  const detectedSkills = detectSkills(userMessage, allSkills)
  if (detectedSkills.length === 0) return ""
  return await loadSkillsContext(detectedSkills)
}

function formatMemoryContext(entries: Array<{ content: string; type: string; importance: number }>, maxTokens: number): string {
  if (entries.length === 0) return ""

  const lines = entries.map((e) => `- [${e.type}] ${e.content} (importancia: ${e.importance.toFixed(1)})`)
  const joined = lines.join("\n")

  const estimatedTokens = Math.ceil(joined.length / 3.5)
  if (estimatedTokens <= maxTokens) {
    return `MEMORIAS RELEVANTES:\n${joined}`
  }

  let currentTokens = 0
  const filtered: string[] = []
  for (const line of lines) {
    const lineTokens = Math.ceil(line.length / 3.5)
    if (currentTokens + lineTokens > maxTokens) break
    filtered.push(line)
    currentTokens += lineTokens
  }

  return `MEMORIAS RELEVANTES (top ${filtered.length}):\n${filtered.join("\n")}`
}