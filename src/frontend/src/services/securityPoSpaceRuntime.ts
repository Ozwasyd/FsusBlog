import { argon2idAsync } from '@noble/hashes/argon2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import {
    poSpaceV1Contract,
    type PoSpaceUnsupportedReason
} from '@/generated/poSpaceV1Contract';
import { AppErrorCode, createAppError } from '@/utils/appError';

export const POSPACE_ALGORITHM = poSpaceV1Contract.algorithm;

export interface PoSpaceProviderPayload {
    algorithm: string;
    saltHex: string;
    memoryKib: number;
    iterations: number;
    lanes: number;
    targetDurationMs: number;
}

export interface PoSpaceAssignmentContext {
    challengeId: string;
    action: string;
    routeKey: string;
    subjectHash: string;
    clientIpHash: string;
    deviceFpHash: string;
    policyVersion: string;
}

export type PoSpaceMemoryTier = 'unknown' | 'low' | 'standard' | 'high';

export interface PoSpaceCapabilitySnapshot {
    supported: boolean;
    reason: 'supported' | PoSpaceUnsupportedReason;
    memoryTier: PoSpaceMemoryTier;
    hardwareConcurrency: number;
    mobileHint: boolean;
    maxAllowedMemoryKib: number;
    requestedMemoryKib: number;
    workerAvailable: boolean;
}

export interface PoSpaceEnvironmentHints {
    workerAvailable?: boolean;
    hardwareConcurrency?: number;
    deviceMemoryGb?: number;
    userAgent?: string;
    mobileHint?: boolean;
    forceSlowDevice?: boolean;
}

export interface PoSpaceSolveOptions extends PoSpaceEnvironmentHints {
    nonceHex?: string;
}

export type PoSpaceSolveResult =
  | {
      ok: true;
      nonceHex: string;
      proofHex: string;
      durationMs: number;
      capability: PoSpaceCapabilitySnapshot;
  }
  | {
      ok: false;
      unsupported: true;
      reason: PoSpaceUnsupportedReason;
      capability: PoSpaceCapabilitySnapshot;
  };

export function parsePoSpacePayload(raw: Record<string, unknown>): PoSpaceProviderPayload
{
    const payload: PoSpaceProviderPayload = {
        algorithm: requireString(raw.algorithm, 'algorithm'),
        saltHex: requireHex(raw.saltHex, 16, 'saltHex'),
        memoryKib: requireInteger(raw.memoryKib, 'memoryKib'),
        iterations: requireInteger(raw.iterations, 'iterations'),
        lanes: requireInteger(raw.lanes, 'lanes'),
        targetDurationMs: requireInteger(raw.targetDurationMs, 'targetDurationMs')
    };

    if (payload.algorithm !== POSPACE_ALGORITHM)
    {
        throw createAppError(AppErrorCode.Validation, 'pospace_algorithm_unsupported');
    }
    if (!isValidParameters(payload))
    {
        throw createAppError(AppErrorCode.Validation, 'pospace_parameters_invalid');
    }
    return payload;
}

export function parsePoSpaceAssignment(raw: Record<string, unknown>): PoSpaceAssignmentContext
{
    return {
        challengeId: requireString(raw.challengeId, 'challengeId'),
        action: requireString(raw.action, 'action'),
        routeKey: requireString(raw.routeKey, 'routeKey'),
        subjectHash: requireHex(raw.subjectHash, 32, 'subjectHash'),
        clientIpHash: requireHex(raw.clientIpHash, 32, 'clientIpHash'),
        deviceFpHash: requireHex(raw.deviceFpHash, 32, 'deviceFpHash'),
        policyVersion: requireString(raw.policyVersion, 'policyVersion')
    };
}

