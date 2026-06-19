import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'
import { encodeAedsFrame } from '../../support/aeds-envelope.mjs'

const encoder = new TextEncoder()
const protocol = JSON.parse(readFileSync(resolve(process.cwd(), '../../src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'))
const frameTypes = new Map(protocol.frameTypes.map((frame: { name: string; value: number }) => [frame.name, frame.value]))

function frameType(name: string): number {
  const value = frameTypes.get(name)
  if (!Number.isInteger(value)) {
    throw new Error(`frame_type_missing:${name}`)
  }
  return value
}

function encodeJsonFrame(name: string, payload: unknown): Buffer {
  return Buffer.from(new Uint8Array(encodeAedsFrame(frameType(name), encoder.encode(JSON.stringify(payload)))))
}

async function fulfillJsonFrame(route: Route, name: string, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/octet-stream',
    body: encodeJsonFrame(name, payload)
  })
}

async function openModuleHarness(page: Page): Promise<void> {
  await page.route('**/__risk-control-e2e', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>RiskControl E2E</title></head><body><main id="harness">ready</main></body></html>'
    })
  })
  await page.goto('/__risk-control-e2e', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#harness')).toHaveText('ready')
}

test.describe('RiskControl security console contract', () => {
  test('normal read uses binary AEDS data for active policy, event aggregate and challenge rates', async ({ page }) => {
    const publicJsonRequests: string[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.startsWith('/api/admin/security')) {
        publicJsonRequests.push(pathname)
      }
    })
    await openModuleHarness(page)
    await page.route('**/api/binary/admin/security/risk-control/overview', async (route) => {
      await fulfillJsonFrame(route, 'SecurityOverview', riskControlPayload())
    })

    const result = await page.evaluate(async () => {
      const api = await import('/src/api/security.ts')
      return await api.getRiskControlConsole()
    })

    expect(result.activePolicy.policyVersion).toBe('risk-v2')
    expect(result.riskEventAggregate[0]).toMatchObject({ source: 'anti-crawler', reason: 'FakeCrawler', count: 4 })
    expect(result.challengeMetrics.successRate).toBe(0.7)
    expect(result.challengeMetrics.failureRate).toBe(0.3)
    expect(publicJsonRequests).toEqual([])
  })

  test('insufficient permission is represented by system.config route metadata', async ({ page }) => {
    await openModuleHarness(page)

    const routeMeta = await page.evaluate(async () => {
      const router = await import('/src/router/index.ts')
      const records = router.APP_ROUTE_RECORDS
      const stack = [...records]
      while (stack.length > 0) {
        const current = stack.shift()
        if (!current) continue
        if (current.name === 'ManageSecurityRiskControl') {
          return {
            path: current.path,
            permissions: current.meta?.permissions ?? []
          }
        }
        if (Array.isArray(current.children)) {
          stack.push(...current.children)
        }
      }
      return null
    })

    expect(routeMeta).toEqual({
      path: 'risk-control',
      permissions: ['system.config']
    })
  })

  test('policy writes without admin-sensitive proof are rejected by binary endpoint', async ({ page }) => {
    await openModuleHarness(page)
    let sawPutWithoutProof = false
    await page.route('**/api/binary/admin/security/pow/options', async (route, request) => {
      if (request.method() === 'PUT') {
        sawPutWithoutProof = !request.headers()['x-fsus-mfa-proof']
        await route.fulfill({
          status: 428,
          contentType: 'application/octet-stream',
          body: Buffer.alloc(0)
        })
        return
      }

      await route.abort()
    })

    const result = await page.evaluate(async () => {
      const api = await import('/src/api/security.ts')
      try {
        await api.updatePowOptions({ mode: 'enforce', reason: 'proof-missing-e2e' })
        return { ok: true, message: '' }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : ''
        }
      }
    })

    expect(result.ok).toBe(false)
    expect(sawPutWithoutProof).toBe(true)
  })
})

function riskControlPayload() {
  return {
    activePolicy: {
      snapshotId: 'risk-snapshot-1',
      policyVersion: 'risk-v2',
      updatedAtUtc: '2026-06-19T08:00:00Z',
      globalMode: 'enforce',
      maxRiskScore: 200,
      strictRiskMultiplierPercent: 150,
      lastKnownGoodSnapshotId: 'risk-snapshot-0',
      defaultAction: {
        actionName: '*',
        thresholds: {
          allowScore: 0,
          challengeScore: 50,
          hardChallengeScore: 70,
          queueScore: 85,
          blockScore: 100
        },
        challengeKind: 'captchaV1',
        escalationLevel: 1,
        modeOverride: null,
        anonymousWriteAllowed: false,
        hardChallengeKinds: ['argon2idPoSpaceV1'],
        hardChallengeEscalationLevel: 2
      },
      actionOverrides: {
        'public.read': {
          actionName: 'public.read',
          thresholds: {
            allowScore: 0,
            challengeScore: 40,
            hardChallengeScore: 60,
            queueScore: 80,
            blockScore: 100
          },
          challengeKind: 'captchaV1',
          escalationLevel: 1,
          modeOverride: null,
          anonymousWriteAllowed: true,
          hardChallengeKinds: ['argon2idPoSpaceV1'],
          hardChallengeEscalationLevel: 2
        }
      },
      subsystemModes: {
        antiCrawler: 'enforce',
        pow: 'observe'
      }
    },
    risk: {
      eventsLastHour: 3,
      eventsLastDay: 9,
      snapshotCount: 2,
      highRiskSnapshotCount: 1,
      topReason: 'FakeCrawler',
      topSource: 'anti-crawler'
    },
    riskEventAggregate: [
      {
        source: 'anti-crawler',
        reason: 'FakeCrawler',
        count: 4,
        scoreDeltaSum: 120,
        maxTotalScore: 140,
        lastOccurredAtUtc: '2026-06-19T08:05:00Z'
      }
    ],
    challengeMetrics: {
      kind: null,
      windowStartedAtUtc: '2026-06-18T08:00:00Z',
      totalIssued: 10,
      totalAttempts: 10,
      verified: 7,
      failed: 2,
      replayed: 1,
      expired: 0,
      revoked: 0,
      successRate: 0.7,
      failureRate: 0.3,
      kindBreakdown: [],
      recentAttempts: []
    },
    recentEvents: [],
    topRiskSnapshots: [
      {
        subject: 'ip:test',
        score: 140,
        lastReason: 'FakeCrawler',
        lastSource: 'anti-crawler',
        updatedAtUtc: '2026-06-19T08:05:00Z',
        expiresAtUtc: '2026-06-19T09:05:00Z'
      }
    ]
  }
}
