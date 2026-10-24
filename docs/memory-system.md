# Sistema de Memoria de Mara OS

## Resumen

Mara OS separa dos cosas:

- **Historial de conversación** (corto plazo): siempre en SQLite.
- **Memoria a largo plazo**: **Hindsight** es la fuente principal y SQLite actúa
  como espejo local y respaldo.

La extracción y la búsqueda son automáticas y deterministas: no dependen de que
el LLM decida cuándo llamar a una tool. Además, el LLM tiene las tools
`guardar_recuerdo` y `buscar_recuerdos` (`src/memory-tools.ts`) para guardar o
consultar a petición del usuario.

```
                      ┌──────────────────────────────┐
                      │        MemoryManager         │
                      │ remember / search / forget   │
                      │ list / get / rememberMany    │
                      └──────────────┬───────────────┘
                                     │
                    ┌────────────────┴─────────────────┐
                    ▼                                  ▼
          ┌───────────────────┐              ┌───────────────────┐
          │ ResilientMemory   │              │ ConversationStore │
          │ (HINDSIGHT_ENABLED│              │ SQLite (corto)    │
          │  =true)           │              └───────────────────┘
          └─────┬───────┬─────┘
                │       │
     retain/    │       │  espejo local + outbox
     recall      ▼       ▼
          ┌──────────┐  ┌──────────────────────────────┐
          │ Hindsight│  │ SQLite data/mara.db          │
          │ REST API │  │ memories · memory_sync ·     │
          │ (banco)  │  │ memory_tombstones            │
          └──────────┘  └──────────────────────────────┘
```

Si `HINDSIGHT_ENABLED` no está definido (o es `false`), `MemoryManager` usa solo
`SqliteMemoryStore`, exactamente como antes. No hay migración silenciosa ni
cambios de datos al actualizar.

---

## Arquitectura

### Capas

| Archivo | Responsabilidad |
|---------|-----------------|
| `memory-manager.ts` | API pública única y selección de backend |
| `conversation-store.ts` | Historial conversacional (SQLite, corto plazo) |
| `memory-extractor.ts` | Extracción automática de hechos con el LLM |
| `context-builder.ts` | Construcción del system prompt |
| `stores/sqlite.ts` | Backend SQLite con FTS5, deduplicación y tombstones |
| `stores/hindsight.ts` | Adaptador REST de Hindsight (`MemoryStore`) |
| `stores/resilient.ts` | Compone Hindsight + SQLite + outbox |
| `sync-queue.ts` | Outbox persistente (`memory_sync`) con reintentos |
| `migrate.ts` | Migración legacy MEMORY.md → SQLite (solo sin Hindsight) |

### Selección de backend

```
registerMemoryStoreFactory() configurado  → "custom"
si no, HINDSIGHT_ENABLED=true             → "hindsight" (Hindsight + SQLite)
si no,                                    → "sqlite"
```

`getBackendType()` devuelve `"sqlite" | "hindsight" | "custom"`. `/status`,
`/context` y el mensaje de arranque muestran el backend real y, con Hindsight,
si está operativo y cuántos cambios quedan pendientes de sincronizar.

---

## Memoria a corto plazo (ConversationStore)

- **Backend**: SQLite (tabla `conversations`)
- **Límite**: 6000 tokens (~17000 caracteres), no número de mensajes
- **Estimación de tokens**: `ceil(longitud / 3.5)`
- **Resumen automático**: al superar el 80 % del límite, resume los mensajes
  antiguos en un mensaje de sistema

Hindsight no interviene aquí: el historial nunca se envía como memoria.

---

## Memoria a largo plazo con Hindsight

### Contrato usado

Verificado contra Hindsight API `1.1.0`:

| Operación | Endpoint | Uso en Mara OS |
|-----------|----------|----------------|
| Retain | `POST /v1/{tenant}/banks/{bank}/memories` | guardar hechos |
| Recall | `POST /v1/{tenant}/banks/{bank}/memories/recall` | búsqueda contextual |
| List | `GET /v1/{tenant}/banks/{bank}/memories/list` | `/memory list` |
| Get | `GET /v1/{tenant}/banks/{bank}/memories/{id}` | `/memory get` |
| Invalidate | `PATCH /v1/{tenant}/banks/{bank}/memories/{id}` | olvidar |
| Salud | `GET /health`, `GET /version` | arranque y diagnóstico |
| Config del banco | `GET /v1/{tenant}/banks/{bank}/config` | comprobar existencia |

Notas de contrato:

- `retain` acepta `items[]` con `content`, `timestamp`, `context`,
  `document_id`, `metadata` (solo strings) y `tags`.
