import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCommentPrivacyCredentialProvider,
  type CommentPrivacyCredentialSuite,
  type CommentPrivacyCredentialIssuer,
  type CommentPrivacyCredentialMetadataLoader,
  type CommentPrivacyRevocationWitnessLoader,
  type CommentPrivacyCredentialVault
} from '@/privacy/commentPrivacyCredentialProvider'
import {
  createManagedCircuitNativeCredentialSuite,
  managedCircuitNativeCredentialSuiteContract
} from '@/privacy/commentPrivacyCircuitNativeSuite'
import {
  encodeCommentPrivacyRevocationWitnessMaterial,
  parseCommentPrivacyRevocationWitnessMaterial
} from '@/privacy/commentPrivacyRevocationWitness'

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
      issuerSignature: new Uint8Array([41, 42])
    })
    const credentialSuite = createCredentialSuite()
    const loadRevocationWitness: CommentPrivacyRevocationWitnessLoader = vi.fn().mockResolvedValue(new Uint8Array([71, 72, 73]))
    const provider = createCommentPrivacyCredentialProvider({
      vault,
      loadMetadata,
      issueCredential,
      loadRevocationWitness,
      credentialSuite,
      crypto: createDeterministicCrypto(),
      now: () => 1_000
    })
    const signal = new AbortController().signal

    const material = await provider.prepareCredential({ signal })

    expect(loadMetadata).toHaveBeenCalledWith({ signal })
    expect(credentialSuite.createCredentialRequest).toHaveBeenCalledWith(expect.objectContaining({
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
      credentialRequest: new Uint8Array([21, 22]),
      clientNonce: expect.any(Uint8Array)
    }), { signal })
    expect(credentialSuite.acceptIssuerResponse).toHaveBeenCalledWith(expect.objectContaining({
      issuerPublicKeyId: 'issuer-key-test',
      issuerSignature: new Uint8Array([41, 42]),
      credentialOpening: new Uint8Array([31, 32]),
      metadata,
      signal
    }))
    expect(loadRevocationWitness).toHaveBeenCalledWith(expect.objectContaining({
      credentialEpoch: metadata.credentialEpoch,
      circuitNumericId: metadata.circuitNumericId,
      publicInputLayoutVersion: metadata.publicInputLayoutVersion,
      circuitId: metadata.circuitId,
      issuerPublicKeyHash: metadata.issuerPublicKeyHash,
      revocationRoot: metadata.revocationRoot,
      revocationHandleHash: new Uint8Array([91, 92])
    }), { signal })
    expect(vault.put).toHaveBeenCalledWith(expect.objectContaining({
      credentialEpoch: metadata.credentialEpoch,
      circuitId: metadata.circuitId,
      issuerPublicKeyHash: metadata.issuerPublicKeyHash,
      issuerPublicKeyId: 'issuer-key-test',
      expiresAtUnixMs: 5_000,
      credentialSecret: new Uint8Array([1, 2, 3]),
      credentialCommitment: new Uint8Array([14, 15, 16]),
      issuerSignature: new Uint8Array([4, 5, 6]),
      revocationWitness: new Uint8Array([71, 72, 73]),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low'
    }))
    expect([...(material?.credentialSecret ?? [])]).toEqual([1, 2, 3])
    expect([...(material?.credentialCommitment ?? [])]).toEqual([14, 15, 16])
    expect([...(material?.issuerSignature ?? [])]).toEqual([4, 5, 6])
    expect([...(material?.revocationWitness ?? [])]).toEqual([71, 72, 73])
    expect(globalThis.localStorage.length).toBe(0)
    expect(globalThis.sessionStorage.length).toBe(0)
  })

  it('returns unavailable without calling the issuer when IndexedDB or crypto support is missing', async () => {
    const issueCredential: CommentPrivacyCredentialIssuer = vi.fn()
    const provider = createCommentPrivacyCredentialProvider({
      vault: null,
      loadMetadata: vi.fn(),
      issueCredential,
      credentialSuite: createCredentialSuite(),
      crypto: null
    })

    await expect(provider.prepareCredential({ signal: new AbortController().signal })).resolves.toBeNull()
    expect(issueCredential).not.toHaveBeenCalled()
  })

  it('uses the default managed circuit-native suite to call the issuer and cache prover material', async () => {
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
      issuerSignature: new Uint8Array(80).fill(17)
    }
    const issueCredential: CommentPrivacyCredentialIssuer = vi.fn().mockResolvedValue(issued)
    const loadRevocationWitness: CommentPrivacyRevocationWitnessLoader = vi.fn().mockResolvedValue(new Uint8Array([61, 62, 63]))
    const provider = createCommentPrivacyCredentialProvider({
      vault,
      loadMetadata: vi.fn().mockResolvedValue(metadata),
      issueCredential,
      loadRevocationWitness,
      crypto: createDeterministicCrypto(),
      now: () => 1_000
    })
    const signal = new AbortController().signal

    const material = await provider.prepareCredential({ signal })

    expect(issueCredential).toHaveBeenCalledTimes(1)
    const issueRequest = vi.mocked(issueCredential).mock.calls[0][0]
    expect(issueRequest.credentialRequest).toBeInstanceOf(Uint8Array)
    expect(issueRequest.credentialRequest).toHaveLength(
      managedCircuitNativeCredentialSuiteContract.credentialRequestBytes
    )
    expect(issueRequest.clientNonce).toBeInstanceOf(Uint8Array)
    expect(issueRequest.clientNonce).toHaveLength(32)
    expect(material?.issuerSignature).toEqual(issued.issuerSignature)
    expect(material?.credentialCommitment).toBeInstanceOf(Uint8Array)
    expect(material?.credentialCommitment).toHaveLength(32)
    expect(material?.credentialSecret).toBeInstanceOf(Uint8Array)
    expect(material?.credentialSecret).toHaveLength(32)
    expect(material?.revocationWitness).toEqual(new Uint8Array([61, 62, 63]))
    expect(loadRevocationWitness).toHaveBeenCalledWith(expect.objectContaining({
      credentialEpoch: metadata.credentialEpoch,
      circuitId: metadata.circuitId,
      issuerPublicKeyHash: metadata.issuerPublicKeyHash,
      revocationRoot: metadata.revocationRoot,
      revocationHandleHash: expect.any(Uint8Array)
    }), { signal })
    expect(vi.mocked(loadRevocationWitness).mock.calls[0][0].revocationHandleHash).toHaveLength(32)
    expect(vault.put).toHaveBeenCalledWith(expect.objectContaining({
      issuerPublicKeyId: 'issuer-key-test',
      issuerSignature: issued.issuerSignature,
      credentialCommitment: expect.any(Uint8Array),
      revocationWitness: new Uint8Array([61, 62, 63]),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low'
    }))
    expect(globalThis.localStorage.length).toBe(0)
    expect(globalThis.sessionStorage.length).toBe(0)
  })

  it('encodes the revocation witness as a circuit-friendly non-membership envelope', async () => {
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
      issuerSignature: new Uint8Array(80).fill(17)
    }
    const response = createRevocationWitnessResponse(metadata)
    const provider = createCommentPrivacyCredentialProvider({
      vault,
      loadMetadata: vi.fn().mockResolvedValue(metadata),
      issueCredential: vi.fn().mockResolvedValue(issued),
      loadRevocationWitness: vi.fn().mockResolvedValue(encodeCommentPrivacyRevocationWitnessMaterial(response)),
      crypto: createDeterministicCrypto(),
      now: () => 1_000
    })

    const material = await provider.prepareCredential({ signal: new AbortController().signal })
    const witness = parseCommentPrivacyRevocationWitnessMaterial(material?.revocationWitness)

    expect(witness).toEqual(expect.objectContaining({
      algorithmId: 'circuit-friendly-non-membership.v1',
      credentialEpoch: metadata.credentialEpoch,
      pathDepth: 128,
      issuerPublicKeyHash: metadata.issuerPublicKeyHash
    }))
    expect(witness?.revocationRoot).toEqual(metadata.revocationRoot)
    expect(witness?.revocationHandleHash).toEqual(response.revocationHandleHash)
    expect(witness?.leafKey).toHaveLength(16)
    expect(witness?.witnessHash).toHaveLength(32)
    expect(witness?.siblingHashes).toHaveLength(128 * 32)
  })

  it('generates a deterministic managed circuit-native credential request envelope', async () => {
    const suite = createManagedCircuitNativeCredentialSuite({
      crypto: createFixedCrypto([
        '1b6f406b17aaf92dc7deb911c7cae49756a6623b5c385b5ae6214d7e3d9597f7'
      ].map(hexToBytes))
    })

    const request = await suite.createCredentialRequest({
      credentialSecret: hexToBytes('5982967821da3c5983496214df36aa5e58de6fa25314af4cf4c00400779f08c3'),
      clientNonce: new Uint8Array(32),
      metadata: createMetadata(),
      signal: new AbortController().signal
    })

    expect(request?.credentialRequest).toBeInstanceOf(Uint8Array)
    expect(request?.credentialRequest).toHaveLength(
      managedCircuitNativeCredentialSuiteContract.credentialRequestBytes
    )
    expect(request?.credentialOpening).toHaveLength(
      managedCircuitNativeCredentialSuiteContract.credentialOpeningBytes
    )
    expect(bytesToHex(request?.credentialRequest.slice(0, 30) ?? new Uint8Array())).toBe(
      bytesToHex(new TextEncoder().encode('fsus-circuit-native-request-v2'))
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
        issuerSignature: new Uint8Array([99, 98, 97])
      })
      const provider = createCommentPrivacyCredentialProvider({
        vault: createVault(),
        loadMetadata: vi.fn().mockResolvedValue(metadata),
        issueCredential,
        credentialSuite: null,
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
    publicInputLayoutVersion: 4,
    circuitId: 'fsus.anonymous.comment.v3',
    credentialLevel: 'strong_anonymous',
    reputationBucket: 'rep:low',
    issuerPublicKeyHash: 'issuer-public-key-hash',
    revocationRoot: new Uint8Array([51, 52])
  }
}

function createRevocationWitnessResponse(metadata = createMetadata()) {
  return {
    credentialEpoch: metadata.credentialEpoch,
    algorithmId: 'circuit-friendly-non-membership.v1',
    pathDepth: 128,
    revocationRoot: metadata.revocationRoot,
    issuerPublicKeyHash: metadata.issuerPublicKeyHash,
    revocationHandleHash: new Uint8Array(32).fill(91),
    leafKey: new Uint8Array(16).fill(92),
    witnessHash: new Uint8Array(32).fill(93),
    siblingHashes: new Uint8Array(128 * 32).fill(94)
  }
}

function createCredentialSuite(): CommentPrivacyCredentialSuite {
  return {
    createCredentialRequest: vi.fn().mockResolvedValue({
      credentialRequest: new Uint8Array([21, 22]),
      credentialOpening: new Uint8Array([31, 32])
    }),
    acceptIssuerResponse: vi.fn().mockResolvedValue({
      credentialSecret: new Uint8Array([1, 2, 3]),
      credentialCommitment: new Uint8Array([14, 15, 16]),
      issuerSignature: new Uint8Array([4, 5, 6]),
      revocationWitness: new Uint8Array([7, 8, 9]),
      revocationHandleHash: new Uint8Array([91, 92]),
      credentialLevel: 'strong_anonymous',
      reputationBucket: 'rep:low'
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
