import { readFixedUtf8, readInt32, readInt64Number } from '@/codecs/binary/reader';
import { usePow } from '@/composables/usePow';
import type { BinaryRequestOptions } from '@/contracts/binaryTransport';
import type { RiskChallengeProofContext, RiskChallengeProofSettlement } from '@/contracts/riskChallenge';
import { securityChallengeKindWireName } from '@/security/challenge-kind-wire';
import { encodeBinaryPowProofHeader } from '@/services/powProofCodec';
import { emitRumMetric } from '@/services/telemetryBus';
import { AppError, AppErrorCode, appErrorFromStatus, createAppError, err, ok, type AppResult, unwrapResult } from '@/utils/appError';
import { getBrowserFp } from '@/utils/fingerprint';

import { decode } from '@wasm/aeds';
import { FrameType } from '@wasm/protocol/frame';


import { applyBinaryRequestHeaders, FSUS_HEADERS, withBinaryAccept } from './contracts';


export type { BinaryRequestOptions } from '@/contracts/binaryTransport';

export class BinaryRequestError extends AppError
{
    readonly status: number;
    readonly buffer: ArrayBuffer;
    readonly headers: Headers;
    readonly retryAfter: string | null;

    constructor(status: number, message: string, buffer: ArrayBuffer, code?: AppErrorCode, headers?: HeadersInit)
    {
        super(code ?? appErrorFromStatus(status, message).code, message, { status });
        this.name = 'BinaryRequestError';
        this.status = status;
        this.buffer = buffer;
        this.headers = new Headers(headers);
        this.retryAfter = this.headers.get('retry-after');
    }
}

const ABORT_ERROR: DOMException | Error = Object.freeze(createAbortErrorInstance());

function createAbortErrorInstance(): DOMException | Error
{
    if (typeof DOMException !== 'undefined')
    {
        return new DOMException('The operation was aborted.', 'AbortError');
    }

    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

function createAbortError(): DOMException | Error
{
    return ABORT_ERROR;
}

function throwIfAborted(signal?: AbortSignal): void
{
    if (signal?.aborted)
    {
        throw createAbortError();
    }
}

interface InFlightBinaryRequest {
    controller: AbortController;
    promise: Promise<AppResult<ArrayBuffer>>;
    waiters: Set<symbol>;
}

const DEFAULT_POW_SCOPE = 'mutation';
const DEFAULT_POW_TIMEOUT_MS = 60_000;
const inFlightBinaryRequests = new Map<string, InFlightBinaryRequest>();

export function resolveBinaryTransportUrl(url: string): string
{
    if (typeof globalThis.location !== 'undefined')
    {
        return new URL(url, globalThis.location.href).toString();
    }

    return new URL(url, 'http://localhost').toString();
}

async function buildBinaryPowHeadersFresh(fp: string, signal?: AbortSignal): Promise<Record<string, string>>
{
    throwIfAborted(signal);

    const { calculate } = usePow();
    const challengeResponse = await fetch(resolveBinaryTransportUrl('/api/binary/auth/pow-challenge?_t=' + Date.now()), {
        credentials: 'include',
        headers: withBinaryAccept(),
        signal
    });
    throwIfAborted(signal);

    const challengeBuffer = await challengeResponse.arrayBuffer();
    throwIfAborted(signal);

    if (!challengeResponse.ok)
    {
        throw new BinaryRequestError(challengeResponse.status, `Binary request failed: ${challengeResponse.status}`, challengeBuffer, undefined, challengeResponse.headers);
    }

    const raw = decodePowChallenge(challengeBuffer);
    const { salt, difficulty, timestamp, signature } = raw;
    if (!salt || !signature)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'POW_CHALLENGE_PARSE_FAILED');
    }

    throwIfAborted(signal);
    const { nonce } = await calculate(salt, fp, difficulty, DEFAULT_POW_TIMEOUT_MS, signal);
    throwIfAborted(signal);

    return {
        [FSUS_HEADERS.deviceFingerprint]: fp,
        [FSUS_HEADERS.powProof]: encodeBinaryPowProofHeader({ salt, nonce, timestamp, difficulty, signature, browserFp: fp })
    };
}

export async function buildBinaryPowHeaders(signal?: AbortSignal, powScope: string = DEFAULT_POW_SCOPE): Promise<Record<string, string>>
{
    throwIfAborted(signal);

    const fp = getBrowserFp();
    void powScope;
    return await buildBinaryPowHeadersFresh(fp, signal);
}

function derivePowScope(url: string, options?: BinaryRequestOptions): string
{
    if (options?.powScope)
    {
        return options.powScope;
    }

    const method = (options?.method ?? 'GET').toUpperCase();
    return `${method}:${url}`;
}

async function buildPowHeadersIfNeeded(url: string, options?: BinaryRequestOptions): Promise<Record<string, string>>
{
    if (!options?.requiresPow || url.includes('pow-challenge'))
    {
        return {};
    }

    return await buildBinaryPowHeaders(options.signal ?? undefined, derivePowScope(url, options));
}

