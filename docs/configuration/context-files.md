# Archivos de Contexto

Los archivos de contexto definen la personalidad, el conocimiento del usuario, las reglas operativas y la memoria del agente. Se leen en cada mensaje (con caché por mtime) y se inyectan en el system prompt.

## SYSTEM.md — Plantilla del System Prompt

**Ubicación**: `config/SYSTEM.md`

Plantilla que estructura cómo se construye el system prompt. Contiene placeholders que se reemplazan en tiempo real:

| Placeholder | Fuente | Propósito |
|---|---|---|
| `{{DATE_TIME}}` | Fecha actual formateada | Contexto temporal |
| `{{TIMEZONE}}` | `TIMEZONE` de .env | Zona horaria |
| `{{SOUL}}` | `config/SOUL.md` | Personalidad del agente |
| `{{USER}}` | `config/USER.md` | Información del usuario |
| `{{AGENTS}}` | `config/AGENTS.md` | Reglas operativas |
| `{{MEMORY}}` | `MemoryManager.search()` (Hindsight o SQLite) | Recuerdos relevantes del mensaje |
| `{{SKILLS}}` | Skills detectados | Instrucciones de dominio específico |

Contiene instrucciones críticas:
- "Responde SIEMPRE en español, NUNCA en inglés"
- "Usa texto plano sin formato Markdown"
- "Tienes herramientas disponibles, úsalas sin excusas"

## SOUL.md — Personalidad del Agente

**Ubicación**: `config/SOUL.md`
**Propósito**: Define quién es el agente y cómo se comunica.

Mara es:
- Directa, técnica, sin rodeos
- Profesional pero cercana
- No da explicaciones no solicitadas
- Tiene acceso completo y autorizado a los sistemas de Kike
- No simula, actúa

## USER.md — Perfil del Usuario

**Ubicación**: `config/USER.md`
**Propósito**: Proporciona contexto estable sobre el usuario.

Contiene:
- Nombre: Kike Rodriguez Vela
- Ubicación: Madrid, España
- Trabajo: Desarrollador e ingeniero de infraestructura
- Stack: macOS, Ubuntu, Proxmox, Docker, Python, TypeScript, Bash, SQL
- Intereses: Ciberseguridad, blockchain, IA/ML, vehículos eléctricos
- Herramientas: Obsidian, Cursor, Ollama

## AGENTS.md — Reglas Operativas

**Ubicación**: `config/AGENTS.md`
**Propósito**: Define reglas de comportamiento y formato.

Incluye:
- Formato de respuesta (texto plano, sin markdown)
- Política de memoria (Hindsight como fuente principal, sin escribir a mano)
- Lista de herramientas MCP disponibles con descripciones
- Instrucciones obligatorias de uso de tools
- Comportamiento en /help y /status

## MEMORY.md — Memoria Persistente (legacy)

**Ubicación**: `config/MEMORY.md`

La memoria dinámica ya no vive aquí: la gestiona `MemoryManager` (Hindsight como
fuente principal y SQLite como espejo/respaldo) y se inyecta en `{{MEMORY}}`
como resultado de una búsqueda contextual.

`MEMORY.md` se conserva como archivo estático editable a mano. Con Hindsight
activo no se migra automáticamente a SQLite para no duplicar contenido. Ver
[Sistema de memoria](../memory-system.md).

## Caché

Todos los archivos se cachean en memoria con invalidación por mtime (modification time). Si el archivo no ha cambiado en disco, se devuelve la versión cacheada. Esto reduce la latencia de 40-60ms a ~1ms por request.

## Modificación en Caliente

Los archivos de contexto se leen frescos en cada mensaje. No es necesario reiniciar el bot al editarlos. Si el mtime cambia, el caché se invalida automáticamente.
