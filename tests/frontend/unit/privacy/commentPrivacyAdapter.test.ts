import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/comment', () => ({
  getAnonymousCredentialRootSnapshot: vi.fn(),
  getAnonymousCredentialCircuitSnapshot: vi.fn(),
  getCommentPolicySnapshot: vi.fn(),
  issueAnonymousCommentTicket: vi.fn()
}))

import {
  getAnonymousCredentialCircuitSnapshot,
  getAnonymousCredentialRootSnapshot,
  getCommentPolicySnapshot,
  issueAnonymousCommentTicket
} from '@/api/comment'
import { createCommentPrivacyAdapter } from '@/privacy/commentPrivacyAdapter'
import {
  CommentPolicyContractVersion,
  CommentPolicyReadiness,
  type CommentPolicySnapshot
} from '@/contracts/commentPolicy'

const rootSnapshot = {
  credentialEpoch: 20260619,
  rootExpiresAtUnixMs: Date.now() + 60_000,
  circuitNumericId: 7,
  publicInputLayoutVersion: 6,
  circuitId: 'fsus.anonymous.comment.v5',
  verifyingKeyHash: 'a'.repeat(64),
  issuerPublicKeyHash: 'b'.repeat(64),
  credentialRoot: new Uint8Array([1, 2]),
  revocationRoot: new Uint8Array([3, 4]),
  circuitMetadata: new Uint8Array([5, 6]),
  zkAnonymousEnabled: true,
  verifierConfigured: true
}
const policySnapshot = {
  contractVersion: CommentPolicyContractVersion.Current,
  anonymousCommentsEnabled: true,
  publicCommentsEnabled: true,
  zkAnonymousEnabled: true,
  defaultAuthorMode: 'zk_anonymous',
  zkProdEnabled: true,
  zkProdNativeVerifierConfigured: true,
  zkProdTrustedSetupVerified: true,
  zkProdCredentialRequired: true,
  zkProdCredentialRootReady: true,
  commentMaxChars: 1000,
  commentMaxUtf8Bytes: 4096,
  supportedDisplayLanguages: ['zh-CN', 'en'],
  snapshotHash: '9'.repeat(64),
  zkProdUnavailableReason: '',
  zkProdReadiness: CommentPolicyReadiness.Ready
} satisfies CommentPolicySnapshot

describe('commentPrivacyAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAnonymousCredentialRootSnapshot).mockResolvedValue(rootSnapshot as never)
    vi.mocked(getAnonymousCredentialCircuitSnapshot).mockResolvedValue({
      ...rootSnapshot,
      circuitMetadata: new Uint8Array([7, 8])
    } as never)
    vi.mocked(getCommentPolicySnapshot).mockResolvedValue(policySnapshot)
    vi.mocked(issueAnonymousCommentTicket).mockResolvedValue({
      ticketExpiresAtUnixMs: Date.now() + 30_000,
      ticket: new Uint8Array([21, 22]),
      rateClass: 'common',
      requiresModeration: false
    } as never)
  })

  it('fails closed before metadata or ticket calls when the in-memory credential provider is unavailable', async () => {
    const adapter = createCommentPrivacyAdapter({
      credentialProvider: {
        async prepareCredential() {
          return null
        }
      }
    })
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
            credentialCommitment: new Uint8Array([18, 19]),
            issuerSignature: new Uint8Array([10]),
            revocationWitness: new Uint8Array([11]),
            credentialLevel: 'strong_anonymous',
            reputationBucket: 'rep:low'
          }
        }
      }
    })

    const credential = await adapter.ensureCredentialPrepared({ signal })
    const metadata = await adapter.loadPrivacyMetadata({ scope: 'comment:v1:article:42:top', articleId: 42, signal })
    expect(credential.ok).toBe(true)
    expect(metadata.ok).toBe(true)
    if (!metadata.ok) {
      throw new Error('metadata unavailable')
    }
    expect(metadata.metadata.policyHash).toBe('9'.repeat(64))

    const ticketMetadata = {
      ...metadata.metadata,
      credentialCommitment: new Uint8Array([18, 19]),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low'
    }
    const ticket = await adapter.issueAnonymousTicket({
      scope: 'comment:v1:article:42:top',
      metadata: ticketMetadata,
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
    expect(getCommentPolicySnapshot).toHaveBeenCalledWith({ signal, credentials: 'omit' })
    expect(issueAnonymousCommentTicket).toHaveBeenCalledWith(expect.objectContaining({
      articleId: 42,
      circuitNumericId: 7,
      publicInputLayoutVersion: 6,
      actionContext: 'comment.create',
      anonymousScope: 'comment:v1:article:42:top',
      circuitId: 'fsus.anonymous.comment.v5',
      verifyingKeyHash: 'a'.repeat(64),
      nullifierHash: new Uint8Array([16, 17]),
      credentialRoot: new Uint8Array([1, 2]),
      revocationRoot: new Uint8Array([3, 4]),
      isEligible: true,
      mayComment: true,
      rateClass: 'common',
      requiresModeration: false,
      zkProof: new Uint8Array([12, 13]),
      publicInputs: new Uint8Array([14, 15])
    }), { signal, credentials: 'omit' })
    expect(vi.mocked(issueAnonymousCommentTicket).mock.calls[0]?.[0]).not.toHaveProperty('credentialEpoch')
    expect(ticket.ok).toBe(true)
  })

  it('does not prepare metadata when backend policy readiness is unavailable', async () => {
    vi.mocked(getCommentPolicySnapshot).mockResolvedValue({
      ...policySnapshot,
      zkProdNativeVerifierConfigured: false,
      zkProdUnavailableReason: 'native_verifier_unavailable',
      zkProdReadiness: CommentPolicyReadiness.VerifierMissing
    })
    const adapter = createCommentPrivacyAdapter()

    await expect(adapter.loadPrivacyMetadata({
      scope: 'comment:v1:article:42:top',
      articleId: 42,
      signal: new AbortController().signal
    })).resolves.toEqual({
      ok: false,
      reason: 'comment_privacy_metadata_unavailable'
    })
    expect(issueAnonymousCommentTicket).not.toHaveBeenCalled()
  })
})
