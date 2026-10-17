import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { McpServerConfig, McpConfig } from "./config.js"
import { info, error as logError, debug, warn } from "./logger.js"

const SERVER_CONNECT_TIMEOUT_MS = 15_000

export const clientsMap = new Map<string, Client>()
export const toolToClientMap = new Map<string, Client>()
export const memoryServerNames = new Set(["engram"])
export let hasMemoryServer = false
export let ollamaTools: Array<any> = []

// Estado del último intento de conexión, para diagnósticos (mensaje de arranque).
let configuredServers: string[] = []
const failedServers = new Set<string>()

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
      signal: AbortSignal.timeout(SERVER_CONNECT_TIMEOUT_MS),
      headers: {
        "Accept": "application/json, text/event-stream",
      },
    },
  })
}

async function connectServer(server: McpServerConfig): Promise<{ server: McpServerConfig; ok: boolean; error?: string }> {
  const transportLabel = server.type ?? "http"
  const targetLabel = server.type === "stdio" ? server.command : server.url
  info("MCP", `Connecting to server "${server.name}" (${transportLabel}) ${targetLabel ?? ""}...`)

  const transport = buildTransport(server)
  const client = new Client(
    { name: `mara-os-client-${server.name}`, version: "1.0.0" },
    { capabilities: {} }
  )

  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${SERVER_CONNECT_TIMEOUT_MS / 1000}s`)), SERVER_CONNECT_TIMEOUT_MS)
      ),
    ])
  } catch (err) {
    try { client.close() } catch { /* ignore */ }
    throw err
  }

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

  return { server, ok: true }
}

export async function initMcpClients() {
  try {
    const mcpConfigPath = join(process.cwd(), "mcp.json")
    const mcpConfigContent = await readFile(mcpConfigPath, "utf8")
    const mcpConfig = JSON.parse(mcpConfigContent) as McpConfig
    info("MCP", `Loading config from ${mcpConfigPath}`)
    info("MCP", `Servers configured: ${mcpConfig.servers.map((server) => `${server.name}:${server.type ?? "http"}`).join(", ")}`)

    const servers = mcpConfig.servers
    configuredServers = servers.map((server) => server.name)
    failedServers.clear()

    const results = await Promise.allSettled(
      servers.map(server => connectServer(server))
    )

    results.forEach((r, index) => {
      if (r.status === "rejected") {
        failedServers.add(servers[index].name)
        logError("MCP", `Failed to connect to "${servers[index].name}": ${r.reason}`)
      }
    })

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

export function getToolsByServer(serverName: string): Array<{ name: string, description: string }> {
  const client = clientsMap.get(serverName)
  if (!client) return []
  const tools: Array<{ name: string, description: string }> = []
  for (const [toolName, toolClient] of toolToClientMap) {
    if (toolClient === client) {
      tools.push({ name: toolName, description: "" })
    }
  }
  return tools
}

export async function callServerTool(serverName: string, toolName: string, toolArgs: any): Promise<string> {
  const client = clientsMap.get(serverName)
  if (!client) {
    throw new Error(`Server "${serverName}" not connected`)
  }
  const callResult = await client.callTool({ name: toolName, arguments: toolArgs })
  if (callResult && typeof callResult === "object" && "content" in callResult && Array.isArray(callResult.content)) {
    const textParts = callResult.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
    return textParts
  }
  return JSON.stringify(callResult)
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

export function getConnectedMcpServerNames(): string[] {
  return Array.from(clientsMap.keys())
}

export function getRegisteredToolNames(): string[] {
  return ollamaTools
    .map((tool: any) => tool?.function?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
}

export interface McpStatus {
  /** Servidores declarados en mcp.json. */
  configured: string[]
  /** Servidores conectados. */
  connected: string[]
  /** Servidores que fallaron al conectar. */
  failed: string[]
  /** Número de tools registradas por servidor conectado. */
  toolsByServer: Record<string, number>
}

/** Resumen del estado MCP tras `initMcpClients()`, para diagnósticos. */
export function getMcpStatus(): McpStatus {
  const nameByClient = new Map<Client, string>()
  for (const [name, client] of clientsMap) {
    nameByClient.set(client, name)
  }

  const toolsByServer: Record<string, number> = {}
  for (const [, client] of toolToClientMap) {
    const name = nameByClient.get(client)
    if (name) toolsByServer[name] = (toolsByServer[name] ?? 0) + 1
  }

  return {
    configured: [...configuredServers],
    connected: [...clientsMap.keys()],
    failed: [...failedServers],
    toolsByServer,
  }
}
