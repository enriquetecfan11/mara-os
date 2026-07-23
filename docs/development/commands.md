# Comandos de Desarrollo

## Scripts Disponibles

```bash
pnpm bot              # Iniciar el bot
pnpm typecheck        # Verificar tipos TypeScript
pnpm reset-bot        # Limpiar memoria (vacía MEMORY.md)
pnpm reset-memory     # Restaurar MEMORY.md del estado de git
```

## pnpm bot

Inicia el bot con las variables de entorno del archivo `.env`:

```bash
pnpm bot
```

Equivalente a:
```bash
node --env-file-if-exists=.env --import tsx src/bot.ts
```

## pnpm typecheck

Ejecuta el compilador de TypeScript en modo strict para verificar tipos sin emitir archivos:

```bash
pnpm typecheck
```

## pnpm reset-bot

Elimina el contenido de MEMORY.md para empezar con memoria limpia:

```bash
pnpm reset-bot
```

## pnpm reset-memory

Restaura MEMORY.md al estado que tenía en el último commit de git:

```bash
pnpm reset-memory
```

## Dependencias

| Paquete | Versión | Propósito |
|---|---|---|
| grammy | ^1.38.4 | Framework de bot de Telegram |
| @modelcontextprotocol/sdk | ^1.29.0 | Cliente MCP |
| tsx | ^4.21.0 | TypeScript runner (dev) |
| typescript | ^5.9.3 | TypeScript compiler (dev) |
| @types/node | ^24.10.1 | Tipos de Node.js (dev) |
