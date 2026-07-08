import { describe, expect, it, vi } from 'vitest'
import {
  createCommentPrivacyWasmProver,
  type CommentPrivacyProverManifest
} from '@/privacy/commentPrivacyWasmProver'
import { encodeCommentPrivacyRevocationWitnessMaterial } from '@/privacy/commentPrivacyRevocationWitness'

const manifest: CommentPrivacyProverManifest = {
  moduleUrl: '/wasm/comment-privacy-prover.js',
  wasmUrl: '/wasm/comment-privacy-prover.wasm',
  provingKeyUrl: '/wasm/comment-privacy-prover.zkey',
  integrity: 'sha256-VudRNfCt5IqiLg8Sobjb2s8erK3IL1r3wbRnV9xN1pc=',
  circuitId: 'fsus.anonymous.comment.v2',
  publicInputLayoutVersion: 3,
  wasmSha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
  provingKeySha256: '787c798e39a5bc1910355bae6d0cd87a36b2e10fd0202a83e3bb6b005da83472'
}

const verifyingKeyHash = 'a'.repeat(64)
const issuerPublicKeyHash = 'b'.repeat(64)
const policyHash = '9'.repeat(64)

const proofRequest = {
  scope: 'article:42',
  rootVersion: `20260618:${verifyingKeyHash}`,
  metadataBytes: new Uint8Array([1, 2, 3]),
  credentialEpoch: 20260618,
  circuitNumericId: 7,
  publicInputLayoutVersion: 3,
  circuitId: 'fsus.anonymous.comment.v2',
  verifyingKeyHash,
  issuerPublicKeyHash,
  policyHash,
  credentialCommitment: new Uint8Array(32).fill(0x55),
  credentialRoot: new Uint8Array([4, 5]),
  revocationRoot: new Uint8Array([6, 7]),
  circuitMetadata: new Uint8Array([8, 9]),
  credentialLevel: 'strong_anonymous',
  reputationBucket: 'rep:low',
  credentialSecret: new Uint8Array([10, 11]),
  issuerSignature: new Uint8Array([12, 13]),
  revocationWitness: encodeCommentPrivacyRevocationWitnessMaterial({
    credentialEpoch: 20260618,
    algorithmId: 'circuit-friendly-non-membership.v1',
    pathDepth: 128,
    revocationRoot: new Uint8Array([6, 7]),
    issuerPublicKeyHash,
    revocationHandleHash: new Uint8Array(32).fill(0x31),
    leafKey: new Uint8Array(16).fill(0x32),
    witnessHash: new Uint8Array(32).fill(0x33),
    siblingHashes: new Uint8Array(128 * 32).fill(0x34)
  })
}

const expectedNullifierHash = new Uint8Array(32).fill(0x41)
const expectedPublicInputs = encodeExpectedPublicInputs(proofRequest, expectedNullifierHash)

