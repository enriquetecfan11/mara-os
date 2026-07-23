# Sistema de Skills

## ¿Qué son los Skills?

Los skills son archivos markdown en `config/skills/` que contienen instrucciones especializadas para dominios concretos. Se detectan automáticamente por palabras clave en el mensaje del usuario.

## Estructura de un Skill

Cada skill es un archivo `.md` con frontmatter YAML y cuerpo markdown:

```markdown
---
name: calendario
keywords: [calendario, evento, reunión, cita, schedule]
---

Cuando Kike pida crear un evento, usa Create_an_event con título, fecha y hora.
Cuando pregunte por eventos, usa Get_all_Events.
Para modificar, usa Reschedule_Event.
Para eliminar, usa Delete_Calendar_Event.
Para ver disponibilidad, usa Check_Availability.
```

### Frontmatter

| Campo | Descripción | Obligatorio |
|---|---|---|
| `name` | Nombre único del skill | Sí |
| `keywords` | Lista de palabras para activación automática | Sí |

### Cuerpo

Texto markdown con instrucciones para el modelo sobre cómo usar las tools MCP en ese dominio.

## Skills Actuales

| Archivo | Keywords | Propósito |
|---|---|---|
| `calendario.md` | calendario, evento, reunión, cita, schedule | Gestión de Google Calendar |
| `notas.md` | nota, notas, tarea, tareas, task, todo, lista | Gestión de notas y tareas |
| `automatizacion.md` | mac, mac mini, script, apple, automation, jxa, automate | Automatización del Mac con AppleScript/JXA |
| `memoria.md` | recuerda, olvida, memoria, recuerdo, acuérdate | Gestión de memoria persistente |

## Carga y Detección

### loadAllSkills()

- Escanea `config/skills/*.md`
- Parsea el frontmatter de cada archivo
- Almacena en `skillsCache` (se cachea en memoria tras la primera carga)
- Devuelve un Map<name, Skill>

### detectSkills(message, skills)

- Convierte el mensaje a minúsculas
- Para cada skill, comprueba si alguna keyword está contenida en el mensaje
- Devuelve array de nombres de skills detectados

### loadSkillsContext(detectedNames)

- Carga los cuerpos de los skills detectados
- Los concatena como `SKILLS ACTIVOS:` en el system prompt

### getSkillList()

- Devuelve lista de nombres de skills disponibles

### reloadSkills()

- Limpia el caché y recarga desde disco

## Detección Automática

La auto-detección está siempre activa. Cuando un mensaje contiene una keyword de un skill, el contenido del skill se inyecta en el system prompt para guiar al modelo.

No es necesario reiniciar el bot al añadir skills nuevos.

## Añadir un Nuevo Skill

1. Crea `config/skills/miskill.md`
2. Añade frontmatter con `name` y `keywords`
3. Escribe instrucciones en markdown
4. El bot lo detectará automáticamente

## Comandos Relacionados

- `/skill lista` — Ver skills disponibles
- `/skill <nombre>` — Cargar un skill específico manualmente
- `/skill recargar` — Recargar skills desde disco
