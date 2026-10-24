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

## MEMORY.md (legacy)

`config/MEMORY.md` ya no recibe recuerdos dinámicos. Con Hindsight activo, la
migración automática a SQLite se omite a propósito para no duplicar contenido.
Las filas antiguas de `memories` tampoco se envían solas a Hindsight.

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
