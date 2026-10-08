import type { BinaryRouteRequest, BinaryTransportRequest } from '@/contracts/binaryTransport';
import { encodeJsonRequest } from '@/codecs/binary/jsonRequestEncoder';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import { getBrowserFp } from '@/utils/fingerprint';

import { FrameType } from '@wasm/protocol/frame';

import { encodeAedsFrame } from './binaryFrame';
import { FSUS_HEADERS } from './contracts';


import type { ApiRequestConfig } from './requestConfig';

const ADMIN_SENSITIVE_MFA_HEADER = 'X-Fsus-Mfa-Proof';

export interface AnonymousGovernanceStatusResponse {
    root: AnonymousGovernanceRootStatus;
    verifier: AnonymousGovernanceVerifierStatus;
    revocation: AnonymousGovernanceRevocationStatus;
    commentStats: AnonymousGovernanceCommentStats;
    credentials: AnonymousGovernanceCredentialRow[];
}

export interface AnonymousGovernanceRootStatus {
    available: boolean;
    credentialEpoch: number | null;
    rootHash: string | null;
    maskedRootHash: string | null;
    circuitId: string | null;
    verifyingKeyHash: string | null;
    publicInputLayoutVersion: number | null;
    expiresAtUtc: string | null;
    graceExpiresAtUtc: string | null;
    status: string;
}

export interface AnonymousGovernanceVerifierStatus {
    zkAnonymousEnabled: boolean;
    configured: boolean;
    circuitStatus: string;
    failClosed: boolean;
}

export interface AnonymousGovernanceRevocationStatus {
    status: string;
    revocationRootHash: string | null;
    maskedRevocationRootHash: string | null;
    revocationCount: number;
    latestRevokedAtUtc: string | null;
}

export interface AnonymousGovernanceCommentStats {
    totalAnonymous: number;
    pendingAnonymous: number;
    approvedAnonymous: number;
    rejectedAnonymous: number;
    hiddenAnonymous: number;
    zkAnonymous: number;
    legacyServerVisiblePseudonymous: number;
}

export interface AnonymousGovernanceCredentialRow {
    epoch: number;
    rootHash: string;
    maskedRootHash: string;
    revocationRootHash: string;
    maskedRevocationRootHash: string;
    status: string;
    revocationCount: number;
    updatedAtUtc: string;
    expiresAtUtc: string;
    graceExpiresAtUtc: string;
}

export interface AnonymousGovernanceNullifierListResponse {
    items: AnonymousGovernanceNullifierRow[];
}

export interface AnonymousGovernanceNullifierRow {
    scope: string;
    nullifierHash: string;
    maskedHash: string;
    status: string;
    useCount: number;
    firstCommentId: number | null;
    lastCommentId: number | null;
    blockReason: string | null;
    createdAtUtc: string;
    updatedAtUtc: string;
    blockHistory: AnonymousGovernanceBlockHistoryItem[];
}

export interface AnonymousGovernanceBlockHistoryItem {
    status: string;
    reason: string | null;
    updatedAtUtc: string;
}

export interface AnonymousGovernanceNullifierBlockRequest {
    nullifierHash: string;
    scope: string;
    reason?: string | null;
}

export interface AnonymousGovernanceCredentialRevokeRequest {
    epoch: number;
    rootHash: string;
    revocationHandleHash: string;
    revocationRootHash: string;
    reason?: string | null;
}

export interface AnonymousGovernanceActionResponse {
    applied: boolean;
}

interface AnonymousGovernanceBinaryRequestOptions {
    requestFrame?: FrameType;
    request?: unknown;
}

const governanceHeaders = (mfaProofToken?: string | null): Headers =>
{
    const headers = new Headers();
    headers.set(FSUS_HEADERS.deviceFingerprint, getBrowserFp());
    const proofToken = mfaProofToken?.trim();
    if (proofToken)
    {
        headers.set(ADMIN_SENSITIVE_MFA_HEADER, proofToken);
    }

    return headers;
};

function governanceBody(frameType: FrameType, request: unknown): ArrayBuffer
{
    return encodeAedsFrame(frameType, encodeJsonRequest(request));
}

function requestAnonymousGovernanceBinary<T>(
    binaryRoute: BinaryRouteRequest,
    config?: ApiRequestConfig,
    options: AnonymousGovernanceBinaryRequestOptions = {}
): Promise<T>
{
    const requestOptions: NonNullable<BinaryTransportRequest['requestOptions']> = {
        headers: governanceHeaders(config?.mfaProofToken)
    };
    if (options.requestFrame !== undefined)
    {
        requestOptions.body = governanceBody(options.requestFrame, options.request);
    }

    return requestBinaryOnly<T>({
        binaryRoute,
        frameType: FrameType.AnonymousGovernanceActionResponse,
        requestOptions,
        signal: config?.signal
    });
}

export function getAnonymousGovernanceStatus(config?: ApiRequestConfig): Promise<AnonymousGovernanceStatusResponse>
{
    return requestAnonymousGovernanceBinary<AnonymousGovernanceStatusResponse>(
        { operationId: 'binary_get_admin_anonymous_governance_status' },
        config
    );
}

export function listAnonymousGovernanceNullifiers(config?: ApiRequestConfig): Promise<AnonymousGovernanceNullifierListResponse>
{
    return requestAnonymousGovernanceBinary<AnonymousGovernanceNullifierListResponse>(
        { operationId: 'binary_get_admin_anonymous_governance_nullifiers' },
        config
    );
}

export function blockAnonymousGovernanceNullifier(
    request: AnonymousGovernanceNullifierBlockRequest,
    config?: ApiRequestConfig
): Promise<AnonymousGovernanceActionResponse>
{
    return requestAnonymousGovernanceBinary<AnonymousGovernanceActionResponse>(
        { operationId: 'binary_post_admin_anonymous_governance_nullifiers_block' },
        config,
        {
            requestFrame: FrameType.AnonymousGovernanceActionRequest,
            request
        }
    );
}

export function revokeAnonymousGovernanceCredential(
    request: AnonymousGovernanceCredentialRevokeRequest,
    config?: ApiRequestConfig
): Promise<AnonymousGovernanceActionResponse>
{
    return requestAnonymousGovernanceBinary<AnonymousGovernanceActionResponse>(
        { operationId: 'binary_post_admin_anonymous_governance_credentials_revoke' },
        config,
        {
            requestFrame: FrameType.AnonymousGovernanceActionRequest,
            request
        }
    );
}
