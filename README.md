# Mara OS

Asistente personal local basado en un bot de Telegram y modelos locales de lenguaje a través de Ollama.

El proyecto está diseñado para ser sencillo, legible y fácil de personalizar. Sirve como implementación de referencia para entender cómo conectar un canal de chat (Telegram), un motor de inferencia local (Ollama), archivos de contexto persistentes (alma, usuario, reglas del agente), memoria a largo plazo y reglas sencillas de confirmación de seguridad.

## Características principales

- **Integración con Telegram**: Envío y recepción de mensajes directamente desde un bot de Telegram.
- **Inferencia local**: Procesamiento de lenguaje natural utilizando Ollama y modelos locales (como Gemma, Llama o Phi).
- **Personalidad y contexto persistentes**: Carga dinámica del contexto del agente a partir de archivos Markdown (`SOUL.md`, `USER.md`, `AGENTS.md`).
- **Memoria persistente**: Hindsight como memoria principal a largo plazo (retención/recall semántico) con SQLite como historial y respaldo local. Sin servidores MCP obligatorios.
- **Control de seguridad**: Flujo básico de aprobación para acciones externas críticas.
- **Soporte multimedia**: Descarga automática de imágenes enviadas por Telegram a un directorio local de subidas para su posterior procesamiento.
- **Síntesis de voz**: Genera audio con Voicebox TTS y lo envía junto con la respuesta de texto. Activable/desactivable por chat con el comando `/voz on|off`.
- **Integración con Mara UI**: Emite el estado y las respuestas de Mara a una interfaz visual (protocolo de eventos v1) mediante un servidor WebSocket "brain" opcional, sin afectar a Telegram.

## Requisitos

