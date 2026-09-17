import { prepareCodeFonts } from '@/bootstrap/codeFontPreparation';

type IdleWindow = Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

let hasScheduled = false;

function prepareVisibleCodeFonts(): void
{
    if (document.querySelector('pre, code'))
    {
        void prepareCodeFonts().catch(() => undefined);
    }
}

export function scheduleNonCriticalResources(): void
{
    if (hasScheduled || typeof window === 'undefined')
    {
        return;
    }

    hasScheduled = true;
    prepareVisibleCodeFonts();

    const load = () =>
    {
        void import('@/services/telemetryService').then(({ initTelemetryService }) =>
        {
            initTelemetryService();
        });
    };

    const idleWindow = window as IdleWindow;
    if (typeof idleWindow.requestIdleCallback === 'function')
    {
        idleWindow.requestIdleCallback(() => load(), { timeout: 1500 });
        return;
    }

    window.setTimeout(load, 800);
}
