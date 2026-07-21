import createCommentPrivacyRuntime from './comment_privacy_runtime.js'

const ARTIFACT_UNAVAILABLE = 'comment_privacy_prover_artifact_unavailable'
const ARTIFACT_INVALID = 'comment_privacy_prover_artifact_invalid'
const PROOF_FAILED = 'comment_privacy_prover_failed'
const NULLIFIER_DOMAIN = 'fsus.anonymous.comment.v5:nullifier:v1'
const PUBLIC_INPUT_TRANSCRIPT_DOMAIN = 'fsus.anonymous.comment.v5.public-inputs'
const COMMENT_ACTION_CONTEXT = 'comment.create'

export function createCommentPrivacyProver() {
  let loadedPromise = null

  async function load(manifest, signal) {
    throwIfAborted(signal)
    if (!loadedPromise) {
      loadedPromise = (async () => {
        const [runtime, provingKey] = await Promise.all([
          createCommentPrivacyRuntime({
            locateFile: (file) => file.endsWith('.wasm') ? manifest.wasmUrl : file
          }),
          fetchBytes(manifest.provingKeyUrl, signal)
        ])
        const keyPtr = copyToWasm(runtime, provingKey)
        try {
          const ok = runtime._comment_privacy_validate_proving_key(keyPtr, provingKey.byteLength)
          if (ok !== 1) {
            throw new Error(ARTIFACT_INVALID)
          }
        } finally {
          runtime._free(keyPtr)
        }
        return { runtime, provingKey }
      })()
    }

    try {
      return await loadedPromise
    } catch (error) {
      loadedPromise = null
      throw sanitize(error, ARTIFACT_UNAVAILABLE)
    }
  }

  return {
    async prewarm({ manifest, signal }) {
      await load(manifest, signal)
    },
    async prepareProof(request) {
      const { runtime, provingKey } = await load(request.manifest, request.signal)
      const nullifierHash = await createNullifierHash(request)
      const publicInputs = encodePublicInputs(request, nullifierHash)
      const publicInputDigest = await digestBytes('SHA-256', publicInputs)
      const keyPtr = copyToWasm(runtime, provingKey)
      const publicInputsPtr = copyToWasm(runtime, publicInputs)
      const digestPtr = copyToWasm(runtime, publicInputDigest)
      try {
        const ok = runtime._comment_privacy_prepare_proof(
          keyPtr,
          provingKey.byteLength,
          publicInputsPtr,
          publicInputs.byteLength,
          digestPtr,
          publicInputDigest.byteLength
        )
        if (ok !== 1) {
          throw new Error(PROOF_FAILED)
        }
        const proofPtr = runtime._comment_privacy_get_proof_ptr()
        const proofLen = runtime._comment_privacy_get_proof_len()
        if (!Number.isFinite(proofPtr) || !Number.isFinite(proofLen) || proofPtr <= 0 || proofLen <= 0) {
          throw new Error(PROOF_FAILED)
        }
        return {
          proofBytes: new Uint8Array(runtime.HEAPU8.subarray(proofPtr, proofPtr + proofLen)),
          publicInputs,
          nullifierHash
        }
      } finally {
        runtime._free(keyPtr)
        runtime._free(publicInputsPtr)
        runtime._free(digestPtr)
      }
    }
  }
}

async function fetchBytes(url, signal) {
  if (typeof fetch !== 'function') {
    throw new Error(ARTIFACT_UNAVAILABLE)
  }
  const response = await fetch(url, {
    cache: 'force-cache',
    credentials: 'omit',
    signal
  })
  if (!response.ok) {
    throw new Error(ARTIFACT_UNAVAILABLE)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error(ARTIFACT_INVALID)
  }
  return bytes
}

function copyToWasm(runtime, bytes) {
  const ptr = runtime._malloc(bytes.byteLength)
  if (!ptr) {
    throw new Error(PROOF_FAILED)
  }
  runtime.HEAPU8.set(bytes, ptr)
  return ptr
}

async function createNullifierHash(request) {
  const chunks = []
  writeString(chunks, NULLIFIER_DOMAIN)
  writeString(chunks, COMMENT_ACTION_CONTEXT)
  writeString(chunks, request.scope)
  writeBytes(chunks, request.credentialSecret)
  writeBytes(chunks, request.credentialCommitment)
  writeBytes(chunks, request.circuitMetadata)
  return await digestBytes('SHA-256', concatChunks(chunks))
}

function encodePublicInputs(request, nullifierHash) {
  const chunks = []
  writeString(chunks, PUBLIC_INPUT_TRANSCRIPT_DOMAIN)
  writeString(chunks, COMMENT_ACTION_CONTEXT)
  writeString(chunks, request.scope)
  writeString(chunks, request.circuitId ?? '')
  writeString(chunks, request.verifyingKeyHash ?? '')
  writeUInt16(chunks, request.publicInputLayoutVersion ?? 0)
  writeInt64(chunks, request.credentialEpoch ?? 0)
  writeString(chunks, bytesToHex(nullifierHash))
  writeString(chunks, bytesToHex(requiredBytes(request.credentialRoot)))
  writeString(chunks, bytesToHex(requiredBytes(request.revocationRoot)))
  writeString(chunks, request.issuerPublicKeyHash ?? '')
  writeString(chunks, request.policyHash ?? '')
  writeString(chunks, request.credentialLevel ?? '')
  writeString(chunks, request.reputationBucket ?? '')
  return concatChunks(chunks)
}

function writeString(chunks, value) {
  const bytes = new TextEncoder().encode(String(value ?? ''))
  writeInt32(chunks, bytes.byteLength)
  chunks.push(bytes)
}

function writeBytes(chunks, value) {
  const bytes = requiredBytes(value)
  writeInt32(chunks, bytes.byteLength)
  chunks.push(bytes)
}

function writeInt32(chunks, value) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setInt32(0, value, true)
  chunks.push(bytes)
}

function writeUInt16(chunks, value) {
  const bytes = new Uint8Array(2)
  new DataView(bytes.buffer).setUint16(0, value, true)
  chunks.push(bytes)
}

function writeInt64(chunks, value) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, BigInt(Math.trunc(value)), true)
  chunks.push(bytes)
}

function concatChunks(chunks) {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function digestBytes(algorithm, bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error(ARTIFACT_INVALID)
  }
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, buffer))
}

function requiredBytes(value) {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(ARTIFACT_INVALID)
  }
  return value
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function sanitize(error, fallback) {
  if (error instanceof Error && error.message.startsWith('comment_privacy_prover_')) {
    return error
  }
  return new Error(fallback)
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

globalThis.__fsusCommentPrivacyProverModule = Object.freeze({
  createCommentPrivacyProver
})
