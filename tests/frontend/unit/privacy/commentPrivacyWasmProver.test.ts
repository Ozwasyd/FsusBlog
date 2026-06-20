import { describe, expect, it, vi } from 'vitest'
import {
  createCommentPrivacyWasmProver,
  type CommentPrivacyProverManifest
} from '@/privacy/commentPrivacyWasmProver'

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

const proofRequest = {
  scope: 'article:42',
  rootVersion: 'root-v1',
  metadataBytes: new Uint8Array([1, 2, 3]),
  credentialEpoch: 20260618,
  circuitNumericId: 7,
  publicInputLayoutVersion: 3,
  circuitId: 'fsus.anonymous.comment.v2',
  credentialRoot: new Uint8Array([4, 5]),
  revocationRoot: new Uint8Array([6, 7]),
  circuitMetadata: new Uint8Array([8, 9]),
  credentialSecret: new Uint8Array([10, 11]),
  issuerSignature: new Uint8Array([12, 13]),
  revocationWitness: new Uint8Array([14, 15])
}

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

  it('delegates proof generation to the loaded wasm prover artifact without console output', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prepareProof = vi.fn().mockResolvedValue({
      proofBytes: new Uint8Array([21, 22, 23]),
      publicInputs: new Uint8Array([31, 32]),
      nullifierHash: new Uint8Array([41, 42])
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
      expect(result.publicInputs).toEqual(new Uint8Array([31, 32]))
      expect(result.nullifierHash).toEqual(new Uint8Array([41, 42]))
      expect(consoleLog).not.toHaveBeenCalled()
      expect(consoleWarn).not.toHaveBeenCalled()
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleLog.mockRestore()
      consoleWarn.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('strips witness material returned by the delegate from the proof bundle', async () => {
    const prover = createCommentPrivacyWasmProver({
      loadManifest: vi.fn().mockResolvedValue(manifest),
      loadArtifact: createArtifactLoader(),
      loadModule: vi.fn().mockResolvedValue({
        prepareProof: vi.fn().mockResolvedValue({
          proofBytes: new Uint8Array([21, 22, 23]),
          publicInputs: new Uint8Array([31, 32]),
          nullifierHash: new Uint8Array([41, 42]),
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
    expect(result.publicInputs).toEqual(new Uint8Array([31, 32]))
    expect(result.nullifierHash).toEqual(new Uint8Array([41, 42]))
  })
})

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
