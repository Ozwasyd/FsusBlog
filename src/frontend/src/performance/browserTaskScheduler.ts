export type BrowserTaskYieldPath = 'native' | 'fallback' | 'throttled';

export type BrowserTaskVisibility = 'visible' | 'hidden' | 'prerender' | 'unknown';

export interface BrowserTaskYieldResult {
    path: BrowserTaskYieldPath;
    visibility: BrowserTaskVisibility;
    waitedMs: number;
    nativeFailure: 'rejected' | null;
}

interface BrowserSchedulerCapability {
    yield: () => Promise<void>;
}

interface BrowserTaskSchedulerEnvironment {
    scheduler: BrowserSchedulerCapability | null;
    now: () => number;
    visibility: () => BrowserTaskVisibility;
    setTimer: (callback: () => void) => number;
    clearTimer: (timer: number) => void;
}

export interface BrowserTaskSchedulerOptions {
    minimumIntervalMs?: number;
    environment?: Partial<BrowserTaskSchedulerEnvironment>;
}

export interface BrowserTaskYieldOptions {
    signal?: AbortSignal;
    force?: boolean;
}

export interface BrowserTaskScheduler {
    yieldToBrowser: (options?: BrowserTaskYieldOptions) => Promise<BrowserTaskYieldResult>;
    reset: () => void;
}

const defaultEnvironment: BrowserTaskSchedulerEnvironment = {
    scheduler: readSchedulerCapability(),
    now: () => performance.now(),
    visibility: readVisibility,
    setTimer: callback => Number(globalThis.setTimeout(callback, 0)),
    clearTimer: timer => globalThis.clearTimeout(timer)
};

function readSchedulerCapability(): BrowserSchedulerCapability | null
{
    const scheduler = (globalThis as typeof globalThis & {
        scheduler?: { yield?: () => Promise<void>; };
    }).scheduler;

    return typeof scheduler?.yield === 'function'
        ? { yield: () => scheduler.yield() }
        : null;
}

function readVisibility(): BrowserTaskVisibility
{
    if (typeof document === 'undefined')
    {
        return 'unknown';
    }
    if (document.visibilityState === 'visible' || document.visibilityState === 'hidden' || document.visibilityState === 'prerender')
    {
        return document.visibilityState;
    }
    return 'unknown';
}

function abortReason(signal: AbortSignal): unknown
{
    return signal.reason ?? new DOMException('The browser task yield was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void
{
    if (signal?.aborted)
    {
        throw abortReason(signal);
    }
}

function waitWithAbort(task: Promise<void>, signal: AbortSignal | undefined): Promise<void>
{
    if (!signal)
    {
        return task;
    }
    throwIfAborted(signal);

    return new Promise<void>((resolve, reject) =>
    {
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        task.then(
            () =>
            {
                signal.removeEventListener('abort', onAbort);
                resolve();
            },
            error =>
            {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            }
        );
    });
}

function fallbackYield(environment: BrowserTaskSchedulerEnvironment, signal: AbortSignal | undefined): Promise<void>
{
    throwIfAborted(signal);

    return new Promise<void>((resolve, reject) =>
    {
        let timer = 0;
        const onAbort = () =>
        {
            environment.clearTimer(timer);
            reject(abortReason(signal!));
        };
        timer = environment.setTimer(() =>
        {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        });
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export function createBrowserTaskScheduler(options: BrowserTaskSchedulerOptions = {}): BrowserTaskScheduler
{
    const minimumIntervalMs = options.minimumIntervalMs ?? 8;
    if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0)
    {
        throw new RangeError('minimumIntervalMs must be a finite non-negative number');
    }

    const environment: BrowserTaskSchedulerEnvironment = {
        ...defaultEnvironment,
        ...options.environment
    };
    let lastYieldAt = Number.NEGATIVE_INFINITY;

    return {
        async yieldToBrowser(yieldOptions = {})
        {
            const { signal, force = false } = yieldOptions;
            throwIfAborted(signal);

            const startedAt = environment.now();
            if (!force && startedAt - lastYieldAt < minimumIntervalMs)
            {
                return {
                    path: 'throttled',
                    visibility: environment.visibility(),
                    waitedMs: 0,
                    nativeFailure: null
                };
            }

            lastYieldAt = startedAt;
            let path: BrowserTaskYieldPath = 'fallback';
            let nativeFailure: BrowserTaskYieldResult['nativeFailure'] = null;

            if (environment.scheduler)
            {
                try
                {
                    await waitWithAbort(environment.scheduler.yield(), signal);
                    path = 'native';
                }
                catch (error)
                {
                    throwIfAborted(signal);
                    nativeFailure = 'rejected';
                    await fallbackYield(environment, signal);
                }
            }
            else
            {
                await fallbackYield(environment, signal);
            }

            throwIfAborted(signal);
            return {
                path,
                visibility: environment.visibility(),
                waitedMs: Math.max(0, environment.now() - startedAt),
                nativeFailure
            };
        },
        reset()
        {
            lastYieldAt = Number.NEGATIVE_INFINITY;
        }
    };
}

const sharedBrowserTaskScheduler = createBrowserTaskScheduler();

export function yieldToBrowser(options?: BrowserTaskYieldOptions): Promise<BrowserTaskYieldResult>
{
    return sharedBrowserTaskScheduler.yieldToBrowser(options);
}
