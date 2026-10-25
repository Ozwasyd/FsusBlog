import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'
import { encodeAedsFrame } from '../../support/aeds-envelope.mjs'

const encoder = new TextEncoder()
const protocol = JSON.parse(readFileSync(resolve(process.cwd(), '../../src/shared/Contracts/Validation/aeds-protocol.json'), 'utf8'))
const frameTypes = new Map(protocol.frameTypes.map((frame: { name: string; value: number }) => [frame.name, frame.value]))

function frameType(name: string): number {
  const value = frameTypes.get(name)
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`frame_type_missing:${name}`)
  }
  return value
}

function encodeJsonFrame(name: string, payload: unknown): Buffer {
  return Buffer.from(new Uint8Array(encodeAedsFrame(frameType(name), encoder.encode(JSON.stringify(payload)))))
}

function decodeJsonFramePayload(body: Buffer): { frameType: number; payload: Record<string, unknown> } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const payloadLength = view.getUint32(10, true)
  return {
    frameType: view.getUint16(8, true),
    payload: JSON.parse(new TextDecoder().decode(body.subarray(16, 16 + payloadLength)))
  }
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
            permissions: current.meta?.requiredAdminPermissions ?? []
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

  test('simulator dry-run covers allow, challenge, queue and block decisions through the binary bridge', async ({ page }) => {
    const publicJsonRequests: string[] = []
    const simulatedDecisions: string[] = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.startsWith('/api/admin/security')) {
        publicJsonRequests.push(pathname)
      }
    })
    await openModuleHarness(page)
    await page.route('**/api/binary/admin/security/risk-control/simulate', async (route, request) => {
      expect(request.method()).toBe('POST')
      expect(request.headers()['x-fsus-mfa-proof']).toBeUndefined()
      const body = request.postDataBuffer()
      expect(body).not.toBeNull()
      const decoded = decodeJsonFramePayload(body!)
      expect(decoded.frameType).toBe(frameType('SecurityOverview'))
      const riskScore = Number(decoded.payload.riskScore ?? 0)
      const decision = riskScore >= 120
        ? 'block'
        : riskScore >= 90
          ? 'queue_for_moderation'
          : riskScore >= 50
            ? 'challenge'
            : 'allow'
      simulatedDecisions.push(decision)
      await fulfillJsonFrame(route, 'SecurityOverview', {
        riskScore,
        effectiveRiskScore: riskScore,
        decision,
        decisionKind: decision,
        reasons: [decision],
        requiredChallenges: decision === 'challenge' ? ['perceptionCharacterV3'] : [],
        policyVersion: 'risk-v2',
        action: decoded.payload.action,
        routeKey: decoded.payload.routeKey,
        subject: decoded.payload.subject,
        clientIp: decoded.payload.clientIp,
        actorStatus: decoded.payload.actorStatus,
        identityKind: decoded.payload.identityKind,
        escalationLevel: decision === 'challenge' ? 1 : 0,
        simulated: true
      })
    })

    const decisions = await page.evaluate(async () => {
      const api = await import('/src/api/security.ts')
      const scores = [10, 50, 90, 125]
      const results = []
      for (const riskScore of scores) {
        const response = await api.simulateRiskControl({
          action: 'comment.create',
          routeKey: 'comment.create',
          subject: `ip:203.0.113.${riskScore}`,
          riskScore,
          clientIp: `203.0.113.${riskScore}`,
          userAgent: 'Mozilla/5.0',
          deviceFingerprint: 'device-123456',
          region: 'CN',
          actorStatus: 'anonymous',
          identityKind: 'anonymous'
        })
        results.push(response.decision)
      }
      return results
    })

    expect(decisions).toEqual(['allow', 'challenge', 'queue_for_moderation', 'block'])
    expect(simulatedDecisions).toEqual(decisions)
    expect(publicJsonRequests).toEqual([])
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
        challengeKind: 'perceptionCharacterV3',
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
          challengeKind: 'perceptionCharacterV3',
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
