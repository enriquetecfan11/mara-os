# Sistema de Memoria de Mara OS

## Resumen

Mara OS implementa un sistema de memoria de dos niveles, gestionado de forma automática y determinista, sin depender de que el LLM decida cuándo usar tools.

```
┌─────────────────────────────────────────────────────────────┐
│                      MEMORY MANAGER                          │
│  (API unificada: remember, search, forget, list, get)       │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
   ┌───────────────┐               ┌───────────────┐
   │  SQLite Store │               │ Engram Store  │
   │  (local, FTS5)│               │ (MCP adapter) │
   └───────────────┘               └───────────────┘
```

---

## Arquitectura

### Capas

| Archivo | Responsabilidad |
|---------|-----------------|
| `memory-manager.ts` | API pública única, selección de backend |
| `conversation-store.ts` | Historial conversacional (corto plazo) |
| `memory-extractor.ts` | Extracción automática de hechos (largo plazo) |
| `context-builder.ts` | Construcción centralizada del system prompt |
| `stores/sqlite.ts` | Backend SQLite con FTS5 y deduplicación |
| `stores/engram.ts` | Adapter para servidor MCP Engram |
| `migrate.ts` | Migración única MEMORY.md → SQLite |

### Flujo de una request

```
Mensaje usuario
      │
      ▼
ConversationStore.add()           # Guarda en historial corto plazo
      │
      ▼
ContextBuilder.build()            # Combina:
      ├── SOUL + USER + AGENTS
      ├── ConversationStore.recent()  # Últimos N tokens (6000)
      ├── MemoryManager.search()      # Top-5 recuerdos relevantes
      └── Skills context
      │
      ▼
ollama.ts → askPi()               # Solo envía prompt construido
      │
      ▼
Respuesta del modelo
      │
      ▼
ConversationStore.add()           # Guarda respuesta
      │
      ▼
MemoryExtractor.extract()         # Async, no bloquea:
      └── LLM analiza conversación → extrae hechos JSON → MemoryManager.remember()
```

---

## Memoria a Corto Plazo (ConversationStore)

### Características
- **Backend**: SQLite (tabla `conversations`)
- **Límite**: 6000 tokens (~17000 caracteres), no número de mensajes
- **Estimación tokens**: `ceil(longitud / 3.5)`
- **Resumen automático**: Al superar 80% del límite (4800 tokens), resume mensajes antiguos en 1 mensaje de sistema conservando 50% tokens (3000)

### Esquema SQLite
```sql
CREATE TABLE conversations (
  chat_id    INTEGER NOT NULL,
  role       TEXT    NOT NULL,  -- user | assistant | system | tool
  content    TEXT    NOT NULL,
  timestamp  INTEGER NOT NULL,
  tokens     INTEGER NOT NULL,
  PRIMARY KEY (chat_id, timestamp)
);
CREATE INDEX idx_conversations_chat_id ON conversations(chat_id);
CREATE INDEX idx_conversations_timestamp ON conversations(timestamp);
```

### Resumen automático
```typescript
// Cuando totalTokens > 4800:
// 1. Toma mensajes más antiguos hasta llegar a 3000 tokens
// 2. Crea resumen: "[Resumen: X mensajes usuario, Y respuestas. Temas: a, b, c]"
// 3. Borra originales, inserta resumen como mensaje system
```

### API
```typescript
addMessage(chatId, { role, content, timestamp })
getRecent(chatId, maxTokens)     // Para inyectar en prompt
getAll(chatId)                    // Para extracción
clear(chatId)                     // /reset
getTokenCount(chatId)
summarizeOldMessages(chatId, keepTokens)
```

---

## Memoria a Largo Plazo (MemoryManager + Stores)

### Backend SQLite (por defecto)

**Ubicación**:
- Desarrollo: `data/mara.db`
- Producción: `/var/lib/mara/memory/mara.db`

**Esquema**:
```sql
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,
  content         TEXT NOT NULL,
  type            TEXT NOT NULL,
  importance      REAL NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_accessed   INTEGER NOT NULL,
  access_count    INTEGER DEFAULT 0,
  source          TEXT NOT NULL,  -- conversation | manual | migration
  metadata        TEXT            -- JSON opcional
);

CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=rowid);
-- Triggers para mantener FTS sincronizado
```

**Índices**: type, importance DESC, created_at DESC, last_accessed DESC

**Deduplicación**: Antes de insertar, normaliza contenido (`trim().lowercase().replace(/\s+/g, '')`) y busca coincidencia exacta por tipo. Si existe, actualiza `last_accessed` y `access_count` en lugar de duplicar.

**Cache LRU**: 500 entradas en memoria para lecturas frecuentes.

### Backend Engram (opcional)

Si `mcp.json` contiene servidor `engram` conectado:
- `MemoryManager` usa `EngramMemoryStore`
- Delega a tools MCP: `remember`, `recall`, `forget`, `list_memories`, `get_memory`, `update_memory_access`
- Mismos métodos públicos, cambio transparente

