/**
 * FsusPow Engine - Worker 
 * 集成 SIMD/标量双核自动切换、WASM 预热、参数强校验与异常链路追踪
 */

const ctx: DedicatedWorkerGlobalScope = self as any;

// 全局状态管理
let powModule: any = null;
let modulePromise: Promise<any> | null = null;
let isWarmedUp = false;
let engineType = 'UNKNOWN'; // 用于日志追踪当前运行的是哪个内核

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
 * 通过尝试验证一段极小的 SIMD 二进制流来判断浏览器支持情况
 * 安全性保障：避免在旧设备上加载 SIMD 代码导致 Worker 直接崩溃
 */
const checkSimdSupport = (): boolean => {
    try {
        // 一个最小合法的 WASM 模块，包含 v128 类型定义
        // Magic(4) + Version(4) + TypeSection...
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
 * 逻辑自洽：确保单例模式，且根据硬件特性加载对应的 WASM 文件
 */
const getEngine = async () => {
    // 单例模式：防止重复加载
    if (powModule) return powModule;
    if (modulePromise) return modulePromise;

    try {
        // 1. 探测硬件特性
        const supportSimd = checkSimdSupport();
        engineType = supportSimd ? 'SIMD-128' : 'SCALAR-BASIC';
        
        // 2. 选择对应的配置路径
        const targetConfig = supportSimd ? PATH_CONFIG.SIMD : PATH_CONFIG.BASIC;
        console.log(`[Worker] Detected Engine: ${engineType}. Fetching glue: ${targetConfig.GLUE}`);

        // 3. 加载胶水代码 (Glue Code)
        const response = await fetch(targetConfig.GLUE);
        if (!response.ok) throw new Error(`Glue code fetch failed: ${response.status}`);
        
        let scriptContent = await response.text();
        
        // 4. 注入胶水代码并导出模块工厂 (兼容 Emscripten MODULARIZE=1)
        // 这里的 try-catch 是为了防止 eval 执行期间的语法错误
        try {
            scriptContent += `
                if (typeof createPowModule !== 'undefined') {
                    self.createPowModule = createPowModule;
                } else if (typeof Module !== 'undefined') {
                    self.createPowModule = Module;
                }
            `;
            const runGlue = new Function(scriptContent);
            runGlue.call(self);
        } catch (evalErr) {
            throw new Error(`Glue code execution failed: ${evalErr}`);
        }

        const factory = (self as any).createPowModule;
        if (typeof factory !== 'function') throw new Error("FACTORY_MISSING");

        // 5. 实例化 WASM
        // 关键逻辑：重写 locateFile，无论胶水代码请求什么，都强制指向我们选定的 .wasm 文件
        modulePromise = factory({
            locateFile: (path: string) => {
                if (path.endsWith('.wasm')) {
                    return `/wasm/${targetConfig.WASM}`;
                }
                return `/wasm/${path}`;
            },
            // 桥接 WASM 内部的 stdout/stderr 到 Worker 控制台
            print: (msg: string) => console.log(`[WASM-${engineType}]: ${msg}`),
            printErr: (msg: string) => console.warn(`[WASM-${engineType}_ERR]: ${msg}`)
        });

        powModule = await modulePromise;
        console.log(`[Worker] WASM Module (${engineType}) initialized successfully`);

        // 6. JIT 预热 (Warm-up)
        // 性能最大化：消除首次计算时的冷启动延迟 (Compilation + Instantiation overhead)
        if (!isWarmedUp && powModule.solve_pow) {
            console.log('[Worker] Performing JIT warmup...');
            try {
                // 使用极其简单的参数触发一次完整调用路径
                powModule.solve_pow("warmup_salt", "warmup_fp", 1);
                isWarmedUp = true;
                console.log('[Worker] JIT Warmup complete.');
            } catch (e) {
                // 预热失败不应阻断主流程，只需记录警告
                console.warn('[Worker] JIT Warmup skipped:', e);
            }
        }

        return powModule;
    } catch (err) {
        console.error('[Worker] Initialization Error:', err);
        modulePromise = null; // 逻辑自洽：失败后重置 Promise，允许主线程重试
        throw err;
    }
};

/**
 * 消息中心
 */
ctx.onmessage = async (e: MessageEvent) => {
    const { salt, browserFp, difficulty, type } = e.data;

    // ===========================
    // 1. 预热/心跳处理 (PING)
    // ===========================
    if (type === 'PING') {
        try {
            await getEngine();
            // 返回 PONG 时带上当前的引擎类型，便于前端 Debug
            return ctx.postMessage({ type: 'PONG', engine: engineType });
        } catch (err: any) {
            console.error('[Worker] PING Failed:', err); 
            // 明确告知主线程初始化失败
            return ctx.postMessage({ success: false, error: `INIT_FAIL: ${err.message}` });
        }
    }

    // ===========================
    // 2. 任务准入校验 (安全性保障)
    // ===========================
    // 防止传入过长的字符串导致 C++ 内存溢出风险
    if (!salt || typeof salt !== 'string' || salt.length > 256) {
        console.warn('[Worker] 拦截到非法 Salt 任务');
        return ctx.postMessage({ success: false, error: 'INVALID_INPUT' });
    }

    // ===========================
    // 3. 执行核心逻辑
    // ===========================
    try {
        const engine = await getEngine();
        
        if (typeof engine.solve_pow !== 'function') {
            throw new Error("WASM_METHOD_NOT_FOUND");
        }

        const diffNum = Number(difficulty) || 4;
        console.log(`[Worker] 开始求解 (${engineType}): Difficulty=${diffNum}, Salt=${salt.substring(0, 8)}...`);
        
        const startTime = performance.now();
        
        // 🌟 核心计算 (调用 WASM 导出的 C++ 方法)
        // 异常处理重点：
        // 尽管 C++ 关闭了异常，但如果发生内存访问越界或中止，JS 会捕获到 WebAssembly.RuntimeError
        let nonce: string;
        try {
            const rawResult = engine.solve_pow(salt, browserFp || '', diffNum);
            nonce = String(rawResult); // 类型安全转换
        } catch (wasmError: any) {
            // 捕获 WASM 运行时的崩溃 (RuntimeError)
            console.error(`[Worker] WASM Runtime Crash:`, wasmError);
            throw new Error(`WASM_CRASH: ${wasmError.message}`);
        }
        
        const duration = performance.now() - startTime;
        console.log(`[Worker] 求解成功: Nonce=${nonce}, 耗时=${Math.round(duration)}ms`);

        // 4. 返回成果
        ctx.postMessage({ 
            success: true, 
            nonce: nonce,
            duration: Math.round(duration),
            engine: engineType // 告知主线程是由哪个引擎算出来的
        });

    } catch (err: any) {
        // 全局兜底异常处理
        console.error('[Worker] Calculation Error:', err);
        ctx.postMessage({ 
            success: false, 
            error: err.message || 'UNKNOWN_CALC_ERROR' 
        });
    }
};