const RELOAD_GUARD_PREFIX = 'fsusblog:challenge-capability-reload:';

export type ChallengeCapabilityReloadResult = 'reload_requested' | 'already_requested' | 'guard_unavailable';

export interface ChallengeCapabilityReloadDependencies {
    readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
    readonly reload?: (() => void) | null;
}

/**
 * Requests one normal document reload for a stale challenge-capability build.
 * The per-build session marker is written before reload so a stale CDN/browser
 * response cannot create a reload loop. If the guard cannot be persisted, the
 * client fails closed instead of attempting an unbounded reload.
 */
export function requestChallengeCapabilityReload(
    manifestVersion: string,
    dependencies: ChallengeCapabilityReloadDependencies = {}
): ChallengeCapabilityReloadResult
{
    const storage = dependencies.storage === undefined
        ? browserSessionStorage()
        : dependencies.storage;
    const reload = dependencies.reload === undefined
        ? browserReload()
        : dependencies.reload;
    if (!storage || !reload)
    {
        return 'guard_unavailable';
    }

    const key = `${RELOAD_GUARD_PREFIX}${manifestVersion.trim() || 'unknown'}`;
    try
    {
        if (storage.getItem(key) === 'requested')
        {
            return 'already_requested';
        }
        storage.setItem(key, 'requested');
    }
    catch
    {
        return 'guard_unavailable';
    }

    reload();
    return 'reload_requested';
}

function browserSessionStorage(): Storage | null
{
    if (typeof window === 'undefined')
    {
        return null;
    }
    try
    {
        return window.sessionStorage;
    }
    catch
    {
        return null;
    }
}

function browserReload(): (() => void) | null
{
    return typeof window === 'undefined'
        ? null
        : () => window.location.reload();
}