export function detectPoSpaceCapability(
    payload: PoSpaceProviderPayload,
    hints: PoSpaceEnvironmentHints = {}
): PoSpaceCapabilitySnapshot
{
    const workerAvailable = hints.workerAvailable ?? typeof Worker !== 'undefined';
    const nav = typeof navigator === 'undefined'
        ? undefined
        : navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean; }; };
    const hardwareConcurrency = hints.hardwareConcurrency ?? nav?.hardwareConcurrency ?? 1;
    const hintedUserAgent = hints.userAgent;
    const userAgent = hintedUserAgent ?? nav?.userAgent ?? '';
    const mobileHint = hints.mobileHint
    ?? (hintedUserAgent ? isMobileUserAgent(hintedUserAgent) : nav?.userAgentData?.mobile ?? isMobileUserAgent(userAgent));
    const deviceMemoryGb = hints.deviceMemoryGb ?? nav?.deviceMemory;
    const memoryTier = resolveMemoryTier(deviceMemoryGb);
    const maxAllowedMemoryKib = mobileHint
        ? 0
        : memoryTier === 'low'
      ? 0
      : poSpaceV1Contract.memoryKib.max;

    let supported = true;
    let reason: PoSpaceCapabilitySnapshot['reason'] = 'supported';
    if (!workerAvailable)
    {
        supported = false;
        reason = 'worker_unavailable';
    }
    else if (hints.forceSlowDevice || hardwareConcurrency <= 1)
    {
        supported = false;
        reason = 'slow_device';
    }
    else if (payload.memoryKib > maxAllowedMemoryKib)
    {
        supported = false;
        reason = mobileHint ? 'mobile_memory_cap' : 'memory_tier_cap';
    }

    return {
        supported,
        reason,
        memoryTier,
        hardwareConcurrency,
        mobileHint,
        maxAllowedMemoryKib,
        requestedMemoryKib: payload.memoryKib,
        workerAvailable
    };
}

export async function solvePoSpaceProof(
    assignment: PoSpaceAssignmentContext,
    payload: PoSpaceProviderPayload,
    options: PoSpaceSolveOptions = {}
): Promise<PoSpaceSolveResult>
{
    const capability = detectPoSpaceCapability(payload, {
        ...options,
        workerAvailable: options.workerAvailable ?? true
    });
    if (!capability.supported)
    {
        if (capability.reason === 'supported')
        {
            throw createAppError(AppErrorCode.InfraFailure, 'pospace_capability_state_invalid');
        }
        return {
            ok: false,
            unsupported: true,
            reason: capability.reason,
            capability
        };
    }

    const nonceHex = options.nonceHex ? requireHex(options.nonceHex, poSpaceV1Contract.nonceBytes, 'nonceHex') : createNonceHex();
    const startedAt = nowMs();
    const proofBytes = await argon2idAsync(createMaterial(assignment, payload, nonceHex), hexToBytes(payload.saltHex), {
        t: payload.iterations,
        m: payload.memoryKib,
        p: payload.lanes,
        dkLen: poSpaceV1Contract.proofBytes,
        asyncTick: 10,
        maxmem: payload.memoryKib * 1024 + 1024 * 1024
    });
    return {
        ok: true,
        nonceHex,
        proofHex: bytesToHex(proofBytes),
        durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
        capability
    };
}

export function createPoSpaceVerifyPayload(
    issuePayload: Record<string, unknown>,
    nonceHex: string,
    proofHex: string
): Record<string, string>
{
    const parsed = parsePoSpacePayload(issuePayload);
    return {
        algorithm: parsed.algorithm,
        saltHex: parsed.saltHex,
        memoryKib: parsed.memoryKib.toString(),
        iterations: parsed.iterations.toString(),
        lanes: parsed.lanes.toString(),
        targetDurationMs: parsed.targetDurationMs.toString(),
        nonceHex: requireHex(nonceHex, poSpaceV1Contract.nonceBytes, 'nonceHex'),
        proofHex: requireHex(proofHex, poSpaceV1Contract.proofBytes, 'proofHex')
    };
}

