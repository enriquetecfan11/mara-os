# Testing

Actualmente no hay tests automatizados. El proyecto se verifica mediante type checking y ejecución manual.

## Type Checking

```bash
pnpm typecheck
```

Esto ejecuta `tsc --noEmit` con `strict: true`. Es la primera línea de defensa contra errores.

## Comprobar Ollama

Antes de arrancar el bot, verifica que el backend de inferencia está operativo:

```bash
pnpm check:ollama
```

Comprueba, en orden, y sale con código 0 (todo bien) o 1 (algún fallo):

1. **Conectividad** a `OLLAMA_URL` (`/api/version`).
2. **Modelo disponible** en el servidor (`OLLAMA_MODEL` en `/api/tags`).
3. **Respuesta de texto** (una petición real de chat).
4. **Tool calling** — que el modelo devuelve `tool_calls`; es imprescindible para que el bot use los servidores MCP.

Usa las mismas variables que el bot (`OLLAMA_URL`, `OLLAMA_MODEL` del `.env`), así que puedes apuntarlo a otro servidor/modelo sin tocar nada:

```bash
OLLAMA_URL=http://127.0.0.1:11434 OLLAMA_MODEL=mi-modelo:latest node --import tsx scripts/check-ollama.ts
```

Implementado en `scripts/check-ollama.ts`.

## Verificación Manual

### Flujo Básico

1. Inicia el bot: `pnpm bot`
2. Envía un mensaje de texto a tu bot de Telegram
3. Espera la respuesta del asistente
4. Verifica en los logs del terminal que:
   - Se cargaron los servidores MCP
   - Se detectaron skills (si aplica)
   - Las tool_calls se ejecutaron correctamente
   - La respuesta se envió de vuelta

### Probar Tools Específicas

```bash
# Ver skills disponibles
/skill lista

# Ver estado del sistema
/status

# Forzar recarga de skills
/skill recargar

# Consultar memoria
/memory
/memory ¿qué recuerdas de mí?
```

### Probar Fallos

- Detén Ollama y envía un mensaje → debería reintentar y fallar gracefulmente
- Detén un servidor MCP y verifica que el resto del bot sigue funcionando
- Presiona Ctrl+C → debería cerrar MCP clients y parar sin errores

## Próximos Pasos

Cuando se añadan tests, deberían cubrir:
- Parseo de frontmatter de skills
- Detección de keywords
- Construcción del system prompt
- Limpieza de markdown
- Flujo de aprobaciones
