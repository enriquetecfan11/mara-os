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

Hindsight ejecuta su propio LLM para extraer hechos en cada `retain`. Con
`HINDSIGHT_API_LLM_PROVIDER=groq` pide `service_tier: auto`, que el plan
gratuito de Groq rechaza (`HTTP 500 ... service_tier auto is not available`).
La variable `HINDSIGHT_API_LLM_GROQ_SERVICE_TIER=on_demand` debería evitarlo,
pero en la práctica no fue fiable. Lo que funciona es usar Groq a través del
proveedor `openai`, que no envía `service_tier`:

`.env` del servidor Hindsight (no el de Mara):

```env
HINDSIGHT_API_LLM_PROVIDER=openai
HINDSIGHT_API_LLM_BASE_URL=https://api.groq.com/openai/v1
HINDSIGHT_API_LLM_API_KEY=gsk_...
HINDSIGHT_API_LLM_MODEL=openai/gpt-oss-120b
HINDSIGHT_API_WORKER_ID=mara-hindsight
```

`compose.yml` (uno solo en la carpeta: si hay `compose.yaml` y `compose.yml`,
Docker usa `compose.yaml` y avisa con `Found multiple config files`):

```yaml
services:
  hindsight:
    image: ghcr.io/vectorize-io/hindsight:latest
    container_name: mara-hindsight
    restart: unless-stopped
    shm_size: "1gb"
    ports:
      - "8888:8888"
      - "9999:9999"
    env_file: .env
    volumes:
      - hindsight-data:/home/hindsight/.pg0

volumes:
  hindsight-data:
```

Errores que aparecieron al montarlo:

- **El `.env` no llega al contenedor.** Sin `env_file: .env`, Compose solo usa
  el `.env` para sustituir `${VAR}` en el YAML. Un bloque `environment:` con
  `HINDSIGHT_API_LLM_PROVIDER: groq` fijo gana a lo que pongas en el `.env`.
- **`LLM API key is required`**: el compose referencia una variable
  (`${GROQ_API_KEY}`) que ya no existe en el `.env`.
- **`401 Invalid API Key`**: la clave de Groq no es válida. Compruébala con
  `curl -H "Authorization: Bearer $K" https://api.groq.com/openai/v1/models`
  (tiene que dar 200), sin comillas ni espacios en el `.env`.
- **`/home/hindsight/.pg0 is not writable`**: con una carpeta del host
  (`./data`), Docker la crea como root y Hindsight corre como UID 1000. Usa el
  volumen con nombre de arriba o `sudo chown -R 1000:1000 data`.

