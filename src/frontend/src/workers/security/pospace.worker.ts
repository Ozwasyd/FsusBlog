import {
    detectPoSpaceCapability,
    parsePoSpaceAssignment,
    parsePoSpacePayload,
    solvePoSpaceProof,
    type PoSpaceCapabilitySnapshot
} from '../../services/securityPoSpaceRuntime';

type PoSpaceWorkerRequest =
  | {
      v: 1;
      type: 'capability';
      requestId: number;
      payload: Record<string, unknown>;
      hints?: Record<string, unknown>;
      forceWorkerFailure?: boolean;
  }
  | {
      v: 1;
      type: 'solve';
      requestId: number;
      assignment: Record<string, unknown>;
      payload: Record<string, unknown>;
      hints?: Record<string, unknown>;
      nonceHex?: string;
      forceWorkerFailure?: boolean;
  };

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
      reason: string;
      capability: PoSpaceCapabilitySnapshot;
  }
  | {
      v: 1;
      type: 'error';
      requestId: number;
      ok: false;
      error: string;
  };

// Dedicated workers share MessagePort's message and transferable APIs.
const ctx = self as Pick<MessagePort, 'onmessage' | 'postMessage'>;

ctx.onmessage = async (event: MessageEvent<PoSpaceWorkerRequest>) =>
{
    const request = event.data;
    if (request ? request.v !== 1 : true)
    {
        return;
    }

    try
    {
        if (request.forceWorkerFailure)
        {
            throw new Error('pospace_forced_worker_failure');
        }

        const payload = parsePoSpacePayload(request.payload);
        if (request.type === 'capability')
        {
            const response: PoSpaceWorkerResponse = {
                v: 1,
                type: 'capability',
                requestId: request.requestId,
                ok: true,
                capability: detectPoSpaceCapability(payload, normalizeHints(request.hints))
            };
            ctx.postMessage(response);
            return;
        }

        const assignment = parsePoSpaceAssignment(request.assignment);
        const solved = await solvePoSpaceProof(assignment, payload, {
            ...normalizeHints(request.hints),
            nonceHex: request.nonceHex
        });
        if (!solved.ok)
        {
            const response: PoSpaceWorkerResponse = {
                v: 1,
                type: 'unsupported',
                requestId: request.requestId,
                ok: false,
                unsupported: true,
                reason: solved.reason,
                capability: solved.capability
            };
            ctx.postMessage(response);
            return;
        }

        const response: PoSpaceWorkerResponse = {
            v: 1,
            type: 'solved',
            requestId: request.requestId,
            ok: true,
            nonceHex: solved.nonceHex,
            proofHex: solved.proofHex,
            durationMs: solved.durationMs,
            capability: solved.capability
        };
        ctx.postMessage(response);
    }
    catch (error)
    {
        const response: PoSpaceWorkerResponse = {
            v: 1,
            type: 'error',
            requestId: request.requestId,
            ok: false,
            error: error instanceof Error ? error.message : 'pospace_worker_failed'
        };
        ctx.postMessage(response);
    }
};

function normalizeHints(raw: Record<string, unknown> | undefined)
{
    if (!raw)
    {
        return undefined;
    }

    return {
        workerAvailable: true,
        hardwareConcurrency: toNumber(raw.hardwareConcurrency),
        deviceMemoryGb: toNumber(raw.deviceMemoryGb),
        userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : undefined,
        mobileHint: typeof raw.mobileHint === 'boolean' ? raw.mobileHint : undefined,
        forceSlowDevice: raw.forceSlowDevice === true
    };
}

function toNumber(value: unknown): number | undefined
{
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
