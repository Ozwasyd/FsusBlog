import { ref, shallowRef, triggerRef } from 'vue';
import { AppErrorCode, createAppError } from '@/utils/appError';

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

const createPowRuntimeError = (message: string, details: string, code: AppErrorCode = AppErrorCode.InfraFailure) =>
  createAppError(code, message, { details })

// ==========================================
// 全局单例状态管理
// ==========================================

const globalWorker = shallowRef<Worker | null>(null);
const isCalculating = ref(false);
const globalError = ref<string | null>(null);

type PowRunState = {
  runId: number
  worker: Worker
  reject: (reason?: any) => void
  timerId: ReturnType<typeof setTimeout> | null
  abortCleanup?: () => void
}

let currentRunId = 0;
let activeRun: PowRunState | null = null;

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
          name: 'FsusPowWorker',
          type: 'module'
        }
      );

      globalWorker.value = newWorker;
      return newWorker;
    } catch {
      globalError.value = "WORKER_INIT_FAILED";
      throw createPowRuntimeError('pow_worker_init_failed', 'worker_init_failed');
    }
  };

  /**
   * 物理硬杀 (唯一有效的抢占手段)
   * 逻辑自洽：直接销毁物理线程，释放 CPU 资源
   */
  const destroyWorker = (worker: Worker | null) => {
    if (!worker) {
      return;
    }

    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();

    if (globalWorker.value === worker) {
      globalWorker.value = null;
      triggerRef(globalWorker);
    }
  };

  const mapTerminationReason = (reason: string) => {
    if (reason === 'POW_CALCULATION_TIMEOUT') {
      return createPowRuntimeError('pow_calculation_timeout', 'pow_calculation_timeout', AppErrorCode.Timeout);
    }

    if (reason === 'WORKER_THREAD_CRASHED') {
      return createPowRuntimeError('pow_worker_thread_crashed', 'pow_worker_thread_crashed');
    }

    return new PowAbortError(reason);
  };

  const completeRun = (
    runId: number,
    worker: Worker,
    action: () => void
  ) => {
    const current = activeRun;
    if (!current || current.runId !== runId || current.worker !== worker) {
      return;
    }

    if (current.timerId) {
      clearTimeout(current.timerId);
      current.timerId = null;
    }

    worker.onmessage = null;
    worker.onerror = null;
    current.abortCleanup?.();
    activeRun = null;
    isCalculating.value = false;
    action();
  };

  const terminate = (reason: string = "TERMINATED_BY_USER", targetRunId?: number) => {
    const current = activeRun;
    if (current && (targetRunId === undefined || current.runId === targetRunId)) {
      if (current.timerId) {
        clearTimeout(current.timerId);
        current.timerId = null;
      }

      activeRun = null;
      isCalculating.value = false;
      globalError.value = null;
      const rejectPending = current.reject;
      current.abortCleanup?.();
      destroyWorker(current.worker);
      rejectPending(mapTerminationReason(reason));
      return;
    }

    if (targetRunId === undefined) {
      destroyWorker(globalWorker.value);
      isCalculating.value = false;
      globalError.value = null;
    }
  };

  /**
   * 核心方法：异步求解 PoW 挑战
   * 算法最优：新任务直接物理抢占旧任务，保证响应最新输入
   */
  const calculate = (
    salt: string,
    browserFp: string,
    difficulty: number = 4,
    timeout: number = 30000,
    signal?: AbortSignal
  ): Promise<PowResult> => {
    if (signal?.aborted) {
      return Promise.reject(new PowAbortError());
    }

    // [修复 2026-02-23] 物理抢占逻辑
    // 如果当前有任务在跑，不要幻想能软中断它，直接杀掉重建，这是性能损耗最小的路径
    if (isCalculating.value) {
      console.info('[usePow] 触发物理抢占：终止陈旧 PoW 任务');
      terminate("PREEMPTED_BY_NEW_TASK", activeRun?.runId);
    }

    isCalculating.value = true;
    globalError.value = null;
    const currentWorker = initWorker();
    const runId = ++currentRunId;

    return new Promise((resolve, reject) => {
      const runState: PowRunState = {
        runId,
        worker: currentWorker,
        reject,
        timerId: null,
        abortCleanup: undefined
      };
      activeRun = runState;

      const abortCurrentRun = () => {
        terminate("POW_CALCULATION_ABORTED", runId);
      };

      if (signal) {
        signal.addEventListener('abort', abortCurrentRun, { once: true });
        runState.abortCleanup = () => {
          signal.removeEventListener('abort', abortCurrentRun);
          runState.abortCleanup = undefined;
        };
      }

      if (signal?.aborted) {
        terminate("POW_CALCULATION_ABORTED", runId);
        return;
      }

      runState.timerId = setTimeout(() => {
        terminate("POW_CALCULATION_TIMEOUT", runId);
      }, timeout);

      currentWorker.onmessage = (e: MessageEvent) => {
        const { success, nonce, duration, error: workerError, type } = e.data;

        // 严格类型校验
        if (type === 'PONG' || type === 'PREWARM_DONE') return;

        if (success) {
          completeRun(runId, currentWorker, () => {
            if (signal?.aborted) {
              reject(new PowAbortError());
              return;
            }

            resolve({ nonce, duration });
          });
        } else {
          const msg = workerError || "WASM_RUNTIME_ERROR";
          completeRun(runId, currentWorker, () => {
            globalError.value = msg;
            reject(createPowRuntimeError('pow_runtime_failed', msg));
          });
        }
      };

      currentWorker.onerror = (_err: ErrorEvent) => {
        if (!activeRun || activeRun.runId !== runId || activeRun.worker !== currentWorker) {
          return;
        }

        terminate("WORKER_THREAD_CRASHED", runId);
      };

      try {
        currentWorker.postMessage({
          salt: String(salt),
          browserFp: String(browserFp),
          difficulty: Number(difficulty),
          type: 'CALC'
        });
      } catch {
        terminate("WORKER_THREAD_CRASHED", runId);
      }
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
