import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/composition/binaryTransport'
import {
  blockAnonymousGovernanceNullifier,
  getAnonymousGovernanceStatus,
  listAnonymousGovernanceNullifiers,
  revokeAnonymousGovernanceCredential
} from '@/api/anonymousGovernance'
import { FSUS_HEADERS } from '@/api/contracts'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

vi.mock('@/utils/fingerprint', () => ({
  getBrowserFp: () => 'fp-governance'
}))

const binaryMock = vi.mocked(requestBinaryOnly)
const decoder = new TextDecoder()

describe('anonymous governance admin API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads governance status through the admin binary endpoint with step-up proof', async () => {
    binaryMock.mockResolvedValue({
      root: { available: true, credentialEpoch: 2048 },
      verifier: { configured: true },
      revocation: { status: 'ready' },
      commentStats: { totalAnonymous: 3 }
    })

    await getAnonymousGovernanceStatus({ mfaProofToken: 'proof-status' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/anonymous-governance/status')
    expect(call?.frameType).toBe(FrameType.AnonymousGovernanceActionResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-status')
    expect((call?.requestOptions?.headers as Headers).get(FSUS_HEADERS.deviceFingerprint)).toBe('fp-governance')
    expect(call?.requestOptions?.body).toBeUndefined()
  })

  it('loads masked nullifier governance rows from the admin endpoint', async () => {
    binaryMock.mockResolvedValue({
      items: [{
        scope: 'article:42',
        maskedHash: '01234567...89abcdef',
        nullifierHash: '0123456789abcdef0123456789abcdef',
        status: 'active'
      }]
    })

    await listAnonymousGovernanceNullifiers({ mfaProofToken: 'proof-nullifiers' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/anonymous-governance/nullifiers')
    expect(call?.frameType).toBe(FrameType.AnonymousGovernanceActionResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-nullifiers')
  })

  it('blocks a nullifier with an AEDS governance action request frame', async () => {
    binaryMock.mockResolvedValue({ applied: true })

    await blockAnonymousGovernanceNullifier({
      nullifierHash: '0123456789abcdef',
      scope: 'article:42',
      reason: 'spam wave'
    }, { mfaProofToken: 'proof-block' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/anonymous-governance/nullifiers/block')
    expect(call?.frameType).toBe(FrameType.AnonymousGovernanceActionResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-block')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.AnonymousGovernanceActionRequest, {
      nullifierHash: '0123456789abcdef',
      scope: 'article:42',
      reason: 'spam wave'
    })
  })

  it('revokes credential eligibility by epoch and root without a user identifier', async () => {
    binaryMock.mockResolvedValue({ applied: true })

    await revokeAnonymousGovernanceCredential({
      epoch: 2048,
      rootHash: 'root-v1',
      revocationHandleHash: 'handle-v1',
      revocationRootHash: 'revocation-root-v2',
      reason: 'credential abuse'
    }, { mfaProofToken: 'proof-revoke' })

    const call = binaryMock.mock.calls[0]?.[0]
    expect(routeUrl(call)).toBe('/api/binary/admin/anonymous-governance/credentials/revoke')
    expect(call?.frameType).toBe(FrameType.AnonymousGovernanceActionResponse)
    expect((call?.requestOptions?.headers as Headers).get('X-Fsus-Mfa-Proof')).toBe('proof-revoke')
    expectAedsJsonBody(call?.requestOptions?.body, FrameType.AnonymousGovernanceActionRequest, {
      epoch: 2048,
      rootHash: 'root-v1',
      revocationHandleHash: 'handle-v1',
      revocationRootHash: 'revocation-root-v2',
      reason: 'credential abuse'
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
  expect(payload).not.toHaveProperty('userId')
  expect(payload).not.toHaveProperty('credentialCommitment')
  expect(payload).not.toHaveProperty('proof')
}

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
