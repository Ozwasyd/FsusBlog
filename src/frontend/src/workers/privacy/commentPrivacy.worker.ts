import { createCommentPrivacyWasmProver } from '@/privacy/commentPrivacyWasmProver'
import type { CommentPrivacyProofRequest } from '@/privacy/commentPrivacyTypes'

type CommentPrivacyWorkerRequest =
  | {
      v: 1
      type: 'prewarm'
      requestId: number
    }
  | {
      v: 1
      type: 'prepareProof'
      requestId: number
      scope: string
      rootVersion: string
      metadataBytes: ArrayBuffer
      credentialEpoch?: number
      circuitNumericId?: number
      publicInputLayoutVersion?: number
      circuitId?: string
      verifyingKeyHash?: string
      issuerPublicKeyHash?: string
      policyHash?: string
      credentialCommitment?: ArrayBuffer
      credentialRoot?: ArrayBuffer
      revocationRoot?: ArrayBuffer
      circuitMetadata?: ArrayBuffer
      credentialLevel?: string
      reputationBucket?: string
      credentialSecret?: ArrayBuffer
      issuerSignature?: ArrayBuffer
      revocationWitness?: ArrayBuffer
    }

type CommentPrivacyWorkerResponse =
  | {
      v: 1
      type: 'prewarmed'
      requestId: number
      ok: true
    }
  | {
      v: 1
      type: 'proof'
      requestId: number
      ok: true
      proofBytes: Uint8Array
      publicInputs: Uint8Array
      nullifierHash: Uint8Array
    }
  | {
      v: 1
      type: 'error'
      requestId: number
      ok: false
      error: string
    }

const ctx = self as DedicatedWorkerGlobalScope
const prover = createCommentPrivacyWasmProver()

ctx.onmessage = (event: MessageEvent<CommentPrivacyWorkerRequest>) => {
  const request = event.data
  if (!request || request.v !== 1) {
    return
  }

  void handleRequest(request)
}

async function handleRequest(request: CommentPrivacyWorkerRequest): Promise<void> {
  try {
    if (request.type === 'prewarm') {
      await prover.prewarm()
      const response: CommentPrivacyWorkerResponse = {
        v: 1,
        type: 'prewarmed',
        requestId: request.requestId,
        ok: true
      }
      ctx.postMessage(response)
      return
    }

    const proof = await prover.prepareProof(toProofRequest(request))
    const response: CommentPrivacyWorkerResponse = {
      v: 1,
      type: 'proof',
      requestId: request.requestId,
      ok: true,
      proofBytes: proof.proofBytes,
      publicInputs: proof.publicInputs,
      nullifierHash: proof.nullifierHash
    }
    ctx.postMessage(response, [proof.proofBytes.buffer, proof.publicInputs.buffer, proof.nullifierHash.buffer])
  } catch (error) {
    const response: CommentPrivacyWorkerResponse = {
      v: 1,
      type: 'error',
      requestId: request.requestId,
      ok: false,
      error: sanitizeWorkerError(error)
    }
    ctx.postMessage(response)
  }
}

function toProofRequest(request: Extract<CommentPrivacyWorkerRequest, { type: 'prepareProof' }>): CommentPrivacyProofRequest {
  return {
    scope: request.scope,
    rootVersion: request.rootVersion,
    metadataBytes: new Uint8Array(request.metadataBytes),
    credentialEpoch: request.credentialEpoch,
    circuitNumericId: request.circuitNumericId,
    publicInputLayoutVersion: request.publicInputLayoutVersion,
    circuitId: request.circuitId,
    verifyingKeyHash: request.verifyingKeyHash,
    issuerPublicKeyHash: request.issuerPublicKeyHash,
    policyHash: request.policyHash,
    credentialCommitment: toBytes(request.credentialCommitment),
    credentialRoot: toBytes(request.credentialRoot),
    revocationRoot: toBytes(request.revocationRoot),
    circuitMetadata: toBytes(request.circuitMetadata),
    credentialLevel: request.credentialLevel,
    reputationBucket: request.reputationBucket,
    credentialSecret: toBytes(request.credentialSecret),
    issuerSignature: toBytes(request.issuerSignature),
    revocationWitness: toBytes(request.revocationWitness)
  }
}

function toBytes(buffer: ArrayBuffer | undefined): Uint8Array | undefined {
  return buffer ? new Uint8Array(buffer) : undefined
}

function sanitizeWorkerError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('comment_privacy_prover_')) {
    return error.message
  }

  return 'comment_privacy_worker_failed'
}
