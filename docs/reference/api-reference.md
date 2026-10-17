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
ollamaUrl: string           // OLLAMA_URL (default: http://192.168.1.182:11434)
ollamaModel: string         // OLLAMA_MODEL (default: ornith-1.5:9b)
timezone: string            // TIMEZONE (default: Europe/Madrid)
brainWsUrl: string          // MARA_BRAIN_WS_URL (default: "", vacío = desactivado)

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

### src/events.ts

Servidor WebSocket "brain" y protocolo de eventos v1 hacia Mara UI. No-bloqueante:
si `MARA_BRAIN_WS_URL` está vacío o el bridge no conecta, todo es un no-op.

```typescript
type MaraState = "idle" | "listening" | "thinking" | "speaking" | "seeing" | "error" | "offline"

interface MaraEventEnvelope<T = unknown> { type: string; version: number; timestamp: number; data: T }
interface ConfirmRequest { id: string; title: string; message: string; action: string }

startUiEvents(): void                       // Arranca el servidor (log + no-op si falla)
closeUiEvents(): void                       // Cierra el servidor (shutdown limpio)
emit(type: string, data: unknown): void     // Envelope v1 a todos los clientes
setState(state: MaraState): void            // mara:state (dedup si no cambió)
emitMessage(text: string): void             // mara:message
emitNetwork(connected: boolean): void       // mara:network
emitConfirm(request: ConfirmRequest): void  // mara:confirm
emitError(message?: string): void           // mara:error
getState(): MaraState
isUiEnabled(): boolean
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
├── startUiEvents()         → Arrancar servidor WebSocket brain (no-bloqueante)
├── initMcpClients()        → Conectar servidores MCP
├── checkOllama()           → Verificar que Ollama responde
├── bot.start()             → Iniciar bot de Telegram
└── bot.api.getMe()         → Verificar bot y notificar inicio
```
