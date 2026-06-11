import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('notification stream recovery workflow', () => {
  it('uses safe console output and schedules retry after recovery failures', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../src/frontend/src/composables/useNotification.ts', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('safeConsoleError')
    expect(source).toContain('safeConsoleWarn')
    expect(source).toContain('NOTIFICATION_RECOVERY_RETRY_MS')
    expect(source).toContain('scheduleReauthRetry(failureCode)')
    expect(source).not.toContain('console.error')
    expect(source).not.toContain('console.warn')
  })

  it('keeps runtime notification initialization errors on safe console output', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../src/frontend/src/components/runtime/AppRuntime.vue', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('safeConsoleWarn(errorLabel, error)')
    expect(source).not.toContain('console.warn(errorLabel, error)')
  })

  it('installs the safe console guard during frontend bootstrap', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../src/frontend/src/bootstrap/entry.ts', import.meta.url)),
      'utf8'
    )

    expect(source).toContain("import { installSafeConsoleGuard } from '@/services/safeConsole'")
    expect(source).toContain('installSafeConsoleGuard()')
  })
})