- **Node.js >= 20.11** (ver `.nvmrc`).
- **pnpm**. Obligatorio: `pnpm-workspace.yaml` es lo que autoriza la ejecución de los scripts de instalación nativos de `better-sqlite3` y `sharp`. Con `npm install` se instalan sin compilar y el bot falla al arrancar.
- **ffmpeg** en el PATH. Solo se usa para transcribir audio.
- Un bot de Telegram (puedes crear uno con [@BotFather](https://t.me/BotFather)).
- Un servidor **Ollama** accesible en la red (no hace falta en la misma máquina).
- (Opcional) Un servidor **Hindsight** para memoria a largo plazo. Sin él, todo
  funciona con SQLite local.
- (Opcional) Voicebox instalado y ejecutándose para síntesis de voz.

En **Raspberry Pi** hace falta además **Raspberry Pi OS de 64 bits**: tanto `better-sqlite3` como `onnxruntime-node` distribuyen sus binarios `linux-arm64` dentro del propio paquete de npm, pero no hay builds de 32 bits. No hace falta compilar nada a mano.

## Instalación y Configuración

1. Instala las dependencias del proyecto:
   ```bash
   corepack enable
   pnpm install
   ```

2. Copia el archivo de variables de entorno y configúralo:
   ```bash
   cp .env.example .env
   ```

3. Edita `.env` con tus credenciales y configuración:
   ```env
   TELEGRAM_TOKEN=tu_token_de_telegram
   LLM_PROVIDER=unsloth
   OLLAMA_API=openai
   OLLAMA_URL=http://192.168.1.79:8888
   OLLAMA_MODEL=unsloth/Qwen3.5-4B-MTP-GGUF
   OLLAMA_API_KEY=sk-tu-token
   GROQ_API_KEY=
   GROQ_MODEL=qwen/qwen3.8-27b
   TIMEZONE=Europe/Madrid
   STT_ENABLED=false
   VOICEBOX_URL=http://192.168.1.79:17493
   VOICEBOX_ENABLED=false
   VOICEBOX_PROFILE=Mara
   TELEGRAM_SEND_VOICE=false
   MCP_DISABLED_SERVERS=macos_automator
   MARA_BRAIN_WS_URL=ws://0.0.0.0:9000
   HINDSIGHT_ENABLED=true
   HINDSIGHT_API_URL=http://192.168.1.196:8888
   HINDSIGHT_BANK_ID=mara-os
   ```

### Variables de Configuración

- **`TELEGRAM_TOKEN`**: Token del bot de Telegram (obligatorio).
- **`TELEGRAM_CHAT_ID`**: ID del chat donde enviar mensajes de startup (opcional).
- **`LLM_PROVIDER`**: Proveedor de inferencia **inicial**: `unsloth` = Unsloth Studio en la LAN (usa `OLLAMA_*`), `groq` = Groq Cloud (usa `GROQ_*`), `ollama` = Ollama nativo, `openai` = cualquier otro servidor OpenAI-compatible (usa `LLM_*`). El activo se cambia en caliente desde Telegram con `/modelo` (sin reiniciar); lo guardado en `data/llm-provider.json` manda sobre esta variable.
- **`LLM_STATE_FILE`**: Dónde se persiste el proveedor elegido con `/modelo` (default: `data/llm-provider.json`).
- **`OLLAMA_API`**: Dialecto del servidor local. `ollama` (default) habla `/api/chat`; `openai` habla `/v1/chat/completions` (Unsloth Studio, vLLM, llama.cpp server, LM Studio…).
- **`OLLAMA_URL`**: URL del servidor local (default: `http://192.168.1.182:11434`).
- **`OLLAMA_MODEL`**: Modelo del servidor local (default: `ornith-1.5:9b`, con soporte de tool calling).
- **`OLLAMA_API_KEY`**: API key del servidor local, se envía como `Authorization: Bearer`. Vacío = sin cabecera (Ollama normal).
- **`OLLAMA_NUM_CTX`**: Ventana de contexto por petición, solo dialecto `ollama` (default: `16384`). **No lo bajes del default de Ollama**: si el Modelfile no define `num_ctx`, el servidor usa 4096 tokens y las tools MCP del prompt (~3k) desbordan cualquier mensaje con `400 exceed_context_size_error`.
- **`GROQ_API_KEY`**: API key de Groq Cloud. **`GROQ_MODEL`** (default: `qwen/qwen3.8-27b`, 131k de contexto) y **`GROQ_API_URL`** (default: `https://api.groq.com/openai`).
- **`LLM_API_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_MAX_TOKENS`**: overrides genéricos que ganan sobre los del proveedor activo.
- **`TIMEZONE`**: Zona horaria (default: `Europe/Madrid`).
- **`STT_ENABLED`**: Interruptor maestro de transcripción de voz (default: `true`). Con `false` el bot no descarga el audio, no carga whisper y no llama a Voicebox: contesta al instante con un aviso.
- **`STT_LOCAL_ENABLED`**: Solo si `STT_ENABLED=true`. `true` = whisper en esta máquina, `false` = Voicebox (default: `true`).
- **`STT_MODEL`**: Modelo whisper para transformers.js: `Xenova/whisper-tiny`, `-base`, `-small`, o `onnx-community/whisper-large-v3-turbo`. OJO: el turbo exige onnxruntime >= 1.20 (IR version 10); con `@xenova/transformers` 2.x falla con `Unsupported model IR version: 10`.
- **`STT_CACHE_DIR`**: Dónde se guardan los pesos de whisper (default: `./data/models`). Nunca dentro de `node_modules`: un `pnpm install` los borra y obliga a volver a bajar cientos de MB.
- **`VOICEBOX_URL`**: URL del servidor Voicebox para TTS (default: `http://192.168.1.79:17493`).
- **`VOICEBOX_ENABLED`**: Habilita síntesis de voz (`true`/`false`, default: `false`).
- **`VOICEBOX_PROFILE`**: Nombre del perfil de voz en Voicebox (default: `Mara`).
- **`TELEGRAM_SEND_VOICE`**: Envía audio por defecto en nuevos chats (`true`/`false`, default: `false`). Se puede alternar por chat con `/voz on|off`.
- **`MCP_DISABLED_SERVERS`**: Servidores MCP a desactivar, separados por comas. En una Raspberry Pi hay que poner `macos_automator`: depende de AppleScript y no puede funcionar fuera de macOS.
- **`MCP_MEMORY_SERVERS`**: Servidores MCP que cuentan como backend de memoria, separados por comas. Vacío por defecto: la memoria la gestiona el bot (Hindsight + SQLite) sin depender de ningún MCP.
- **`HINDSIGHT_ENABLED`**: Activa Hindsight como memoria principal (`true`/`false`, default: `false`). Ausente = solo SQLite, como antes.
- **`HINDSIGHT_API_URL`**: URL de la API de Hindsight (default: `http://192.168.1.196:8888`). El panel web (`:9999`) no se usa desde el bot.
- **`HINDSIGHT_BANK_ID`**: Banco de memoria (default: `mara-os`).
- **`HINDSIGHT_API_KEY`**: Opcional; se envía como `Authorization: Bearer`.
- **`MEMORY_MIN_IMPORTANCE`**: Importancia mínima (0-1) para guardar un hecho extraído (default: `0.5`).
- **`MEMORY_EXTRACTION_MIN_INTERVAL_MS`**: Mínimo entre extracciones del mismo chat (default: `60000`; `0` lo desactiva).
- **`MARA_BRAIN_WS_URL`**: URL del servidor WebSocket "brain" que emite eventos v1 a Mara UI. Vacío = desactivado (default). Ver [Integración con Mara UI](#integración-con-mara-ui).

**Nota**: Las respuestas de más de 500 caracteres envían solo texto para evitar sobrecarga. El audio se genera en español (`language: "es"`).

`mcp.json` admite `${VAR}` y `${VAR:-por_defecto}`, de modo que las rutas de binarios no quedan atadas a una máquina concreta. Ajusta `NPX_PATH` a donde esté en tu equipo.

## Archivos de Contexto (`config/`)

El agente define su comportamiento mediante archivos Markdown ubicados en la carpeta `config/`:

- **`SOUL.md`**: Define la personalidad profunda del agente, su tono de comunicación y estilo preferido de respuestas.
- **`USER.md`**: Información estable sobre el usuario (preferencias, tecnologías que usa, ubicación, etc.) para que el agente tenga contexto al responder.
- **`AGENTS.md`**: Reglas operativas y del canal (por ejemplo, evitar markdown en Telegram, cómo y cuándo guardar recuerdos, límites de seguridad).
- **`MEMORY.md`**: Archivo legacy de memoria estática. Los recuerdos dinámicos van a Hindsight (con espejo en SQLite); con Hindsight activo no se migra automáticamente.
- **`skills/`**: Guías Specialized que se inyectan en el contexto cuando el mensaje del usuario encaja con sus palabras clave.

## Ejecución

Antes de arrancar, comprueba el proveedor de inferencia activo (conectividad, modelo presente, respuesta de texto y **tool calling**, de lo que dependen las herramientas MCP):

```bash
pnpm check:llm
```

Para iniciar el bot en modo de desarrollo o ejecución normal:

```bash
pnpm bot
```

Variante ligera, sin MCP ni UI:

```bash
pnpm bot:lite
```

El proceso usa `process.cwd()` para localizar `config/` y `mcp.json`: **arráncalo siempre desde la raíz del repositorio**. Bajo systemd, fija `WorkingDirectory`.

## Cambiar de proveedor sin reiniciar

Desde Telegram:

```
/modelo          → estado de los cuatro proveedores (marca el activo)
/modelo groq     → prueba que responde y lo activa
/modelo unsloth  → vuelve al servidor de la LAN
```

Antes de cambiar, el bot consulta el listado de modelos del candidato y
comprueba que el modelo configurado está disponible; si no responde, no cambia
nada y explica por qué. La elección se guarda en `data/llm-provider.json`, así
que sobrevive a los reinicios. `LLM_PROVIDER` es solo el valor inicial.

## Diagnóstico

| Comando | Qué hace |
|---|---|
| `pnpm check:llm` | Conectividad, modelo disponible, respuesta de texto y tool calling (`check:ollama` sigue como alias) |
| `pnpm check:hindsight` | Salud, versión, banco y recall de Hindsight (solo lectura) + estado local |
| `pnpm check:stt` | Confirma si el STT está activo o neutralizado |
| `pnpm bench:stt <modelo>` | Mide precisión y velocidad de un modelo whisper sobre un audio real |
| `pnpm test` | Tests de memoria contra un Hindsight falso (sin red) |
| `pnpm typecheck` | TypeScript sin emitir |

## Memoria a largo plazo (Hindsight)

Con `HINDSIGHT_ENABLED=true`, Mara OS usa Hindsight como fuente principal:

- Guarda cada hecho nuevo con `retain` (idempotente por `document_id`).
- Recupera contexto con `recall` (`budget: "low"`, `prefer_observations`).
- Olvida con `PATCH state=invalidated`; nunca borra el banco.
- SQLite (`data/mara.db`) guarda el historial y hace de espejo/respaldo con una
  outbox que se reintenta sola si el servidor no responde.

No se migran recuerdos antiguos automáticamente. Detalle completo en
[docs/memory-system.md](docs/memory-system.md) y
[docs/operations/memory-management.md](docs/operations/memory-management.md).

`pnpm bench:stt` es la herramienta para decidir el modelo de STT en un equipo concreto:

```bash
pnpm bench:stt Xenova/whisper-small
```

## Notas para Raspberry Pi

- **64 bits obligatorio.** `better-sqlite3` y `onnxruntime-node` publican `linux-arm64` dentro del paquete de npm; no existe build de 32 bits.
- **Whisper local no es viable.** En una Pi 5, `whisper-tiny` tarda ~5 s en 5 s de audio y `whisper-large-v3-turbo` ~68 s. Los modelos que transcriben bien no llegan a tiempo, así que lo razonable es `STT_ENABLED=false` y delegar en Voicebox si está disponible.
- **Espacio en la SD.** La dependencia `@xenova/transformers` ocupa ~183 MB en `node_modules` aunque el STT esté apagado (los binarios nativos vienen para todas las plataformas). Con STT activo, los pesos se guardan en `STT_CACHE_DIR`.
- **`macos_automator` no puede funcionar.** Ponlo en `MCP_DISABLED_SERVERS`; si no, solo aporta tools muertas al contexto del LLM.
- `data/` (base de datos), `data/models/` y `config/uploads/` se crean solas en runtime.

## Integración con Mara UI

Mara OS puede emitir su estado y respuestas a **Mara UI** (la interfaz visual del asistente) usando el **protocolo de eventos v1**:

```ts
{ type: string, version: 1, timestamp: number, data: T }
```

### Topología

Mara OS actúa como **servidor WebSocket "brain"**. El bridge de Mara UI se conecta a él y difunde los eventos a la interfaz:

```txt
mara-ui (React) ──WS──▶ bridge (server/index.mjs) ──WS (MARA_BRAIN_WS_URL)──▶ mara-os
```

### Configuración

1. En `mara-os/.env` activa el brain (vacío = desactivado):
   ```env
   MARA_BRAIN_WS_URL=ws://0.0.0.0:9000
   ```
   Usa `0.0.0.0` si el bridge está en otro equipo de la red, o `localhost` para pruebas locales.

2. En `mara-ui/.env` apunta el bridge al brain y arranca el servidor:
   ```env
   MARA_BRAIN_WS_URL=ws://192.168.1.50:9000   # host y puerto del brain
   ```
   ```bash
   npm run server
   ```

> Si `MARA_BRAIN_WS_URL` no está definido, mara-os funciona exactamente igual que antes: el módulo de eventos es un no-op.

### Eventos emitidos

| `type` | `data` | Cuándo |
|---|---|---|
| `mara:state` | `{ state }` (`idle`/`listening`/`thinking`/`speaking`/`seeing`/`error`/`offline`) | Transiciones del agente: `thinking` al procesar, `idle` al terminar, `listening` al transcribir audio, `seeing` al procesar una foto, `speaking` durante TTS, `error`/`offline` en fallos |
| `mara:message` | `{ text }` | Respuesta actual generada |
| `voice.speaking.started` | `{}` | Empieza la síntesis de voz (TTS) |
| `voice.speaking.finished` | `{}` | Termina la síntesis de voz (TTS) |
| `voice.audio` | `{ text, audio }` (`audio` = WAV en base64) | Voz generada para que la UI la reproduzca (respuesta al micrófono del navegador) |
| `mara:network` | `{ connected }` | Estado del transporte (emitido en arranque/conexión) |
| `mara:confirm` | `{ id, title, message, action }` | Cuando un mensaje requiere aprobación (además del aviso de Telegram) |

> El ciclo de habla (`voice.speaking.*`) envuelve **la generación TTS**, no el envío
> a un canal concreto: la UI pasa a `speaking`/`idle` según la síntesis de voz y
> Telegram es solo un canal de salida más, no controla el estado visual.

Al conectar (o reconectar) un cliente, el brain reenvía el estado actual, el último mensaje y el estado de red para que la UI se sincronice.

## Estructura del Proyecto

```txt
src/
  bot.ts              # Lógica principal del bot, conexión con Telegram y Ollama
  ollama.ts           # Cliente de Ollama: chat, tool calling y reintentos
  ollama-http.ts      # num_ctx por petición y lectura del cuerpo de error
  stt.ts              # Transcripción local con whisper (transformers.js)
  voicebox.ts         # TTS y STT remotos vía Voicebox
  mcp.ts              # Conexión a los servidores MCP y construcción de tools
  events.ts           # Servidor WebSocket "brain" + protocolo de eventos v1 (Mara UI)
  approvals.ts        # Control básico de confirmaciones de seguridad
  telegram-files.ts   # Helper para descarga de archivos e imágenes de Telegram

config/
  SOUL.md             # Personalidad del agente (Mara)
  USER.md             # Información del usuario (Kike)
  AGENTS.md           # Reglas de formato y comportamiento
  MEMORY.md           # Memoria compartida y persistente
  skills/             # Guías Specialized por palabra clave

scripts/
  check-ollama.ts     # Diagnóstico del backend de Ollama
  check-hindsight.ts  # Diagnóstico de Hindsight (solo lectura)
  check-stt-off.ts    # Comprueba que el STT queda neutralizado
  bench-stt.ts        # Compara modelos whisper sobre un audio real

tests/
  hindsight-store.test.ts    # Contrato REST del adaptador
  resilient-memory.test.ts   # Fallback, outbox y olvido suave
```
