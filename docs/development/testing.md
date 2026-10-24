# Testing

## Type Checking

```bash
pnpm typecheck
```

Ejecuta `tsc --noEmit` con `strict: true` e incluye `src/`, `scripts/` y `tests/`.

## Tests automatizados

```bash
pnpm test
```

Usa el test runner de Node (`node --test`) con `tsx`. No necesitan red ni el
servidor real: los tests levantan un **servidor HTTP falso** que imita el
contrato de Hindsight 1.1.

- `tests/hindsight-store.test.ts`
  - `initialize` comprueba salud y banco, sin escribir.
  - `retain`: `items[]`, `document_id`, `timestamp`, `metadata` y `tags`.
  - `rememberMany`: un solo `retain` con varios items.
  - `recall`: `budget: "low"`, `prefer_observations`, `max_tokens`; mapeo de
    tipo/importancia/origen desde metadata y tags.
  - `list`/`get`, `forget` con `PATCH state=invalidated` (nunca `DELETE`).
  - `invalidateDocument` pagina el listado por `document_id`.
  - `Authorization: Bearer` cuando hay API key.
  - 4xx de validación = fallo permanente.
  - Timeout → circuito abierto y sin llamadas posteriores.
- `tests/resilient-memory.test.ts`
  - Escritura en SQLite + sincronización con Hindsight.
  - Fallo de `retain`: copia local + outbox + reintento con backoff.
  - Sin migración automática de filas anteriores a Hindsight.
  - Deduplicación sin reenviar a Hindsight.
  - Olvido suave en local + invalidación remota, sin borrar el banco.
  - Hindsight caído: todo se resuelve en SQLite.
  - Un olvido pendiente gana a un retain pendiente.

## Comprobar el proveedor de inferencia

Antes de arrancar el bot, verifica que el proveedor está operativo:

```bash
pnpm check:llm        # alias: pnpm check:ollama
```

Comprueba, en orden, y sale con código 0 (todo bien) o 1 (algún fallo):

1. **Conectividad** al proveedor activo y autenticación si hay API key (`/api/tags` en dialecto `ollama`, `/v1/models` en `openai`).
2. **Modelo disponible** en el servidor (`llm.model` del proveedor activo).
3. **Respuesta de texto** (una petición real de chat).
4. **Tool calling** — que el modelo devuelve `tool_calls`; es imprescindible para que el bot use los servidores MCP.

Usa la misma resolución de proveedor que el bot (`src/providers.ts`): prueba el
que esté guardado por `/modelo` y, si no hay ninguno, `LLM_PROVIDER`. Con
`LLM_STATE_FILE` apuntando a un fichero que no exista puedes forzar el del `.env`:

```bash
# Groq
LLM_PROVIDER=groq GROQ_API_KEY=gsk_... LLM_STATE_FILE=/tmp/nada.json pnpm check:llm

# Servidor local con otro modelo, sin tocar el .env
LLM_MODEL=otro-modelo LLM_STATE_FILE=/tmp/nada.json pnpm check:llm
```

Implementado en `scripts/check-ollama.ts`.

## Comprobar Hindsight

```bash
pnpm check:hindsight
```

**Solo lectura**, contra el servidor configurado:

1. `GET /health` y `GET /version`.
2. `GET /v1/<tenant>/banks/<bank>/config`: el banco existe y es accesible.
3. `GET .../stats`.
4. `POST .../memories/recall` con una consulta de prueba (no crea recuerdos).
5. Estado local: memorias en SQLite, tombstones y cambios pendientes de outbox.

Sale con 0 si todo está correcto. Apunta a otro servidor sin tocar el `.env`:

```bash
HINDSIGHT_API_URL=http://127.0.0.1:8888 pnpm check:hindsight
```

## Verificación Manual

### Flujo Básico

1. Inicia el bot: `pnpm bot`
2. Comprueba en el arranque el modo de memoria (`Hindsight (banco mara-os)`).
3. Envía un mensaje de texto a tu bot de Telegram
4. Espera la respuesta del asistente
5. Verifica en los logs del terminal que:
   - Se cargaron los servidores MCP
   - Se detectaron skills (si aplica)
   - Las tool_calls se ejecutaron correctamente
   - La respuesta se envió de vuelta

### Probar memoria

```bash
# Ver que el banco y la outbox están sanos
pnpm check:hindsight

# En Telegram
/memory
/memory ¿qué recuerdas de mí?
/memory list
```

Si Hindsight estaba caído al escribir, `/status` mostrará pendientes; al volver
el servidor se sincronizan solos (o fuerza con `HINDSIGHT_SYNC_INTERVAL_MS`).

### Probar Fallos

- Detén Ollama y envía un mensaje → debería reintentar y fallar gracefulmente
- Detén un servidor MCP y verifica que el resto del bot sigue funcionando
- Para Hindsight (o pon una URL incorrecta): el bot debe seguir respondiendo y
  usando SQLite; los recuerdos nuevos quedan en la outbox
- Presiona Ctrl+C → debería cerrar MCP clients y parar sin errores
