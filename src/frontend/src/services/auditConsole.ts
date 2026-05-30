type FrontendAuditLevel = 'info' | 'warn' | 'error'
export type FrontendAuditType =
  | 'audit'
  | 'business'
  | 'security'
  | 'infra'
  | 'exception'
  | 'lifecycle'
  | 'access'
  | 'performance'

export type FrontendAuditRecord = {
  source: string
  type: FrontendAuditType
  occurredAtUtc: string
  eventInfo: string
  context?: Record<string, unknown>
  level?: FrontendAuditLevel
}

function resolveConsole(level: FrontendAuditLevel | undefined, type: FrontendAuditType): typeof console.info {
  if (level === 'error' || type === 'exception') {
    return console.error
  }

  if (level === 'warn' || type === 'security') {
    return console.warn
  }

  return console.info
}

export function emitFrontendAudit(record: FrontendAuditRecord): void {
  const write = resolveConsole(record.level, record.type)
  write(
    `[${record.source}] [${record.type}] [${record.occurredAtUtc}] ${record.eventInfo}`,
    record.context ?? {}
  )
}
