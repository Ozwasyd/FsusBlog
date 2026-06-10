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
    expect(router).toContain('if (!options.ssr && !shouldDeferPublicBootstrap) {')
    expect(router).toContain('scheduleProgressForSlowNavigation()')
    expect(router).not.toContain('void loadProgressBar().then((progress) => {\n        progress.start()')
  })

  it('uses freshness-aware user info for admin and role guards', () => {
    expect(router).toContain('ensureUserInfoFresh({ maxAgeMs: 30_000, forceWhenUnknown: true })')
    expect(router).not.toContain('await userStore.fetchUserInfo(true)')
    expect(userStore).toContain('const lastFetchedAt = ref(0)')
    expect(userStore).toContain('const ensureUserInfoFresh = async')
    expect(userStore).toContain('Date.now() - lastFetchedAt.value <= maxAgeMs')
  })
})
