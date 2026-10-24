# Gestión de Memoria

## Dos capas, una fuente principal

- **Historial de conversación**: SQLite (`conversations` en `data/mara.db`).
  Siempre local, nunca se envía a Hindsight.
- **Memoria a largo plazo**: **Hindsight** (banco `mara-os`) con SQLite como
  espejo local y respaldo.

```
HINDSIGHT_ENABLED=true   → Hindsight + SQLite (espejo/outbox)
HINDSIGHT_ENABLED=false  → solo SQLite (comportamiento anterior)
```

## Requisitos y configuración

En `.env`:

```env
HINDSIGHT_ENABLED=true
HINDSIGHT_API_URL=http://192.168.1.196:8888
HINDSIGHT_BANK_ID=mara-os
# HINDSIGHT_API_KEY=          # solo si el servidor tiene auth
# HINDSIGHT_TENANT=default
# HINDSIGHT_TIMEOUT_MS=8000
# HINDSIGHT_RETAIN_TIMEOUT_MS=25000
# HINDSIGHT_HEALTH_TIMEOUT_MS=2500
# HINDSIGHT_SYNC_BATCH_SIZE=10
# HINDSIGHT_SYNC_INTERVAL_MS=60000
# MEMORY_MIN_IMPORTANCE=0.5
# MEMORY_EXTRACTION_MIN_INTERVAL_MS=60000
```

El panel (`:9999`) no lo usa el bot; todo va por la API (`:8888`).

### Servidor Hindsight con Groq

Hindsight ejecuta su propio LLM para extraer hechos en cada `retain`. Si usa
Groq (`HINDSIGHT_API_LLM_PROVIDER=groq`), por defecto pide
`service_tier: auto`, que el plan gratuito de Groq no admite. Configura el
contenedor de **Hindsight** (no el de Mara) con:

```env
HINDSIGHT_API_LLM_GROQ_SERVICE_TIER=on_demand
```

y recréalo con `docker compose up -d`: `restart` no recarga las variables.
Comprueba que la tiene con `docker exec mara-hindsight env | grep SERVICE_TIER`.

## Verificar antes de arrancar

```bash
pnpm check:hindsight
```

Es **solo lectura**: comprueba salud, versión, existencia del banco, `stats`, un
`recall` de prueba, y el estado local (memorias, tombstones y pendientes de
sincronizar). Sale con 0 si todo está bien.

## Qué pasa si Hindsight no responde

1. La escritura se guarda en SQLite y entra en la outbox `memory_sync`.
2. La búsqueda y el listado se resuelven contra SQLite.
3. El circuito se abre 30 s para no martillear el servidor.
4. Cada `HINDSIGHT_SYNC_INTERVAL_MS` (o al llamar `syncMemory()`) se reintenta
   con backoff exponencial. Al volver el servidor, la outbox se vacía sola.

No se pierde ni se duplica: el `document_id` estable hace el retain idempotente.

## Hindsight responde pero la outbox no se vacía

Síntoma: `pnpm check:hindsight` da salud y `recall` correctos pero
`❌ Outbox: N cambios esperando`, `total_documents` se queda en 0 y `/help`
muestra `Hindsight: ❌ no responde` a ratos (justo después de cada respuesta,
cuando el extractor intenta guardar y el fallo abre el circuito 30 s).

El error real queda en la outbox:

```bash
docker exec mara-os node -e "
const db = require('better-sqlite3')('/app/data/mara.db', { readonly: true });
console.table(db.prepare('SELECT memory_id, attempts, last_error FROM memory_sync WHERE completed_at IS NULL').all());
"
```

- `Hindsight HTTP 500: Fact extraction failed ... service_tier auto is not
  available for this org`: falta `HINDSIGHT_API_LLM_GROQ_SERVICE_TIER=on_demand`
  en el servidor (ver [Servidor Hindsight con Groq](#servidor-hindsight-con-groq)).
- Otro `HTTP 500`: mira los logs del contenedor de Hindsight; suele ser su LLM.
- `timeout` / `aborted`: el retain tarda más que `HINDSIGHT_RETAIN_TIMEOUT_MS`.
- `Hindsight en circuito abierto por fallo reciente`: consecuencia de otro
  fallo, no la causa; busca la fila con el error real.

Tras arreglarlo, los pendientes se reintentan solos (backoff máximo 15 min).
Para forzarlo ya:

```bash
docker exec mara-os node -e "
const db = require('better-sqlite3')('/app/data/mara.db');
console.log(db.prepare('UPDATE memory_sync SET next_attempt_at = 0 WHERE completed_at IS NULL').run().changes, 'reprogramados');
"
```

## MEMORY.md (legacy)

`config/MEMORY.md` ya no recibe recuerdos dinámicos. Con Hindsight activo, la
migración automática a SQLite se omite a propósito para no duplicar contenido.
Las filas antiguas de `memories` tampoco se envían solas a Hindsight.

## Tools del LLM

Además de la extracción automática, Mara tiene dos tools nativas
(`src/memory-tools.ts`), que no pasan por ningún servidor MCP:

- `guardar_recuerdo` (`contenido`, `tipo?`, `importancia?`): guarda con
  `source: "manual"` vía `MemoryManager.remember()`.
- `buscar_recuerdos` (`consulta`, `limite?`): `MemoryManager.search()`.

Usan el mismo `MemoryManager` que el resto: Hindsight con espejo SQLite y outbox.

## Comandos

- `/memory [query]` — Buscar recuerdos
- `/memory search <texto>` — Búsqueda explícita
- `/memory list` — Listar los más importantes
- `/memory forget <id>` — Olvidar (suave y reversible)
- `/reset` — Limpia el historial de conversación (no toca la memoria)
- `pnpm check:hindsight` — Diagnóstico de solo lectura

## Ver el estado

En los logs de arranque:

```
[Memory] Memory mode: Hindsight (banco mara-os) + SQLite local
[MemoryManager] Memoria: Hindsight (0 cambios pendientes de sincronizar)
```

Si Hindsight no está disponible:

```
[Hindsight] No disponible en http://192.168.1.196:8888; se usará SQLite como respaldo
```

O envía `/status` / `/context`: muestran backend, disponibilidad y pendientes.

## Cambiar de backend

`MemoryManager` sigue siendo extensible sin tocar el resto del bot:

```ts
import { registerMemoryStoreFactory } from "./memory/memory-manager.js"

registerMemoryStoreFactory(() => new MiMemoryStore())
```

Implementa `MemoryStore` de `src/memory/types.ts`. Si defines una fábrica,
tiene prioridad sobre `HINDSIGHT_ENABLED`.

## Operación y mantenimiento

- Copia de seguridad local: `data/mara.db` (o `/var/lib/mara/memory/mara.db` en
  producción). Contiene historial, espejo de memoria y outbox.
- El banco de Hindsight se respalda desde el servidor; el bot nunca lo borra.
- Los recuerdos olvidados quedan como `invalidated` en Hindsight y como
  tombstone en local: recuperables, no destruidos.
