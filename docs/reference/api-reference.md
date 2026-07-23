# Referencia de la API Interna

## Módulos

### src/config.ts

Variables de entorno y rutas del proyecto.

```typescript
telegramToken: string       // TELEGRAM_TOKEN
telegramChatId: string      // TELEGRAM_CHAT_ID
agentDir: string            // path a config/
skillsDir: string           // path a config/skills/
uploadsDir: string          // path a config/uploads/
memoryPath: string          // path a config/MEMORY.md
ollamaUrl: string           // OLLAMA_URL (default: http://localhost:11434)
ollamaModel: string         // OLLAMA_MODEL (default: gemma4:e2b)
timezone: string            // TIMEZONE (default: Europe/Madrid)

interface McpServerConfig {
  name: string
  type?: "http" | "stdio"
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  servers: McpServerConfig[]
}
```

### src/logger.ts

Logging estructurado con niveles y colores.

```typescript
debug(module: string, message: any): void   // Nivel debug (gris)
info(module: string, message: any): void    // Nivel info (cyan)
warn(module: string, message: any): void    // Nivel warn (amarillo)
error(module: string, message: any): void   // Nivel error (rojo)
```

### src/cache.ts

Caché de archivos con invalidación por mtime.

```typescript
readContextFile(agentDir: string, filename: string): Promise<string>
clearCache(): void
```

### src/skills.ts

Detección y carga de skills.

```typescript
interface Skill {
  name: string
  keywords: string[]
  content: string
}

loadAllSkills(): Promise<Map<string, Skill>>
detectSkills(message: string, skills: Map<string, Skill>): string[]
loadSkillsContext(detectedNames: string[]): Promise<string>
getSkillList(): Promise<string[]>
reloadSkills(): Promise<void>
```

### src/approvals.ts

Flujo de aprobación para acciones de riesgo.

```typescript
approvalMessage: string
needsApproval(message: string): boolean
hasApproval(message: string): boolean
```

### src/telegram-files.ts

Descarga de fotos de Telegram.

```typescript
saveTelegramPhoto(bot: Bot, token: string, fileId: string, uploadsDir: string): Promise<string>
```

### src/mcp.ts

Conexión y despacho de servidores MCP.

```typescript
clientsMap: Map<string, Client>
toolToClientMap: Map<string, Client>
memoryServerNames: Set<string>
hasMemoryServer: boolean
ollamaTools: Array<any>

initMcpClients(): Promise<void>
callMcpTool(toolName: string, toolArgs: any): Promise<string>
closeMcpClients(): Promise<void>
getToolsByServer(serverName: string): Array<{ name: string, description: string }>
callServerTool(serverName: string, toolName: string, toolArgs: any): Promise<string>
```

### src/ollama.ts

Orquestación de LLM y loop de tools.

```typescript
clearChatHistory(chatId: number): void
cancelRequest(chatId: number): void
askPi(chatId: number, message: string): Promise<string>
askPiWithRetry(chatId: number, message: string, maxRetries?: number): Promise<string>
```

### src/bot.ts

Handler de Telegram, comandos y entrada del programa.

```typescript
// Funciones internas
stripMarkdown(text: string): string
enqueue(chatId: number, fn: () => Promise<void>): Promise<void>
startTyping(chatId: number): ReturnType<typeof setInterval>
stopTyping(interval): void
checkOllama(): Promise<boolean>
gracefulShutdown(signal: string): Promise<void>
start(): Promise<void>
```

## Flujo de Inicio

```
start()
├── initMcpClients()        → Conectar servidores MCP
├── checkOllama()           → Verificar que Ollama responde
├── bot.start()             → Iniciar bot de Telegram
└── bot.api.getMe()         → Verificar bot y notificar inicio
```
