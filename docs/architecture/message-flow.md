# Flujo de Mensajes

## Ciclo Completo de un Mensaje

### 1. Recepción en Telegram (bot.ts)

```typescript
bot.on("message:text", async (ctx) => { ... })
```

- El bot recibe un mensaje de texto o foto.
- Si el mensaje contiene palabras de riesgo (publicar, postear, tuitea), se requiere confirmación explícita ("Confirmo").
- El mensaje se encola por `chatId` para procesamiento secuencial.
- Se inicia el indicador "escribiendo..." que se repite cada 4s.

### 2. Construcción del System Prompt (ollama.ts)

`askPi()` construye un system prompt dinámico:

1. Lee los archivos de contexto cacheados: SOUL.md, USER.md, AGENTS.md, MEMORY.md
2. Lee la plantilla SYSTEM.md
3. Detecta skills relevantes al mensaje del usuario vía `detectSkills()`
4. Reemplaza los placeholders en SYSTEM.md:
   - `{{DATE_TIME}}` → fecha/hora actual
   - `{{TIMEZONE}}` → zona horaria configurada
   - `{{SOUL}}` → contenido de SOUL.md
   - `{{USER}}` → contenido de USER.md
   - `{{AGENTS}}` → contenido de AGENTS.md
   - `{{MEMORY}}` → contenido de MEMORY.md
   - `{{SKILLS}}` → skills detectados

### 3. Envío a Ollama

```typescript
fetch("http://localhost:11434/api/chat", {
  body: JSON.stringify({
    model: ollamaModel,
    messages: [{ role: "system", content: systemPrompt }, ...history],
    stream: false,
    tools: ollamaTools,
    tool_choice: "required",
    temperature: 0.3
  })
})
```

- `tool_choice: "required"` fuerza al modelo a usar herramientas.
- `temperature: 0.3` reduce la no-determinismo del modelo cuantizado.
- Timeout de 60s por request.

### 4. Procesamiento de la Respuesta

El bucle principal:

```
while (hay_tool_calls) {
  1. Enviar mensaje + historial a Ollama
  2. Recibir respuesta (texto + tool_calls opcionales)
  3. Si hay tool_calls:
     a. Ejecutar todas en paralelo via Promise.all()
     b. Añadir resultados al historial como role: "tool"
     c. Repetir desde paso 1
  4. Si no hay tool_calls:
     a. Devolver texto como respuesta final
}
```

### 5. Ejecución de Tools (mcp.ts)

- Cada tool_call se mapea al servidor MCP correspondiente.
- Si es `update_memory` (fallback), escribe directamente MEMORY.md.
- Si es una tool MCP real, se llama al servidor y se extrae el texto de la respuesta.

### 6. Respuesta al Usuario

- El texto final se limpia de markdown (`stripMarkdown()`).
- Se envía como mensaje de texto plano a Telegram.

## Diagrama de Flujo

```
Usuario ──▶ Telegram ──▶ bot.ts ──▶ ollama.ts ──▶ Ollama API
                ▲                                    │
                │                                    ▼
                │                            ¿tool_calls?
                │                              │       │
                │                             Sí       No
                │                              │       │
                │                              ▼       ▼
                │                     mcp.ts  ──▶  Responder
                │                       │
                │                       ▼
                │               Servidores MCP
                │                       │
                └─── Resultados ◀────────┘
```
