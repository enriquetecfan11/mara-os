# Comandos de Telegram

## Comandos del Bot

| Comando | Descripción | Implementación |
|---|---|---|
| `/start` | Inicia la conversación, limpia el historial y saluda | `bot.ts:63` |
| `/help` | Muestra ayuda completa con modelo, contexto y skills | `bot.ts:78` |
| `/status` | Muestra estado del sistema (fecha, modelo, archivos de contexto, skills) | `bot.ts:130` |
| `/reset` | Limpia el historial de conversación del chat actual | `bot.ts:73` |
| `/cancel` | Cancela la operación en curso (aborta request a Ollama) | `bot.ts:202` |
| `/skill lista` | Lista skills disponibles | `bot.ts:175` |
| `/skill <nombre>` | Carga un skill específico manualmente | `bot.ts:193` |
| `/skill recargar` | Recarga skills desde disco | `bot.ts:186` |
| `/memory [query]` | Busca recuerdos en la memoria persistente | `bot.ts:207` |
| `/memory forget <id>` | Olvida un recuerdo específico | `bot.ts:214` |
| `/feedback <texto>` | Envía opinión sobre el bot (se guarda en FEEDBACK.log) | `bot.ts:229` |

## Comandos de Desarrollo

| Comando | Descripción |
|---|---|
| `pnpm bot` | Iniciar el bot |
| `pnpm typecheck` | Verificar tipos TypeScript |
| `pnpm reset-bot` | Vaciar MEMORY.md |
| `pnpm reset-memory` | Restaurar MEMORY.md de git |

## Flujo de Aprobación

Cuando un mensaje contiene palabras de riesgo (publicar, postear, tuitea, etc.), el bot responde:

> "Esto sale fuera de Telegram. Si quieres hacerlo, empieza el mensaje por: Confirmo"

El usuario debe reenviar el mensaje comenzando con "Confirmo" para ejecutar la acción.

## Manejo de Fotos

Las fotos enviadas al bot se descargan automáticamente a `config/uploads/` y se procesan con el caption como contexto.

## Respuesta a Errores

Si ocurre un error no controlado, el bot responde:

> "Ups, ocurrió un error al procesar tu mensaje. Inténtalo de nuevo."
