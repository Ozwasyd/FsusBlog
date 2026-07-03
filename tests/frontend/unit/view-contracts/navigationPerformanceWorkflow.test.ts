import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('navigation performance workflow contract', () => {
  const router = readRepoFile('src/frontend/src/router/index.ts')
  const userStore = readRepoFile('src/frontend/src/store/user.ts')

  it('delays nprogress until navigation is slow and skips public AOT hydration', () => {
    expect(router).toContain('const PROGRESS_DELAY_MS = 120')
    expect(router).toContain('window.setTimeout(() => {')
    expect(router).toContain('progressRequestId')
    expect(router).toContain('function finishProgressNavigation()')
    expect(router).toContain('if (!options.ssr && !shouldDeferPublicBootstrap && !isSameAccountShellChildSwitch(to, from)) {')
    expect(router).toContain('scheduleProgressForSlowNavigation()')
    expect(router).not.toContain('void loadProgressBar().then((progress) => {\n        progress.start()')
  })

  it('uses route-scoped account and admin session probes', () => {
    expect(router).toContain("sessionBootstrap.ensurePublicShell()")
    expect(router).toContain("sessionBootstrap.ensureAccountSession({ reason: 'route' })")
    expect(router).toContain("sessionBootstrap.ensureAdminSession({ reason: 'route' })")
    expect(router).toContain('isPublicShellRouteName(to.name)')
    expect(router).not.toContain('await userStore.fetchUserInfo(true)')
    expect(router).not.toContain('ensureUserInfoFresh({ maxAgeMs: 30_000, forceWhenUnknown: true })')
    expect(userStore).toContain('const lastVerifiedAt = ref(0)')
    expect(userStore).toContain('const ensureUserInfoFresh = async')
    expect(userStore).toContain('Date.now() - lastVerifiedAt.value <= maxAgeMs')
  })
})
