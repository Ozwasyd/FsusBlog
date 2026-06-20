import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCommentPrivacyCredentialProvider,
  type CommentPrivacyBlindCredentialSuite,
  type CommentPrivacyCredentialIssuer,
  type CommentPrivacyCredentialMetadataLoader,
  type CommentPrivacyCredentialVault
} from '@/privacy/commentPrivacyCredentialProvider'
import { createManagedBbsBlindCredentialSuite } from '@/privacy/commentPrivacyBbsBlindSuite'

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
      issuerPublicKeyId: 'issuer-key-test',
      bbsSignature: new Uint8Array([41, 42])
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
      issuerPublicKeyId: 'issuer-key-test',
      bbsSignature: new Uint8Array([41, 42]),
      blindOpening: new Uint8Array([31, 32]),
      metadata,
      signal
    }))
    expect(vault.put).toHaveBeenCalledWith(expect.objectContaining({
      credentialEpoch: metadata.credentialEpoch,
      circuitId: metadata.circuitId,
      issuerPublicKeyHash: metadata.issuerPublicKeyHash,
      issuerPublicKeyId: 'issuer-key-test',
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

  it('uses the default managed BBS blind suite to call the issuer and cache prover material', async () => {
    const vault = createVault()
    const metadata = createMetadata()
    const issued = {
      credentialEpoch: metadata.credentialEpoch,
      rootExpiresAtUnixMs: 5_000,
      circuitNumericId: metadata.circuitNumericId,
      publicInputLayoutVersion: metadata.publicInputLayoutVersion,
      circuitId: metadata.circuitId,
      credentialLevel: 'strong_anonymous',
      issuerPublicKeyId: 'issuer-key-test',
      bbsSignature: new Uint8Array(80).fill(17)
    }
    const issueCredential: CommentPrivacyCredentialIssuer = vi.fn().mockResolvedValue(issued)
    const provider = createCommentPrivacyCredentialProvider({
      vault,
      loadMetadata: vi.fn().mockResolvedValue(metadata),
      issueCredential,
      crypto: createDeterministicCrypto(),
      now: () => 1_000
    })
    const signal = new AbortController().signal

    const material = await provider.prepareCredential({ signal })

    expect(issueCredential).toHaveBeenCalledTimes(1)
    const issueRequest = vi.mocked(issueCredential).mock.calls[0][0]
    expect(issueRequest.blindedRequest).toBeInstanceOf(Uint8Array)
    expect(issueRequest.blindedRequest).toHaveLength(144)
    expect(issueRequest.clientNonce).toBeInstanceOf(Uint8Array)
    expect(issueRequest.clientNonce).toHaveLength(32)
    expect(material?.issuerSignature).toEqual(issued.bbsSignature)
    expect(material?.credentialSecret).toBeInstanceOf(Uint8Array)
    expect(material?.credentialSecret).toHaveLength(32)
    expect(material?.revocationWitness).toBeInstanceOf(Uint8Array)
    expect(vault.put).toHaveBeenCalledWith(expect.objectContaining({
      issuerPublicKeyId: 'issuer-key-test',
      issuerSignature: issued.bbsSignature
    }))
    expect(globalThis.localStorage.length).toBe(0)
    expect(globalThis.sessionStorage.length).toBe(0)
  })

  it('generates the same managed BBS commitment_with_proof as the backend fixture', async () => {
    const suite = createManagedBbsBlindCredentialSuite({
      crypto: createFixedCrypto([
        '1b6f406b17aaf92dc7deb911c7cae49756a6623b5c385b5ae6214d7e3d9597f7',
        '0b71f3e3fc1517bd763b180dc4f6d269da8c96fb5307653b77205c31e40c521e',
        '2b8c33fb06580d8dffdc72212967ae75838859096abeea973cc0d9e80ac1946c'
      ].map(hexToBytes))
    })

    const request = await suite.createBlindIssuanceRequest({
      credentialSecret: hexToBytes('5982967821da3c5983496214df36aa5e58de6fa25314af4cf4c00400779f08c3'),
      clientNonce: new Uint8Array(32),
      metadata: createMetadata(),
      signal: new AbortController().signal
    })

    expect(bytesToHex(request?.blindedRequest ?? new Uint8Array())).toBe(
      '841a082b7427d330bb7f75f4a8609e8366b102bd60801bee2879364cc88090c188ecbbe49100e0631d167f492e3071bd4cfa3b7a511ec5f9c4f85f8bc1da916f9a7d7792ef69a5ce8b779250eabfb73b1ec3c7a16bd4f5a71aa11ccefa4c0215c388f7ecefc60de2d420fbb7160fc5d96756d53ba7763c6ad8b286b206b1aa724d817be2dc5dcbf2add7ad145a9ac67b'
    )
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
        issuerPublicKeyId: 'issuer-key-test',
        bbsSignature: new Uint8Array([99, 98, 97])
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

function createFixedCrypto(chunks: Uint8Array[]): Crypto {
  let index = 0
  return {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) {
        const chunk = chunks[index++]
        if (!chunk || chunk.byteLength !== array.byteLength) {
          throw new Error('fixed crypto exhausted')
        }
        array.set(chunk)
      }
      return array
    }
  } as Crypto
}

function hexToBytes(hex: string): Uint8Array {
  const output = new Uint8Array(hex.length / 2)
  for (let offset = 0; offset < output.byteLength; offset += 1) {
    output[offset] = Number.parseInt(hex.slice(offset * 2, offset * 2 + 2), 16)
  }
  return output
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
