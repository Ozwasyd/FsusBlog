import {
    SecurityChallengeKind,
    type SecurityChallengeAssignment,
    type SecurityChallengeProviderPayload,
    type SecurityChallengeVerifyResponse,
    type VerifySecurityChallengeRequest
} from '@/api/security';
import {
    createPerceptionV2WorkerClient,
    type PerceptionV2WorkerClient
} from '@/services/securityPerceptionV2Client';
import { AppErrorCode, createAppError } from '@/utils/appError';
import type { RenderRecipeV2 } from '@/workers/security/perception-v2.renderer';

import type {
    PerceptionChallengeAssignment,
    PerceptionChallengeClient,
    PerceptionChallengeKind,
    PerceptionChallengeRenderPayload,
    PerceptionChallengeRenderer,
    PerceptionChallengeSubmitPayload,
    PerceptionChallengeVerifyResult
} from '@ozwasyd/element-plus/perception-challenge';

type VerifySecurityChallenge = (request: VerifySecurityChallengeRequest) => Promise<SecurityChallengeVerifyResponse>;

export interface PerceptionChallengeRuntimeOptions {
    envelopeId: string;
    assignment: SecurityChallengeAssignment;
    providerPayload: SecurityChallengeProviderPayload;
    verifyChallenge: VerifySecurityChallenge;
    workerClient?: PerceptionV2WorkerClient;
    now?: () => number;
}

export interface PerceptionChallengeRuntime {
    challenge: PerceptionChallengeAssignment;
    renderer: PerceptionChallengeRenderer;
    client: PerceptionChallengeClient;
    dispose(): void;
}

const GENERIC_PERCEPTION_FAILURE = '验证未通过，请重试。';
const GENERIC_PERCEPTION_UNAVAILABLE = '安全验证暂不可用，请稍后重试。';
const MIN_SOLVE_DURATION_MS = 750;
const FLOW_PROMPTS: Record<ActivePerceptionKind, { prompt: string; description: string; }> = {
    localization: {
        prompt: '点选图中目标位置',
        description: '完成后继续提交当前操作。'
    },
    'micro-interaction': {
        prompt: '完成一次确认操作',
        description: '完成后继续提交当前操作。'
    }
};

type ActivePerceptionKind = Extract<PerceptionChallengeKind, 'localization' | 'micro-interaction'>;

export function isPerceptionChallengeKind(kind: SecurityChallengeKind): boolean
{
    return kind === SecurityChallengeKind.PerceptionLocalizationV2
    || kind === SecurityChallengeKind.PerceptionMicroInteractionV2;
}

export function createPerceptionChallengeRuntime(options: PerceptionChallengeRuntimeOptions): PerceptionChallengeRuntime
{
    const workerClient = options.workerClient ?? createPerceptionV2WorkerClient();
    const ownsWorker = !options.workerClient;
    const startedAtUnixMs = options.now?.() ?? Date.now();
    const challenge = mapPerceptionChallengeAssignment(options.assignment, options.providerPayload);
    const renderer = createPerceptionChallengeRenderer(workerClient);

    return {
        challenge,
        renderer,
        client: {
            verify: async (payload) =>
            {
                const response = await options.verifyChallenge({
                    envelopeId: options.envelopeId,
                    challengeId: options.assignment.challengeId,
                    kind: options.assignment.kind,
                    action: options.assignment.action,
                    routeKey: options.assignment.routeKey,
                    providerPayload: buildPerceptionVerifyProviderPayload(
                        options.providerPayload.payload,
                        payload,
                        Math.max(0, (options.now?.() ?? Date.now()) - startedAtUnixMs)
                    )
                });
                return mapPerceptionVerifyResult(response);
            }
        },
        dispose()
        {
            if (ownsWorker)
            {
                workerClient.dispose();
            }
        }
    };
}

export function mapPerceptionChallengeAssignment(
    assignment: SecurityChallengeAssignment,
    providerPayload: SecurityChallengeProviderPayload
): PerceptionChallengeAssignment
{
    const recipe = parseRecipe(providerPayload.payload.recipeJson);
    const kind = resolvePerceptionKind(assignment.kind, providerPayload.payload.taskKind);
    const prompt = FLOW_PROMPTS[kind];
    const grid = resolveGrid(recipe, providerPayload.payload);

    return {
        challengeId: assignment.challengeId,
        kind,
        prompt: prompt.prompt,
        description: prompt.description,
        gridWidth: grid.width,
        gridHeight: grid.height,
        expiresAtUnixMs: assignment.expiresAtUnixMs,
        microInteractionEnabled: kind === 'micro-interaction',
        meta: {
            action: assignment.action,
            routeKey: assignment.routeKey,
            recipeJson: providerPayload.payload.recipeJson,
            recipeHashHex: providerPayload.payload.recipeHashHex,
            algorithm: providerPayload.payload.algorithm
        }
    };
}

