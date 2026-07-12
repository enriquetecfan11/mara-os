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

## Requisitos

- Node.js (v18+)
- pnpm o npm
- Un bot de Telegram (puedes crear uno con [@BotFather](https://t.me/BotFather))
- Ollama instalado y ejecutándose localmente

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
   OLLAMA_MODEL=gemma4:e2b
   TIMEZONE=Europe/Madrid
   ```

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

## Estructura del Proyecto

```txt
src/
  bot.ts              # Lógica principal del bot, conexión con Telegram y Ollama
  approvals.ts        # Control básico de confirmaciones de seguridad
  telegram-files.ts   # Helper para descarga de archivos e imágenes de Telegram

config/
  SOUL.md             # Personalidad del agente (Mara)
  USER.md             # Información del usuario (Kike)
  AGENTS.md           # Reglas de formato y comportamiento
  MEMORY.md           # Memoria compartida y persistente
```
