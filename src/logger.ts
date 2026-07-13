type LogLevel = "debug" | "info" | "warn" | "error"

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",    // gray
  info: "\x1b[36m",     // cyan
  warn: "\x1b[33m",     // yellow
  error: "\x1b[31m",    // red
}

const RESET = "\x1b[0m"

function getLogLevel(): LogLevel {
  const envLevel = (process.env.LOG_LEVEL || "info").toLowerCase()
  return envLevel in LOG_LEVELS ? (envLevel as LogLevel) : "info"
}

export function log(level: LogLevel, module: string, message: any): void {
  const currentLevel = getLogLevel()

  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) {
    return
  }

  const time = new Date().toLocaleTimeString("es-ES", { hour12: false })
  const color = COLORS[level]
  const levelStr = level.toUpperCase().padEnd(5)

  const msg = typeof message === "string" ? message : JSON.stringify(message, null, 2)
  console.log(`${color}[${time}] [${levelStr}] [${module}]${RESET} ${msg}`)
}

export function debug(module: string, message: any): void {
  log("debug", module, message)
}

export function info(module: string, message: any): void {
  log("info", module, message)
}

export function warn(module: string, message: any): void {
  log("warn", module, message)
}

export function error(module: string, message: any): void {
  log("error", module, message)
}
