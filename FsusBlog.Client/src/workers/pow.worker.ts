import { initPowModule, type PowEngineKind } from '@wasm/pow';
import { AppErrorCode, createAppError, isAppError, toAppError } from '@/utils/appError';

/**
 * FsusPow Engine - Worker
 * 统一 Wasm 规范：模块化加载、资产清单化、业务层仅关注调度与错误语义。
 */

const ctx: DedicatedWorkerGlobalScope = self as any;

let powModule: any = null;
let modulePromise: Promise<any> | null = null;
let isWarmedUp = false;
let engineType: PowEngineKind | 'UNKNOWN' = 'UNKNOWN';

/**
 * 引擎加载器：环境感知与动态链接
 */
const getEngine = async () => {
    if (powModule) return powModule;
    if (modulePromise) return modulePromise;

    try {
        modulePromise = initPowModule().then((initResult) => {
            engineType = initResult.engine;
            powModule = initResult.module;
            return powModule;
        });

        const resolvedModule = await modulePromise;
        if (!resolvedModule) {
            throw createAppError(AppErrorCode.InfraFailure, "FACTORY_MISSING: Glue code did not export createPowModule");
        }
        console.log(`[Worker] WASM Module (${engineType}) initialized successfully`);

        if (!isWarmedUp && resolvedModule.solve_pow) {
            try {
                resolvedModule.solve_pow("warmup_salt", "warmup_fp", 1);
                isWarmedUp = true;
            } catch (e) {
                console.warn('[Worker] JIT Warmup skipped:', e);
            }
        }

        return resolvedModule;
    } catch (err) {
        console.error('[Worker] Initialization Error:', err);
        modulePromise = null;
        powModule = null;
        throw err;
    }
};

/**
 * 消息中心
 */
ctx.onmessage = async (e: MessageEvent) => {
    const { salt, browserFp, difficulty, type } = e.data;

    // 1. 预热/心跳处理 (PING)
    if (type === 'PING') {
        try {
            await getEngine();
            return ctx.postMessage({ type: 'PONG', engine: engineType });
        } catch (err: any) {
            console.error('[Worker] PING Failed:', err); 
            return ctx.postMessage({ 
                success: false, 
                error: `INIT_FAIL: ${err.message}`,
                type: 'CALC_ERROR' 
            });
        }
    }

    // 2. 任务准入校验
    if (!salt || typeof salt !== 'string' || salt.length > 256) {
        return ctx.postMessage({ 
            success: false, 
            error: 'INVALID_INPUT',
            type: 'CALC_ERROR'
        });
    }

    // 3. 执行核心逻辑
    try {
        const engine = await getEngine();
        
        if (typeof engine.solve_pow !== 'function') {
            throw createAppError(AppErrorCode.InvariantViolation, "WASM_METHOD_NOT_FOUND");
        }

        const diffNum = Number(difficulty) || 4;
        
        const startTime = performance.now();
        
        let nonce: string;
        try {
            const rawResult = engine.solve_pow(salt, browserFp || '', diffNum);
            nonce = String(rawResult);
        } catch (wasmError: any) {
            console.error(`[Worker] WASM Runtime Crash:`, wasmError);
            throw createAppError(AppErrorCode.InfraFailure, `WASM_CRASH: ${wasmError.message}`);
        }
        
        const duration = performance.now() - startTime;

        // 4. 返回成果
        ctx.postMessage({ 
            success: true, 
            nonce: nonce,
            duration: Math.round(duration),
            engine: engineType,
            type: 'CALC_RESULT'
        });

    } catch (err: any) {
        const normalized = isAppError(err) ? err : toAppError(err, 'UNKNOWN_CALC_ERROR');
        ctx.postMessage({ 
            success: false, 
            error: normalized.message || 'UNKNOWN_CALC_ERROR',
            type: 'CALC_ERROR' 
        });
    }
};
