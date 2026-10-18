import { AppErrorCode, createAppError, isAppError, toAppError } from '@/utils/appError';

import { initPowModule, type PowEngineKind } from '@wasm/pow';

/**
 * FsusPow Engine - Worker
 * 统一 Wasm 规范：模块化加载、资产清单化、业务层仅关注调度与错误语义。
 */

// Dedicated workers share MessagePort's message and transferable APIs.
const ctx = self as Pick<MessagePort, 'onmessage' | 'postMessage'> & { readonly name: string; };
const workerRole = String(ctx.name || '').startsWith('FsusPowShard') ? 'shard' : 'main';

let powModule: any = null;
let modulePromise: Promise<any> | null = null;
let isWarmedUp = false;
let engineType: PowEngineKind | 'UNKNOWN' = 'UNKNOWN';
let activeShardWorkers: Worker[] = [];

const THREAD_POOL_FALLBACK_TIMEOUT_MS = 5000;
const ENABLE_THREAD_POOL_SHARDS = false;
const POW_SOLVE_BATCH_ATTEMPTS = 65536;

/**
 * 引擎加载器：环境感知与动态链接
 */
const getEngine = async (disableThreadsTier = false) =>
{
    if (powModule)
    {
        return powModule;
    }
    if (modulePromise)
    {
        return modulePromise;
    }

    try
    {
        modulePromise = initPowModule(disableThreadsTier ? { disableThreadsTier: true } : undefined).then((initResult) =>
        {
            engineType = initResult.engine;
            powModule = initResult.module;
            return powModule;
        });

        const resolvedModule = await modulePromise;
        if (!resolvedModule)
        {
            throw createAppError(AppErrorCode.InfraFailure, "FACTORY_MISSING: Glue code did not export createPowModule");
        }
        console.log(`[Worker] WASM Module (${engineType}) initialized successfully role=${workerRole}`);

        if (!isWarmedUp && resolvedModule.solve_pow)
        {
            try
            {
                resolvedModule.solve_pow("warmup_salt", "warmup_fp", 1);
                isWarmedUp = true;
            }
            catch (e)
            {
                console.warn('[Worker] JIT Warmup skipped:', e);
            }
        }

        return resolvedModule;
    }
    catch (err)
    {
        console.error('[Worker] Initialization Error:', err);
        modulePromise = null;
        powModule = null;
        throw err;
    }
};

function terminateShardWorkers()
{
    for (const worker of activeShardWorkers)
    {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
    }
    activeShardWorkers = [];
}

function resolveShardCount(): number
{
    const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 1);
    return Math.min(4, Math.max(1, cores - 1));
}

function isThreadPoolCandidate(difficulty: number): boolean
{
    return ENABLE_THREAD_POOL_SHARDS && engineType === 'THREADS-SIMD' && difficulty > 0 && difficulty <= 32 && resolveShardCount() > 1;
}

function yieldToWorkerEventLoop(): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function assertWithinDeadline(deadlineAt: number)
{
    if (Number.isFinite(deadlineAt) && performance.now() >= deadlineAt)
    {
        throw createAppError(AppErrorCode.Timeout, 'POW_SOLVER_TIMEOUT');
    }
}

async function calculateWithBoundedSolver(
    engine: any,
    salt: string,
    browserFp: string,
    difficulty: number,
    deadlineAt: number
): Promise<string>
{
    if (difficulty <= 0)
    {
        return '0';
    }

    if (typeof engine.solve_pow_limited !== 'function')
    {
        throw createAppError(AppErrorCode.InvariantViolation, 'WASM_LIMITED_METHOD_NOT_FOUND');
    }

    let startNonce = 0;
    while (startNonce <= 0xffffffff)
    {
        assertWithinDeadline(deadlineAt);
        const remainingNonceSpace = 0x1_0000_0000 - startNonce;
        const attempts = Math.min(POW_SOLVE_BATCH_ATTEMPTS, remainingNonceSpace);
        const result = engine.solve_pow_limited(salt, browserFp, difficulty, startNonce, attempts);
        if (typeof result === 'string' && result.length > 0)
        {
            return result;
        }

        assertWithinDeadline(deadlineAt);

        startNonce = (startNonce + attempts) >>> 0;
        if (startNonce === 0 || attempts <= 0)
        {
            break;
        }

        await yieldToWorkerEventLoop();
    }

    throw createAppError(AppErrorCode.Timeout, 'POW_SOLVER_EXHAUSTED');
}

