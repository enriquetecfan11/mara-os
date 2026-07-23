# Gestión de Sesiones

## Historial por Chat

Cada chat (identificado por `chatId`) tiene su propio historial de conversación almacenado en memoria:

```typescript
const chatHistories = new Map<number, ChatSession>()
```

### Límite de Mensajes

El historial está limitado a 20 mensajes. Cuando se excede, se elimina el mensaje más antiguo (FIFO):

```typescript
if (history.length > 20) {
  history.shift()
}
```

### Formato de Sesión

```typescript
interface ChatSession {
  messages: Array<{
    role: "user" | "assistant" | "tool",
    content: string,
    name?: string,
    tool_calls?: any[]
  }>,
  lastUsed: number  // timestamp de último uso
}
```

## Limpieza de Sesiones Inactivas

Las sesiones inactivas se eliminan automáticamente para prevenir fugas de memoria:

```typescript
const CHAT_TIMEOUT = 30 * 60 * 1000     // 30 minutos
const CLEANUP_INTERVAL = 5 * 60 * 1000  // cada 5 minutos
```

El timer de limpieza se inicia al cargar el módulo `ollama.ts`.

## Cancelación de Requests

Cada request activa tiene un `AbortController` asociado al chatId:

```typescript
const activeControllers = new Map<number, AbortController>()
```

### Cancelar Manualmente

El comando `/cancel` aborta la request en curso del chat:

```typescript
export function cancelRequest(chatId: number) {
  const controller = activeControllers.get(chatId)
  if (controller) {
    controller.abort()
    activeControllers.delete(chatId)
  }
}
```

### Timeout Automático

Cada request tiene un timeout de 60s. Si se excede, el `AbortController` aborta automáticamente:

```typescript
const timeout = setTimeout(
  () => controller.abort(new Error("Timeout after 60s")),
  60000
)
```

## Limpieza del Historial

El comando `/reset` elimina el historial del chat actual:

```typescript
export function clearChatHistory(chatId: number) {
  chatHistories.delete(chatId)
}
```

Esto no afecta la memoria persistente (MEMORY.md o Engram), solo el contexto inmediato de la conversación.
