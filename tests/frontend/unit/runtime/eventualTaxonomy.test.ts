import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { findEventuallyNamedTaxonomyId } from '../../support/eventual-taxonomy.mjs'

const repoRoot = resolve(__dirname, '../../../..')

describe('runtime taxonomy visibility helper', () => {
  it('waits until a newly created taxonomy appears in the read list', async () => {
    let attempts = 0

    const id = await findEventuallyNamedTaxonomyId({
      label: '/api/Category taxonomy reread',
      name: 'Distribution Category 123',
      timeoutMs: 100,
      intervalMs: 1,
      read: async () => {
        attempts += 1
        return attempts < 3
          ? []
          : [{ id: 42, name: 'Distribution Category 123' }]
      }
    })

    expect(id).toBe(42)
    expect(attempts).toBe(3)
  })
})

describe('acceptance runtime isolation helpers', () => {
  it('uses the active Redis test container when clearing PoW risk state', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/e2e/acceptance/public-routes.spec.ts'), 'utf8')

    expect(source).toContain('FSUSBLOG_REDIS_CONTAINER')
    expect(source).not.toContain("'exec',\n      'fsusblog-redis'")
  })

  it('keeps unsuppressed public routes serial but parallelizes the fully isolated acceptance lane', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/e2e/acceptance/public-routes.spec.ts'), 'utf8')

    expect(source).toContain('process.env.FSUSBLOG_DISABLE_HUMAN_READ_PROOF === \'1\'')
    expect(source).toContain('process.env.FSUSBLOG_DISABLE_NOTIFICATION_STREAM === \'1\'')
    expect(source).toMatch(/\?\s*'parallel'\s*:\s*'serial'/)
    expect(source).toContain('test.describe.configure({ mode: publicRouteExecutionMode })')
  })

  it('does not treat recoverable notification stream preflight responses as page runtime noise', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'), 'utf8')

    expect(source).toContain("url.includes('/api/notifications/stream/preflight')")
    expect(source).toContain('status === 428 || status === 429')
  })

  it('anchors public login acceptance to the passkey recovery surface instead of legacy password fields', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/e2e/acceptance/public-routes.spec.ts'), 'utf8')
    const loginBlock = source.slice(source.indexOf("label: 'public-login'"), source.indexOf("label: 'public-register'"))

    expect(loginBlock).not.toContain("#username")
    expect(loginBlock).toContain('使用通行密钥登录')
    expect(loginBlock).toContain('Recovery Key')
  })

  it('disables human-read proof during public route acceptance to keep risk state isolated', () => {
    const source = readFileSync(resolve(repoRoot, 'tools/test/legacy-test.sh'), 'utf8')
    const marker = 'check:acceptance:public'
    const publicAcceptanceCall = source.slice(
      source.indexOf(marker) - 120,
      source.indexOf(marker) + 80
    )

    expect(publicAcceptanceCall).toContain('FSUSBLOG_DISABLE_HUMAN_READ_PROOF=1')
  })

  it('disables notification stream during public route acceptance to avoid preflight risk pollution', () => {
    const lane = readFileSync(resolve(repoRoot, 'tools/test/legacy-test.sh'), 'utf8')
    const support = readFileSync(resolve(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'), 'utf8')
    const runtime = readFileSync(resolve(repoRoot, 'src/frontend/src/components/runtime/AppRuntime.vue'), 'utf8')

    expect(lane).toContain('FSUSBLOG_DISABLE_NOTIFICATION_STREAM=1')
    expect(support).toContain('__FSUSBLOG_DISABLE_NOTIFICATION_STREAM__')
    expect(runtime).toContain('__FSUSBLOG_DISABLE_NOTIFICATION_STREAM__')
  })

  it('feeds public route acceptance an adaptive worker cap in the isolated lane', () => {
    const packageJson = readFileSync(resolve(repoRoot, 'src/frontend/package.json'), 'utf8')
    const lane = readFileSync(resolve(repoRoot, 'tools/test/legacy-test.sh'), 'utf8')
    const resolver = readFileSync(resolve(repoRoot, 'tools/test/resolve-playwright-workers.mjs'), 'utf8')

    expect(packageJson).toContain('FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS:-${FSUSBLOG_PLAYWRIGHT_WORKERS:-1}')
    expect(lane).toContain('configure_playwright_workers acceptance-public-routes FSUSBLOG_PUBLIC_ACCEPTANCE_WORKERS')
    expect(resolver).toContain("name === 'acceptance-public-routes'")
  })

  it('gives the exhaustive UX viewport lanes bounded adaptive workers with isolated sessions', () => {
    const smokeLane = readFileSync(resolve(repoRoot, 'tools/test/lanes/ux-viewport-smoke.sh'), 'utf8')
    const visualLane = readFileSync(resolve(repoRoot, 'tools/test/lanes/ux-viewport-visual.sh'), 'utf8')
    const boundariesLane = readFileSync(resolve(repoRoot, 'tools/test/lanes/ux-viewport-boundaries.sh'), 'utf8')
    const resolver = readFileSync(resolve(repoRoot, 'tools/test/resolve-playwright-workers.mjs'), 'utf8')

    for (const lane of [smokeLane, visualLane, boundariesLane]) {
      expect(lane).toContain('FSUSBLOG_TEST_SESSION_ISOLATION="${FSUSBLOG_TEST_SESSION_ISOLATION:-1}"')
      expect(lane).toContain('FSUSBLOG_PLAYWRIGHT_WORKERS="$FSUSBLOG_UX_VIEWPORT_WORKERS" prepare_session_fixtures_once')
      expect(lane).toContain('require_release_preview')
      expect(lane).toContain('PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"')
      expect(lane).not.toContain('PLAYWRIGHT_BASE_URL="$DEBUG_FRONTEND_URL"')
    }

    expect(visualLane).toContain('configure_playwright_workers ux-viewport-visual FSUSBLOG_UX_VIEWPORT_WORKERS')
    expect(boundariesLane).toContain("profile='ux-viewport-boundaries'")
    expect(boundariesLane).toContain("profile='ux-viewport-visual'")
    expect(boundariesLane).toContain('configure_playwright_workers "$profile" FSUSBLOG_UX_VIEWPORT_WORKERS')
    expect(resolver).toMatch(/if \(name === 'ux-viewport-visual'\) \{[\s\S]*?memoryPerWorkerGiB: 3\.5[\s\S]*?cpuCap: cpus >= 8 \? 3 : cpus >= 4 \? 2 : 1/)
    expect(resolver).toMatch(/if \(name === 'ux-viewport-boundaries'\) \{[\s\S]*?memoryPerWorkerGiB: 2\.5[\s\S]*?cpuCap: cpus >= 8 \? 4 : cpus >= 4 \? 2 : 1/)
    expect(resolver).toMatch(/if \(name === 'ux-viewport-smoke'\) \{[\s\S]*?memoryPerWorkerGiB: 2\.5[\s\S]*?cpuCap: cpus >= 8 \? 4 : cpus >= 4 \? 2 : 1/)
  })

  it('parallelizes viewport case groups only when per-worker session isolation is enabled', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts'), 'utf8')

    expect(source).toContain("const usesIsolatedSessions = process.env.FSUSBLOG_TEST_SESSION_ISOLATION === '1'")
    expect(source).toMatch(/const viewportExecutionMode = mode === 'smoke' \|\| usesIsolatedSessions\s*\?\s*'parallel'\s*:\s*'default'/)
    expect(source).toContain('mode: viewportExecutionMode')
  })

  it('asserts the admin article list canonical pagination query without permitting arbitrary query state', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/e2e/ux/viewport-boundaries.spec.ts'), 'utf8')

    expect(source).toContain("route.name === 'manage-list' ? { page: '1', size: '10' } : undefined")
    expect(source).toContain('testCase.route.expectedQuery')
    expect(source).toContain('searchParams.entries()')
  })

  it('clears the accessibility focus probe before checking duplicate sticky chrome', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'), 'utf8')
    const focusHelper = source.slice(
      source.indexOf('export async function assertFocusOutlineVisible'),
      source.indexOf('export async function assertNoDuplicateStickyBars')
    )

    expect(focusHelper).toContain('focusable.blur()')
    expect(focusHelper.indexOf('focusable.blur()')).toBeGreaterThan(focusHelper.indexOf('focusable.focus'))
  })

  it('excludes visually hidden skip links from mobile touch-target measurements', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/support/playwright/acceptance-shared.ts'), 'utf8')
    const touchTargetHelper = source.slice(
      source.indexOf('export async function assertTouchTargetSize'),
      source.indexOf('export async function assertNoDuplicateStickyBars')
    )

    expect(touchTargetHelper).toContain("control.classList.contains('sr-only')")
  })

  it('disables notification stream during cross-browser smoke before the first navigation', () => {
    const lane = readFileSync(resolve(repoRoot, 'tools/test/lanes/cross-browser-smoke.sh'), 'utf8')
    const smoke = readFileSync(resolve(repoRoot, 'tests/frontend/e2e/acceptance/cross-browser-smoke.spec.ts'), 'utf8')

    expect(lane).toContain('FSUSBLOG_DISABLE_NOTIFICATION_STREAM=1')
    expect(smoke).toContain('page.addInitScript')
    expect(smoke).toContain('__FSUSBLOG_DISABLE_NOTIFICATION_STREAM__')
    expect(smoke).toContain('fsusDisableNotificationStream')
    expect(smoke.indexOf('page.addInitScript')).toBeGreaterThan(-1)
    expect(smoke.indexOf('page.goto')).toBeGreaterThan(smoke.indexOf('page.addInitScript'))
  })
})
