import { safeConsoleError, safeConsoleInfo, safeConsoleWarn } from '@/services/safeConsole'

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

type AuditConsoleWriter = (...data: unknown[]) => void

function resolveConsole(level: FrontendAuditLevel | undefined, type: FrontendAuditType): AuditConsoleWriter {
  if (level === 'error' || type === 'exception') {
    return safeConsoleError
  }

  if (level === 'warn' || type === 'security') {
    return safeConsoleWarn
  }

  return safeConsoleInfo
}

export function emitFrontendAudit(record: FrontendAuditRecord): void {
  const write = resolveConsole(record.level, record.type)
  write(
    `[${record.source}] [${record.type}] [${record.occurredAtUtc}] ${record.eventInfo}`,
    record.context ?? {}
  )
}
