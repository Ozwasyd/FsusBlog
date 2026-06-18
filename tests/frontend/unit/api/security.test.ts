import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import {
  createAntiCrawlerRule,
  getSecurityOverview,
  resetSecurityRisk,
  updateAntiCrawlerOptions,
  updatePowOptions
} from '@/api/security'
import { FSUS_HEADERS } from '@/api/contracts'

vi.mock('@/services/binaryTransport', () => ({
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
    expect(call?.binaryUrl).toBe('/api/binary/admin/security/overview')
    expect(call?.frameType).toBe(FrameType.SecurityOverview)
    expect(call?.requestOptions?.body).toBeUndefined()
    expect((call?.requestOptions?.headers as Headers).get(FSUS_HEADERS.deviceFingerprint)).toBe('fp-security-test')
  })

  it('updates anti-crawler options with an AEDS request frame and admin step-up proof', async () => {
    binaryMock.mockResolvedValue({ snapshotId: 'anti-1', options: { mode: 'observe' } })

    await updateAntiCrawlerOptions({ mode: 'observe', reason: 'tighten' }, { mfaProofToken: 'proof-anti' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(call?.binaryUrl).toBe('/api/binary/admin/security/anti-crawler/options')
    expect(call?.frameType).toBe(FrameType.AntiCrawlerPolicySnapshot)
    expect(call?.requestOptions?.method).toBe('PUT')
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
    expect(call?.binaryUrl).toBe('/api/binary/admin/security/risk/ip/reset')
    expect(call?.frameType).toBe(FrameType.SecurityRiskResetResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-risk')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.SecurityRiskResetRequest, {
      subject: '127.0.0.1',
      reason: 'manual'
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
    expect(ruleCall?.binaryUrl).toBe('/api/binary/admin/security/anti-crawler/rules')
    expect(ruleCall?.frameType).toBe(FrameType.AntiCrawlerRuleResponse)
    expectAedsJsonBody(ruleCall?.requestOptions?.body, FrameType.AntiCrawlerRuleRequest, {
      name: 'Block scanner'
    })

    const powCall = binaryMock.mock.calls[1]?.[0]
    expect(powCall?.binaryUrl).toBe('/api/binary/admin/security/pow/options')
    expect(powCall?.frameType).toBe(FrameType.PowPolicySnapshot)
    expect((powCall?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-pow')
    expectAedsJsonBody(powCall?.requestOptions?.body, FrameType.PowOptionsUpdateRequest, {
      mode: 'enforce',
      reason: 'pow-strict'
    })
  })

  it('does not retain the deprecated security JSON client in production source', () => {
    const source = readFileSync(resolve(process.cwd(), '../../src/frontend/src/api/security.ts'), 'utf8')
    expect(source).not.toContain('/api/admin/security')
    expect(source).not.toContain('JsonApiResponse')
    expect(source).not.toContain('response.json')
    expect(source).not.toContain('application/json')
    expect(source).not.toContain('JSON.stringify')
    expect(source).not.toContain('fetch(')
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