### Tipos de memoria
| Tipo | Descripción | Ejemplo |
|------|-------------|---------|
| `preference` | Preferencias usuario | "Prefiero café con leche" |
| `personal_fact` | Hechos personales | "Mi perro se llama Toscano" |
| `project` | Proyectos en curso | "Estoy migrando a Kubernetes" |
| `decision` | Decisiones tomadas | "Voy a usar Rust para el nuevo servicio" |
| `person` | Personas relevantes | "María es mi jefa" |
| `place` | Lugares importantes | "La oficina está en Castellana 123" |
| `routine` | Rutinas habituales | "Entreno los martes y jueves a las 7" |
| `important_event` | Eventos fechados | "Cumpleaños de Ana: 15 marzo" |
| `skill_knowledge` | Conocimientos técnicos | "Sabe Python, TypeScript, Bash" |
| `other` | Otros | (fallback) |

### Extracción automática

Tras cada respuesta del asistente, en background (no bloquea):

```typescript
// 1. Obtiene conversación reciente (4000 tokens)
// 2. Prompt estructurado al LLM (temperatura 0.1, format: json)
// 3. Parsea JSON: { memories: [{ content, type, importance }] }
// 4. Valida y almacena cada memoria vía MemoryManager.remember()
```

**Prompt de extracción** incluye instrucciones estrictas de qué NO extraer (saludos, frases circunstanciales, opiniones subjetivas, duplicados).

### Recuperación automática

Antes de cada llamada al modelo:

```typescript
const memorySearch = await memoryManager.search({
  query: userMessage,
  limit: 5,
  minImportance: 0.3
});
```

Resultados se formatean e inyectan en `{{MEMORY}}` del system prompt:
```
MEMORIAS RELEVANTES:
- [personal_fact] Mi perro se llama Toscano (importancia: 0.8)
- [preference] Prefiero café con leche (importancia: 0.6)
```

Límite de tokens para memoria en prompt: 1500 tokens.

---

## API MemoryManager

```typescript
// Inicialización (singleton)
const memory = getMemoryManager()
await memory.initialize()

// Memoria largo plazo
await memory.remember(content, type, importance, source?, metadata?)
await memory.search({ query, limit?, types?, minImportance? })
await memory.forget(id)
await memory.list(limit?, offset?)
await memory.get(id)

// Memoria corto plazo (delegación a ConversationStore)
await memory.addConversationMessage(chatId, { role, content, timestamp })
await memory.getRecentConversation(chatId, maxTokens)
await memory.clearConversation(chatId)
await memory.getConversationTokenCount(chatId)

// Metadatos
memory.getBackendType()     // "engram" | "sqlite"
memory.isUsingEngram()      // boolean
await memory.close()        // shutdown graceful
```

---

## Comando `/memory`

| Comando | Descripción |
|---------|-------------|
| `/memory` | Busca top-5 recuerdos relevantes a "recuerdos recientes" |
| `/memory <query>` | Busca top-5 por query libre |
| `/memory search <texto>` | Búsqueda explícita, top-10 |
| `/memory list` | Lista 20 recuerdos más importantes |
| `/memory forget <id>` | Elimina recuerdo por ID |

**Funciona siempre** (SQLite o Engram), no requiere servidor MCP.

---

## Migración MEMORY.md

Al primer arranque (`runMemoryMigration()`):
1. Verifica marcador `.memory_migrated`
2. Lee `config/MEMORY.md`
3. Parsea líneas no vacías ni encabezados
4. Infiere tipo por heurística:
   - "prefiero/me gusta" → preference
   - "mi perro/gato/se llama" → personal_fact
   - "proyecto/estoy trabajando" → project
   - "decidí/voy a" → decision
   - "cumpleaños/aniversario" → important_event
   - "rutina/suelo" → routine
   - "vivo en/trabajo en" → place
   - "conozco/sé/habilidad" → skill_knowledge
   - else → other
5. Inserta con importance 0.5, source "migration"
6. Crea marcador para no repetir

`MEMORY.md` se mantiene como archivo legacy (configuración manual/fija), pero nuevos recuerdos dinámicos van a SQLite/Engram.

---

## Robustez

- **Fallo memoria no rompe respuesta**: Extracción y búsqueda son best-effort, errores se loggan pero no propagan
- **Shutdown graceful**: `MemoryManager.close()` cierra ambas stores
- **Sin dependencias externas**: Solo SQLite (better-sqlite3), cero servicios adicionales
- **Raspberry Pi 5 friendly**: Bajo consumo RAM, escrituras batch, índices eficientes

---

## Métricas de rendimiento (estimadas)

| Operación | Latencia típica |
|-----------|-----------------|
| `getRecent(6000 tokens)` | 1-3 ms |
| `search(query, limit=5)` | 2-5 ms (FTS5) |
| `remember()` | 3-8 ms |
| Extracción LLM (background) | 500-2000 ms |

---

## Mejoras futuras

1. **Búsqueda semántica**: Embeddings + vector store (sqlite-vec/Qdrant) manteniendo interfaz `MemoryStore`
2. **Consolidación periódica**: Job que fusione duplicados semánticos
3. **Memoria episódica**: Queries temporales ("qué pasó la semana pasada")
4. **Cifrado en reposo**: Para datos sensibles
5. **Dashboard**: Hit-rate, tokens ahorrados, extracciones fallidas