import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/comment', () => ({
  getAnonymousCredentialRootSnapshot: vi.fn(),
  getAnonymousCredentialCircuitSnapshot: vi.fn(),
  issueAnonymousCommentTicket: vi.fn()
}))

import {
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
  issueAnonymousCommentTicket
} from '@/api/comment'
import { createCommentPrivacyAdapter } from '@/privacy/commentPrivacyAdapter'

const rootSnapshot = {
  credentialEpoch: 20260619,
  rootExpiresAtUnixMs: Date.now() + 60_000,
  circuitNumericId: 7,
  publicInputLayoutVersion: 2,
  circuitId: 'comment.v1',
  verifyingKeyHash: 'vk-hash',
  credentialRoot: new Uint8Array([1, 2]),
  revocationRoot: new Uint8Array([3, 4]),
  circuitMetadata: new Uint8Array([5, 6]),
  zkAnonymousEnabled: true,
  verifierConfigured: true
}

describe('commentPrivacyAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAnonymousCredentialRootSnapshot).mockResolvedValue(rootSnapshot as never)
    vi.mocked(getAnonymousCredentialCircuitSnapshot).mockResolvedValue({
      ...rootSnapshot,
      circuitMetadata: new Uint8Array([7, 8])
    } as never)
    vi.mocked(issueAnonymousCommentTicket).mockResolvedValue({
      credentialEpoch: 20260619,
      ticketExpiresAtUnixMs: Date.now() + 30_000,
      ticket: new Uint8Array([21, 22]),
      credentialLevel: 'strong_anonymous'
    } as never)
  })

  it('fails closed when no in-memory credential provider is available', async () => {
    const adapter = createCommentPrivacyAdapter()
    const signal = new AbortController().signal

    await expect(adapter.ensureCredentialPrepared({ signal })).resolves.toEqual({
      ok: false,
      reason: 'comment_privacy_credential_unavailable'
    })
    expect(getAnonymousCredentialRootSnapshot).not.toHaveBeenCalled()
    expect(issueAnonymousCommentTicket).not.toHaveBeenCalled()
  })

  it('loads metadata and issues ticket without browser credentials or auth headers', async () => {
    const signal = new AbortController().signal
    const adapter = createCommentPrivacyAdapter({
      credentialProvider: {
        async prepareCredential() {
          return {
            credentialSecret: new Uint8Array([9]),
            issuerSignature: new Uint8Array([10]),
            revocationWitness: new Uint8Array([11])
          }
        }
      }
    })

    const credential = await adapter.ensureCredentialPrepared({ signal })
    const metadata = await adapter.loadPrivacyMetadata({ scope: 'article:42', articleId: 42, signal })
    expect(credential.ok).toBe(true)
    expect(metadata.ok).toBe(true)
    if (!metadata.ok) {
      throw new Error('metadata unavailable')
    }

    const ticket = await adapter.issueAnonymousTicket({
      scope: 'article:42',
      metadata: metadata.metadata,
      proof: {
        proofBytes: new Uint8Array([12, 13]),
        publicInputs: new Uint8Array([14, 15]),
        nullifierHash: new Uint8Array([16, 17])
      },
      proofBytes: new Uint8Array([12, 13]),
      signal
    })

    expect(getAnonymousCredentialRootSnapshot).toHaveBeenCalledWith({ signal, credentials: 'omit' })
    expect(getAnonymousCredentialCircuitSnapshot).toHaveBeenCalledWith({ signal, credentials: 'omit' })
    expect(issueAnonymousCommentTicket).toHaveBeenCalledWith(expect.objectContaining({
      articleId: 42,
      credentialEpoch: 20260619,
      circuitNumericId: 7,
      publicInputLayoutVersion: 2,
      anonymousScope: 'article:42',
      circuitId: 'comment.v1',
      nullifierHash: new Uint8Array([16, 17]),
      zkProof: new Uint8Array([12, 13]),
      publicInputs: new Uint8Array([14, 15])
    }), { signal, credentials: 'omit' })
    expect(ticket.ok).toBe(true)
  })
})
