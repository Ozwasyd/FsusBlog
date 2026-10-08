export interface CommentPrivacyCredentialMaterial {
    credentialSecret: Uint8Array;
    credentialCommitment: Uint8Array;
    issuerSignature: Uint8Array;
    revocationWitness: Uint8Array;
    revocationHandleHash?: Uint8Array;
    credentialLevel: string;
    reputationBucket: string;
}

export interface CommentPrivacyCredentialProvider {
    prepareCredential(request: { signal: AbortSignal; }): Promise<CommentPrivacyCredentialMaterial | null>;
}

export interface CommentPrivacyCredentialIssuerMetadata {
    credentialEpoch: number;
    rootExpiresAtUnixMs: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    circuitId: string;
    credentialLevel: string;
    reputationBucket: string;
    issuerPublicKeyHash: string;
    schemeId: string;
    issuerPublicKeyId: string;
    modulusBytes: number;
    subjectPublicKeyInfo: Uint8Array;
    credentialRoot: Uint8Array;
    revocationRoot: Uint8Array;
    revocationDistribution: CommentPrivacyRevocationDistribution;
}

/** Server-issued coordinates for exactly one public revocation operation; never a URL. */
export type CommentPrivacyRevocationArtifactReference = {
    kind: 'snapshot'; epoch: number; version: number; revocationRoot: string;
} | {
    kind: 'delta'; epoch: number; version: number; revocationRoot: string; baseVersion: number;
};

export interface CommentPrivacyRevocationDistribution {
    protocol: 'public-snapshot-delta.v1';
    epoch: number;
    version: number;
    contentAddress: string;
    snapshot: CommentPrivacyRevocationArtifactReference;
    delta: CommentPrivacyRevocationArtifactReference | null;
    entryBytes: 32;
    maxArtifactBytes: number;
}

export interface CommentPrivacyCredentialIssueRequest {
    credentialEpoch: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    circuitId: string;
    credentialLevel: string;
    schemeId: string;
    issuerPublicKeyId: string;
    blindedMessage: Uint8Array;
}

export interface CommentPrivacyCredentialIssueResponse {
    credentialEpoch: number;
    expiresAtUnixMs: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    circuitId: string;
    credentialLevel: string;
    schemeId: string;
    issuerPublicKeyId: string;
    blindSignature: Uint8Array;
}

export interface CommentPrivacyCredentialIssuePayload {
    credentialRequest: Uint8Array;
    credentialOpening: Uint8Array;
}

// Suite failures remain deliberately opaque at runtime: every category maps to null/fail-closed.
export type CommentPrivacyCredentialSuiteFailureCategory =
  | 'cancelled'
  | 'invalid-input'
  | 'invalid-metadata'
  | 'cryptographic-failure';

export type CommentPrivacyCredentialSuiteResult<T> = T | null;

export interface CommentPrivacyCredentialSuite {
    createCredentialRequest(input: {
        credentialSecret: Uint8Array;
        clientNonce: Uint8Array;
        metadata: CommentPrivacyCredentialIssuerMetadata;
        signal: AbortSignal;
    }): Promise<CommentPrivacyCredentialSuiteResult<CommentPrivacyCredentialIssuePayload>>;
    acceptIssuerResponse(input: {
        credentialSecret: Uint8Array;
        clientNonce: Uint8Array;
        credentialOpening: Uint8Array;
        issuerPublicKeyId: string;
        issuerSignature: Uint8Array;
        metadata: CommentPrivacyCredentialIssuerMetadata;
        response: CommentPrivacyCredentialIssueResponse;
        signal: AbortSignal;
    }): Promise<CommentPrivacyCredentialSuiteResult<CommentPrivacyCredentialMaterial>>;
}
