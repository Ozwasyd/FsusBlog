/**
 * FsusPow Engine - Worker 
 * 集成 SIMD/标量双核自动切换、WASM 预热、参数强校验与异常链路追踪
 */

const ctx: DedicatedWorkerGlobalScope = self as any;

// 全局状态管理
let powModule: any = null;
let modulePromise: Promise<any> | null = null;
let isWarmedUp = false;
let engineType = 'UNKNOWN';

// 文件路径配置 (对应 CMake 输出)
const PATH_CONFIG = {
    SIMD: {
        GLUE: '/wasm/fsus_pow_simd.js',
        WASM: 'fsus_pow_simd.wasm'
    },
    BASIC: {
        GLUE: '/wasm/fsus_pow_basic.js',
        WASM: 'fsus_pow_basic.wasm'
    }
};

/**
 * 核心：WebAssembly SIMD 特性探测器
 */
const checkSimdSupport = (): boolean => {
    try {
        const simdProbe = new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0, 
            1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 
            1, 8, 0, 65, 0, 253, 15, 253, 98, 11
        ]);
        return WebAssembly.validate(simdProbe);
    } catch (e) {
        return false;
    }
};

/**
 * 引擎加载器：环境感知与动态链接
 */
const getEngine = async () => {
    if (powModule) return powModule;
    if (modulePromise) return modulePromise;

    try {
        // 1. 探测硬件特性
        const supportSimd = checkSimdSupport();
        engineType = supportSimd ? 'SIMD-128' : 'SCALAR-BASIC';
        
        const targetConfig = supportSimd ? PATH_CONFIG.SIMD : PATH_CONFIG.BASIC;
        console.log(`[Worker] Detected Engine: ${engineType}. Loading glue via importScripts: ${targetConfig.GLUE}`);

        // 2. 加载胶水代码 (CSP Safe)
        // [修复 2026-02-23] 使用 importScripts 替代 fetch+eval，符合 CSP 规范
        // 注意：importScripts 是同步阻塞加载，这在 Worker 中是完全合法的
        try {
            importScripts(targetConfig.GLUE);
        } catch (scriptErr) {
             throw new Error(`Glue code import failed: ${scriptErr}`);
        }

        // 3. 获取 Emscripten 模块工厂
        // Emscripten 的 glue code 通常会挂载到 self.createPowModule 或 self.Module
        // 这里需要配合 C++ 编译时的 MODULARIZE 选项
        const factory = (self as any).createPowModule || (self as any).Module;
        
        if (typeof factory !== 'function') {
            throw new Error("FACTORY_MISSING: Glue code did not export createPowModule");
        }

        // 4. 实例化 WASM
        modulePromise = factory({
            locateFile: (path: string) => {
                if (path.endsWith('.wasm')) {
                    return `/wasm/${targetConfig.WASM}`;
                }
                return `/wasm/${path}`;
            },
            print: (msg: string) => console.log(`[WASM-${engineType}]: ${msg}`),
            printErr: (msg: string) => console.warn(`[WASM-${engineType}_ERR]: ${msg}`)
        });

        powModule = await modulePromise;
        console.log(`[Worker] WASM Module (${engineType}) initialized successfully`);

        // 5. JIT 预热
        if (!isWarmedUp && powModule.solve_pow) {
            try {
                // 触发一次完整的调用路径，迫使浏览器编译热点代码
                powModule.solve_pow("warmup_salt", "warmup_fp", 1);
                isWarmedUp = true;
            } catch (e) {
                console.warn('[Worker] JIT Warmup skipped:', e);
            }
        }

        return powModule;
    } catch (err) {
        console.error('[Worker] Initialization Error:', err);
        modulePromise = null;
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
            throw new Error("WASM_METHOD_NOT_FOUND");
        }

        const diffNum = Number(difficulty) || 4;
        
        // [修复 2026-02-23] 纯粹的物理执行
        // 这一步会彻底阻塞 Worker 线程，直到 C++ 返回结果。
        // 期间主线程发来的任何 terminate 指令会直接销毁本线程，
        // 任何 postMessage 都会排队等待（也就是如果被 terminate 了，它们永远不会被处理）
        const startTime = performance.now();
        
        let nonce: string;
        try {
            const rawResult = engine.solve_pow(salt, browserFp || '', diffNum);
            nonce = String(rawResult);
        } catch (wasmError: any) {
            console.error(`[Worker] WASM Runtime Crash:`, wasmError);
            throw new Error(`WASM_CRASH: ${wasmError.message}`);
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
        ctx.postMessage({ 
            success: false, 
            error: err.message || 'UNKNOWN_CALC_ERROR',
            type: 'CALC_ERROR' 
        });
    }
};