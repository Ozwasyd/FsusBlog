export type CommentPrivacyUiState = 'ready' | 'preparing' | 'unavailable' | 'publicOnly'

export interface CommentPrivacyMetadata {
  scope: string
  rootVersion: string
  metadataBytes: Uint8Array
}

export interface CommentPrivacyPreparedTicket {
  scope: string
  proofToken: string
  zkProof: Uint8Array
  expiresAtUnixMs: number
}

export interface CommentPrivacyCredentialSuccess {
  ok: true
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
  signal?: AbortSignal
}

export interface CommentPrivacyWorkerClient {
  prewarm(signal?: AbortSignal): Promise<void>
  prepareProof(request: CommentPrivacyProofRequest): Promise<Uint8Array>
  dispose(): void
}