function isStateChangingRequest(options?: BinaryRequestOptions): boolean
{
    const method = (options?.method ?? 'GET').toUpperCase();
    return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function hashRequestBody(body: BodyInit | null | undefined): string
{
    if (body === undefined || body === null)
    {
        return 'no-body';
    }

    if (typeof body === 'string')
    {
        return `text:${body}`;
    }

    if (body instanceof URLSearchParams)
    {
        return `search:${body.toString()}`;
    }

    if (body instanceof ArrayBuffer)
    {
        return hashBytes(new Uint8Array(body));
    }

    if (ArrayBuffer.isView(body))
    {
        return hashBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
    }

    return `object:${Object.prototype.toString.call(body)}`;
}

function hashBytes(bytes: Uint8Array): string
{
    let hash = 2166136261;
    for (const byte of bytes)
    {
        hash ^= byte;
        hash = Math.imul(hash, 16777619);
    }

    return `bytes:${bytes.byteLength}:${hash >>> 0}`;
}

function shouldDedupeBinaryRequest(url: string, options?: BinaryRequestOptions): boolean
{
    if (options?.requiresPow
    || options?.riskChallengeProof
    || options?.onResponseHeaders
    || url.includes('pow-challenge'))
    {
        return false;
    }

    const method = (options?.method ?? 'GET').toUpperCase();
    return method === 'GET' || method === 'HEAD';
}

function buildBinaryRequestDedupeKey(url: string, options?: BinaryRequestOptions): string
{
    const method = (options?.method ?? 'GET').toUpperCase();
    return `${method}:${url}:${hashRequestBody(options?.body ?? null)}`;
}

function emitBinaryDedupMetric(hit: boolean): void
{
    emitRumMetric('fsus.frontend.binary.dedup.hit_ratio', {
        value: hit ? 1 : 0,
        hit
    });
}

function waitForInFlightBinaryRequest(entry: InFlightBinaryRequest, signal?: AbortSignal): Promise<AppResult<ArrayBuffer>>
{
    return new Promise((resolve, reject) =>
    {
        const waiter = Symbol('binary-request-waiter');
        let settled = false;

        const cleanup = () =>
        {
            signal?.removeEventListener('abort', onAbort);
            entry.waiters.delete(waiter);
        };

        const onAbort = () =>
        {
            if (settled)
            {
                return;
            }

            settled = true;
            cleanup();
            reject(createAbortError());
            if (entry.waiters.size === 0)
            {
                entry.controller.abort();
            }
        };

        entry.waiters.add(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });

        entry.promise.then(
            (result) =>
            {
                if (settled)
                {
                    return;
                }

                settled = true;
                cleanup();
                resolve(cloneBinaryRequestResult(result));
            },
            (reason) =>
            {
                if (settled)
                {
                    return;
                }

                settled = true;
                cleanup();
                reject(reason);
            }
        );

        if (signal?.aborted)
        {
            onAbort();
        }
    });
}

function cloneBinaryRequestResult(result: AppResult<ArrayBuffer>): AppResult<ArrayBuffer>
{
    if (!result.ok)
    {
        return result;
    }

    return ok(result.value.slice(0));
}

function readCookieValue(name: string): string
{
    if (typeof document === 'undefined')
    {
        return '';
    }

    const prefix = `${name}=`;
    for (const item of document.cookie.split(';'))
    {
        const trimmed = item.trim();
        if (trimmed.startsWith(prefix))
        {
            return decodeURIComponent(trimmed.slice(prefix.length));
        }
    }

    return '';
}

export function readCsrfToken(): string
{
    if (typeof document === 'undefined')
    {
        return '';
    }

    const metaToken = document.querySelector<HTMLMetaElement>('meta[name="fsus-csrf-token"]')?.content?.trim();
    if (metaToken)
    {
        return metaToken;
    }

    return readCookieValue('XSRF-TOKEN').trim();
}

function applyCsrfHeader(headers: Headers, options?: BinaryRequestOptions): void
{
    if (options?.credentials === 'omit' || !isStateChangingRequest(options) || headers.has(FSUS_HEADERS.csrfToken))
    {
        return;
    }

    const token = readCsrfToken();
    if (token)
    {
        headers.set(FSUS_HEADERS.csrfToken, token);
    }
}

function decodePowChallenge(buffer: ArrayBuffer): { salt: string; difficulty: number; timestamp: number; signature: string; }
{
    const frame = decode(buffer);
    if (!frame.ok || frame.frameType !== FrameType.PowChallenge)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, frame.ok ? 'POW_CHALLENGE_FRAME_UNEXPECTED' : 'POW_CHALLENGE_DECODE_FAILED');
    }

    const payload = frame.payloadView;
    if (payload.byteLength !== 204)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'POW_CHALLENGE_PAYLOAD_INVALID');
    }

    return {
        salt: readFixedUtf8(payload, 0, 64),
        difficulty: readInt32(payload, 64),
        timestamp: readInt64Number(payload, 68),
        signature: readFixedUtf8(payload, 76, 128)
    };
}

