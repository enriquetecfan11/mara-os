# Skills

## ¿Qué es un Skill?

Un skill es un archivo markdown en `config/skills/` que proporciona instrucciones especializadas al modelo para manejar dominios concretos. Se detectan automáticamente por palabras clave en el mensaje del usuario.

## Estructura de Archivo

```markdown
---
name: nombre-del-skill
keywords: [palabra1, palabra2, palabra clave]
---

Instrucciones para el modelo sobre cómo usar las tools en este dominio.
```

### Campos Obligatorios

| Campo | Descripción |
|---|---|
| `name` | Nombre único del skill |
| `keywords` | Lista de palabras que activan el skill |

### Cuerpo del Skill

El cuerpo del archivo se inyecta en el system prompt bajo la sección `SKILLS ACTIVOS:` cuando el skill se detecta. Debe contener instrucciones claras sobre qué tools usar y cómo.

## Skills Actuales

### calendario.md

- **Keywords**: calendario, evento, reunión, cita, schedule
- **Propósito**: Guía el uso de herramientas de Google Calendar
- **Incluye**: Crear, ver, modificar, eliminar eventos y ver disponibilidad

### notas.md

- **Keywords**: nota, notas, tarea, tareas, task, todo, lista
- **Propósito**: Gestión de notas y tareas
- **Incluye**: Crear, ver, listar, completar y eliminar tareas

### automatizacion.md

- **Keywords**: mac, mac mini, script, apple, automation, jxa, automate
- **Propósito**: Automatización del sistema macOS
- **Incluye**: Ejecución de AppleScript/JXA, obtención de scripts del knowledge base

### memoria.md

- **Keywords**: recuerda, olvida, memoria, recuerdo, acuérdate
- **Propósito**: Gestión de memoria persistente
- **Incluye**: Instrucciones para recordar y recuperar información

## Ciclo de Vida

1. **Carga**: `loadAllSkills()` escanea `config/skills/*.md`, parsea frontmatter y cachea
2. **Detección**: `detectSkills()` compara keywords del skill con el mensaje del usuario
3. **Inyección**: `loadSkillsContext()` concatena los cuerpos de skills detectados al system prompt
4. **Recarga**: `/skill recargar` o `reloadSkills()` limpia el caché y recarga

## Crear un Nuevo Skill

1. Crea `config/skills/mi-skill.md`
2. Añade frontmatter:
   ```yaml
   ---
   name: mi-skill
   keywords: [palabra1, palabra2]
   ---
   ```
3. Escribe instrucciones en markdown
4. No necesitas reiniciar el bot

## Comandos

- `/skill lista` — Ver skills disponibles
- `/skill <nombre>` — Cargar un skill específico
- `/skill recargar` — Recargar skills desde disco
