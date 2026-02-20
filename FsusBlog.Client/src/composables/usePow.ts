import { ref, shallowRef, triggerRef } from 'vue';

export interface PowResult {
  nonce: string;
  duration: number;
}

// ==========================================
// 🌟 全局单例状态管理
// 性能最大化：所有状态提升至模块作用域
// ==========================================

// Worker 实例引用 (使用 shallowRef 避免 Vue 深度代理 Worker 对象带来的性能开销)
const globalWorker = shallowRef<Worker | null>(null);

// 状态锁：确保全站同一时刻只有一个 PoW 任务在运行
const isCalculating = ref(false);
const globalError = ref<string | null>(null);

// 挂起任务的拒绝控制器 (用于手动终止时立即结束 Promise)
let currentReject: ((reason?: any) => void) | null = null;

export function usePow() {
  /**
   * 初始化 Worker 实例 (懒加载模式)
   */
  const initWorker = (): Worker => {
    if (globalWorker.value) return globalWorker.value;

    try {
      // 创建 Worker
      const newWorker = new Worker(
        new URL('../workers/pow.worker.ts', import.meta.url),
        {
          type: 'module',
          name: 'FsusPowWorker' // 方便在 DevTools 中调试
        }
      );

      globalWorker.value = newWorker;
      return newWorker;
    } catch (err) {
      const msg = "Worker 初始化失败";
      globalError.value = msg;
      throw err;
    }
  };

  /**
   * 核心方法：异步求解 PoW 挑战
   * 逻辑自洽：通过全局锁防止并发调用
   */
  const calculate = (
    salt: string,
    browserFp: string,
    difficulty: number = 4,
    timeout: number = 30000
  ): Promise<PowResult> => {
    // 1. 并发锁检查
    if (isCalculating.value) {
      return Promise.reject(new Error("ALREADY_CALCULATING"));
    }

    // 2. 重置状态
    isCalculating.value = true;
    globalError.value = null;
    const currentWorker = initWorker();

    return new Promise((resolve, reject) => {
      // 保存 reject 句柄供 terminate 使用
      currentReject = reject;

      // 3. 超时熔断机制
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("POW_CALCULATION_TIMEOUT"));
      }, timeout);

      // 4. 清理闭包
      const cleanup = () => {
        clearTimeout(timer);
        // 移除回调引用，防止内存泄漏
        if (currentWorker) {
            currentWorker.onmessage = null;
            currentWorker.onerror = null;
        }
        isCalculating.value = false;
        currentReject = null;
      };

      // 5. 消息处理 (使用 onmessage 覆盖模式，防止监听器堆积)
      currentWorker.onmessage = (e: MessageEvent) => {
        const { success, nonce, duration, error: workerError, type } = e.data;

        // 忽略非计算结果的消息 (如 PONG)
        if (type === 'PONG' || type === 'PREWARM_DONE') return;

        cleanup();

        if (success) {
          resolve({ nonce, duration });
        } else {
          const msg = workerError || "WASM_RUNTIME_ERROR";
          globalError.value = msg;
          reject(new Error(msg));
        }
      };

      // 6. 错误处理
      currentWorker.onerror = (_err: ErrorEvent) => {
        cleanup();
        // 遇到 Worker 崩溃，强制销毁实例，下次重建
        terminate(); 
        globalError.value = "WORKER_THREAD_CRASHED";
        reject(new Error("WORKER_THREAD_CRASHED"));
      };

      // 7. 发送任务
      // 安全性保障：确保 browserFp 与主线程一致
      currentWorker.postMessage({
        salt: String(salt),        
        browserFp: String(browserFp),
        difficulty: Number(difficulty),
        type: 'CALC'
      });
    });
  };

  /**
   * 预热 WASM 引擎
   * 不阻塞 isCalculating 状态
   */
  const prewarm = () => {
    // 如果正在计算，跳过预热
    if (isCalculating.value) return;

    try {
      const w = initWorker();
      w.postMessage({ type: 'PING' });
    } catch (e) {
      console.warn("PoW Prewarm skipped:", e);
    }
  };

  /**
   * 显式销毁 Worker
   * 逻辑自洽：立即拒绝所有挂起的 Promise，并重置全局状态
   */
  const terminate = () => {
    // 1. 拒绝当前挂起的任务 (防止前端永久 loading)
    if (currentReject) {
        currentReject(new Error("TERMINATED_BY_USER"));
        currentReject = null;
    }

    // 2. 销毁物理线程
    if (globalWorker.value) {
      globalWorker.value.terminate();
      globalWorker.value = null;
    }

    // 3. 重置状态
    isCalculating.value = false;
    globalError.value = null;
    
    // 强制触发 Vue 更新 (可选，视情况而定)
    triggerRef(globalWorker);
  };

  return {
    isCalculating,
    error: globalError, // 保持对外变量名一致
    calculate,
    prewarm,
    terminate
  };
}