import {
    isCanonicalReleaseId,
    LOCAL_UNVERSIONED_RELEASE_ID
} from '@/generated/releaseIdContract';

export const BOOTSTRAP_IMPORT_RETRY_KEY = 'fsus:bootstrap-import-retry';
export const BOOTSTRAP_IMPORT_RETRY_TTL_MS = 5 * 60 * 1000;

interface BootstrapImportRetryState {
    buildId: string;
    attemptedAtMs: number;
}

export interface BootstrapImportRecovery {
    clear(): void;
    retryOnce(error: unknown): boolean;
}

export interface BootstrapImportRecoveryOptions {
    storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    reload(): void;
    buildId: string;
    now?: () => number;
    ttlMs?: number;
}

export function isRecoverableBootstrapImportError(error: unknown): boolean
{
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('Failed to fetch dynamically imported module')
    || message.includes('Importing a module script failed')
    || message.includes('error loading dynamically imported module');
}

export function createBootstrapImportRecovery(
    options: BootstrapImportRecoveryOptions
): BootstrapImportRecovery
{
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? BOOTSTRAP_IMPORT_RETRY_TTL_MS;
    const buildId = options.buildId.trim();
    if (buildId !== LOCAL_UNVERSIONED_RELEASE_ID && !isCanonicalReleaseId(buildId))
    {
        throw new Error('Bootstrap import recovery requires a canonical frontend build identity.');
    }

    const clear = (): void =>
    {
        try
        {
            options.storage.removeItem(BOOTSTRAP_IMPORT_RETRY_KEY);
        }
        catch
        {
            // Storage can be unavailable in hardened/private browser contexts.
        }
    };

    const readCurrentState = (): BootstrapImportRetryState | null =>
    {
        try
        {
            const raw = options.storage.getItem(BOOTSTRAP_IMPORT_RETRY_KEY);
            if (!raw)
            {
                return null;
            }

            const parsed = JSON.parse(raw) as Partial<BootstrapImportRetryState>;
            if (typeof parsed.buildId !== 'string'
            || typeof parsed.attemptedAtMs !== 'number'
            || !Number.isFinite(parsed.attemptedAtMs))
            {
                clear();
                return null;
            }

            const ageMs = now() - parsed.attemptedAtMs;
            if (parsed.buildId !== buildId || ageMs < 0 || ageMs > ttlMs)
            {
                clear();
                return null;
            }

            return {
                buildId: parsed.buildId,
                attemptedAtMs: parsed.attemptedAtMs
            };
        }
        catch
        {
            clear();
            return null;
        }
    };

    // A successful deployment/version change or an abandoned retry window must
    // not carry the previous release's one-shot marker into this bootstrap.
    readCurrentState();

    return {
        clear,
        retryOnce(error: unknown): boolean
        {
            if (!isRecoverableBootstrapImportError(error) || readCurrentState())
            {
                return false;
            }

            try
            {
                const state: BootstrapImportRetryState = {
                    buildId,
                    attemptedAtMs: now()
                };
                options.storage.setItem(BOOTSTRAP_IMPORT_RETRY_KEY, JSON.stringify(state));
                options.reload();
                return true;
            }
            catch
            {
                clear();
                return false;
            }
        }
    };
}

export async function runBootstrapImport<TModule>(
    load: () => Promise<TModule>,
    bootstrap: (module: TModule) => Promise<void>,
    recovery: BootstrapImportRecovery
): Promise<void>
{
    try
    {
        const module = await load();
        await bootstrap(module);
        recovery.clear();
    }
    catch (error)
    {
        if (!recovery.retryOnce(error))
        {
            throw error;
        }
    }
}
