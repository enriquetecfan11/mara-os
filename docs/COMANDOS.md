# Comandos de Telegram

Todos los comandos que entiende Mara en Telegram.

## Conversación

| Comando | Qué hace |
|---|---|
| `/start` | Borra el historial del chat y muestra la bienvenida completa: estado del sistema, estados y comandos |
| `/help` | Muestra la misma bienvenida, sin borrar el historial |
| `/reset` | Borra el historial del chat |
| `/cancel` | Cancela la petición en curso al modelo |
| `/feedback <texto>` | Guarda tu opinión en `config/FEEDBACK.log` |

## Estado y diagnóstico

| Comando | Qué hace |
|---|---|
| `/status` | Fecha, proveedor, modelo y servidor activos, archivos de contexto y skills |
| `/context` | Contexto de ejecución detallado: archivos, skills, tools, servidores MCP conectados y estado de la memoria (backend, recuerdos, Hindsight disponible, pendientes de sincronizar) |

## Modelo

| Comando | Qué hace |
|---|---|
| `/modelo` | Lista los proveedores (`unsloth`, `groq`, `ollama`, `openai`), si están configurados y cuál está activo |
| `/modelo <proveedor>` | Comprueba que el proveedor responde y tiene el modelo, y si es así lo activa. El cambio se mantiene tras reiniciar |

Ejemplo: `/modelo groq`

## Grupos de tools

Los grupos arrancan **apagados**. La memoria (`guardar_recuerdo`,
`buscar_recuerdos`, `buscar_en_notas`) está siempre activa.

| Comando | Qué hace |
|---|---|
| `/tools` | Muestra qué grupos están activos |
| `/tools on <grupo…>` | Activa esos grupos |
| `/tools off <grupo…>` | Desactiva esos grupos |
| `/tools solo <grupo…>` | Deja activos solo esos grupos |

Grupos: `tareas`, `notas`, `proyectos`, `delegaciones`, `ejecuciones`. El estado
se mantiene tras reiniciar.

Ejemplo: `/tools on tareas notas`

## Memoria

| Comando | Qué hace |
|---|---|
| `/memory` | Recuerdos recientes (5) |
| `/memory <consulta>` | Busca recuerdos (5 resultados) |
| `/memory search <consulta>` | Busca recuerdos mostrando su id (10 resultados). También `find` |
| `/memory list` | Los 20 últimos recuerdos con su id |
| `/memory forget <id>` | Olvida un recuerdo |

Sin comando: un mensaje que empiece por *recuerda que…*, *apunta…*, *anota…*,
*memoriza…* o *no olvides que…* se guarda directamente en la memoria.
*Recuérdame…* no cuenta: se trata como un recordatorio.

## Notas de Obsidian

| Comando | Qué hace |
|---|---|
| `/notas <consulta>` | Busca en el banco de notas de Obsidian y devuelve hasta 5 notas con un fragmento de cada una. No pasa por el modelo |

Sin comando: si preguntas algo como *¿qué tengo en mis notas sobre…?*, Mara
puede buscar en las notas por su cuenta, pero lo decide el modelo. `/notas`
busca siempre.

## Skills

| Comando | Qué hace |
|---|---|
| `/skill` o `/skill lista` | Lista los skills instalados |
| `/skill <nombre>` | Carga un skill a mano y muestra su contenido |
| `/skill recargar` | Recarga los skills desde disco |

## Voz

| Comando | Qué hace |
|---|---|
| `/voz` | Indica si la respuesta por voz está activada en este chat |
| `/voz on` | Responde también con nota de voz |
| `/voz off` | Responde solo con texto |

Sin `/voz`, Mara responde con voz solo cuando le hablas con voz.

## Confirmación

Si un mensaje implica publicar algo fuera de Telegram, Mara pide confirmación:
reenvía el mensaje empezando por **Confirmo**.
