import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCommentPrivacyCredentialProvider,
  type CommentPrivacyBlindCredentialSuite,
  type CommentPrivacyCredentialIssuer,
  type CommentPrivacyCredentialMetadataLoader,
  type CommentPrivacyCredentialVault
} from '@/privacy/commentPrivacyCredentialProvider'

describe('commentPrivacyCredentialProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the mocked issuer happy path, stores the unblinded credential, and returns prover material', async () => {
    const vault = createVault()
    const metadata = createMetadata()
    const loadMetadata: CommentPrivacyCredentialMetadataLoader = vi.fn().mockResolvedValue(metadata)
    const issueCredential: CommentPrivacyCredentialIssuer = vi.fn().mockResolvedValue({
      credentialEpoch: metadata.credentialEpoch,
      rootExpiresAtUnixMs: 5_000,
      circuitNumericId: metadata.circuitNumericId,
      publicInputLayoutVersion: metadata.publicInputLayoutVersion,
      circuitId: metadata.circuitId,
      credentialLevel: 'strong_anonymous',
      issuerResponse: new Uint8Array([41, 42]),
      credentialCommitment: new Uint8Array([43, 44])
    })
    const blindCredentialSuite = createBlindCredentialSuite()
    const provider = createCommentPrivacyCredentialProvider({
      vault,
      loadMetadata,
      issueCredential,
      blindCredentialSuite,
      crypto: createDeterministicCrypto(),
      now: () => 1_000
    })
    const signal = new AbortController().signal

    const material = await provider.prepareCredential({ signal })

    expect(loadMetadata).toHaveBeenCalledWith({ signal })
    expect(blindCredentialSuite.createBlindIssuanceRequest).toHaveBeenCalledWith(expect.objectContaining({
      credentialSecret: expect.any(Uint8Array),
      clientNonce: expect.any(Uint8Array),
      metadata,
      signal
    }))
    expect(issueCredential).toHaveBeenCalledWith(expect.objectContaining({
      credentialEpoch: metadata.credentialEpoch,
      circuitNumericId: metadata.circuitNumericId,
      publicInputLayoutVersion: metadata.publicInputLayoutVersion,
      circuitId: metadata.circuitId,
      credentialLevel: 'strong_anonymous',
      blindedRequest: new Uint8Array([21, 22]),
      clientNonce: expect.any(Uint8Array)
    }), { signal })
    expect(blindCredentialSuite.unblindIssuerResponse).toHaveBeenCalledWith(expect.objectContaining({
      issuerResponse: new Uint8Array([41, 42]),
      credentialCommitment: new Uint8Array([43, 44]),
      blindOpening: new Uint8Array([31, 32]),
      metadata,
      signal
    }))
    expect(vault.put).toHaveBeenCalledWith(expect.objectContaining({
      credentialEpoch: metadata.credentialEpoch,
      circuitId: metadata.circuitId,
      issuerPublicKeyHash: metadata.issuerPublicKeyHash,
      expiresAtUnixMs: 5_000,
      credentialSecret: new Uint8Array([1, 2, 3]),
      issuerSignature: new Uint8Array([4, 5, 6]),
      revocationWitness: new Uint8Array([7, 8, 9])
    }))
    expect([...(material?.credentialSecret ?? [])]).toEqual([1, 2, 3])
    expect([...(material?.issuerSignature ?? [])]).toEqual([4, 5, 6])
    expect([...(material?.revocationWitness ?? [])]).toEqual([7, 8, 9])
    expect(globalThis.localStorage.length).toBe(0)
    expect(globalThis.sessionStorage.length).toBe(0)
  })

  it('returns unavailable without calling the issuer when IndexedDB or crypto support is missing', async () => {
    const issueCredential: CommentPrivacyCredentialIssuer = vi.fn()
    const provider = createCommentPrivacyCredentialProvider({
      vault: null,
      loadMetadata: vi.fn(),
      issueCredential,
      blindCredentialSuite: createBlindCredentialSuite(),
      crypto: null
    })

    await expect(provider.prepareCredential({ signal: new AbortController().signal })).resolves.toBeNull()
    expect(issueCredential).not.toHaveBeenCalled()
  })

  it('fails closed without leaking sensitive material when unblind support is unavailable', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const metadata = createMetadata()
      const issueCredential: CommentPrivacyCredentialIssuer = vi.fn().mockResolvedValue({
        credentialEpoch: metadata.credentialEpoch,
        rootExpiresAtUnixMs: 5_000,
        circuitNumericId: metadata.circuitNumericId,
        publicInputLayoutVersion: metadata.publicInputLayoutVersion,
        circuitId: metadata.circuitId,
        credentialLevel: 'strong_anonymous',
        issuerResponse: new Uint8Array([99, 98, 97]),
        credentialCommitment: new Uint8Array([96, 95, 94])
      })
      const provider = createCommentPrivacyCredentialProvider({
        vault: createVault(),
        loadMetadata: vi.fn().mockResolvedValue(metadata),
        issueCredential,
        blindCredentialSuite: null,
        crypto: createDeterministicCrypto()
      })

      await expect(provider.prepareCredential({ signal: new AbortController().signal })).resolves.toBeNull()

      expect(issueCredential).not.toHaveBeenCalled()
      expect(consoleLog).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleLog.mockRestore()
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    }
  })
})

function createVault(): CommentPrivacyCredentialVault {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    pruneExpired: vi.fn().mockResolvedValue(0),
    clear: vi.fn().mockResolvedValue(undefined)
  }
}

function createMetadata() {
  return {
    credentialEpoch: 20260620,
    rootExpiresAtUnixMs: 10_000,
    circuitNumericId: 7,
    publicInputLayoutVersion: 2,
    circuitId: 'fsus.anonymous.comment.v1',
    credentialLevel: 'strong_anonymous',
    issuerPublicKeyHash: 'issuer-public-key-hash'
  }
}

function createBlindCredentialSuite(): CommentPrivacyBlindCredentialSuite {
  return {
    createBlindIssuanceRequest: vi.fn().mockResolvedValue({
      blindedRequest: new Uint8Array([21, 22]),
      blindOpening: new Uint8Array([31, 32])
    }),
    unblindIssuerResponse: vi.fn().mockResolvedValue({
      credentialSecret: new Uint8Array([1, 2, 3]),
      issuerSignature: new Uint8Array([4, 5, 6]),
      revocationWitness: new Uint8Array([7, 8, 9])
    })
  }
}

function createDeterministicCrypto(): Crypto {
  return {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) {
        for (let i = 0; i < array.byteLength; i += 1) {
          array[i] = (i % 251) + 1
        }
      }
      return array
    }
  } as Crypto
}
