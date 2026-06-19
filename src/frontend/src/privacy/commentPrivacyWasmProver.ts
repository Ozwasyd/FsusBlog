import type { CommentPrivacyProofBundle, CommentPrivacyProofRequest } from './commentPrivacyTypes'

export interface CommentPrivacyProverManifest {
  moduleUrl: string
  wasmUrl: string
  provingKeyUrl: string
  integrity?: string
}

export interface CommentPrivacyWasmProver {
  prewarm(signal?: AbortSignal): Promise<void>
  prepareProof(request: CommentPrivacyProofRequest): Promise<CommentPrivacyProofBundle>
}

export interface CommentPrivacyWasmProverOptions {
  manifestUrl?: string
  loadManifest?: (request: { manifestUrl: string; signal?: AbortSignal }) => Promise<CommentPrivacyProverManifest | null>
  loadModule?: (moduleUrl: string, signal?: AbortSignal) => Promise<unknown>
}

type WasmProverDelegate = {
  prewarm?: (request: { manifest: CommentPrivacyProverManifest; signal?: AbortSignal }) => Promise<void> | void
  prepareProof: (request: CommentPrivacyProofRequest & { manifest: CommentPrivacyProverManifest }) => Promise<unknown> | unknown
}

type LoadedProver = {
  manifest: CommentPrivacyProverManifest
  delegate: WasmProverDelegate
}

const DEFAULT_MANIFEST_URL = '/wasm/comment-privacy-prover.manifest.json'
const ARTIFACT_UNAVAILABLE = 'comment_privacy_prover_artifact_unavailable'
const ARTIFACT_INVALID = 'comment_privacy_prover_artifact_invalid'
const PROOF_FAILED = 'comment_privacy_prover_failed'

export function createCommentPrivacyWasmProver(options: CommentPrivacyWasmProverOptions = {}): CommentPrivacyWasmProver {
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL
  const loadManifest = options.loadManifest ?? defaultLoadManifest
  const loadModule = options.loadModule ?? defaultLoadModule
  let loadedPromise: Promise<LoadedProver> | null = null

  const load = async (signal?: AbortSignal): Promise<LoadedProver> => {
    throwIfAborted(signal)
    if (!loadedPromise) {
      loadedPromise = (async () => {
        const manifest = normalizeManifest(await loadManifest({ manifestUrl, signal }))
        const module = await loadModule(manifest.moduleUrl, signal)
        return {
          manifest,
          delegate: resolveDelegate(module)
        }
      })()
    }

    try {
      return await loadedPromise
    } catch (error) {
      loadedPromise = null
      throw sanitizeProverError(error)
    }
  }

  return {
    async prewarm(signal?: AbortSignal): Promise<void> {
      const loaded = await load(signal)
      await loaded.delegate.prewarm?.({ manifest: loaded.manifest, signal })
    },
    async prepareProof(request: CommentPrivacyProofRequest): Promise<CommentPrivacyProofBundle> {
      throwIfAborted(request.signal)
      assertProofRequest(request)
      const loaded = await load(request.signal)
      try {
        const result = await loaded.delegate.prepareProof({ ...request, manifest: loaded.manifest })
        return normalizeProofBundle(result)
      } catch (error) {
        throw sanitizeProverError(error, PROOF_FAILED)
      }
    }
  }
}

async function defaultLoadManifest(request: { manifestUrl: string; signal?: AbortSignal }): Promise<CommentPrivacyProverManifest | null> {
  if (typeof fetch !== 'function') {
    return null
  }

  const response = await fetch(request.manifestUrl, {
    cache: 'force-cache',
    credentials: 'omit',
    signal: request.signal
  })
  if (!response.ok) {
    return null
  }

  return await response.json() as CommentPrivacyProverManifest
}

async function defaultLoadModule(moduleUrl: string): Promise<unknown> {
  return await import(/* @vite-ignore */ moduleUrl)
}

function normalizeManifest(manifest: CommentPrivacyProverManifest | null): CommentPrivacyProverManifest {
  if (!manifest) {
    throw new Error(ARTIFACT_UNAVAILABLE)
  }

  if (!isNonEmptyString(manifest.moduleUrl) || !isNonEmptyString(manifest.wasmUrl) || !isNonEmptyString(manifest.provingKeyUrl)) {
    throw new Error(ARTIFACT_INVALID)
  }

  return {
    moduleUrl: manifest.moduleUrl,
    wasmUrl: manifest.wasmUrl,
    provingKeyUrl: manifest.provingKeyUrl,
    integrity: isNonEmptyString(manifest.integrity) ? manifest.integrity : undefined
  }
}

function resolveDelegate(module: unknown): WasmProverDelegate {
  const record = asRecord(module)
  const defaultExport = asRecord(record.default)
  const factory = getFunction(record, 'createCommentPrivacyProver') ?? getFunction(defaultExport, 'createCommentPrivacyProver')
  const candidate = factory ? factory() : (hasPrepareProof(record) ? record : defaultExport)

  if (!hasPrepareProof(candidate)) {
    throw new Error(ARTIFACT_INVALID)
  }

  return {
    prewarm: getFunction(candidate, 'prewarm') as WasmProverDelegate['prewarm'],
    prepareProof: candidate.prepareProof as WasmProverDelegate['prepareProof']
  }
}

function hasPrepareProof(value: unknown): value is { prepareProof: WasmProverDelegate['prepareProof']; prewarm?: WasmProverDelegate['prewarm'] } {
  return typeof asRecord(value).prepareProof === 'function'
}

function getFunction(record: Record<string, unknown>, key: string): ((...args: never[]) => unknown) | undefined {
  return typeof record[key] === 'function' ? record[key] as (...args: never[]) => unknown : undefined
}

function normalizeProofBundle(result: unknown): CommentPrivacyProofBundle {
  const record = asRecord(result)
  const proofBytes = toRequiredBytes(record.proofBytes, 'proofBytes')
  const publicInputs = toRequiredBytes(record.publicInputs, 'publicInputs')
  const nullifierHash = toRequiredBytes(record.nullifierHash, 'nullifierHash')
  return { proofBytes, publicInputs, nullifierHash }
}

function assertProofRequest(request: CommentPrivacyProofRequest): void {
  if (!isNonEmptyString(request.scope) || !isNonEmptyString(request.rootVersion) || !isNonEmptyString(request.circuitId)) {
    throw new Error(ARTIFACT_INVALID)
  }
  if (!Number.isFinite(request.credentialEpoch) || !Number.isFinite(request.circuitNumericId) || !Number.isFinite(request.publicInputLayoutVersion)) {
    throw new Error(ARTIFACT_INVALID)
  }

  toRequiredBytes(request.metadataBytes, 'metadataBytes')
  toRequiredBytes(request.credentialRoot, 'credentialRoot')
  toRequiredBytes(request.revocationRoot, 'revocationRoot')
  toRequiredBytes(request.circuitMetadata, 'circuitMetadata')
  toRequiredBytes(request.credentialSecret, 'credentialSecret')
  toRequiredBytes(request.issuerSignature, 'issuerSignature')
  toRequiredBytes(request.revocationWitness, 'revocationWitness')
}

function toRequiredBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${ARTIFACT_INVALID}:${field}`)
  }

  return new Uint8Array(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function sanitizeProverError(error: unknown, fallback = ARTIFACT_UNAVAILABLE): Error {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return error
  }
  if (error instanceof Error && error.message.startsWith('comment_privacy_prover_')) {
    return new Error(error.message)
  }

  return new Error(fallback)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
