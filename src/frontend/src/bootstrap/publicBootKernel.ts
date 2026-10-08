import {
    PUBLIC_BOOT_HANDOFF_SCHEMA,
    clearPublicBootFailure,
    failClosedPublicBootNavigation,
    type PublicBootHandoff,
    type PublicBootIntent
} from '@/bootstrap/publicBootHandoff';

type PublicBootConfig = Readonly<{
    schema: 'fsusblog.public-boot-config.v1';
    frontendBuildIdentity: string;
    entryUrl: string;
    coreModulePreloads: readonly string[];
    takeoverStylesheets: readonly string[];
}>;

interface TrustedTypePolicyLike {
    createScriptURL(value: string): unknown;
}

interface TrustedTypePolicyRules {
    createScriptURL(value: string): string;
}

interface TrustedTypePolicyFactoryLike {
    createPolicy(name: string, rules: TrustedTypePolicyRules): TrustedTypePolicyLike;
}

const configElementId = 'fsus-public-boot-config';
const handoffElementId = 'fsus-public-boot-handoff';
const intentTypes = ['pointerdown', 'touchstart', 'keydown', 'scroll'] as const;
let cleanupCurrentKernel = (): void =>
{
    // No kernel state exists before configuration validation.
};

function canonicalAssetUrl(value: unknown): string | null
{
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    {
        return null;
    }
    try
    {
        const url = new URL(value, window.location.href);
        return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin === window.location.origin
      && url.username === ''
      && url.password === ''
            ? url.href
            : null;
    }
    catch
    {
        return null;
    }
}

function isSameOriginAssetUrl(value: unknown): value is string
{
    return canonicalAssetUrl(value) !== null;
}

function isTrustedAssetList(value: unknown): value is readonly string[]
{
    return Array.isArray(value)
    && value.every(isSameOriginAssetUrl)
    && new Set(value.map(canonicalAssetUrl)).size === value.length;
}

function readConfig(): PublicBootConfig | null
{
    const element = document.getElementById(configElementId);
    if (!(element instanceof HTMLScriptElement) || element.type !== 'application/json')
    {
        return null;
    }
    try
    {
        const value = JSON.parse(element.textContent ?? '') as Partial<PublicBootConfig>;
        if (value.schema !== 'fsusblog.public-boot-config.v1'
            || typeof value.frontendBuildIdentity !== 'string'
            || value.frontendBuildIdentity.length === 0
            || value.frontendBuildIdentity.trim() !== value.frontendBuildIdentity
            || !isSameOriginAssetUrl(value.entryUrl)
            || !isTrustedAssetList(value.coreModulePreloads)
            || !isTrustedAssetList(value.takeoverStylesheets))
        {
            return null;
        }
        const configuredAssets = [
            value.entryUrl,
            ...value.coreModulePreloads,
            ...value.takeoverStylesheets
        ];
        return new Set(configuredAssets.map(canonicalAssetUrl)).size === configuredAssets.length
            ? value as PublicBootConfig
            : null;
    }
    catch
    {
        return null;
    }
}

function removeBootCarriers(): void
{
    document.getElementById(handoffElementId)?.remove();
    document.getElementById(configElementId)?.remove();
}

function failClosed(frontendBuildIdentity: string): void
{
    cleanupCurrentKernel();
    removeBootCarriers();
    failClosedPublicBootNavigation(frontendBuildIdentity);
}