Tras cambiar variables: `docker compose up -d --force-recreate` (`restart` no
las recarga). El log debe mostrar `LLM: provider=openai, model=...`.

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
  available for this org`: Hindsight usa el proveedor `groq`; cámbialo a
  `openai` con la URL de Groq (ver [Servidor Hindsight con Groq](#servidor-hindsight-con-groq)).
- `... Invalid API Key`: la clave de Groq del servidor Hindsight no es válida.
- Otro `HTTP 500`: mira los logs del contenedor de Hindsight; suele ser su LLM.
- `timeout` / `aborted`: el retain tarda más que `HINDSIGHT_RETAIN_TIMEOUT_MS`.
- `Hindsight en circuito abierto por fallo reciente`: consecuencia de otro
  fallo, no la causa; busca la fila con el error real.

`check:hindsight` en 7/7 **no** demuestra que Hindsight guarde: solo que la
outbox local está vacía. La prueba es `total_documents` > 0 en `Stats`, o un
retain directo a un banco de prueba:

```bash
curl -s -X POST http://192.168.1.196:8888/v1/default/banks/mara-os-diagnostico/memories \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"content":"Prueba: al usuario le gusta el verde.","document_id":"diag-1"}],"async":false}'
```

Tiene que responder `{"success":true,...}`.

Tras arreglarlo, los pendientes se reintentan solos (backoff máximo 15 min).
Para forzarlo ya:

```bash
docker exec mara-os node -e "
const db = require('better-sqlite3')('/app/data/mara.db');
console.log(db.prepare('UPDATE memory_sync SET next_attempt_at = 0 WHERE completed_at IS NULL').run().changes, 'reprogramados');
"
```

Si el banco se ha recreado vacío (p. ej. al borrar los datos de Hindsight), los
recuerdos ya marcados como sincronizados no se reenvían solos. Para volver a
encolar todos los recuerdos locales (salvo los olvidados):

```bash
docker exec mara-os node -e "
const db = require('better-sqlite3')('/app/data/mara.db');
const r = db.prepare(\`
  INSERT INTO memory_sync (memory_id, document_id, action, attempts, next_attempt_at, created_at)
  SELECT id, 'mara-' || id, 'retain', 0, 0, ?
  FROM memories WHERE id NOT IN (SELECT id FROM memory_tombstones)
  ON CONFLICT(memory_id) DO UPDATE SET
    action = 'retain', attempts = 0, next_attempt_at = 0,
    last_error = NULL, completed_at = NULL, failed_permanently_at = NULL
\`).run(Date.now());
console.log(r.changes, 'recuerdos en cola');
"
```

El `document_id` estable (`mara-<id>`) hace que reenviar sea idempotente.

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

### "Recuerda que…" sin depender del modelo

Los modelos pequeños no llaman a `guardar_recuerdo` de forma fiable, y el
extractor automático se salta mensajes (como mucho una extracción por minuto y
chat). Por eso `askPi()` detecta las peticiones explícitas con
`detectRememberRequest()` ("recuerda que…", "apunta…", "no olvides que…",
"acuérdate de que…", "memoriza…") y las guarda **antes** de llamar al LLM, como
`Kike dice: <dato>` para que Hindsight no se las atribuya al asistente. Al
system prompt se le añade una nota para que el modelo solo lo confirme.

No se activa con preguntas ni con "recuérdame…", que suele ser un recordatorio.
En el log aparece `[Memory] Petición explícita guardada: "<dato>"`.

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

## Notas de Obsidian

El vault se importa a un **banco aparte** (`HINDSIGHT_NOTES_BANK_ID`, por
defecto `obsidian`) para que miles de hechos de las notas no desplacen a los
recuerdos personales en el recall. Mara lo consulta solo cuando hace falta, con
la tool `buscar_en_notas` (siempre activa, junto a las de memoria), que cita la
nota de origen.

Lo más cómodo es el script, que usa el vault por defecto
(`~/Documents/obisidian-vault`, o `OBSIDIAN_VAULT`) y acepta las mismas opciones:

```bash
scripts/import_vault.sh              # importa lo nuevo o modificado
scripts/import_vault.sh --dry-run    # qué enviaría, sin enviar nada
```

En el homelab, con el vault clonado en `~/mara/obisidian-vault`,
`scripts/homelab/sync_vault.sh` hace todo: `git pull` del vault, importación
dentro de la imagen `mara-os` (sin Node en el host) y comprobación final
(Hindsight sano, 0 notas pendientes, la búsqueda devuelve notas). Se copia a
`~/mara/scripts/`. Las notas borradas del vault no se borran de Hindsight.

O directamente:

```bash
pnpm import:obsidian ~/Documents/obisidian-vault --folder MaraOs --dry-run  # qué se enviaría
pnpm import:obsidian ~/Documents/obisidian-vault --folder MaraOs            # piloto
pnpm import:obsidian ~/Documents/obisidian-vault                            # todo
```

- Cada nota es un documento `obsidian:<ruta>`: reimportar la **reemplaza**, no
  la duplica.
- Solo se envían las notas nuevas o modificadas desde la última vez (hash en
  `data/obsidian-import.json`); `--force` lo reenvía todo. Si una nota falla,
  volver a ejecutar reintenta solo esa.
- Se saltan `.obsidian`, `.trash`, `templates` y las notas casi vacías; el
  frontmatter se quita.
- Se ejecuta donde está el vault (el Mac) contra el Hindsight de la LAN.

### Modo `chunks`: sin LLM ni tokens

El script configura el banco con `retain_extraction_mode: "chunks"`: Hindsight
guarda cada nota troceada tal cual y la busca con embeddings locales + texto,
**sin llamar a ningún LLM**. Importar el vault entero no gasta tokens de Groq,
tarda ~2 s por nota y conserva el texto original (no hechos sueltos).

Observaciones, grafo y recuperación temporal dependen de hechos extraídos por
el LLM, así que se apagan en ese banco. El **reranker también**: es local pero
en CPU sube cada búsqueda de ~0,2 s a ~10 s, más que el timeout de las tools.

`buscar_en_notas` pide unos 8000 tokens de candidatos, se queda con el trozo
más relevante de cada nota (hasta 5 notas distintas) y recorta cada uno a 700
caracteres: unos 3,5 KB por búsqueda, asumible para un modelo pequeño.

El banco de memoria personal (`mara-os`) sigue en el modo normal, con
extracción de hechos por LLM.

### PDF, DOCX y otros ficheros

Hindsight también acepta ficheros (`POST /v1/default/banks/{bank}/files/retain`,
multipart): PDF, DOCX, PPTX, XLSX, imágenes con OCR y audio. Los convierte a
Markdown y los guarda como un documento más; en un banco en modo `chunks`
tampoco gastan LLM. El vault actual no tiene ficheros de ese tipo, así que el
script solo importa `.md`.
