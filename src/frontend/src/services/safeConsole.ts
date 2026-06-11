export type SafeConsoleLevel = 'log' | 'info' | 'warn' | 'error'

type SafeConsoleWriter = (...data: unknown[]) => void
const GUARDED_CONSOLE_LEVELS: SafeConsoleLevel[] = ['log', 'info', 'warn', 'error']

let consoleGuardInstalled = false

function resolveConsoleWriter(level: SafeConsoleLevel): SafeConsoleWriter | null {
  if (typeof console === 'undefined') {
    return null
  }

  const writer = console[level]
  return typeof writer === 'function' ? writer.bind(console) : null
}

export function safeConsole(level: SafeConsoleLevel, ...data: unknown[]): void {
  const writer = resolveConsoleWriter(level)
  if (!writer) {
    return
  }

  try {
    writer(...data)
  } catch {
    // Dev console proxies can throw while their transport is disconnected.
  }
}

export function installSafeConsoleGuard(): void {
  if (consoleGuardInstalled || typeof console === 'undefined') {
    return
  }

  consoleGuardInstalled = true
  for (const level of GUARDED_CONSOLE_LEVELS) {
    const original = console[level]
    if (typeof original !== 'function') {
      continue
    }

    console[level] = ((...data: unknown[]) => {
      try {
        original.apply(console, data)
      } catch {
        // Keep logging best-effort when a console proxy loses its connection.
      }
    }) as typeof console[typeof level]
  }
}

export const safeConsoleInfo = (...data: unknown[]): void => safeConsole('info', ...data)
export const safeConsoleWarn = (...data: unknown[]): void => safeConsole('warn', ...data)
export const safeConsoleError = (...data: unknown[]): void => safeConsole('error', ...data)
