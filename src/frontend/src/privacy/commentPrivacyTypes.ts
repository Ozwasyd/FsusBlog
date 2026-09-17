import type { CommentPrivacyCredentialMaterial } from './commentPrivacyContracts';

export type CommentPrivacyUiState = 'ready' | 'preparing' | 'unavailable' | 'publicOnly';

export interface CommentPrivacyMetadata {
    scope: string;
    rootVersion: string;
    metadataBytes: Uint8Array;
    credentialEpoch?: number;
    circuitNumericId?: number;
    publicInputLayoutVersion?: number;
    circuitId?: string;
    verifyingKeyHash?: string;
    issuerPublicKeyHash?: string;
    policyHash?: string;
    credentialRoot?: Uint8Array;
    revocationRoot?: Uint8Array;
    circuitMetadata?: Uint8Array;
    credentialLevel?: string;
    reputationBucket?: string;
}

export interface CommentPrivacyPreparedTicket {
    scope: string;
    ticket: Uint8Array;
    expiresAtUnixMs: number;
    rateClass: 'common' | 'unknown';
    requiresModeration: boolean;
}

export interface CommentPrivacyCredentialSuccess {
    ok: true;
    credential?: CommentPrivacyCredentialMaterial;
}

export interface CommentPrivacyAdapterFailure {
    ok: false;
    reason: string;
}

export type CommentPrivacyCredentialResult =
  | CommentPrivacyCredentialSuccess
  | CommentPrivacyAdapterFailure;

export type CommentPrivacyMetadataResult =
  | {
      ok: true;
      metadata: CommentPrivacyMetadata;
  }
  | CommentPrivacyAdapterFailure;

export type CommentPrivacyTicketResult =
  | {
      ok: true;
      ticket: CommentPrivacyPreparedTicket;
  }
  | CommentPrivacyAdapterFailure;

export interface CommentPrivacyMetadataRequest {
    scope: string;
    articleId: number | null;
    signal: AbortSignal;
}

export interface CommentPrivacyTicketRequest {
    scope: string;
    metadata: CommentPrivacyMetadata;
    proof: CommentPrivacyProofBundle;
    proofBytes: Uint8Array;
    signal: AbortSignal;
}

export interface CommentPrivacyAdapter {
    ensureCredentialPrepared(request: { signal: AbortSignal; }): Promise<CommentPrivacyCredentialResult>;
    loadPrivacyMetadata(request: CommentPrivacyMetadataRequest): Promise<CommentPrivacyMetadataResult>;
    issueAnonymousTicket(request: CommentPrivacyTicketRequest): Promise<CommentPrivacyTicketResult>;
    purgeCredential?(): void | Promise<void>;
}

export interface CommentPrivacyProofRequest {
    scope: string;
    rootVersion: string;
    metadataBytes: Uint8Array;
    credentialEpoch?: number;
    circuitNumericId?: number;
    publicInputLayoutVersion?: number;
    circuitId?: string;
    verifyingKeyHash?: string;
    issuerPublicKeyHash?: string;
    policyHash?: string;
    isEligible?: boolean;
    mayComment?: boolean;
    rateClass?: 'common' | 'unknown';
    requiresModeration?: boolean;
    credentialCommitment?: Uint8Array;
    credentialRoot?: Uint8Array;
    revocationRoot?: Uint8Array;
    circuitMetadata?: Uint8Array;
    credentialLevel?: string;
    reputationBucket?: string;
    credentialSecret?: Uint8Array;
    issuerSignature?: Uint8Array;
    revocationWitness?: Uint8Array;
    signal?: AbortSignal;
}

export interface CommentPrivacyProofBundle {
    proofBytes: Uint8Array;
    publicInputs: Uint8Array;
    nullifierHash: Uint8Array;
}

export interface CommentPrivacyRevocationWorkerRequest {
    artifact: import('@/api/comment').AnonymousCredentialRevocationArtifact;
    baseEntryHashes?: Uint8Array;
    revocationHandleHash: Uint8Array;
    expectedEpoch: number;
    expectedVersion: number;
    expectedIssuerPublicKeyHash: string;
    expectedRevocationRoot: Uint8Array;
    nowUnixMs: number;
    maxCpuMs: number;
    signal?: AbortSignal;
}

export interface CommentPrivacyRevocationWorkerResult {
    witness: Uint8Array;
    entryHashes: Uint8Array;
}

export interface CommentPrivacyWorkerClient {
    prewarm(signal?: AbortSignal): Promise<void>;
    buildRevocationWitness(request: CommentPrivacyRevocationWorkerRequest): Promise<CommentPrivacyRevocationWorkerResult>;
    prepareProof(request: CommentPrivacyProofRequest): Promise<CommentPrivacyProofBundle>;
    dispose(): void;
}
