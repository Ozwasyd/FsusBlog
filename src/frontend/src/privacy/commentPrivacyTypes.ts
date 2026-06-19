export type CommentPrivacyUiState = 'ready' | 'preparing' | 'unavailable' | 'publicOnly'

export interface CommentPrivacyMetadata {
  scope: string
  rootVersion: string
  metadataBytes: Uint8Array
  credentialEpoch?: number
  circuitNumericId?: number
  publicInputLayoutVersion?: number
  circuitId?: string
  credentialRoot?: Uint8Array
  revocationRoot?: Uint8Array
  circuitMetadata?: Uint8Array
}

export interface CommentPrivacyPreparedTicket {
  scope: string
  credentialEpoch: number
  ticket: Uint8Array
  expiresAtUnixMs: number
  credentialLevel?: string
}

export interface CommentPrivacyCredentialMaterial {
  credentialSecret: Uint8Array
  issuerSignature: Uint8Array
  revocationWitness: Uint8Array
}

export interface CommentPrivacyCredentialSuccess {
  ok: true
  credential?: CommentPrivacyCredentialMaterial
}

export interface CommentPrivacyAdapterFailure {
  ok: false
  reason: string
}

export type CommentPrivacyCredentialResult =
  | CommentPrivacyCredentialSuccess
  | CommentPrivacyAdapterFailure

export type CommentPrivacyMetadataResult =
  | {
      ok: true
      metadata: CommentPrivacyMetadata
    }
  | CommentPrivacyAdapterFailure

export type CommentPrivacyTicketResult =
  | {
      ok: true
      ticket: CommentPrivacyPreparedTicket
    }
  | CommentPrivacyAdapterFailure

export interface CommentPrivacyMetadataRequest {
  scope: string
  articleId: number | null
  signal: AbortSignal
}

export interface CommentPrivacyTicketRequest {
  scope: string
  metadata: CommentPrivacyMetadata
  proof: CommentPrivacyProofBundle
  proofBytes: Uint8Array
  signal: AbortSignal
}

export interface CommentPrivacyAdapter {
  ensureCredentialPrepared(request: { signal: AbortSignal }): Promise<CommentPrivacyCredentialResult>
  loadPrivacyMetadata(request: CommentPrivacyMetadataRequest): Promise<CommentPrivacyMetadataResult>
  issueAnonymousTicket(request: CommentPrivacyTicketRequest): Promise<CommentPrivacyTicketResult>
}

export interface CommentPrivacyProofRequest {
  scope: string
  rootVersion: string
  metadataBytes: Uint8Array
  credentialEpoch?: number
  circuitNumericId?: number
  publicInputLayoutVersion?: number
  circuitId?: string
  credentialRoot?: Uint8Array
  revocationRoot?: Uint8Array
  circuitMetadata?: Uint8Array
  credentialSecret?: Uint8Array
  issuerSignature?: Uint8Array
  revocationWitness?: Uint8Array
  signal?: AbortSignal
}

export interface CommentPrivacyProofBundle {
  proofBytes: Uint8Array
  publicInputs: Uint8Array
  nullifierHash: Uint8Array
}

export interface CommentPrivacyWorkerClient {
  prewarm(signal?: AbortSignal): Promise<void>
  prepareProof(request: CommentPrivacyProofRequest): Promise<CommentPrivacyProofBundle>
  dispose(): void
}
