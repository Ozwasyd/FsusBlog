import type { AedsAccessProfileId } from '@/generated/aedsAccessProfiles';
import type { FsusBinaryOperationId } from '@/generated/fsusBinaryRoutes';

import type { FrameType } from '@wasm/protocol/frame';

import type {
    RiskChallengeFailureReason,
    RiskChallengeHandoff,
    RiskChallengeProofContext,
    RiskControlDecision
} from './riskChallenge';

export const binaryDecodeWorkerProtocolVersion = 1 as const;

export type PrivateRequestScope = 'public' | 'account' | 'admin';

export interface SliceRef { offset: number; length: number; }

export interface BinaryRequestOptions extends RequestInit {
    requiresPow?: boolean;
    powScope?: string;
    riskChallengeProof?: RiskChallengeProofContext;
    onResponseHeaders?: (headers: Headers) => void;
}

export interface PowParams {
    nonce: string;
    salt: string;
    fp: string;
    signature: string;
    difficulty: number;
    timestamp: number;
}

export type BinaryFramePayloadDecoder = (frameType: FrameType, payload: Uint8Array, accessProfile?: AedsAccessProfileId) => unknown;

export interface BinaryRouteRequest {
    operationId: FsusBinaryOperationId;
    params?: Record<string, string | number | bigint>;
    query?: URLSearchParams | Record<string, string | number | boolean | null | undefined>;
}

export interface BinaryTransportRequest {
    binaryUrl?: string;
    binaryRoute?: BinaryRouteRequest;
    frameType: FrameType;
    requestOptions?: BinaryRequestOptions;
    signal?: AbortSignal;
    suppressAuthFailureTelemetry?: boolean;
    accessProfile?: AedsAccessProfileId;
    /** Required by the static gate for legacy binaryUrl calls. Generated routes infer it from auth metadata. */
    privateScope?: PrivateRequestScope;
}

export type TransportFailureKind =
  | 'binary_disabled'
  | 'auth_failed'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'precondition_required'
  | 'rate_limited'
  | 'public_artifact_not_ready'
  | 'client_route_contract'
  | 'accept_contract'
  | 'network'
  | 'decode_failed';

export interface TransportFailure {
    kind: TransportFailureKind;
    message: string;
    status?: number;
    traceId?: string;
    backendCode?: number;
    backendCategory?: number;
    details?: string;
    retryAfter?: string | null;
    canceled?: boolean;
    riskChallengeFailure?: RiskChallengeFailureReason;
    riskChallengeHandoff?: RiskChallengeHandoff;
    riskControlDecision?: RiskControlDecision;
}

export interface BinaryDecodeSuccess<T> {
    ok: true;
    value: T;
}

export interface BinaryDecodeFailure {
    ok: false;
    failure: TransportFailure;
}

export type BinaryDecodeResult<T> = BinaryDecodeSuccess<T> | BinaryDecodeFailure;

export type DecodeErrorCode =
  | 'none'
  | 'wasm_init_failed'
  | 'decode_failed'
  | 'frame_type_unexpected'
  | 'crc_failed'
  | 'payload_out_of_range'
  | 'schema_mismatch'
  | 'pod_parse_failed';

export interface DecodeWorkerRequest {
    v: typeof binaryDecodeWorkerProtocolVersion;
    type?: 'decode';
    requestId: number;
    buffer: ArrayBuffer;
    expectedFrameType?: number;
    sentAtUnixMs?: number;
    accessProfile?: AedsAccessProfileId;
}

export interface CancelWorkerRequest {
    v: typeof binaryDecodeWorkerProtocolVersion;
    type: 'cancel';
    requestId: number;
}

export type BinaryWorkerRequest = DecodeWorkerRequest | CancelWorkerRequest;

export interface DecodeWorkerResponse {
    v: typeof binaryDecodeWorkerProtocolVersion;
    requestId: number;
    ok: boolean;
    frameType?: number;
    data?: unknown;
    errorCode: DecodeErrorCode;
    error?: string;
    workerTransferMs?: number;
    diagnostics?: import('@wasm/aeds').AedsRuntimeDiagnostics;
}
