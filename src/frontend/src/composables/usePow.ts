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

type PowQueuedTask = {
  runId: number
  salt: string
  browserFp: string
  difficulty: number
  timeout: number
  signal?: AbortSignal
  resolve: (value: PowResult) => void
  reject: (reason?: any) => void
  abortCleanup?: () => void
}

type PowRunState = PowQueuedTask & {
  worker: Worker
  timerId: ReturnType<typeof setTimeout> | null
}

let currentRunId = 0;
let activeRun: PowRunState | null = null;
const queuedTasks: PowQueuedTask[] = [];

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

  const cleanupTaskAbort = (task: Pick<PowQueuedTask, 'abortCleanup'>) => {
    task.abortCleanup?.();
    task.abortCleanup = undefined;
  };

  const rejectQueuedTasks = (reason: unknown) => {
    while (queuedTasks.length > 0) {
      const task = queuedTasks.shift();
      if (!task) {
        continue;
      }

      cleanupTaskAbort(task);
      task.reject(reason);
    }
  };

  function completeRun(
    runId: number,
    worker: Worker,
    action: () => void,
    startNext: boolean = true
  ) {
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
    cleanupTaskAbort(current);
    activeRun = null;
    isCalculating.value = false;
    action();
    if (startNext) {
      startNextQueuedTask();
    }
  }

  function cancelActiveRun(runId: number) {
    const current = activeRun;
    if (!current || current.runId !== runId) {
      return;
    }

    completeRun(runId, current.worker, () => {
      current.reject(new PowAbortError());
    });
  }

  function startNextQueuedTask() {
    if (activeRun) {
      return;
    }

    while (queuedTasks.length > 0) {
      const task = queuedTasks.shift();
      if (!task) {
        continue;
      }

      if (task.signal?.aborted) {
        cleanupTaskAbort(task);
        task.reject(new PowAbortError());
        continue;
      }

      isCalculating.value = true;
      globalError.value = null;
      const currentWorker = initWorker();
      const runState: PowRunState = {
        ...task,
        worker: currentWorker,
        timerId: null
      };
      activeRun = runState;

      runState.timerId = setTimeout(() => {
        terminate("POW_CALCULATION_TIMEOUT", task.runId);
      }, task.timeout);

      currentWorker.onmessage = (e: MessageEvent) => {
        const { success, nonce, duration, error: workerError, type, runId: responseRunId } = e.data;

        if (type === 'PONG' || type === 'PREWARM_DONE') return;
        if (responseRunId !== undefined && responseRunId !== task.runId) return;

        if (!activeRun || activeRun.runId !== task.runId || activeRun.worker !== currentWorker) {
          return;
        }

        if (success) {
          completeRun(task.runId, currentWorker, () => {
            if (task.signal?.aborted) {
              task.reject(new PowAbortError());
              return;
            }

            task.resolve({ nonce, duration });
          });
        } else {
          const msg = workerError || "WASM_RUNTIME_ERROR";
          completeRun(task.runId, currentWorker, () => {
            globalError.value = msg;
            task.reject(createPowRuntimeError('pow_runtime_failed', msg));
          });
        }
      };

      currentWorker.onerror = (_err: ErrorEvent) => {
        if (!activeRun || activeRun.runId !== task.runId || activeRun.worker !== currentWorker) {
          return;
        }

        terminate("WORKER_THREAD_CRASHED", task.runId);
      };

      try {
        currentWorker.postMessage({
          salt: String(task.salt),
          browserFp: String(task.browserFp),
          difficulty: Number(task.difficulty),
          runId: task.runId,
          type: 'CALC'
        });
      } catch {
        terminate("WORKER_THREAD_CRASHED", task.runId);
      }

      return;
    }
  }

  function terminate(reason: string = "TERMINATED_BY_USER", targetRunId?: number) {
    const current = activeRun;
    if (current && (targetRunId === undefined || current.runId === targetRunId)) {
      const shouldResetQueue = targetRunId === undefined;
      completeRun(current.runId, current.worker, () => {
        globalError.value = null;
        destroyWorker(current.worker);
        current.reject(mapTerminationReason(reason));
        if (shouldResetQueue) {
          rejectQueuedTasks(mapTerminationReason(reason));
        }
      }, !shouldResetQueue);
      return;
    }

    if (targetRunId === undefined) {
      destroyWorker(globalWorker.value);
      isCalculating.value = false;
      globalError.value = null;
      rejectQueuedTasks(mapTerminationReason(reason));
    }
  }

  /**
   * 核心方法：异步求解 PoW 挑战
   * 同一时间只运行一个 Worker 任务，后续请求 FIFO 排队，避免并发 API 互相物理抢占。
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

    const runId = ++currentRunId;

    return new Promise((resolve, reject) => {
      const task: PowQueuedTask = {
        runId,
        salt,
        browserFp,
        difficulty,
        timeout,
        signal,
        resolve,
        reject,
        abortCleanup: undefined
      };

      const abortTask = () => {
        const queuedIndex = queuedTasks.findIndex((queuedTask) => queuedTask.runId === runId);
        if (queuedIndex >= 0) {
          const [queuedTask] = queuedTasks.splice(queuedIndex, 1);
          cleanupTaskAbort(queuedTask);
          queuedTask.reject(new PowAbortError());
          return;
        }

        cancelActiveRun(runId);
      };

      if (signal) {
        signal.addEventListener('abort', abortTask, { once: true });
        task.abortCleanup = () => {
          signal.removeEventListener('abort', abortTask);
          task.abortCleanup = undefined;
        };
      }

      if (signal?.aborted) {
        cleanupTaskAbort(task);
        reject(new PowAbortError());
        return;
      }

      queuedTasks.push(task);
      startNextQueuedTask();
    });
  };

  const prewarm = () => {
    if (isCalculating.value || queuedTasks.length > 0) return;

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