export function createPerceptionChallengeRenderer(workerClient: PerceptionV2WorkerClient): PerceptionChallengeRenderer
{
    return {
        async render(challenge)
        {
            const recipe = parseRecipe(String(challenge.meta?.recipeJson ?? ''));
            if (!recipe)
            {
                throw createAppError(AppErrorCode.InfraFailure, GENERIC_PERCEPTION_UNAVAILABLE);
            }

            const rendered = await workerClient.render(recipe);
            if (!rendered.ok)
            {
                throw createAppError(AppErrorCode.InfraFailure, GENERIC_PERCEPTION_UNAVAILABLE);
            }

            return rendered.result as PerceptionChallengeRenderPayload;
        }
    };
}

export function buildPerceptionVerifyProviderPayload(
    issuedPayload: Record<string, string>,
    submitPayload: PerceptionChallengeSubmitPayload,
    solveDurationMs: number
): Record<string, string>
{
    const payload: Record<string, string> = {
        ...issuedPayload,
        solveDurationMs: String(Math.max(MIN_SOLVE_DURATION_MS, Math.trunc(solveDurationMs)))
    };

    if (submitPayload.kind === 'localization')
    {
        payload.x = String(submitPayload.x);
        payload.y = String(submitPayload.y);
        return payload;
    }

    if (submitPayload.kind !== 'micro-interaction')
    {
        throw createAppError(AppErrorCode.ContractViolation, GENERIC_PERCEPTION_FAILURE);
    }

    payload.stepSummary = submitPayload.steps.join(',');
    const point = parseMicroInteractionPoint(submitPayload.steps);
    if (point)
    {
        payload.x = String(point.x);
        payload.y = String(point.y);
    }
    return payload;
}

export function mapPerceptionVerifyResult(response: SecurityChallengeVerifyResponse): PerceptionChallengeVerifyResult
{
    return response.verified
        ? {
        verified: true,
        proofToken: response.proofToken,
        retryAfterMs: response.retryAfterMs
      }
        : {
        verified: false,
        reason: GENERIC_PERCEPTION_FAILURE,
        retryAfterMs: response.retryAfterMs
      };
}

function resolvePerceptionKind(kind: SecurityChallengeKind, taskKind?: string): ActivePerceptionKind
{
    const normalizedTask = normalizeToken(taskKind);
    if (kind === SecurityChallengeKind.PerceptionLocalizationV2 || normalizedTask === 'localization')
    {
        return 'localization';
    }
    if (kind === SecurityChallengeKind.PerceptionMicroInteractionV2 || normalizedTask === 'microinteraction')
    {
        return 'micro-interaction';
    }
    throw createAppError(AppErrorCode.ContractViolation, GENERIC_PERCEPTION_UNAVAILABLE);
}

function parseRecipe(value: string | undefined): RenderRecipeV2 | null
{
    if (!value?.trim())
    {
        return null;
    }

    try
    {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch
    {
        return null;
    }
}

function resolveGrid(recipe: RenderRecipeV2 | null, payload: Record<string, string>): { width: number; height: number; }
{
    const hints = recipe && typeof recipe === 'object' && 'presentationHints' in recipe
        ? (recipe.presentationHints as Record<string, unknown>)
        : {};
    const width = toPositiveInt(payload.gridWidth) || toPositiveInt(hints.canvasWidth) || toPositiveInt((recipe as { width?: unknown; } | null)?.width) || 320;
    const height = toPositiveInt(payload.gridHeight) || toPositiveInt(hints.canvasHeight) || toPositiveInt((recipe as { height?: unknown; } | null)?.height) || 180;
    return { width, height };
}

function toPositiveInt(value: unknown): number
{
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function normalizeToken(value: string | undefined): string
{
    return (value ?? '').replace(/[-_]/g, '').toLowerCase();
}

function parseMicroInteractionPoint(steps: readonly string[]): { x: number; y: number; } | null
{
    const last = steps[steps.length - 1] ?? '';
    const coordinates = last.includes(':') ? last.slice(last.lastIndexOf(':') + 1) : last;
    const [xRaw, yRaw] = coordinates.split(',', 2);
    const x = Number.parseFloat(xRaw);
    const y = Number.parseFloat(yRaw);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
