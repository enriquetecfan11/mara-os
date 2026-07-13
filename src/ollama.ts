import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentDir, memoryPath, ollamaUrl, ollamaModel } from "./config.js"
import { ollamaTools, hasMemoryServer, callMcpTool } from "./mcp.js"
import { loadAllSkills, detectSkills, loadSkillsContext } from "./skills.js"

const chatHistories = new Map<number, Array<{ role: "user" | "assistant" | "tool", content: string, name?: string, tool_calls?: any[] }>>()

export function clearChatHistory(chatId: number) {
  chatHistories.delete(chatId)
  console.log(`[Ollama] Chat history cleared for chat ${chatId}`)
}

export async function askPi(chatId: number, message: string) {
  const soul = await readFile(join(agentDir, "SOUL.md"), "utf8")
  const user = await readFile(join(agentDir, "USER.md"), "utf8")
  const agents = await readFile(join(agentDir, "AGENTS.md"), "utf8")
  const currentMemory = await readFile(memoryPath, "utf8")
  const systemTemplate = await readFile(join(agentDir, "SYSTEM.md"), "utf8")
  console.log(`[Memory] Loaded MEMORY.md (${currentMemory.length} chars)`)

  const allSkills = await loadAllSkills()
  const detectedSkills = detectSkills(message, allSkills)
  const skillsContext = await loadSkillsContext(detectedSkills)
  if (detectedSkills.length > 0) {
    console.log(`[Skills] Detected: ${detectedSkills.join(", ")}`)
  }

  const timezone = process.env.TIMEZONE || "Europe/Madrid"
  const currentDateTime = new Date().toLocaleString("es-ES", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "medium"
  })
  const systemPrompt = systemTemplate
    .replace("{{DATE_TIME}}", currentDateTime)
    .replace("{{TIMEZONE}}", timezone)
    .replace("{{SOUL}}", soul)
    .replace("{{USER}}", user)
    .replace("{{AGENTS}}", agents)
    .replace("{{MEMORY}}", currentMemory)
    .replace("{{SKILLS}}", skillsContext)
  console.log(`[Prompt] System prompt ready for chat ${chatId} (${systemPrompt.length} chars)`)

  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, [])
  }
  const history = chatHistories.get(chatId)!

  history.push({ role: "user", content: message })

  if (history.length > 20) {
    history.shift()
  }

  let loop = true
  let replyText = ""

  while (loop) {
    console.log(`[Ollama] Sending request to ${ollamaUrl}/api/chat using model: ${ollamaModel} (history size: ${history.length})...`)
    
    const tools = [
      ...(!hasMemoryServer ? [{
        type: "function",
        function: {
          name: "update_memory",
          description: "Updates the MEMORY.md file with new or updated facts. Write the entire updated content of the MEMORY.md file.",
          parameters: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "The complete, updated content for the MEMORY.md file."
              }
            },
            required: ["content"]
          }
        }
      }] : []),
      ...ollamaTools
    ]
    console.log(`[Ollama] Tools available: ${tools.map((tool: any) => tool.function?.name ?? "unknown").join(", ")}`)
    if (!hasMemoryServer) {
      console.log(`[Memory] Using fallback update_memory tool because Engram is not connected`)
    }

    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          ...history,
        ],
        stream: false,
        tools: tools,
        tool_choice: "required",
        temperature: 0.3
      }),
    })

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as {
      message: {
        role: "assistant"
        content: string
        tool_calls?: Array<{
          function: {
            name: string
            arguments: any
          }
        }>
      }
    }

    const assistantMessage = data.message
    
    history.push({
      role: "assistant",
      content: assistantMessage.content || "",
      ...(assistantMessage.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {})
    })
    
    if (history.length > 20) {
      history.shift()
    }

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      console.log(`[Ollama] Received tool calls:`, JSON.stringify(assistantMessage.tool_calls))
      
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name
        let toolArgs = toolCall.function.arguments

        if (typeof toolArgs === "string") {
          try {
            toolArgs = JSON.parse(toolArgs)
          } catch {
            // Keep as string
          }
        }

        console.log(`[Tool] Executing tool "${toolName}" with arguments:`, toolArgs)

        let resultStr = ""
        if (toolName === "update_memory") {
          let newMemory = ""
          if (toolArgs && typeof toolArgs === "object" && "content" in toolArgs) {
            newMemory = toolArgs.content
          } else if (typeof toolArgs === "string") {
            newMemory = toolArgs
          }
          if (newMemory) {
            await writeFile(memoryPath, newMemory, "utf8")
            console.log(`[Memory] Updated MEMORY.md with new contents: ${newMemory}`)
            resultStr = "Memoria actualizada correctamente."
          } else {
            resultStr = "Error: no se proporcionó contenido para actualizar la memoria."
          }
        } else {
          try {
            resultStr = await callMcpTool(toolName, toolArgs)
          } catch (err: any) {
            console.error(`[MCP] Error executing tool "${toolName}":`, err)
            resultStr = `Error executing tool: ${err?.message || err}`
          }
        }

        history.push({
          role: "tool",
          content: resultStr
        })

        if (history.length > 20) {
          history.shift()
        }
      }
    } else {
        console.log(`[Ollama] Final assistant message length: ${assistantMessage.content?.length ?? 0}`)
        const finalContent = assistantMessage.content?.trim() ?? "No he podido generar una respuesta.";
        replyText = finalContent;
        loop = false;
    }
  }

  return replyText || "Memoria actualizada."
}
