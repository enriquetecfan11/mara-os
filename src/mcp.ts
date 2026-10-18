import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { McpServerConfig, McpConfig } from "./config.js"
import { info, error as logError, debug, warn } from "./logger.js"

const SERVER_CONNECT_TIMEOUT_MS = 15_000

// Env MCP opcional: desactiva servidores por nombre sin tocar mcp.json.
// Útil en la Raspberry Pi, donde macos_automator no puede funcionar (manda AppleScript).
const disabledMcpServers = new Set(
  (process.env.MCP_DISABLED_SERVERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

/**
 * Sustituye ${VAR} y ${VAR:-por_defecto} por variables de entorno, para que
 * mcp.json no lleve rutas absolutas atadas a una máquina concreta (las de uv,
 * npx o ffmpeg cambian entre un Mac y la Raspberry Pi).
 */
function expandString(input: string): string {
  let out = input

  // Primera pasada: los ${VAR} sin default. Así los anidados se resuelven antes,
  // porque ${UV_PATH:-${HOME}/.local/bin/uv} necesita Expanding $HOME primero.
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "")
    if (next === out) break
    out = next
  }

  // Segunda pasada: los ${VAR:-por_defecto}.
  return out.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g,
    (_, name: string, fallback: string) => process.env[name] ?? fallback,
  )
}

function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return expandString(value)
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars)
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, expandEnvVars(v)]),
    )
  }
  return value
}

export const clientsMap = new Map<string, Client>()
export const toolToClientMap = new Map<string, Client>()
// Servidores MCP que cuentan como backend de "memoria". Vacío por defecto.
// Declara aquí los tuyos con MCP_MEMORY_SERVERS=nombre1,nombre2.
export const memoryServerNames = new Set(
  (process.env.MCP_MEMORY_SERVERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)
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

    const allServers = mcpConfig.servers
    const enabledServers = disabledMcpServers.size
      ? allServers.filter((s) => !disabledMcpServers.has(s.name))
      : allServers

    if (disabledMcpServers.size) {
      const skipped = allServers.filter((s) => disabledMcpServers.has(s.name)).map((s) => s.name)
      if (skipped.length > 0) {
        info("MCP", `Disabled by MCP_DISABLED_SERVERS: ${skipped.join(", ")}`)
      }
    }

    // Resuelve ${VAR} / ${VAR:-por_defecto} contra el entorno para que mcp.json
    // no lleve rutas absolutas atadas a una máquina.
    const expanded = expandEnvVars({ servers: enabledServers }) as McpConfig
    const servers = expanded.servers.filter((s) => s.command || s.url)

    if (servers.length < enabledServers.length) {
      warn("MCP", `${enabledServers.length - servers.length} server(s) descartados: faltan command/url tras expandir las variables`)
    }

    info("MCP", `Servers configured: ${servers.map((server) => `${server.name}:${server.type ?? "http"}`).join(", ")}`)

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
    if (memoryServerNames.size === 0) {
      debug("Memory", `MCP_MEMORY_SERVERS vacío: ningún servidor MCP cuenta como backend de memoria`)
    } else if (!hasMemoryServer) {
      warn("Memory", `Ninguno de los servidores MCP de memoria declarados (${Array.from(memoryServerNames).join(", ")}) conectó`)
    }
    info("Memory", `Memory mode: ${hasMemoryServer ? "MCP memory server" : "SQLite (data/mara.db)"}`)
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