- `recall` acepta `query`, `budget`, `max_tokens`, `prefer_observations`.
  Mara OS usa `budget: "low"`, `prefer_observations: true` y un `max_tokens`
  alineado con el presupuesto del prompt.
- **No existe borrado individual duro.** El `DELETE` del banco borra todo y
  **nunca se usa**. Olvidar = `PATCH state: "invalidated"` (reversible).
- El panel `:9999` es solo observabilidad; el bot habla con la API `:8888`.
- Si el servidor activa autenticación, se envía
  `Authorization: Bearer ${HINDSIGHT_API_KEY}`.

### Escritura (sin duplicar, sin migrar)

1. Se guarda primero en SQLite: id local estable y copia de seguridad.
2. Solo las filas **nuevas** entran en la outbox `memory_sync`. Las filas que ya
   existían antes de activar Hindsight no tienen entrada y **nunca se envían
   solas**.
3. Se intenta `retain` con `document_id = mara-<id local>`.
4. Si Hindsight responde, la entrada se marca como completada en la outbox.
5. Si falla, queda pendiente y se reintenta con backoff exponencial (30 s → 15
   min). Los errores 4xx de validación se marcan como fallo permanente.

El `document_id` estable hace el reintento idempotente: Hindsight reemplaza el
mismo documento, no crea un duplicado.

### Lectura

- Con Hindsight disponible, `recall` es la fuente principal.
- Se añaden solo memorias locales **no confirmadas** en Hindsight (pendientes o
  anteriores a la activación), deduplicadas por contenido normalizado. Así no se
  pierde nada y no se duplica lo ya sincronizado.
- Si Hindsight no responde (timeout, 5xx, circuito abierto), búsqueda y listado
  se resuelven contra SQLite sin bloquear la respuesta.

### Olvido

- `forget(id-local)`: tombstone local (`memory_tombstones`) + invalidación de
  todos los hechos del documento `mara-<id>` en Hindsight.
- `forget(id-remoto)`: invalida ese hecho concreto.
- El recuerdo original **no se destruye** en local; deja de aparecer.
- Nunca se borra el banco completo.

### Circuit breaker y timeouts

- `HINDSIGHT_TIMEOUT_MS` (8 s): recall/list/get.
- `HINDSIGHT_RETAIN_TIMEOUT_MS` (25 s): retain, que ejecuta extracción con LLM
  en el servidor.
- `HINDSIGHT_HEALTH_TIMEOUT_MS` (2,5 s): salud y banco al arrancar.
- Un fallo de red/5xx abre el circuito 30 s: durante ese tiempo se usa SQLite
  sin seguir golpeando el servidor.
- Un `retain` que falla en el servidor (p. ej. su LLM de extracción) también
  cuenta como 5xx: `/help` mostrará `Hindsight: ❌` durante esos 30 s aunque
  `/health` responda. Si Hindsight usa Groq en plan gratuito, necesita
  `HINDSIGHT_API_LLM_GROQ_SERVICE_TIER=on_demand`; ver
  [Gestión de memoria](operations/memory-management.md#hindsight-responde-pero-la-outbox-no-se-vacía).

---

## Memoria a largo plazo sin Hindsight (SQLite)

`SqliteMemoryStore` sigue siendo el backend completo cuando Hindsight está
desactivado y el respaldo cuando está caído.

**Ubicación**:
- Desarrollo: `data/mara.db`
- Producción: `/var/lib/mara/memory/mara.db`

**Esquema**:

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  importance REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  metadata TEXT
);

CREATE VIRTUAL TABLE memories_fts USING fts5(content, content=memories, content_rowid=rowid);

