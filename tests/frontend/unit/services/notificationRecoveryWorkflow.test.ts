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

  it('keeps public runtime bootstrap aligned with hydrated account state', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../src/frontend/src/components/runtime/AppRuntime.vue', import.meta.url)),
      'utf8'
    )

    expect(source).toContain('const publicRoute = isPublicRouteNow()')
    expect(source).toContain('if (publicRoute) {')
    expect(source).toContain('await ensurePublicShell()')
    expect(source).toContain('if (isLocalFixtureSessionActive())')
    expect(source).toContain("await ensureAccountSession({ reason: 'runtime' })")
    expect(source).toContain("await ensureAdminSession({ reason: 'runtime' })")
    expect(source).toContain('setPublicShellRuntimeAuthState(resolvePublicShellRuntimeAuthState(')
    expect(source).toContain('resetPublicShellRuntimeAuthState()')
    expect(source).toContain("requestNotificationInit(userStore.isLoggedIn, '[AppRuntime] 公共访客连接建立受限')")
    expect(source).toContain("const userTask = ensureAccountSession({ reason: 'runtime' })")
    const publicRouteIndex = source.indexOf('if (publicRoute) {')
    const publicFixtureIndex = source.indexOf('if (isLocalFixtureSessionActive())')
    const publicAccountIndex = source.indexOf("await ensureAccountSession({ reason: 'runtime' })")
    const nonPublicAccountIndex = source.indexOf("const userTask = ensureAccountSession({ reason: 'runtime' })")
    expect(publicRouteIndex).toBeLessThan(publicFixtureIndex)
    expect(publicFixtureIndex).toBeLessThan(publicAccountIndex)
    expect(publicAccountIndex).toBeLessThan(nonPublicAccountIndex)
    expect(source).not.toContain("await ensureAccountSession({ reason: 'runtime', forceWhenUnknown: true })")
    expect(source).not.toContain('ensureUserInfo')
  })

  it('mounts the full runtime for public and non-public route branches', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../src/frontend/src/App.vue', import.meta.url)),
      'utf8'
    )

    const runtimeMount = '<FullAppRuntime v-if="runtimeReady" />'
    const runtimeMountIndex = source.indexOf(runtimeMount)
    const publicRouteIndex = source.indexOf('<router-view v-if="isPublicShellRoute"')
    const nonPublicRouteIndex = source.indexOf('<div v-else class="app-wrapper')
    const providerCloseIndex = source.indexOf('</el-config-provider>')

    expect((source.match(new RegExp(runtimeMount, 'g')) ?? []).length).toBe(1)
    expect(publicRouteIndex).toBeGreaterThan(-1)
    expect(nonPublicRouteIndex).toBeGreaterThan(publicRouteIndex)
    expect(runtimeMountIndex).toBeGreaterThan(nonPublicRouteIndex)
    expect(runtimeMountIndex).toBeLessThan(providerCloseIndex)
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
