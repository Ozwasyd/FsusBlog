export const PUBLIC_BOOT_HANDOFF_SCHEMA = 'fsusblog.public-boot-handoff.v1' as const;
export const PUBLIC_BOOT_FAILURE_STORAGE_KEY = 'fsus:public-boot-fail-closed';

const handoffId = 'fsus-public-boot-handoff';
const intentTypes = new Set(['pointerdown', 'touchstart', 'keydown', 'scroll']);

export type PublicBootIntent = Readonly<{
    type: string;
    timestamp: number;
}>;

export type PublicBootHandoff = Readonly<{
    schema: typeof PUBLIC_BOOT_HANDOFF_SCHEMA;
    frontendBuildIdentity: string;
    intent: PublicBootIntent | null;
}>;

function isIntent(value: unknown): value is PublicBootIntent
{
    if (value === null || typeof value !== 'object')
    {
        return false;
    }
    const candidate = value as Partial<PublicBootIntent>;
    return typeof candidate.type === 'string'
    && intentTypes.has(candidate.type)
    && typeof candidate.timestamp === 'number'
    && Number.isFinite(candidate.timestamp)
    && candidate.timestamp >= 0;
}

export function consumePublicBootHandoff(expectedBuildIdentity: string): PublicBootHandoff | null
{
    const carrier = document.getElementById(handoffId);
    if (!(carrier instanceof HTMLDivElement) || !carrier.hidden)
    {
        carrier?.remove();
        return null;
    }

    try
    {
        const value = JSON.parse(carrier.textContent ?? '') as Partial<PublicBootHandoff>;
        if (value.schema !== PUBLIC_BOOT_HANDOFF_SCHEMA
      || value.frontendBuildIdentity !== expectedBuildIdentity
      || !(value.intent === null || isIntent(value.intent)))
        {
            return null;
        }
        carrier.dataset.fsusblogConsumed = 'true';
        return value as PublicBootHandoff;
    }
    catch
    {
        return null;
    }
    finally
    {
        carrier.remove();
    }
}

export function failClosedPublicBootNavigation(
    frontendBuildIdentity: string,
    navigate: () => void = () => window.location.replace(window.location.href)
): 'navigated' | 'sealed'
{
    try
    {
        if (sessionStorage.getItem(PUBLIC_BOOT_FAILURE_STORAGE_KEY) === frontendBuildIdentity)
        {
            document.documentElement.dataset.fsusblogPublicBootFailed = 'true';
            return 'sealed';
        }
        sessionStorage.setItem(PUBLIC_BOOT_FAILURE_STORAGE_KEY, frontendBuildIdentity);
    }
    catch
    {
        document.documentElement.dataset.fsusblogPublicBootFailed = 'true';
        return 'sealed';
    }
    navigate();
    return 'navigated';
}

export function clearPublicBootFailure(frontendBuildIdentity: string): void
{
    try
    {
        if (sessionStorage.getItem(PUBLIC_BOOT_FAILURE_STORAGE_KEY) === frontendBuildIdentity)
        {
            sessionStorage.removeItem(PUBLIC_BOOT_FAILURE_STORAGE_KEY);
        }
    }
    catch
    {
    // Storage failure must not interfere with a successfully loaded entry.
    }
}
