import { ref, shallowRef, triggerRef } from 'vue';

export interface PowResult {
  nonce: string;
  duration: number;
}

// [修复 2026-02-23] 标准中断异常，用于上游组件静默捕获，防止 Promise 级联崩溃
export class PowAbortError extends Error {
  constructor(message: string = "POW_CALCULATION_ABORTED") {
    super(message);
    this.name = "PowAbortError";
  }
}

// ==========================================
// 全局单例状态管理
// ==========================================

const globalWorker = shallowRef<Worker | null>(null);
const isCalculating = ref(false);
const globalError = ref<string | null>(null);

let currentReject: ((reason?: any) => void) | null = null;
let currentTimer: ReturnType<typeof setTimeout> | null = null;

export function usePow() {
  /**
   * 初始化 Worker 实例
   */
  const initWorker = (): Worker => {
    if (globalWorker.value) return globalWorker.value;

    try {
      const newWorker = new Worker(
        new URL('../workers/pow.worker.ts', import.meta.url),
        {
          name: 'FsusPowWorker'
        }
      );

      globalWorker.value = newWorker;
      return newWorker;
    } catch (err) {
      globalError.value = "WORKER_INIT_FAILED";
      throw err;
    }
  };

  /**
   * 物理硬杀 (唯一有效的抢占手段)
   * 逻辑自洽：直接销毁物理线程，释放 CPU 资源
   */
  const terminate = (reason: string = "TERMINATED_BY_USER") => {
    // 1. 清理定时器
    if (currentTimer) {
      clearTimeout(currentTimer);
      currentTimer = null;
    }

    // 2. 拒绝挂起的 Promise (使用特定异常类型，避免上游崩溃)
    if (currentReject) {
        currentReject(new PowAbortError(reason));
        currentReject = null;
    }

    // 3. 物理销毁线程
    if (globalWorker.value) {
      globalWorker.value.terminate();
      globalWorker.value = null;
    }

    // 4. 重置状态
    isCalculating.value = false;
    globalError.value = null;
    triggerRef(globalWorker);
  };

  /**
   * 核心方法：异步求解 PoW 挑战
   * 算法最优：新任务直接物理抢占旧任务，保证响应最新输入
   */
  const calculate = (
    salt: string,
    browserFp: string,
    difficulty: number = 4,
    timeout: number = 30000
  ): Promise<PowResult> => {
    
    // [修复 2026-02-23] 物理抢占逻辑
    // 如果当前有任务在跑，不要幻想能软中断它，直接杀掉重建，这是性能损耗最小的路径
    if (isCalculating.value) {
      console.warn('[usePow] 触发物理抢占：终止陈旧 PoW 任务');
      terminate("PREEMPTED_BY_NEW_TASK");
    }

    isCalculating.value = true;
    globalError.value = null;
    const currentWorker = initWorker();

    return new Promise((resolve, reject) => {
      currentReject = reject;

      // 超时兜底
      currentTimer = setTimeout(() => {
        terminate("POW_CALCULATION_TIMEOUT");
      }, timeout);

      const cleanup = () => {
        if (currentTimer) {
            clearTimeout(currentTimer);
            currentTimer = null;
        }
        if (currentWorker) {
            currentWorker.onmessage = null;
            currentWorker.onerror = null;
        }
        isCalculating.value = false;
        currentReject = null;
      };

      currentWorker.onmessage = (e: MessageEvent) => {
        const { success, nonce, duration, error: workerError, type } = e.data;

        // 严格类型校验
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

      currentWorker.onerror = (_err: ErrorEvent) => {
        cleanup();
        terminate("WORKER_THREAD_CRASHED");
      };

      currentWorker.postMessage({
        salt: String(salt),        
        browserFp: String(browserFp),
        difficulty: Number(difficulty),
        type: 'CALC'
      });
    });
  };

  const prewarm = () => {
    if (isCalculating.value) return;

    try {
      const w = initWorker();
      w.postMessage({ type: 'PING' });
    } catch (e) {
      console.warn("[usePow] Prewarm skipped:", e);
    }
  };

  return {
    isCalculating,
    error: globalError,
    calculate,
    prewarm,
    terminate
  };
}