# Mara OS

Asistente personal local basado en un bot de Telegram y modelos locales de lenguaje a través de Ollama.

El proyecto está diseñado para ser sencillo, legible y fácil de personalizar. Sirve como implementación de referencia para entender cómo conectar un canal de chat (Telegram), un motor de inferencia local (Ollama), archivos de contexto persistentes (alma, usuario, reglas del agente), memoria a largo plazo y reglas sencillas de confirmación de seguridad.

## Características principales

- **Integración con Telegram**: Envío y recepción de mensajes directamente desde un bot de Telegram.
- **Inferencia local**: Procesamiento de lenguaje natural utilizando Ollama y modelos locales (como Gemma, Llama o Phi).
- **Personalidad y contexto persistentes**: Carga dinámica del contexto del agente a partir de archivos Markdown (`SOUL.md`, `USER.md`, `AGENTS.md`).
- **Memoria persistente**: Usa `MEMORY.md` como memoria local persistente y puede conectar servidores MCP de memoria si están disponibles.
- **Control de seguridad**: Flujo básico de aprobación para acciones externas críticas.
- **Soporte multimedia**: Descarga automática de imágenes enviadas por Telegram a un directorio local de subidas para su posterior procesamiento.
- **Síntesis de voz**: Genera audio con Voicebox TTS y lo envía junto con la respuesta de texto. Activable/desactivable por chat con el comando `/voz on|off`.
- **Integración con Mara UI**: Emite el estado y las respuestas de Mara a una interfaz visual (protocolo de eventos v1) mediante un servidor WebSocket "brain" opcional, sin afectar a Telegram.

## Requisitos

- Node.js (v18+)
- pnpm o npm
- Un bot de Telegram (puedes crear uno con [@BotFather](https://t.me/BotFather))
- Ollama instalado y ejecutándose localmente
- (Opcional) Voicebox instalado y ejecutándose para síntesis de voz

## Instalación y Configuración

1. Instala las dependencias del proyecto:
   ```bash
   pnpm install
   ```

2. Copia el archivo de variables de entorno y configúralo:
   ```bash
   cp .env.example .env
   ```

3. Edita `.env` con tus credenciales y configuración:
   ```env
   TELEGRAM_TOKEN=tu_token_de_telegram
   OLLAMA_URL=http://localhost:11434
   OLLAMA_MODEL=ornith:9b
   TIMEZONE=Europe/Madrid
   VOICEBOX_URL=http://192.168.1.79:17493
   VOICEBOX_ENABLED=true
   VOICEBOX_PROFILE=Alex
   TELEGRAM_SEND_VOICE=true
   MARA_BRAIN_WS_URL=ws://0.0.0.0:9000
   ```

### Variables de Configuración

- **`TELEGRAM_TOKEN`**: Token del bot de Telegram (obligatorio).
- **`TELEGRAM_CHAT_ID`**: ID del chat donde enviar mensajes de startup (opcional).
- **`OLLAMA_URL`**: URL del servidor Ollama (default: `http://localhost:11434`).
- **`OLLAMA_MODEL`**: Modelo a usar en Ollama (default: `ornith:9b`, con soporte de tool calling).
- **`TIMEZONE`**: Zona horaria (default: `Europe/Madrid`).
- **`VOICEBOX_URL`**: URL del servidor Voicebox para TTS (default: `http://192.168.1.79:17493`).
- **`VOICEBOX_ENABLED`**: Habilita síntesis de voz (`true`/`false`, default: `false`).
- **`VOICEBOX_PROFILE`**: Nombre del perfil de voz en Voicebox (default: `Alex`).
- **`TELEGRAM_SEND_VOICE`**: Envía audio por defecto en nuevos chats (`true`/`false`, default: `false`). Se puede alternar por chat con `/voz on|off`.
- **`MARA_BRAIN_WS_URL`**: URL del servidor WebSocket "brain" que emite eventos v1 a Mara UI. Vacío = desactivado (default). Ver [Integración con Mara UI](#integración-con-mara-ui).

**Nota**: Las respuestas de más de 500 caracteres envían solo texto para evitar sobrecarga. El audio se genera en español (`language: "es"`).

## Archivos de Contexto (`config/`)

El agente define su comportamiento mediante archivos Markdown ubicados en la carpeta `config/`:

- **`SOUL.md`**: Define la personalidad profunda del agente, su tono de comunicación y estilo preferido de respuestas.
- **`USER.md`**: Información estable sobre el usuario (preferencias, tecnologías que usa, ubicación, etc.) para que el agente tenga contexto al responder.
- **`AGENTS.md`**: Reglas operativas y del canal (por ejemplo, evitar markdown en Telegram, cómo y cuándo guardar recuerdos, límites de seguridad).
- **`MEMORY.md`**: Memoria duradera local. El bot la usa como fuente persistente cuando no hay servidor MCP de memoria disponible.

## Ejecución

Para iniciar el bot en modo de desarrollo o ejecución normal:

```bash
pnpm bot
```

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
| `mara:network` | `{ connected }` | Estado del transporte (emitido en arranque/conexión) |
| `mara:confirm` | `{ id, title, message, action }` | Cuando un mensaje requiere aprobación (además del aviso de Telegram) |

Al conectar (o reconectar) un cliente, el brain reenvía el estado actual, el último mensaje y el estado de red para que la UI se sincronice.

## Estructura del Proyecto

```txt
src/
  bot.ts              # Lógica principal del bot, conexión con Telegram y Ollama
  events.ts           # Servidor WebSocket "brain" + protocolo de eventos v1 (Mara UI)
  approvals.ts        # Control básico de confirmaciones de seguridad
  telegram-files.ts   # Helper para descarga de archivos e imágenes de Telegram

config/
  SOUL.md             # Personalidad del agente (Mara)
  USER.md             # Información del usuario (Kike)
  AGENTS.md           # Reglas de formato y comportamiento
  MEMORY.md           # Memoria compartida y persistente
```
