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
| `{{MEMORY}}` | `config/MEMORY.md` | Memoria persistente |
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
- Política de memoria (MEMORY.md vs servidor MCP)
- Lista de herramientas MCP disponibles con descripciones
- Instrucciones obligatorias de uso de tools
- Comportamiento en /help y /status

## MEMORY.md — Memoria Persistente

**Ubicación**: `config/MEMORY.md`
**Propósito**: Almacenamiento de hechos y datos persistentes.

Se usa como fallback cuando no hay servidor MCP de memoria (Engram). Cuando Engram está disponible, MEMORY.md se lee al inicio del contexto pero las escrituras van a Engram.

## Caché

Todos los archivos se cachean en memoria con invalidación por mtime (modification time). Si el archivo no ha cambiado en disco, se devuelve la versión cacheada. Esto reduce la latencia de 40-60ms a ~1ms por request.

## Modificación en Caliente

Los archivos de contexto se leen frescos en cada mensaje. No es necesario reiniciar el bot al editarlos. Si el mtime cambia, el caché se invalida automáticamente.
