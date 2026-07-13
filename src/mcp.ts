import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { McpServerConfig, McpConfig } from "./config.js"
import { info, error as logError, debug } from "./logger.js"

export const clientsMap = new Map<string, Client>()
export const toolToClientMap = new Map<string, Client>()
export const memoryServerNames = new Set(["engram"])
export let hasMemoryServer = false
export let ollamaTools: Array<any> = []

function buildTransport(server: McpServerConfig) {
  const serverType = server.type ?? "http"

  if (serverType === "stdio") {
    if (!server.command) {
      throw new Error(`Missing command for stdio MCP server "${server.name}"`)
    }

    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: server.env,
    })
  }

  if (!server.url) {
    throw new Error(`Missing url for http MCP server "${server.name}"`)
  }

  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: {
        "Accept": "application/json, text/event-stream",
      },
    },
  })
}

export async function initMcpClients() {
  try {
    const mcpConfigPath = join(process.cwd(), "mcp.json")
    const mcpConfigContent = await readFile(mcpConfigPath, "utf8")
    const mcpConfig = JSON.parse(mcpConfigContent) as McpConfig
    info("MCP", `Loading config from ${mcpConfigPath}`)
    info("MCP", `Servers configured: ${mcpConfig.servers.map((server) => `${server.name}:${server.type ?? "http"}`).join(", ")}`)

    for (const server of mcpConfig.servers) {
      const transportLabel = server.type ?? "http"
      const targetLabel = server.type === "stdio" ? server.command : server.url
      info("MCP", `Connecting to server "${server.name}" (${transportLabel}) ${targetLabel ?? ""}...`)
      try {
        const transport = buildTransport(server)
        const client = new Client(
          { name: `mara-os-client-${server.name}`, version: "1.0.0" },
          { capabilities: {} }
        )
        await client.connect(transport)
        clientsMap.set(server.name, client)
        if (memoryServerNames.has(server.name)) {
          hasMemoryServer = true
          info("Memory", `MCP memory server detected: "${server.name}"`)
        }
        info("MCP", `Connected to server "${server.name}"`)

        const toolsResult = await client.listTools()
        info("MCP", `Server "${server.name}" tools: ${toolsResult.tools.map(t => t.name).join(", ")}`)

        for (const tool of toolsResult.tools) {
          toolToClientMap.set(tool.name, client)
          const safeDesc = (tool.description || "").replace(/ on Google Calendar/gi, "").replace(/ in Google Calendar/gi, "").replace(/ on my calendar/gi, "").replace(/ of Kike/gi, "")
          ollamaTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: safeDesc,
              parameters: tool.inputSchema || {
                type: "object",
                properties: {}
              }
            }
          })
          debug("MCP", `Registered tool "${tool.name}" from "${server.name}"`)
        }
      } catch (err) {
        logError("MCP", `Failed to connect to server "${server.name}": ${err}`)
      }
    }
    info("MCP", `Loaded ${clientsMap.size} client(s) and ${ollamaTools.length} tool(s) for Ollama`)
    if (!hasMemoryServer) {
      info("Memory", `No MCP memory server available; using fallback MEMORY.md`)
    }
    info("Memory", `Memory mode: ${hasMemoryServer ? "engram" : "fallback MEMORY.md"}`)
  } catch (err) {
    logError("MCP", `Error reading or parsing mcp.json: ${err}`)
  }
}

export async function callMcpTool(toolName: string, toolArgs: any): Promise<string> {
  const client = toolToClientMap.get(toolName)
  if (!client) {
    throw new Error(`Tool "${toolName}" client not found`)
  }
  debug("MCP", `Calling tool "${toolName}" on server...`)
  const callResult = await client.callTool({
    name: toolName,
    arguments: toolArgs
  })

  if (callResult && typeof callResult === "object" && "content" in callResult && Array.isArray(callResult.content)) {
    const textParts = callResult.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
    debug("MCP", `Tool "${toolName}" returned text content (${textParts.length} chars)`)
    return textParts
  }

  const resultStr = JSON.stringify(callResult)
  debug("MCP", `Tool "${toolName}" returned: ${resultStr}`)
  return resultStr
}

export async function closeMcpClients(): Promise<void> {
  try {
    for (const [name, client] of clientsMap) {
      info("MCP", `Disconnecting from server "${name}"...`)
      await client.close()
    }
    clientsMap.clear()
    toolToClientMap.clear()
    ollamaTools = []
  } catch (err) {
    logError("MCP", `Error closing clients: ${err}`)
  }
}
