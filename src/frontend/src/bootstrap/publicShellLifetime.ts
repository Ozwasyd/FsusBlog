import { emitTelemetry } from '@/services/telemetryBus';

let publicShellLifetimeController: AbortController | null = null;
let abortCount = 0;

function createController(): AbortController
{
    publicShellLifetimeController = new AbortController();
    return publicShellLifetimeController;
}

export function resetPublicShellLifetime(): AbortSignal
{
    if (publicShellLifetimeController && !publicShellLifetimeController.signal.aborted)
    {
        publicShellLifetimeController.abort('reset');
    }
    abortCount = 0;
    return createController().signal;
}

export function getPublicShellLifetimeSignal(): AbortSignal
{
    const controller = publicShellLifetimeController;
    if (!controller || controller.signal.aborted)
    {
        return createController().signal;
    }

    return controller.signal;
}

export function abortPublicShellLifetime(reason: string): void
{
    const controller = publicShellLifetimeController;
    if (!controller || controller.signal.aborted)
    {
        return;
    }

    abortCount += 1;
    controller.abort(reason);
    emitTelemetry('public_shell_lifetime_aborted', {
        reason,
        abortCount
    }, 'info');
}

export function getPublicShellLifetimeAbortCount(): number
{
    return abortCount;
}

export function onPublicShellLifetimeAbort(cleanup: () => void): void
{
    const signal = getPublicShellLifetimeSignal();
    if (signal.aborted)
    {
        cleanup();
        return;
    }

    signal.addEventListener('abort', cleanup, { once: true });
}

export function addPublicShellEventListener<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: AddEventListenerOptions
): void;
export function addPublicShellEventListener<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    options?: AddEventListenerOptions
): void;
export function addPublicShellEventListener(
    target: Window | Document,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions
): void;
export function addPublicShellEventListener(
    target: Window | Document,
    type: string,
    listener: EventListener,
    options: AddEventListenerOptions = {}
): void
{
    target.addEventListener(type, listener, {
        ...options,
        signal: getPublicShellLifetimeSignal()
    });
}
