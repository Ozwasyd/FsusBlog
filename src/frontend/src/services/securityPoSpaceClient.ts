import type { PoSpaceUnsupportedReason } from '@/generated/poSpaceV1Contract';
import { toTrustedApplicationWorkerScriptUrl } from '@/security/trustedTypesRuntime';
import { AppErrorCode, createAppError } from '@/utils/appError';
import poSpaceWorkerUrl from '@/workers/security/pospace.worker.ts?worker&url';

import type { PoSpaceCapabilitySnapshot } from './securityPoSpaceRuntime';

export interface PoSpaceAssignmentRequest {
    challengeId: string;
    action: string;
    routeKey: string;
    subjectHash: string;
    clientIpHash: string;
    deviceFpHash: string;
    policyVersion: string;
}

export interface PoSpaceWorkerHints {
    hardwareConcurrency?: number;
    deviceMemoryGb?: number;
    userAgent?: string;
    mobileHint?: boolean;
    forceSlowDevice?: boolean;
}

export interface PoSpaceWorkerSolveSuccess {
    ok: true;
    nonceHex: string;
    proofHex: string;
    durationMs: number;
    capability: PoSpaceCapabilitySnapshot;
}

export interface PoSpaceWorkerUnsupported {
    ok: false;
    unsupported: true;
    reason: PoSpaceUnsupportedReason;
    capability: PoSpaceCapabilitySnapshot;
}

export type PoSpaceWorkerSolveResult = PoSpaceWorkerSolveSuccess | PoSpaceWorkerUnsupported;

export interface PoSpaceWorkerClient {
    capability(payload: Record<string, unknown>, options?: { hints?: PoSpaceWorkerHints; forceWorkerFailure?: boolean; }): Promise<PoSpaceCapabilitySnapshot>;
    solve(
        assignment: PoSpaceAssignmentRequest,
        payload: Record<string, unknown>,
        options?: { hints?: PoSpaceWorkerHints; nonceHex?: string; forceWorkerFailure?: boolean; }
    ): Promise<PoSpaceWorkerSolveResult>;
    dispose(): void;
}

type PoSpaceWorkerResponse =
  | {
      v: 1;
      type: 'capability';
      requestId: number;
      ok: true;
      capability: PoSpaceCapabilitySnapshot;
  }
  | {
      v: 1;
      type: 'solved';
      requestId: number;
      ok: true;
      nonceHex: string;
      proofHex: string;
      durationMs: number;
      capability: PoSpaceCapabilitySnapshot;
  }
  | {
      v: 1;
      type: 'unsupported';
      requestId: number;
      ok: false;
      unsupported: true;
      reason: PoSpaceUnsupportedReason;
      capability: PoSpaceCapabilitySnapshot;
  }
  | {
      v: 1;
      type: 'error';
      requestId: number;
      ok: false;
      error: string;
  };

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeoutId: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30000;

export function createPoSpaceWorkerClient(timeoutMs = DEFAULT_TIMEOUT_MS): PoSpaceWorkerClient
{
    let worker: Worker | null = null;
    let requestId = 0;
    const pending = new Map<number, PendingRequest>();

    const ensureWorker = (): Worker =>
    {
        if (worker)
        {
            return worker;
        }
        if (typeof Worker === 'undefined')
        {
            throw createAppError(AppErrorCode.InfraFailure, 'pospace_worker_unavailable');
        }

        worker = new Worker(toTrustedApplicationWorkerScriptUrl(
            new URL(poSpaceWorkerUrl, import.meta.url)
        ) as string | URL, {
            name: 'FsusPoSpaceWorker',
            type: 'module'
        });
        worker.onmessage = (event: MessageEvent<PoSpaceWorkerResponse>) =>
        {
            const response = event.data;
            const current = pending.get(response.requestId);
            if (!current)
            {
                return;
            }
            pending.delete(response.requestId);
            clearTimeout(current.timeoutId);

            if (response.type === 'error')
            {
                current.reject(createAppError(AppErrorCode.InfraFailure, response.error));
                return;
            }
            if (response.type === 'unsupported')
            {
                current.resolve({
                    ok: false,
                    unsupported: true,
                    reason: response.reason,
                    capability: response.capability
                });
                return;
            }
            if (response.type === 'capability')
            {
                current.resolve(response.capability);
                return;
            }

            current.resolve({
                ok: true,
                nonceHex: response.nonceHex,
                proofHex: response.proofHex,
                durationMs: response.durationMs,
                capability: response.capability
            });
        };
        worker.onerror = () =>
        {
            for (const current of pending.values())
            {
                clearTimeout(current.timeoutId);
                current.reject(createAppError(AppErrorCode.InfraFailure, 'pospace_worker_failed'));
            }
            pending.clear();
            worker?.terminate();
            worker = null;
        };
        return worker;
    };

    const post = <T>(message: Record<string, unknown>): Promise<T> =>
    {
        const activeWorker = ensureWorker();
        const id = ++requestId;
        return new Promise<T>((resolve, reject) =>
        {
            const timeoutId = setTimeout(() =>
            {
                pending.delete(id);
                reject(createAppError(AppErrorCode.Timeout, 'pospace_worker_timeout'));
            }, timeoutMs);
            pending.set(id, {
                resolve: (value: unknown) => resolve(value as T),
                reject,
                timeoutId
            });
            activeWorker.postMessage({ v: 1, requestId: id, ...message });
        });
    };

    return {
        capability(payload, options)
        {
            return post<PoSpaceCapabilitySnapshot>({
                type: 'capability',
                payload,
                hints: options?.hints,
                forceWorkerFailure: options?.forceWorkerFailure
            });
        },
        solve(assignment, payload, options)
        {
            return post<PoSpaceWorkerSolveResult>({
                type: 'solve',
                assignment,
                payload,
                hints: options?.hints,
                nonceHex: options?.nonceHex,
                forceWorkerFailure: options?.forceWorkerFailure
            });
        },
        dispose()
        {
            for (const current of pending.values())
            {
                clearTimeout(current.timeoutId);
                current.reject(createAppError(AppErrorCode.InfraFailure, 'pospace_worker_disposed'));
            }
            pending.clear();
            worker?.terminate();
            worker = null;
        }
    };
}
