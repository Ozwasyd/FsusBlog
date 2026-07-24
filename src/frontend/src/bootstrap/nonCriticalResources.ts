import { loadBundledFonts } from '@/bootstrap/fontLoadingPlanner';

type IdleWindow = Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
};

let hasScheduled = false;

function loadContextualFonts(): void
{
    const pathname = window.location.pathname;
    const locale = document.documentElement.lang || window.navigator.language;
    void loadBundledFonts({ pathname, locale, trigger: 'route' });
    void loadBundledFonts({ pathname, locale, trigger: 'locale' });
    if (document.querySelector('pre, code'))
    {
        void loadBundledFonts({ pathname, locale, trigger: 'content', hasCode: true });
    }
}

async function loadNonCriticalFonts(): Promise<void>
{
    await loadBundledFonts({
        pathname: window.location.pathname,
        locale: document.documentElement.lang || window.navigator.language,
        trigger: 'idle'
    });
}

export function scheduleNonCriticalResources(): void
{
    if (hasScheduled || typeof window === 'undefined')
    {
        return;
    }

    hasScheduled = true;
    loadContextualFonts();

    const load = () =>
    {
        void loadNonCriticalFonts();
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
