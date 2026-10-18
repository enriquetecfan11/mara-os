# Gestión de Memoria

## Un único backend

La memoria persistente vive en **SQLite** (`data/mara.db`), con FTS5 para búsqueda
de texto completo. No depende de ningún servidor MCP, así que sigue funcionando
aunque todos los servidores MCP estén caídos.

- Índice FTS5 para búsqueda por texto completo
- Extracción automática de hechos tras cada respuesta (`memory-extractor.ts`)
- Deduplicación por contenido normalizado antes de insertar
- Caché LRU de 500 entradas para lecturas frecuentes

## MEMORY.md (archivo legacy)

`config/MEMORY.md` se mantiene como archivo editable a mano. Se lee al inicio
del contexto del agente, pero los recuerdos dinámicos van a SQLite.

Una migración única (`runMemoryMigration()`) vuelca su contenido a SQLite en el
primer arranque y deja el marcador `config/.memory_migrated`.

## Cambiar el backend

El backend es extensible sin tocar `MemoryManager`. Implementa la interfaz
`MemoryStore` de `src/memory/types.ts` y regístralo antes de que se cree el
`MemoryManager` por primera vez:

```ts
import { registerMemoryStoreFactory } from "./memory/memory-manager.js"

registerMemoryStoreFactory(() => new MiMemoryStore())
```

Los métodos públicos no cambian, así que el resto del bot no se entera. Si además
el backend es un servidor MCP, declara su nombre en `MCP_MEMORY_SERVERS` para que
cuente como servidor de memoria en los logs de arranque.

## Comandos

- `/memory [query]` — Buscar recuerdos
- `/memory forget <id>` — Olvidar un recuerdo específico
- `/reset` — Limpia el historial de conversación (no afecta a la memoria persistente)
- `pnpm reset-bot` — Vacía MEMORY.md
- `pnpm reset-memory` — Restaura MEMORY.md desde git

## Ver el estado de la memoria

En los logs de arranque:

```
[Memory] Memory mode: SQLite (data/mara.db)
```

Si conectaste un servidor MCP de memoria declarado en `MCP_MEMORY_SERVERS`:

```
[Memory] Memory mode: MCP memory server
```

O envía `/status` al bot, que informa del backend y del número de recuerdos.

## Notas

- La base de datos vive en `/var/lib/mara/memory/mara.db` si existe ese
  directorio o si `NODE_ENV=production`; en desarrollo, en `data/mara.db`.
- El historial de conversación es otro almacén (`conversations` en la misma base)
  y se resume automáticamente cuando supera el presupuesto de tokens.
