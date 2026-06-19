import { describe, expect, it, vi } from 'vitest'
import {
  createCommentPrivacyWasmProver,
  type CommentPrivacyProverManifest
} from '@/privacy/commentPrivacyWasmProver'

const manifest: CommentPrivacyProverManifest = {
  moduleUrl: '/wasm/comment-privacy-prover.js',
  wasmUrl: '/wasm/comment-privacy-prover.wasm',
  provingKeyUrl: '/wasm/comment-privacy-prover.zkey'
}

const proofRequest = {
  scope: 'article:42',
  rootVersion: 'root-v1',
  metadataBytes: new Uint8Array([1, 2, 3]),
  credentialEpoch: 20260618,
  circuitNumericId: 7,
  publicInputLayoutVersion: 2,
  circuitId: 'comment.v1',
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
})