-- Solo con Hindsight: olvidos suaves y outbox
CREATE TABLE memory_tombstones (id TEXT PRIMARY KEY, forgotten_at INTEGER NOT NULL);
CREATE TABLE memory_sync (
  memory_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'retain',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  failed_permanently_at INTEGER
);
```

- **Deduplicación**: normaliza contenido y busca coincidencia exacta por tipo.
  Si existe, actualiza `last_accessed` en vez de duplicar (y no reenvía a
  Hindsight).
- **Caché LRU**: 500 entradas.

---

## Tipos de memoria

| Tipo | Descripción | Ejemplo |
|------|-------------|---------|
| `preference` | Preferencias | "Prefiero café con leche" |
| `personal_fact` | Hechos personales | "Mi perro se llama Toscano" |
| `project` | Proyectos en curso | "Estoy migrando a Kubernetes" |
| `decision` | Decisiones tomadas | "Voy a usar Rust para el servicio" |
| `person` | Personas relevantes | "María es mi jefa" |
| `place` | Lugares importantes | "La oficina está en Castellana 123" |
| `routine` | Rutinas | "Entreno martes y jueves a las 7" |
| `important_event` | Eventos fechados | "Cumpleaños de Ana: 15 marzo" |
| `skill_knowledge` | Conocimientos | "Sabe Python, TypeScript, Bash" |
| `other` | Otros | fallback |

Hindsight no tiene campo nativo de importancia ni de tipo Mara. Se guardan en
`metadata` (`mara_type`, `mara_importance`, `mara_source`) y en `tags`
(`mara:type:*`, `mara:importance:*`), y se recuperan al mapear resultados.

---

## Extracción automática

Tras cada respuesta, en background y sin bloquear:

1. Se toma la conversación reciente (4000 tokens).
2. El LLM remoto (proveedor activo) devuelve `{ memories: [{ content, type, importance }] }`.
3. Se descartan las que no superan `MEMORY_MIN_IMPORTANCE` (0.5 por defecto).
4. Se guardan como máximo 5 por pasada, **en lote**: un solo `retain` con varios
   `items` en Hindsight.
5. Como mínimo, una extracción por chat cada
   `MEMORY_EXTRACTION_MIN_INTERVAL_MS` (60 s). Evita una llamada al LLM por cada
   mensaje en una ráfaga.

Nunca se memorizan todos los mensajes: el prompt excluye saludos, cortesía,
charla circunstancial, opiniones sin valor factual y duplicados.

No se usa `reflect`: añadiría otra llamada al LLM sin mejorar este flujo.

---

## Recuperación contextual

Antes de cada llamada al modelo:

```ts
const memorySearch = await memoryManager.search({
  query: userMessage,
  limit: 5,
  minImportance: 0.3,
  maxTokens: 1500,
})
```

Los resultados se formatean en `{{MEMORY}}`:

```
MEMORIAS RELEVANTES:
- [personal_fact] Mi perro se llama Toscano (importancia: 0.8)
- [preference] Prefiero café con leche (importancia: 0.6)
```

---

## API MemoryManager

```ts
// Largo plazo
await memory.remember(content, type, importance, source?, metadata?)
await memory.rememberMany(entries)          // lote (un retain en Hindsight)
await memory.search({ query, limit?, types?, minImportance?, maxTokens? })
await memory.forget(id)
await memory.list(limit?, offset?)
await memory.get(id)

// Estado
memory.getBackendType()                     // "sqlite" | "hindsight" | "custom"
memory.isHindsightAvailable()
memory.getPendingSyncCount()
await memory.syncMemory()                   // fuerza una pasada de outbox

// Corto plazo
await memory.addConversationMessage(...)
await memory.getRecentConversation(...)
await memory.clearConversation(...)
await memory.getConversationTokenCount(...)
```

---

## Comando `/memory`

| Comando | Descripción |
|---------|-------------|
| `/memory` | Busca los 5 recuerdos más relevantes |
| `/memory <query>` | Búsqueda libre |
| `/memory search <texto>` | Búsqueda explícita, top-10 |
| `/memory list` | 20 recuerdos más importantes |
| `/memory forget <id>` | Olvida un recuerdo (suave y reversible) |

Funciona con Hindsight y con SQLite sin cambiar la interfaz.

---

## MEMORY.md (legacy)

`config/MEMORY.md` queda como archivo estático editable a mano. No recibe
recuerdos nuevos.

- Sin Hindsight: `runMemoryMigration()` puede volcarlo a SQLite una vez, con el
  marcador `config/.memory_migrated`.
- Con Hindsight: la migración **se omite** y no se marca como hecha. Así nunca
  se duplica contenido, y si algún día se desactiva Hindsight la migración a
  SQLite sigue disponible.

No existe migración automática de las filas antiguas de `memories` a Hindsight.
Si se quisiera, sería un script manual explícito.

---

## Una única fuente

- **Hindsight** es la fuente principal de memoria a largo plazo.
- **SQLite** guarda historial de conversación y es espejo/respaldo de memoria.
- **MEMORY.md** es legacy y no se usa para memoria dinámica.
- **MCP de memoria** no es necesario. Si se declara en `MCP_MEMORY_SERVERS`,
  queda como herramienta manual y el arranque avisa de que Hindsight manda.

---

## Robustez

- Un fallo de Hindsight no rompe la respuesta: se registra y se usa SQLite.
- Outbox persistente: una escritura no se pierde aunque el servidor esté caído.
- Shutdown graceful: `MemoryManager.close()` cierra Hindsight, SQLite y outbox.
- Sin LLM en el CHUWI: la inferencia sigue en el proveedor externo configurado (`LLM_PROVIDER`).
