import { privateRequestRuntime, StalePrivateResponseError } from '@/services/privateRequestRuntime';

/** One transient view lifetime over the original admin generation authority. */
export function createDocumentExportPrivateUiLifecycle(clear: () => void)
{
    const controller = new AbortController();
    const lease = privateRequestRuntime.open('admin', controller.signal);
    const listeners = new Set<() => void>();
    let current = true;

    function dispose(): void
    {
        if (!current)
        {
            return;
        }
        current = false;
        lease.signal!.removeEventListener('abort', dispose);
        controller.abort(new StalePrivateResponseError('admin'));
        lease.release();
        clear();
        // Retire private data synchronously; notify after the original runtime's
        // controller iteration so a host can safely construct a fresh port.
        queueMicrotask(() =>
        {
            const pending = [...listeners];
            for (const notify of pending)
            {
                if (listeners.delete(notify))
                {
                    notify();
                }
            }
        });
    }

    lease.signal!.addEventListener('abort', dispose, { once: true });

    return {
        signal: lease.signal!,
        assertCurrent: (): void =>
        {
            lease.assertCurrent();
            if (!current)
            {
                throw new StalePrivateResponseError('admin');
            }
            lease.signal!.throwIfAborted();
        },
        subscribePermissionRevoked: (notify: () => void): (() => void) =>
        {
            if (!current)
            {
                listeners.add(notify);
                queueMicrotask(() =>
                {
                    if (listeners.delete(notify))
                    {
                        notify();
                    }
                });
                return () =>
                {
                    listeners.delete(notify);
                };
            }
            listeners.add(notify);
            return () =>
            {
                listeners.delete(notify);
            };
        },
        dispose
    };
}
