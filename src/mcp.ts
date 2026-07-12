import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { McpServerConfig, McpConfig } from "./config.js"

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

  return new StreamableHTTPClientTransport(new URL(server.url))
}

export async function initMcpClients() {
  try {
    const mcpConfigPath = join(process.cwd(), "mcp.json")
    const mcpConfigContent = await readFile(mcpConfigPath, "utf8")
    const mcpConfig = JSON.parse(mcpConfigContent) as McpConfig
    console.log(`[MCP] Loading config from ${mcpConfigPath}`)
    console.log(`[MCP] Servers configured: ${mcpConfig.servers.map((server) => `${server.name}:${server.type ?? "http"}`).join(", ")}`)

    for (const server of mcpConfig.servers) {
      const transportLabel = server.type ?? "http"
      const targetLabel = server.type === "stdio" ? server.command : server.url
      console.log(`[MCP] Connecting to server "${server.name}" (${transportLabel}) ${targetLabel ?? ""}...`)
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
          console.log(`[Memory] MCP memory server detected: "${server.name}"`)
        }
        console.log(`[MCP] Connected to server "${server.name}"`)

        const toolsResult = await client.listTools()
        console.log(`[MCP] Server "${server.name}" tools:`, toolsResult.tools.map(t => t.name))
        
        for (const tool of toolsResult.tools) {
          toolToClientMap.set(tool.name, client)
          ollamaTools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description || "",
              parameters: tool.inputSchema || {
                type: "object",
                properties: {}
              }
            }
          })
          console.log(`[MCP] Registered tool "${tool.name}" from "${server.name}"`)
        }
      } catch (err) {
        console.error(`[MCP] Failed to connect to server "${server.name}":`, err)
      }
    }
    console.log(`[MCP] Loaded ${clientsMap.size} client(s) and ${ollamaTools.length} tool(s) for Ollama`)
    if (!hasMemoryServer) {
      console.log(`[Memory] No MCP memory server available; using fallback MEMORY.md`)
    }
    console.log(`[Memory] Memory mode: ${hasMemoryServer ? "engram" : "fallback MEMORY.md"}`)
  } catch (err) {
    console.error(`[MCP] Error reading or parsing mcp.json:`, err)
  }
}

export async function callMcpTool(toolName: string, toolArgs: any): Promise<string> {
  const client = toolToClientMap.get(toolName)
  if (!client) {
    throw new Error(`Tool "${toolName}" client not found`)
  }
  console.log(`[MCP] Calling tool "${toolName}" on server...`)
  const callResult = await client.callTool({
    name: toolName,
    arguments: toolArgs
  })
  const resultStr = JSON.stringify(callResult)
  console.log(`[MCP] Tool "${toolName}" returned:`, resultStr)
  return resultStr
}