describe('commentPrivacyWasmProver', () => {
  it('fails closed when the browser prover artifact manifest is unavailable', async () => {
    const loadManifest = vi.fn().mockResolvedValue(null)
    const loadModule = vi.fn()
    const prover = createCommentPrivacyWasmProver({ loadManifest, loadModule })

    await expect(prover.prewarm()).rejects.toThrow('comment_privacy_prover_artifact_unavailable')
    await expect(prover.prepareProof(proofRequest)).rejects.toThrow('comment_privacy_prover_artifact_unavailable')
    expect(loadModule).not.toHaveBeenCalled()
  })

  it('fails closed before importing when a wasm artifact SHA does not match the manifest', async () => {
    const fetchArtifact = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('.js')) {
        return new Response(new Uint8Array([17, 18, 19]))
      }
      if (url.endsWith('.wasm')) {
        return new Response(new Uint8Array([99, 100, 101]))
      }
      if (url.endsWith('.zkey')) {
        return new Response(new Uint8Array([4, 5, 6]))
      }
      return new Response(null, { status: 404 })
    })
    vi.stubGlobal('fetch', fetchArtifact)
    const loadModule = vi.fn()
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue({
        ...manifest,
        wasmSha256: '0000000000000000000000000000000000000000000000000000000000000000'
      }),
      loadModule
    })

    try {
      await expect(prover.prewarm()).rejects.toThrow('comment_privacy_prover_artifact_invalid')
      expect(loadModule).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fails closed before importing when the module integrity does not match the manifest', async () => {
    const loadModule = vi.fn()
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue({
        ...manifest,
        integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
      }),
      loadArtifact: createArtifactLoader(),
      loadModule
    })

    await expect(prover.prewarm()).rejects.toThrow('comment_privacy_prover_artifact_invalid')
    expect(loadModule).not.toHaveBeenCalled()
  })

  it('fails closed before importing when a prover artifact is missing', async () => {
    const loadModule = vi.fn()
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadArtifact: createArtifactLoader({ missing: ['/wasm/comment-privacy-prover.zkey'] }),
      loadModule
    })

    await expect(prover.prewarm()).rejects.toThrow('comment_privacy_prover_artifact_unavailable')
    expect(loadModule).not.toHaveBeenCalled()
  })

  it('loads the public browser prover artifact through a module script tag', async () => {
    const prewarm = vi.fn().mockResolvedValue(undefined)
    const prepareProof = vi.fn().mockResolvedValue({
      proofBytes: new Uint8Array([21, 22, 23]),
      publicInputs: expectedPublicInputs,
      nullifierHash: expectedNullifierHash
    })
    const appendedScripts: HTMLScriptElement[] = []
    const appendChild = vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node): Node => {
      if (node.nodeName === 'SCRIPT') {
        const script = node as HTMLScriptElement
        appendedScripts.push(script)
        queueMicrotask(() => {
          ;(globalThis as Record<string, unknown>).__fsusCommentPrivacyProverModule = {
            createCommentPrivacyProver: vi.fn().mockReturnValue({ prewarm, prepareProof })
          }
          script.dispatchEvent(new window.Event('load'))
        })
      }
      return node
    })
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadArtifact: createArtifactLoader()
    })

    try {
      await prover.prewarm()
      const result = await prover.prepareProof(proofRequest)

      expect(appendedScripts).toHaveLength(1)
      expect(appendedScripts[0].type).toBe('module')
      expect(appendedScripts[0].src).toContain('/wasm/comment-privacy-prover.js')
      expect(prewarm).toHaveBeenCalledWith(expect.objectContaining({ manifest }))
      expect(prepareProof).toHaveBeenCalledWith(expect.objectContaining({ scope: 'article:42' }))
      expect(result.proofBytes).toEqual(new Uint8Array([21, 22, 23]))
      expect(result.publicInputs).toEqual(expectedPublicInputs)
      expect(result.nullifierHash).toEqual(expectedNullifierHash)
    } finally {
      appendChild.mockRestore()
      delete (globalThis as Record<string, unknown>).__fsusCommentPrivacyProverModule
    }
  })

  it('loads the public prover artifact through dynamic import when running inside a worker', async () => {
    const prewarm = vi.fn().mockResolvedValue(undefined)
    const prepareProof = vi.fn().mockResolvedValue({
      proofBytes: new Uint8Array([21, 22, 23]),
      publicInputs: expectedPublicInputs,
      nullifierHash: expectedNullifierHash
    })
    const importModule = vi.fn().mockResolvedValue({
      createCommentPrivacyProver: vi.fn().mockReturnValue({ prewarm, prepareProof })
    })
    vi.stubGlobal('document', undefined)
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadArtifact: createArtifactLoader(),
      importModule
    } as Parameters<typeof createCommentPrivacyWasmProver>[0] & {
      importModule: (moduleUrl: string, signal?: AbortSignal) => Promise<unknown>
    })

    try {
      await prover.prewarm()
      const result = await prover.prepareProof(proofRequest)

      expect(importModule).toHaveBeenCalledTimes(1)
      expect(importModule).toHaveBeenCalledWith('/wasm/comment-privacy-prover.js', undefined)
      expect(prewarm).toHaveBeenCalledWith(expect.objectContaining({ manifest }))
      expect(prepareProof).toHaveBeenCalledWith(expect.objectContaining({ scope: 'article:42' }))
      expect(result.proofBytes).toEqual(new Uint8Array([21, 22, 23]))
      expect(result.publicInputs).toEqual(expectedPublicInputs)
      expect(result.nullifierHash).toEqual(expectedNullifierHash)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('delegates proof generation to the loaded wasm prover artifact without console output', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepareProof = vi.fn().mockResolvedValue({
      proofBytes: new Uint8Array([21, 22, 23]),
      publicInputs: expectedPublicInputs,
      nullifierHash: expectedNullifierHash
    })
    const prewarm = vi.fn().mockResolvedValue(undefined)
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadArtifact: createArtifactLoader(),
      loadModule: vi.fn().mockResolvedValue({
        createCommentPrivacyProver: vi.fn().mockReturnValue({ prewarm, prepareProof })
      })
    })

    try {
      await prover.prewarm()
      const result = await prover.prepareProof(proofRequest)

      expect(prewarm).toHaveBeenCalledWith(expect.objectContaining({ manifest }))
      expect(prepareProof).toHaveBeenCalledWith(expect.objectContaining({
        scope: 'article:42',
        credentialSecret: expect.any(Uint8Array),
        issuerSignature: expect.any(Uint8Array),
        revocationWitness: expect.any(Uint8Array)
      }))
      expect(result.proofBytes).toEqual(new Uint8Array([21, 22, 23]))
      expect(result.publicInputs).toEqual(expectedPublicInputs)
      expect(result.nullifierHash).toEqual(expectedNullifierHash)
      expect(consoleLog).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleLog.mockRestore()
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('fails closed when the wasm prover returns public inputs that do not match the backend transcript', async () => {
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadArtifact: createArtifactLoader(),
      loadModule: vi.fn().mockResolvedValue({
        prepareProof: vi.fn().mockResolvedValue({
          proofBytes: new Uint8Array([21, 22, 23]),
          publicInputs: new Uint8Array([31, 32]),
          nullifierHash: expectedNullifierHash
        })
      })
    })

    await expect(prover.prepareProof(proofRequest)).rejects.toThrow('comment_privacy_prover_artifact_invalid')
  })

  it('fails closed before calling the delegate when revocation witness material is malformed', async () => {
    const prepareProof = vi.fn().mockResolvedValue({
      proofBytes: new Uint8Array([21, 22, 23]),
      publicInputs: expectedPublicInputs,
      nullifierHash: expectedNullifierHash
    })
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadArtifact: createArtifactLoader(),
      loadModule: vi.fn().mockResolvedValue({
        prepareProof
      })
    })

    await expect(prover.prepareProof({
      ...proofRequest,
      revocationWitness: new Uint8Array([14, 15])
    })).rejects.toThrow('comment_privacy_prover_artifact_invalid')
    expect(prepareProof).not.toHaveBeenCalled()
  })

  it('strips witness material returned by the delegate from the proof bundle', async () => {
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadArtifact: createArtifactLoader(),
      loadModule: vi.fn().mockResolvedValue({
        prepareProof: vi.fn().mockResolvedValue({
          proofBytes: new Uint8Array([21, 22, 23]),
          publicInputs: expectedPublicInputs,
          nullifierHash: expectedNullifierHash,
          witness: new Uint8Array([51, 52]),
          credentialSecret: new Uint8Array([61, 62]),
          issuerSignature: new Uint8Array([63, 64]),
          revocationWitness: new Uint8Array([65, 66])
        })
      })
    })

    const result = await prover.prepareProof(proofRequest)

    expect(Object.keys(result).sort()).toEqual(['nullifierHash', 'proofBytes', 'publicInputs'])
    expect(result.proofBytes).toEqual(new Uint8Array([21, 22, 23]))
    expect(result.publicInputs).toEqual(expectedPublicInputs)
    expect(result.nullifierHash).toEqual(expectedNullifierHash)
  })
})

