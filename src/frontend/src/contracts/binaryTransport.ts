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

/** Request-local custody only; shared dependencies are never cancellation authority. */
export interface BinaryTransportResources {
    execution: 'running' | 'ended';
    lease: 'not-opened' | 'held' | 'released' | 'cleanup-failed';
    callerAbortListener: boolean;
    cancellationRequested: boolean;
    queuedDecodes: number;
    pendingDecodes: number;
    decodeTimeouts: number;
    decodeAbortListeners: number;
    abortRaceTimers: number;
    workerTerminal: 'not-used' | 'pending' | 'observed' | 'unknown';
    sharedWorker: boolean;
    sharedWorkerIdleTimer: boolean;
    sharedWorkerCleanupPending: boolean;
    /** The network producer exposes only its public waiter result, including deduped reads. */
    networkTerminal: 'unavailable';
    sharedWasmInitialization: 'unavailable';
}

/** Raw local causes stay on the owning handle; they are not telemetry or remote receipts. */
export interface BinaryTransportLocalFailure {
    stage: 'request' | 'decode' | 'worker' | 'cancel' | 'cleanup';
    firstCause: unknown;
    cause: unknown;
    occurrences: number;
}

export interface BinaryTransportTerminal {
    local: 'observed' | 'unknown';
    resources: Readonly<BinaryTransportResources>;
    failures: readonly Readonly<BinaryTransportLocalFailure>[];
}

/** Public result and producer-observed local terminal are deliberately distinct. */
export interface BinaryTransportOperation<T> {
    readonly result: Promise<T>;
    readonly terminal: Promise<Readonly<BinaryTransportTerminal>>;
    /** Requests cancellation of this request only. It does not acknowledge terminal cleanup. */
    cancel(reason?: unknown): void;
    inspectResources(): Readonly<BinaryTransportResources>;
    inspectFailures(): readonly Readonly<BinaryTransportLocalFailure>[];
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

/** Sent only after the original decode handler has removed its request-local custody. */
export interface DecodeWorkerTerminal {
    v: typeof binaryDecodeWorkerProtocolVersion;
    type: 'terminal';
    requestId: number;
    outcome: 'completed' | 'canceled' | 'failed';
    errorCode?: DecodeErrorCode;
    error?: string;
}

export type BinaryWorkerResponse = DecodeWorkerResponse | DecodeWorkerTerminal;
