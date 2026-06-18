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
    }
  | {
      v: 1
      type: 'error'
      requestId: number
      ok: false
      error: string
    }

const ctx = self as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<CommentPrivacyWorkerRequest>) => {
  const request = event.data
  if (!request || request.v !== 1) {
    return
  }

  try {
    if (request.type === 'prewarm') {
      const response: CommentPrivacyWorkerResponse = {
        v: 1,
        type: 'prewarmed',
        requestId: request.requestId,
        ok: true
      }
      ctx.postMessage(response)
      return
    }

    const proofBytes = createPlaceholderProofBytes(request.scope, request.rootVersion, new Uint8Array(request.metadataBytes))
    const response: CommentPrivacyWorkerResponse = {
      v: 1,
      type: 'proof',
      requestId: request.requestId,
      ok: true,
      proofBytes
    }
    ctx.postMessage(response, [proofBytes.buffer])
  } catch (error) {
    const response: CommentPrivacyWorkerResponse = {
      v: 1,
      type: 'error',
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'comment_privacy_worker_failed'
    }
    ctx.postMessage(response)
  }
}

function createPlaceholderProofBytes(scope: string, rootVersion: string, metadataBytes: Uint8Array): Uint8Array {
  const seed = new TextEncoder().encode(`${scope}\0${rootVersion}`)
  const proof = new Uint8Array(32)
  for (let i = 0; i < proof.length; i += 1) {
    const fromSeed = seed.length > 0 ? seed[i % seed.length] : 0
    const fromMetadata = metadataBytes.length > 0 ? metadataBytes[i % metadataBytes.length] : 0
    proof[i] = (fromSeed ^ fromMetadata ^ i) & 0xff
  }

  return proof
}