async function binaryRequestResultFresh(url: string, options?: BinaryRequestOptions): Promise<AppResult<ArrayBuffer>>
{
    const proofContext = options?.riskChallengeProof;
    let proofInFlight = false;
    let powHeaders: Record<string, string>;
    try
    {
        powHeaders = await buildPowHeadersIfNeeded(url, options);
    }
    catch (error)
    {
        proofContext?.settle('before_send_cancelled');
        throw error;
    }
    const headers = new Headers(options?.headers);
    if (options?.credentials === 'omit')
    {
        headers.delete('authorization');
        headers.delete('cookie');
    }
    applyBinaryRequestHeaders(headers, options?.body !== undefined);
    applyCsrfHeader(headers, options);
    for (const [key, value] of Object.entries(powHeaders))
    {
        headers.set(key, value);
    }

    if (proofContext)
    {
        applyRiskChallengeProofHeaders(headers, proofContext);
        try
        {
            throwIfAborted(options?.signal ?? undefined);
        }
        catch (error)
        {
            proofContext.settle('before_send_cancelled');
            throw error;
        }
        if (!proofContext.markInFlight())
        {
            throw createAppError(AppErrorCode.Conflict, 'risk_challenge_proof_reservation_lost');
        }
        proofInFlight = true;
    }

    const {
        riskChallengeProof: _riskChallengeProof,
        onResponseHeaders,
        ...fetchOptions
    } = options ?? {};
    let response: Response;
    try
    {
        response = await fetch(resolveBinaryTransportUrl(url), {
            credentials: 'include',
            ...fetchOptions,
            headers
        });
        onResponseHeaders?.(new Headers(response.headers));
    }
    catch (error)
    {
        if (proofInFlight)
        {
            proofContext?.settle('unknown_network');
        }
        throw error;
    }

    let buffer: ArrayBuffer;
    try
    {
        buffer = await response.arrayBuffer();
    }
    catch (error)
    {
        if (proofInFlight)
        {
            proofContext?.settle('unknown_network');
        }
        throw error;
    }

    if (proofInFlight)
    {
        proofContext?.settle(settlementFromRiskChallengeResponse(response));
    }

    if (!response.ok)
    {
        return err(new BinaryRequestError(response.status, `Binary request failed: ${response.status}`, buffer, appErrorFromStatus(response.status, `Binary request failed: ${response.status}`).code, response.headers));
    }

    return ok(buffer);
}

function applyRiskChallengeProofHeaders(headers: Headers, context: RiskChallengeProofContext): void
{
    const { proof } = context;
    if (
        !proof.action.trim()
    || !proof.routeKey.trim()
    || !proof.challengeId.trim()
    || !proof.proofToken.trim()
    || !proof.policyVersion.trim()
    || !Number.isFinite(proof.expiresAtUnixMs)
    || securityChallengeKindWireName(proof.kind) === 'unknown'
    )
    {
        context.settle('before_send_cancelled');
        throw createAppError(AppErrorCode.Validation, 'risk_challenge_proof_context_invalid');
    }

    headers.set(FSUS_HEADERS.challengeProof, proof.proofToken);
    headers.set(FSUS_HEADERS.challengeId, proof.challengeId);
    headers.set(FSUS_HEADERS.challengeKind, securityChallengeKindWireName(proof.kind));
}

function settlementFromRiskChallengeResponse(response: Response): RiskChallengeProofSettlement
{
    if (response.ok)
    {
        return 'accepted';
    }

    const outcome = response.headers.get(FSUS_HEADERS.challengeProofOutcome);
    switch (outcome)
    {
        case 'expired':
            return 'expired';
        case 'replayed_or_missing':
            return 'replayed';
        case 'binding_mismatch':
            return 'binding_mismatch';
        case 'revoked':
            return 'revoked';
        case 'rejected':
            return 'rejected';
        default:
            return response.status === 428 ? 'rejected' : 'business_rejected';
    }
}

async function binaryRequestResult(url: string, options?: BinaryRequestOptions): Promise<AppResult<ArrayBuffer>>
{
    try
    {
        throwIfAborted(options?.signal ?? undefined);
    }
    catch (error)
    {
        options?.riskChallengeProof?.settle('before_send_cancelled');
        throw error;
    }

    if (!shouldDedupeBinaryRequest(url, options))
    {
        return await binaryRequestResultFresh(url, options);
    }

    const inFlightKey = buildBinaryRequestDedupeKey(url, options);
    let entry = inFlightBinaryRequests.get(inFlightKey);

    if (!entry)
    {
        emitBinaryDedupMetric(false);
        const controller = new AbortController();
        const requestOptions: BinaryRequestOptions = {
            ...(options ?? {}),
            signal: controller.signal
        };
        const promise = binaryRequestResultFresh(url, requestOptions).finally(() =>
        {
            inFlightBinaryRequests.delete(inFlightKey);
        });
        entry = {
            controller,
            promise,
            waiters: new Set()
        };
        inFlightBinaryRequests.set(inFlightKey, entry);
    }
    else
    {
        emitBinaryDedupMetric(true);
    }

    return await waitForInFlightBinaryRequest(entry, options?.signal ?? undefined);
}

export async function binaryRequest(url: string, options?: BinaryRequestOptions): Promise<ArrayBuffer>
{
    return unwrapResult(await binaryRequestResult(url, options));
}