function calculateWithShardWorkers(salt: string, browserFp: string, difficulty: number): Promise<{ nonce: string; engine: string; }>
{
    const shardCount = resolveShardCount();
    terminateShardWorkers();

    return new Promise((resolve, reject) =>
    {
        let settled = false;
        let failures = 0;
        const fallbackTimer = setTimeout(() =>
        {
            settle(() => reject(createAppError(AppErrorCode.Timeout, 'POW_SHARDS_TIMEOUT')));
        }, THREAD_POOL_FALLBACK_TIMEOUT_MS);

        const settle = (action: () => void) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(fallbackTimer);
            terminateShardWorkers();
            action();
        };

        for (let shard = 0; shard < shardCount; shard += 1)
        {
            const worker = new Worker(new URL('./pow.worker.ts', import.meta.url), {
                name: `FsusPowShard-${shard}`,
                type: 'module'
            });
            activeShardWorkers.push(worker);

            worker.onmessage = (event: MessageEvent) =>
            {
                const { success, nonce, error, engine, type } = event.data;
                if (type !== 'CALC_RESULT' && type !== 'CALC_ERROR')
                {
                    return;
                }

                if (success && typeof nonce === 'string' && nonce.length > 0 && !nonce.startsWith('failed_'))
                {
                    settle(() => resolve({ nonce, engine: `THREADS-SIMD/${engine || 'shard'}` }));
                    return;
                }

                failures += 1;
                if (failures >= shardCount)
                {
                    settle(() => reject(createAppError(AppErrorCode.InfraFailure, error || 'POW_SHARDS_FAILED')));
                }
            };

            worker.onerror = () =>
            {
                failures += 1;
                if (failures >= shardCount)
                {
                    settle(() => reject(createAppError(AppErrorCode.InfraFailure, 'POW_SHARDS_CRASHED')));
                }
            };

            worker.postMessage({
                salt,
                browserFp,
                difficulty,
                startNonce: shard,
                step: shardCount,
                type: 'CALC_SHARD'
            });
        }
    });
}

/**
 * 消息中心
 */
ctx.onmessage = async (e: MessageEvent) =>
{
    terminateShardWorkers();
    const { salt, browserFp, difficulty, startNonce, step, type, runId, timeoutMs } = e.data;

    // 1. 预热/心跳处理 (PING)
    if (type === 'PING')
    {
        try
        {
            await getEngine();
            return ctx.postMessage({ type: 'PONG', engine: engineType });
        }
        catch (err: any)
        {
            console.error('[Worker] PING Failed:', err);
            return ctx.postMessage({
                success: false,
                error: `INIT_FAIL: ${err.message}`,
                type: 'CALC_ERROR'
            });
        }
    }

    // 2. 任务准入校验
    if (!salt || typeof salt !== 'string' || salt.length > 256)
    {
        return ctx.postMessage({
            success: false,
            error: 'INVALID_INPUT',
            runId,
            type: 'CALC_ERROR'
        });
    }

    if (type === 'CALC_SHARD')
    {
        try
        {
            const engine = await getEngine(true);
            if (typeof engine.solve_pow_range !== 'function')
            {
                throw createAppError(AppErrorCode.InvariantViolation, "WASM_RANGE_METHOD_NOT_FOUND");
            }
            const rawResult = engine.solve_pow_range(
                salt,
                browserFp || '',
                Number(difficulty) || 4,
                Number(startNonce) || 0,
                Math.max(1, Number(step) || 1)
            );
            return ctx.postMessage({
                success: true,
                nonce: String(rawResult),
                duration: 0,
                engine: engineType,
                runId,
                type: 'CALC_RESULT'
            });
        }
        catch (err: any)
        {
            const normalized = isAppError(err) ? err : toAppError(err, 'UNKNOWN_SHARD_ERROR');
            return ctx.postMessage({
                success: false,
                error: normalized.message || 'UNKNOWN_SHARD_ERROR',
                runId,
                type: 'CALC_ERROR'
            });
        }
    }

    // 3. 执行核心逻辑
    try
    {
        const engine = await getEngine();

        if (typeof engine.solve_pow !== 'function')
        {
            throw createAppError(AppErrorCode.InvariantViolation, "WASM_METHOD_NOT_FOUND");
        }

        const diffNum = Number(difficulty) || 4;
        const timeoutBudget = Math.max(1, Number(timeoutMs) || 30000);
        const deadlineAt = performance.now() + timeoutBudget;

        const startTime = performance.now();

        let nonce: string;
        let resultEngine: string = engineType;
        try
        {
            if (isThreadPoolCandidate(diffNum))
            {
                try
                {
                    const threaded = await calculateWithShardWorkers(salt, browserFp || '', diffNum);
                    nonce = threaded.nonce;
                    resultEngine = threaded.engine;
                }
                catch (threadedError)
                {
                    console.warn('[Worker] threaded PoW fallback:', threadedError);
                    nonce = await calculateWithBoundedSolver(engine, salt, browserFp || '', diffNum, deadlineAt);
                }
            }
            else
            {
                nonce = await calculateWithBoundedSolver(engine, salt, browserFp || '', diffNum, deadlineAt);
            }
        }
        catch (wasmError: any)
        {
            console.error(`[Worker] WASM Runtime Crash:`, wasmError);
            throw createAppError(AppErrorCode.InfraFailure, `WASM_CRASH: ${wasmError.message}`);
        }

        const duration = performance.now() - startTime;

        // 4. 返回成果
        ctx.postMessage({
            success: true,
            nonce: nonce,
            duration: Math.round(duration),
            engine: resultEngine,
            runId,
            type: 'CALC_RESULT'
        });

    }
    catch (err: any)
    {
        const normalized = isAppError(err) ? err : toAppError(err, 'UNKNOWN_CALC_ERROR');
        ctx.postMessage({
            success: false,
            error: normalized.message || 'UNKNOWN_CALC_ERROR',
            runId,
            type: 'CALC_ERROR'
        });
    }
};
