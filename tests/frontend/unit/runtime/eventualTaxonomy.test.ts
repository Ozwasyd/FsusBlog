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

  it('runs public route acceptance serially to avoid notification preflight rate-limit noise', () => {
    const source = readFileSync(resolve(repoRoot, 'tests/frontend/e2e/acceptance/public-routes.spec.ts'), 'utf8')

    expect(source).toContain("test.describe.configure({ mode: 'serial' })")
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
