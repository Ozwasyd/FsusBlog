import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const DEFAULT_STEP_DEADLINE_MS = 120_000;

function positiveNumber(value)
{
    if (value === undefined || String(value).trim() === '')
    {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function firstPositive(env, names)
{
    for (const name of names)
    {
        const value = positiveNumber(env[name]);
        if (value !== undefined)
        {
            return value;
        }
    }
    return undefined;
}

function boundedTimeout(baseMs, multiplier, stepDeadlineMs, deadlineShare)
{
    const scaled = Math.ceil(baseMs * multiplier);
    const deadlineCap = Math.max(baseMs, Math.floor(stepDeadlineMs * deadlineShare));
    return Math.max(baseMs, Math.min(scaled, deadlineCap));
}

/**
 * @param {{ env?: Record<string, string | undefined>; cpuCount?: number; }} [options]
 */
export function resolveRuntimeBrowserTimeoutPlan({
    env = process.env,
    cpuCount = os.availableParallelism?.() ?? os.cpus().length
} = {})
{
    const machineCpuCount = Math.max(1, Math.floor(positiveNumber(cpuCount) ?? 1));
    const cpuGrant = Math.min(machineCpuCount, firstPositive(env, [
        'FSUSBLOG_STEP_CPU_BUDGET',
        'FSUSBLOG_TIER_CPU_UNITS',
        'FSUSBLOG_BUNDLE_CPU_UNITS',
        'FSUSBLOG_BUNDLE_CPU_BUDGET'
    ]) ?? machineCpuCount);
    const stepDeadlineMs = Math.floor(
        positiveNumber(env.FSUSBLOG_STEP_DEADLINE_MS)
      ?? positiveNumber(env.FSUSBLOG_TIER_DEADLINE_MS)
      ?? positiveNumber(env.FSUSBLOG_BUNDLE_DEADLINE_MS)
      ?? DEFAULT_STEP_DEADLINE_MS
    );
    const activeParallelWorkers = Math.max(1, Math.floor(
        positiveNumber(env.FSUSBLOG_PARALLEL_ACTIVE_WORKERS) ?? 1
    ));
    const effectiveCpuGrant = Math.max(
        1 / activeParallelWorkers,
        cpuGrant / activeParallelWorkers
    );
    // A scheduler grant below the physical CPU count means browser startup,
    // renderer work and the Vite transform pipeline are sharing the host. A
    // RunParallel child must also account for its dynamically reported sibling
    // count: the parent grant belongs to the whole pool, not to every child.
    // Scale sub-operation timeouts sub-linearly so contention tolerance grows
    // without allowing one navigation to consume the complete step deadline.
    const contentionMultiplier = Math.sqrt(machineCpuCount / effectiveCpuGrant);

    return {
        machineCpuCount,
        cpuGrant,
        activeParallelWorkers,
        effectiveCpuGrant,
        stepDeadlineMs,
        contentionMultiplier,
        navigationTimeoutMs: boundedTimeout(
            DEFAULT_NAVIGATION_TIMEOUT_MS,
            contentionMultiplier,
            stepDeadlineMs,
            0.6
        ),
        requestTimeoutMs: boundedTimeout(
            DEFAULT_REQUEST_TIMEOUT_MS,
            contentionMultiplier,
            stepDeadlineMs,
            0.7
        ),
        pageAuditTimeoutMs: boundedTimeout(
            DEFAULT_NAVIGATION_TIMEOUT_MS,
            contentionMultiplier,
            stepDeadlineMs,
            0.5
        )
    };
}

/**
 * @param {number} deadlineAtMs
 * @param {number} preferredMs
 * @param {number} [minimumMs]
 * @returns {number}
 */
export function remainingRuntimeTimeout(deadlineAtMs, preferredMs, minimumMs = 1_000)
{
    const remaining = Math.floor(Number(deadlineAtMs) - Date.now());
    return Math.max(1, Math.min(Math.floor(preferredMs), Math.max(minimumMs, remaining)));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain)
{
    const { requestTimeoutMs } = resolveRuntimeBrowserTimeoutPlan();
    process.stdout.write(String(requestTimeoutMs / 1_000));
}