function encodeExpectedPublicInputs(
  request: typeof proofRequest,
  nullifierHash: Uint8Array
): Uint8Array {
  const chunks: Uint8Array[] = []
  const writeString = (value: string): void => {
    const bytes = new TextEncoder().encode(value)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setInt32(0, bytes.byteLength, true)
    chunks.push(length, bytes)
  }
  const writeUInt16 = (value: number): void => {
    const bytes = new Uint8Array(2)
    new DataView(bytes.buffer).setUint16(0, value, true)
    chunks.push(bytes)
  }
  const writeInt64 = (value: number): void => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true)
    chunks.push(bytes)
  }

  writeString('fsus.anonymous.comment.v2.public-inputs')
  writeString('comment.create')
  writeString(request.scope)
  writeString(request.circuitId)
  writeString(request.verifyingKeyHash)
  writeUInt16(request.publicInputLayoutVersion)
  writeInt64(request.credentialEpoch)
  writeString(bytesToHex(nullifierHash))
  writeString(bytesToHex(request.credentialCommitment))
  writeString(bytesToHex(request.credentialRoot))
  writeString(bytesToHex(request.revocationRoot))
  writeString(request.issuerPublicKeyHash)
  writeString(request.policyHash)
  writeString(request.credentialLevel)
  writeString(request.reputationBucket)

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function createArtifactLoader(options: { missing?: string[] } = {}) {
  return vi.fn(async ({ artifactUrl }: { artifactUrl: string }) => {
    if (options.missing?.includes(artifactUrl)) {
      return null
    }
    if (artifactUrl.endsWith('.js')) {
      return new Uint8Array([17, 18, 19])
    }
    if (artifactUrl.endsWith('.wasm')) {
      return new Uint8Array([1, 2, 3])
    }
    if (artifactUrl.endsWith('.zkey')) {
      return new Uint8Array([4, 5, 6])
    }

    return null
  })
}