const parsedConfig = readConfig();
if (!parsedConfig)
{
    failClosed('invalid-public-boot-config');
}
else
{
    const config = parsedConfig;
    let animationFrameHandle: number | null = null;
    let idleHandle: number | null = null;
    let fallbackTimer: number | null = null;
    let forcedTimer: number | null = null;
    let injected = false;
    let warmed = false;
    let entryScript: HTMLScriptElement | null = null;
    let entryPolicyListener: ((event: SecurityPolicyViolationEvent) => void) | null = null;
    let initializationFailed = false;

    const trustedSources = new Set([config.entryUrl, ...config.coreModulePreloads]);
    let trustedUrl: TrustedTypePolicyLike | null = null;

    function mark(name: string): void
    {
        try
        {
            window.performance?.mark(`fsus:start:${name}`);
        }
        catch
        { /* optional instrumentation */ }
    }

    function cleanupScheduling(): void
    {
        if (animationFrameHandle !== null)
        {
            window.cancelAnimationFrame(animationFrameHandle);
        }
        if (idleHandle !== null)
        {
            window.cancelIdleCallback?.(idleHandle);
        }
        if (fallbackTimer !== null)
        {
            window.clearTimeout(fallbackTimer);
        }
        if (forcedTimer !== null)
        {
            window.clearTimeout(forcedTimer);
        }
        animationFrameHandle = null;
        idleHandle = null;
        fallbackTimer = null;
        forcedTimer = null;
        document.removeEventListener('DOMContentLoaded', kickoff);
        for (const type of intentTypes)
        {
            window.removeEventListener(type, onIntent);
        }
    }

    function cleanupEntryFailureHooks(): void
    {
        if (entryPolicyListener)
        {
            window.removeEventListener('securitypolicyviolation', entryPolicyListener);
        }
        entryPolicyListener = null;
        if (entryScript)
        {
            entryScript.onload = null;
            entryScript.onerror = null;
        }
    }

    function cleanup(): void
    {
        cleanupScheduling();
        cleanupEntryFailureHooks();
    }

    cleanupCurrentKernel = cleanup;

    try
    {
        const trustedTypesFactory = (window as Window & {
            trustedTypes?: TrustedTypePolicyFactoryLike;
        }).trustedTypes;
        trustedUrl = trustedTypesFactory?.createPolicy
            ? trustedTypesFactory.createPolicy('fsusblog-spa-entry', {
                createScriptURL(value)
                {
                    if (!trustedSources.has(value))
                    {
                        throw new TypeError('fsusblog_public_boot_url_rejected');
                    }
                    return value;
                }
            })
            : null;
    }
    catch
    {
        initializationFailed = true;
        failClosed(config.frontendBuildIdentity);
    }

    function findEntryScript(): HTMLScriptElement | null
    {
        const expected = new URL(config.entryUrl, window.location.href).href;
        return [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
            .find((script) =>
            {
                try
                {
                    return new URL(script.src, window.location.href).href === expected;
                }
                catch
                {
                    return false;
                }
            }) ?? null;
    }

    function findLink(rel: 'modulepreload' | 'stylesheet', href: string): HTMLLinkElement | null
    {
        const expected = new URL(href, window.location.href).href;
        return [...document.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"][href]`)]
            .find((link) =>
            {
                try
                {
                    return new URL(link.href, window.location.href).href === expected;
                }
                catch
                {
                    return false;
                }
            }) ?? null;
    }

    function appendLink(rel: 'modulepreload' | 'stylesheet', href: string, foreground: boolean): void
    {
        const existing = findLink(rel, href);
        if (existing)
        {
            if (rel === 'modulepreload' && foreground)
            {
                existing.fetchPriority = 'high';
            }
            return;
        }
        const link = document.createElement('link');
        link.rel = rel;
        link.href = rel === 'modulepreload' && trustedUrl
            ? trustedUrl.createScriptURL(href) as string
            : href;
        link.crossOrigin = 'anonymous';
        if (rel === 'modulepreload')
        {
            link.fetchPriority = foreground ? 'high' : 'low';
        }
        (document.head || document.body).appendChild(link);
    }

    function warm(foreground: boolean): void
    {
        if (!warmed)
        {
            warmed = true;
            for (const href of [config.entryUrl, ...config.coreModulePreloads])
            {
                appendLink('modulepreload', href, foreground);
            }
            mark('public-boot-preload');
        }
        else if (foreground)
        {
            for (const href of [config.entryUrl, ...config.coreModulePreloads])
            {
                const preload = findLink('modulepreload', href);
                if (preload)
                {
                    preload.fetchPriority = 'high';
                }
            }
        }
    }

    function writeHandoff(intent: PublicBootIntent | null): void
    {
        document.getElementById(handoffElementId)?.remove();
        const carrier = document.createElement('div');
        carrier.id = handoffElementId;
        carrier.hidden = true;
        carrier.textContent = JSON.stringify({
            schema: PUBLIC_BOOT_HANDOFF_SCHEMA,
            frontendBuildIdentity: config.frontendBuildIdentity,
            intent
        } satisfies PublicBootHandoff);
        document.body.appendChild(carrier);
    }

    function onEntryFailure(): void
    {
        cleanupEntryFailureHooks();
        entryScript?.remove();
        failClosed(config.frontendBuildIdentity);
    }

    function inject(intent: PublicBootIntent | null): void
    {
        if (injected)
        {
            cleanupScheduling();
            return;
        }

        const existing = findEntryScript();
        if (existing)
        {
            injected = true;
            cleanupScheduling();
            const existingBuildIdentity = existing.dataset.fsusblogFrontendBuildIdentity;
            if (existingBuildIdentity !== config.frontendBuildIdentity)
            {
                failClosed(config.frontendBuildIdentity);
            }
            else
            {
                removeBootCarriers();
            }
            return;
        }

        injected = true;
        cleanupScheduling();
        try
        {
            warm(intent !== null);
            for (const href of config.takeoverStylesheets)
            {
                appendLink('stylesheet', href, true);
            }
            writeHandoff(intent);

            const script = document.createElement('script');
            entryScript = script;
            script.type = 'module';
            script.crossOrigin = 'anonymous';
            script.dataset.fsusblogSpaEntry = 'public-boot';
            script.dataset.fsusblogFrontendBuildIdentity = config.frontendBuildIdentity;
            entryPolicyListener = (event) =>
            {
                const blocked = event.blockedURI;
                if (event.effectiveDirective.includes('script')
          && (!blocked || new URL(blocked, window.location.href).href === new URL(config.entryUrl, window.location.href).href))
                {
                    onEntryFailure();
                }
            };
            window.addEventListener('securitypolicyviolation', entryPolicyListener);
            script.src = trustedUrl
                ? trustedUrl.createScriptURL(config.entryUrl) as string
                : config.entryUrl;
            mark('public-boot-entry-injected');
            document.body.appendChild(script);
            script.onload = () =>
            {
                cleanupEntryFailureHooks();
                clearPublicBootFailure(config.frontendBuildIdentity);
            };
            script.onerror = onEntryFailure;
        }
        catch
        {
            onEntryFailure();
        }
    }

    function scheduleSilentWarming(): void
    {
        animationFrameHandle = null;
        if (injected || idleHandle !== null || fallbackTimer !== null)
        {
            return;
        }
        if (typeof window.requestIdleCallback === 'function')
        {
            idleHandle = window.requestIdleCallback((deadline) =>
            {
                idleHandle = null;
                if (!deadline.didTimeout && deadline.timeRemaining() < 8)
                {
                    fallbackTimer = window.setTimeout(() =>
                    {
                        fallbackTimer = null;
                        inject(null);
                    }, 96);
                    return;
                }
                inject(null);
            }, { timeout: 1200 });
        }
        else
        {
            fallbackTimer = window.setTimeout(() =>
            {
                fallbackTimer = null;
                inject(null);
            }, 96);
        }
        forcedTimer = window.setTimeout(() =>
        {
            forcedTimer = null;
            inject(null);
        }, 1800);
    }

    function onIntent(event: Event): void
    {
        if (injected)
        {
            cleanupScheduling();
            return;
        }
        inject({ type: event.type, timestamp: Date.now() });
    }

    function kickoff(): void
    {
        document.removeEventListener('DOMContentLoaded', kickoff);
        animationFrameHandle = window.requestAnimationFrame(scheduleSilentWarming);
    }

    if (!initializationFailed)
    {
        for (const type of intentTypes)
        {
            window.addEventListener(type, onIntent, { passive: type !== 'keydown' });
        }
        if (document.readyState === 'loading')
        {
            document.addEventListener('DOMContentLoaded', kickoff, { once: true });
        }
        else
        {
            kickoff();
        }
    }
}

export function disposePublicBootKernel(): void
{
    cleanupCurrentKernel();
}
