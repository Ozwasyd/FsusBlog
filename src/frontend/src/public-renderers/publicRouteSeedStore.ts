import type { PublicPageSeed } from '@/public-renderers/pageSeed';
import { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore';
import type { PublicPageKind } from '@/public-renderers/publicRenderBase';

export type PublicRouteSeedKind = PublicPageKind;

export type PublicRouteSeedLookup = Readonly<{
    fullPath?: unknown;
    routeKey?: unknown;
}>;

export type PutPublicRouteSeedOptions<TKind extends PublicRouteSeedKind> = PublicRouteSeedLookup & Readonly<{
    kind: TKind;
    seed: PublicPageSeed<TKind>;
    nowMs?: number;
    ttlMs?: number;
    rendererVersion?: string | null;
}>;

type PublicRouteSeedReadOptions = Readonly<{
    nowMs?: number;
    rendererVersion?: string | null;
}>;

type PublicRouteSeedStoreEntry<TKind extends PublicRouteSeedKind = PublicRouteSeedKind> = Readonly<{
    kind: TKind;
    seed: PublicPageSeed<TKind>;
    keys: readonly string[];
    createdAtMs: number;
    expiresAtMs: number;
    rendererVersion: string | null;
}>;

const DEFAULT_PUBLIC_ROUTE_SEED_TTL_MS = 5 * 60 * 1000;
const routeSeedEntries = new Map<string, PublicRouteSeedStoreEntry>();

function nowMs(): number
{
    return Date.now();
}

function normalizeRouteKey(value: unknown): string | null
{
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function splitPath(fullPath: string): { path: string; suffix: string; }
{
    const queryIndex = fullPath.indexOf('?');
    const hashIndex = fullPath.indexOf('#');
    const suffixIndexCandidates = [queryIndex, hashIndex].filter((index) => index >= 0);
    const suffixIndex = suffixIndexCandidates.length > 0 ? Math.min(...suffixIndexCandidates) : -1;
    if (suffixIndex < 0)
    {
        return { path: fullPath, suffix: '' };
    }

    return {
        path: fullPath.slice(0, suffixIndex),
        suffix: fullPath.slice(suffixIndex)
    };
}

function normalizeFullPath(value: unknown): string | null
{
    if (typeof value !== 'string')
    {
        return null;
    }

    const raw = value.trim();
    if (!raw)
    {
        return null;
    }

    const fullPath = (() =>
    {
        if (/^https?:\/\//i.test(raw))
        {
            try
            {
                const url = new URL(raw);
                return `${url.pathname}${url.search}${url.hash}`;
            }
            catch
            {
                return raw;
            }
        }

        return raw.startsWith('/') ? raw : `/${raw}`;
    })();

    const { path, suffix } = splitPath(fullPath);
    const normalizedPath = path === '/' ? '/' : path.replace(/\/+$/, '') || '/';
    return `${normalizedPath}${suffix}`;
}

function currentFullPath(): string | null
{
    if (typeof window === 'undefined')
    {
        return null;
    }

    return normalizeFullPath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
}

function storageKeys(lookup: PublicRouteSeedLookup): string[]
{
    const keys: string[] = [];
    const fullPath = normalizeFullPath(lookup.fullPath) ?? (lookup.fullPath === undefined ? currentFullPath() : null);
    const routeKey = normalizeRouteKey(lookup.routeKey);
    if (fullPath)
    {
        keys.push(`fullPath:${fullPath}`);
    }
    if (routeKey)
    {
        keys.push(`routeKey:${routeKey}`);
    }

    return keys;
}

function hasExplicitLookup(lookup: PublicRouteSeedLookup): boolean
{
    return lookup.fullPath !== undefined || lookup.routeKey !== undefined;
}

function getSeedRendererVersion<TKind extends PublicRouteSeedKind>(
    seed: PublicPageSeed<TKind>,
    override?: string | null
): string | null
{
    if (typeof override === 'string' && override.trim().length > 0)
    {
        return override.trim();
    }

    const hydrationVersion = seed.hydration?.rendererVersion;
    if (typeof hydrationVersion === 'string' && hydrationVersion.trim().length > 0)
    {
        return hydrationVersion.trim();
    }

    const bootstrapVersion = seed.bootstrap?.rendererVersion;
    return typeof bootstrapVersion === 'string' && bootstrapVersion.trim().length > 0
        ? bootstrapVersion.trim()
        : null;
}

function seedMatchesKind<TKind extends PublicRouteSeedKind>(
    kind: TKind,
    seed: PublicPageSeed<TKind>
): boolean
{
    const bootstrapKind = seed.bootstrap?.kind;
    const hydrationKind = seed.hydration?.pageKind;
    return (!bootstrapKind || bootstrapKind === kind) && (!hydrationKind || hydrationKind === kind);
}

function removeEntry(entry: PublicRouteSeedStoreEntry): void
{
    for (const key of entry.keys)
    {
        if (routeSeedEntries.get(key) === entry)
        {
            routeSeedEntries.delete(key);
        }
    }
}

function removeCollidingEntries(keys: readonly string[]): void
{
    for (const key of keys)
    {
        const existing = routeSeedEntries.get(key);
        if (existing)
        {
            removeEntry(existing);
        }
    }
}

function isEntryUsable<TKind extends PublicRouteSeedKind>(
    kind: TKind,
    entry: PublicRouteSeedStoreEntry,
    options: PublicRouteSeedReadOptions
): entry is PublicRouteSeedStoreEntry<TKind>
{
    if (entry.kind !== kind)
    {
        return false;
    }

    const readAtMs = options.nowMs ?? nowMs();
    if (entry.expiresAtMs <= readAtMs)
    {
        removeEntry(entry);
        return false;
    }

    const expectedRendererVersion = typeof options.rendererVersion === 'string' && options.rendererVersion.trim().length > 0
        ? options.rendererVersion.trim()
        : PUBLIC_RENDERER_VERSION;
    if (entry.rendererVersion && expectedRendererVersion && entry.rendererVersion !== expectedRendererVersion)
    {
        removeEntry(entry);
        return false;
    }

    if (!seedMatchesKind(kind, entry.seed as PublicPageSeed<TKind>))
    {
        removeEntry(entry);
        return false;
    }

    return true;
}

function findEntry<TKind extends PublicRouteSeedKind>(
    kind: TKind,
    lookup: PublicRouteSeedLookup,
    options: PublicRouteSeedReadOptions
): PublicRouteSeedStoreEntry<TKind> | null
{
    for (const key of storageKeys(lookup))
    {
        const entry = routeSeedEntries.get(key);
        if (entry && isEntryUsable(kind, entry, options))
        {
            return entry;
        }
    }

    return null;
}

export function putPublicRouteSeed<TKind extends PublicRouteSeedKind>(
    options: PutPublicRouteSeedOptions<TKind>
): void
{
    if (!seedMatchesKind(options.kind, options.seed))
    {
        return;
    }

    const keys = storageKeys(options);
    if (keys.length === 0)
    {
        return;
    }

    const createdAtMs = options.nowMs ?? nowMs();
    const ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_PUBLIC_ROUTE_SEED_TTL_MS);
    const entry: PublicRouteSeedStoreEntry<TKind> = {
        kind: options.kind,
        seed: options.seed,
        keys,
        createdAtMs,
        expiresAtMs: createdAtMs + ttlMs,
        rendererVersion: getSeedRendererVersion(options.seed, options.rendererVersion)
    };

    removeCollidingEntries(keys);
    for (const key of keys)
    {
        routeSeedEntries.set(key, entry);
    }
}

export function peekPublicRouteSeed<TKind extends PublicRouteSeedKind>(
    kind: TKind,
    lookup: PublicRouteSeedLookup = {},
    options: PublicRouteSeedReadOptions = {}
): PublicPageSeed<TKind> | null
{
    return findEntry(kind, lookup, options)?.seed ?? null;
}

export function consumePublicRouteSeed<TKind extends PublicRouteSeedKind>(
    kind: TKind,
    lookup: PublicRouteSeedLookup = {},
    options: PublicRouteSeedReadOptions = {}
): PublicPageSeed<TKind> | null
{
    const entry = findEntry(kind, lookup, options);
    if (!entry)
    {
        return null;
    }

    removeEntry(entry);
    return entry.seed;
}

export function invalidatePublicRouteSeed(lookup: PublicRouteSeedLookup = {}): void
{
    if (!hasExplicitLookup(lookup))
    {
        routeSeedEntries.clear();
        return;
    }

    const keys = storageKeys(lookup);
    if (keys.length === 0)
    {
        routeSeedEntries.clear();
        return;
    }

    for (const key of keys)
    {
        const entry = routeSeedEntries.get(key);
        if (entry)
        {
            removeEntry(entry);
        }
    }
}

export function resetPublicRouteSeedStoreForTests(): void
{
    routeSeedEntries.clear();
}
