import { buildFsusBinaryRoute, fsusBinaryRouteDescriptors } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/composition/binaryTransport'
import {
  createAntiCrawlerRule,
  getPerceptionSealedV2Console,
  getPerceptionSealedV2Options,
  getRiskControlOptions,
  getRiskControlConsole,
  getSecurityChallengeMetrics,
  getSecurityOverview,
  getSecurityPolicyConsole,
  rollbackPerceptionSealedV2Options,
  resetSecurityRisk,
  simulateRiskControl,
  updateAntiCrawlerOptions,
  updatePerceptionSealedV2Options,
  updatePowOptions
} from '@/api/security'
import { FSUS_HEADERS } from '@/api/contracts'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

vi.mock('@/utils/fingerprint', () => ({
  getBrowserFp: () => 'fp-security-test'
}))

const binaryMock = vi.mocked(requestBinaryOnly)
const decoder = new TextDecoder()

describe('security API binary transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads security overview through AEDS', async () => {
    binaryMock.mockResolvedValue({ status: 'ok', checkedAtUtc: '2026-06-10T00:00:00Z' })

    await getSecurityOverview()

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/security/overview')
    expect(call?.frameType).toBe(FrameType.SecurityOverview)
    expect(call?.requestOptions?.body).toBeUndefined()
    expect((call?.requestOptions?.headers as Headers).get(FSUS_HEADERS.deviceFingerprint)).toBe('fp-security-test')
  })

  it('reads RiskControl console aggregates through binary-only AEDS routes', async () => {
    binaryMock.mockResolvedValueOnce({ activePolicy: { policyVersion: 'risk-v2' } })
    binaryMock.mockResolvedValueOnce({ totalIssued: 10, successRate: 0.7, failureRate: 0.3 })
    binaryMock.mockResolvedValueOnce({ policyVersions: [{ policyId: 'security.risk-control', version: 2 }] })

    await getRiskControlConsole()
    await getSecurityChallengeMetrics()
    await getSecurityPolicyConsole()

    const riskCall = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(riskCall)).toBe('/api/binary/admin/security/risk-control/overview')
    expect(riskCall?.frameType).toBe(FrameType.SecurityOverview)
    expect(riskCall?.requestOptions?.body).toBeUndefined()

    const challengeCall = binaryMock.mock.calls[1]?.[0]
    expect(routeUrl(challengeCall)).toBe('/api/binary/admin/security/challenges/overview')
    expect(challengeCall?.frameType).toBe(FrameType.SecurityOverview)
    expect(challengeCall?.requestOptions?.body).toBeUndefined()

    const policyCall = binaryMock.mock.calls[2]?.[0]
    expect(routeUrl(policyCall)).toBe('/api/binary/admin/security/policies/overview')
    expect(policyCall?.frameType).toBe(FrameType.SecurityOverview)
    expect(policyCall?.requestOptions?.body).toBeUndefined()
  })

  it('adds challenge kind filters as query parameters without changing the frame contract', async () => {
    binaryMock.mockResolvedValue({ kind: 'perceptionLocalizationV2', totalIssued: 3 })

    await getSecurityChallengeMetrics({ kind: 'perceptionLocalizationV2' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/security/challenges/overview?kind=perceptionLocalizationV2')
    expect(call?.frameType).toBe(FrameType.SecurityOverview)
  })

  it('reads RiskControl runtime options through the security overview bridge frame', async () => {
    binaryMock.mockResolvedValueOnce({ policyVersion: 'risk-v3', globalMode: 'observe' })

    await getRiskControlOptions()

    const readCall = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(readCall)).toBe('/api/binary/admin/security/risk-control/options')
    expect(readCall?.frameType).toBe(FrameType.SecurityOverview)
    expect(readCall?.requestOptions?.body).toBeUndefined()
  })

  it('reads and updates perception-sealed@v2 admin policy through binary-only AEDS routes', async () => {
    binaryMock.mockResolvedValueOnce({ policy: { options: { enabled: true } }, metrics: { totalIssued: 2 } })
    binaryMock.mockResolvedValueOnce({ snapshotId: 'perception-1', options: { enabled: true } })
    binaryMock.mockResolvedValueOnce({ snapshotId: 'perception-2', options: { enabled: false } })
    binaryMock.mockResolvedValueOnce({ snapshotId: 'perception-1', options: { enabled: true } })

    await getPerceptionSealedV2Console()
    await getPerceptionSealedV2Options()
    await updatePerceptionSealedV2Options({
      enabled: false,
      localizationEnabled: true,
      microInteractionEnabled: false,
      poSpaceFallbackEnabled: true,
      earlyRejectThreshold: 90,
      maxAttempts: 4,
      minSolveDurationMs: 800,
      maxSolveDurationMs: 60000,
      reason: 'rollout'
    }, { mfaProofToken: 'proof-perception' })
    await rollbackPerceptionSealedV2Options({ mfaProofToken: 'proof-perception-rollback' })

    const consoleCall = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(consoleCall)).toBe('/api/binary/admin/security/perception-v2/overview')
    expect(consoleCall?.frameType).toBe(FrameType.SecurityOverview)
    expect(consoleCall?.requestOptions?.body).toBeUndefined()

    const readCall = binaryMock.mock.calls[1]?.[0]
    expect(routeUrl(readCall)).toBe('/api/binary/admin/security/perception-v2/options')
    expect(readCall?.frameType).toBe(FrameType.SecurityOverview)

    const updateCall = binaryMock.mock.calls[2]?.[0]
    expect(routeUrl(updateCall)).toBe('/api/binary/admin/security/perception-v2/options')
    expect(updateCall?.frameType).toBe(FrameType.SecurityOverview)
    expect(fsusBinaryRouteDescriptors[updateCall.binaryRoute.operationId].method).toBe('PUT')
    expect((updateCall?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-perception')
    expectAedsJsonBody(updateCall?.requestOptions?.body, FrameType.SecurityOverview, {
      enabled: false,
      earlyRejectThreshold: 90,
      reason: 'rollout'
    })

    const rollbackCall = binaryMock.mock.calls[3]?.[0]
    expect(routeUrl(rollbackCall)).toBe('/api/binary/admin/security/perception-v2/options/rollback')
    expect(rollbackCall?.frameType).toBe(FrameType.SecurityOverview)
    expect(fsusBinaryRouteDescriptors[rollbackCall.binaryRoute.operationId].method).toBe('POST')
    expect((rollbackCall?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-perception-rollback')
  })

  it('updates anti-crawler options with an AEDS request frame and admin step-up proof', async () => {
    binaryMock.mockResolvedValue({ snapshotId: 'anti-1', options: { mode: 'observe' } })

    await updateAntiCrawlerOptions({ mode: 'observe', reason: 'tighten' }, { mfaProofToken: 'proof-anti' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/security/anti-crawler/options')
    expect(call?.frameType).toBe(FrameType.AntiCrawlerPolicySnapshot)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('PUT')
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-anti')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.AntiCrawlerOptionsUpdateRequest, {
      mode: 'observe',
      reason: 'tighten'
    })
  })

  it('resets risk scores with the security risk reset frame', async () => {
    binaryMock.mockResolvedValue({ subject: '127.0.0.1', reset: true, resetAtUtc: '2026-06-10T00:00:00Z' })

    await resetSecurityRisk({ subject: '127.0.0.1', reason: 'manual' }, { mfaProofToken: 'proof-risk' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/security/risk/ip/reset')
    expect(call?.frameType).toBe(FrameType.SecurityRiskResetResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-risk')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.SecurityRiskResetRequest, {
      subject: '127.0.0.1',
      reason: 'manual'
    })
  })

  it('simulates RiskControl decisions through the admin binary bridge without MFA mutation proof', async () => {
    binaryMock.mockResolvedValue({
      riskScore: 50,
      decision: 'challenge',
      reasons: ['challenge'],
      requiredChallenges: ['perceptionLocalizationV2'],
      policyVersion: 'risk-v2'
    })

    await simulateRiskControl({
      action: 'comment.create',
      routeKey: 'comment.create',
      subject: 'ip:203.0.113.10',
      riskScore: 50,
      clientIp: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
      deviceFingerprint: 'device-123456',
      region: 'CN',
      actorStatus: 'anonymous',
      identityKind: 'anonymous'
    })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/security/risk-control/simulate')
    expect(call?.frameType).toBe(FrameType.SecurityOverview)
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].method).toBe('POST')
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBeNull()
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.SecurityOverview, {
      action: 'comment.create',
      routeKey: 'comment.create',
      riskScore: 50
    })
  })

  it('uses rule and PoW request frames for security mutations', async () => {
    binaryMock.mockResolvedValueOnce({ id: 'rule-1' })
    binaryMock.mockResolvedValueOnce({ snapshotId: 'pow-1' })

    await createAntiCrawlerRule({
      name: 'Block scanner',
      enabled: true,
      matchType: 'path',
      pattern: '/scan',
      action: 'block',
      score: 30,
      notes: 'scanner'
    }, { mfaProofToken: 'proof-rule' })
    await updatePowOptions({ mode: 'enforce', reason: 'pow-strict' }, { mfaProofToken: 'proof-pow' })

    const ruleCall = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(ruleCall)).toBe('/api/binary/admin/security/anti-crawler/rules')
    expect(ruleCall?.frameType).toBe(FrameType.AntiCrawlerRuleResponse)
    expectAedsJsonBody(ruleCall?.requestOptions?.body, FrameType.AntiCrawlerRuleRequest, {
      name: 'Block scanner'
    })

    const powCall = binaryMock.mock.calls[1]?.[0]
    expect(routeUrl(powCall)).toBe('/api/binary/admin/security/pow/options')
    expect(powCall?.frameType).toBe(FrameType.PowPolicySnapshot)
    expect((powCall?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-pow')
    expectAedsJsonBody(powCall?.requestOptions?.body, FrameType.PowOptionsUpdateRequest, {
      mode: 'enforce',
      reason: 'pow-strict'
    })
  })

})

function expectAedsJsonBody(body: BodyInit | null | undefined, frameType: FrameType, expected: Record<string, unknown>): void {
  expect(body).toBeInstanceOf(ArrayBuffer)
  const bytes = new Uint8Array(body as ArrayBuffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint16(8, true)).toBe(frameType)
  const payloadLength = view.getUint32(10, true)
  const payload = JSON.parse(decoder.decode(bytes.slice(16, 16 + payloadLength)))
  expect(payload).toMatchObject(expected)
}

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
