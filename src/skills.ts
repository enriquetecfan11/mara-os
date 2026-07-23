import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { skillsDir } from "./config.js"

export interface Skill {
  name: string
  keywords: string[]
  content: string
}

const skillsCache = new Map<string, Skill>()

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw }

  const meta: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    meta[key] = val
  }
  return { meta, body: match[2] }
}

export async function loadAllSkills(): Promise<Map<string, Skill>> {
  if (skillsCache.size > 0) return skillsCache

  try {
    const files = await readdir(skillsDir)
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const raw = await readFile(join(skillsDir, file), "utf8")
      const { meta, body } = parseFrontmatter(raw)
      const keywords = (meta.keywords || "")
        .replace(/[\[\]]/g, "")
        .split(",")
        .map(k => k.trim().toLowerCase())
        .filter(Boolean)

      skillsCache.set(meta.name || file.replace(".md", ""), {
        name: meta.name || file.replace(".md", ""),
        keywords,
        content: body.trim()
      })
    }
  } catch (err) {
    console.error("[Skill] Error loading skills:", err)
  }

  return skillsCache
}

export function detectSkills(message: string, skills: Map<string, Skill>): string[] {
  const lower = message.toLowerCase()
  const detected: string[] = []

  for (const [name, skill] of skills) {
    if (skill.keywords.some(kw => lower.includes(kw))) {
      detected.push(name)
    }
  }

  return detected
}

export async function loadSkillsContext(detectedNames: string[]): Promise<string> {
  if (detectedNames.length === 0) return ""

  const allSkills = await loadAllSkills()
  const parts: string[] = []

  for (const name of detectedNames) {
    const skill = allSkills.get(name)
    if (skill) {
      parts.push(skill.content)
    }
  }

  if (parts.length === 0) return ""

  return `\n\nSKILLS ACTIVOS:\n${parts.join("\n\n")}`
}

export async function getSkillList(): Promise<string[]> {
  const skills = await loadAllSkills()
  return Array.from(skills.keys())
}

export async function reloadSkills(): Promise<void> {
  skillsCache.clear()
  await loadAllSkills()
}