export function createPoSpaceUnsupportedReissueAttributes(
    assignment: Pick<PoSpaceAssignmentContext, 'challengeId' | 'action' | 'routeKey'>,
    reason: PoSpaceUnsupportedReason,
    reissueCount: number
): Record<string, unknown>
{
    if (!poSpaceV1Contract.unsupportedReasons.includes(reason)
    || !Number.isSafeInteger(reissueCount)
    || reissueCount < 1
    || reissueCount > poSpaceV1Contract.maxUnsupportedReissues)
    {
        throw createAppError(AppErrorCode.Validation, 'pospace_unsupported_reissue_invalid');
    }

    return {
        unsupportedAssignment: {
            challengeId: requireString(assignment.challengeId, 'challengeId'),
            kind: 'argon2idPoSpaceV1',
            action: requireString(assignment.action, 'action'),
            routeKey: requireString(assignment.routeKey, 'routeKey'),
            reason,
            reissueCount
        }
    };
}

function createMaterial(assignment: PoSpaceAssignmentContext, payload: PoSpaceProviderPayload, nonceHex: string): Uint8Array
{
    return utf8ToBytes([
        poSpaceV1Contract.materialDomain,
        assignment.challengeId,
        assignment.action,
        assignment.routeKey,
        assignment.subjectHash,
        assignment.clientIpHash,
        assignment.deviceFpHash,
        assignment.policyVersion,
        nonceHex,
        payload.targetDurationMs.toString()
    ].join('\n'));
}

function isValidParameters(payload: PoSpaceProviderPayload): boolean
{
    return payload.memoryKib >= poSpaceV1Contract.memoryKib.min && payload.memoryKib <= poSpaceV1Contract.memoryKib.max
    && payload.iterations >= poSpaceV1Contract.iterations.min && payload.iterations <= poSpaceV1Contract.iterations.max
    && payload.lanes >= poSpaceV1Contract.lanes.min && payload.lanes <= poSpaceV1Contract.lanes.max
    && payload.targetDurationMs >= poSpaceV1Contract.targetDurationMs.min && payload.targetDurationMs <= poSpaceV1Contract.targetDurationMs.max;
}

function resolveMemoryTier(deviceMemoryGb?: number): PoSpaceMemoryTier
{
    if (typeof deviceMemoryGb !== 'number' || !Number.isFinite(deviceMemoryGb) || deviceMemoryGb <= 0)
    {
        return 'unknown';
    }
    if (deviceMemoryGb < 4)
    {
        return 'low';
    }
    return deviceMemoryGb >= 8 ? 'high' : 'standard';
}

function createNonceHex(): string
{
    const nonce = new Uint8Array(poSpaceV1Contract.nonceBytes);
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function')
    {
        throw createAppError(AppErrorCode.InfraFailure, 'pospace_crypto_unavailable');
    }
    crypto.getRandomValues(nonce);
    return bytesToHex(nonce);
}

function requireString(value: unknown, field: string): string
{
    const normalized = String(value ?? '').trim();
    if (normalized.length === 0)
    {
        throw createAppError(AppErrorCode.Validation, `pospace_${field}_missing`);
    }
    return normalized;
}

function requireInteger(value: unknown, field: string): number
{
    const canonical = String(value ?? '');
    if (!/^(?:0|[1-9][0-9]*)$/.test(canonical))
    {
        throw createAppError(AppErrorCode.Validation, `pospace_${field}_invalid`);
    }
    const parsed = Number(canonical);
    if (!Number.isSafeInteger(parsed) || String(parsed) !== canonical)
    {
        throw createAppError(AppErrorCode.Validation, `pospace_${field}_invalid`);
    }
    return parsed;
}

function requireHex(value: unknown, bytes: number, field: string): string
{
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized.length !== bytes * 2 || !/^[0-9a-f]+$/.test(normalized))
    {
        throw createAppError(AppErrorCode.Validation, `pospace_${field}_invalid`);
    }
    return normalized;
}

function isMobileUserAgent(userAgent: string): boolean
{
    return /android|iphone|ipad|mobile/i.test(userAgent);
}

function nowMs(): number
{
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}
