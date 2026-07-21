export const COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX = 'fsus:comment-public-draft:v3:';
export const COMMENT_PUBLIC_DRAFT_SCOPE_KEY = 'fsus:comment-public-draft-scope:v3';
export const LEGACY_COMMENT_DRAFT_STORAGE_PREFIX = 'fsus:comment-draft:v1:';

const LOCAL_SCOPE_PATTERN = /^[a-f0-9]{32}$/u;

export interface PersistedPublicCommentDraft {
    version: 3;
    content: string;
    savedAt: number;
    policyHash: string;
    clientMutationId: string;
}

export interface CommentPublicDraftStoragePreparation {
    scopeId: string | null;
    cleanupComplete: boolean;
    persistenceAvailable: boolean;
}

export interface CommentPublicDraftReadResult {
    draft: PersistedPublicCommentDraft | null;
    cleanupComplete: boolean;
}

export function prepareCommentPublicDraftStorage(
    storage: Storage,
    cryptoSource: Pick<Crypto, 'getRandomValues'> | null = getGlobalCrypto()
): CommentPublicDraftStoragePreparation
{
    let keys: string[];
    try
    {
        keys = listStorageKeys(storage);
    }
    catch
    {
        return { scopeId: null, cleanupComplete: false, persistenceAvailable: false };
    }

    let cleanupComplete = true;
    for (const key of keys)
    {
        if (key.startsWith(LEGACY_COMMENT_DRAFT_STORAGE_PREFIX))
        {
            cleanupComplete = removeStorageItem(storage, key) && cleanupComplete;
        }
    }

    let scopeId: string | null;
    try
    {
        const storedScope = storage.getItem(COMMENT_PUBLIC_DRAFT_SCOPE_KEY);
        scopeId = storedScope && LOCAL_SCOPE_PATTERN.test(storedScope) ? storedScope : null;
        if (storedScope && !scopeId)
        {
            cleanupComplete = removeStorageItem(storage, COMMENT_PUBLIC_DRAFT_SCOPE_KEY) && cleanupComplete;
        }
    }
    catch
    {
        return { scopeId: null, cleanupComplete, persistenceAvailable: false };
    }

    if (!scopeId)
    {
        for (const key of keys)
        {
            if (key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX))
            {
                cleanupComplete = removeStorageItem(storage, key) && cleanupComplete;
            }
        }
        scopeId = createLocalScopeId(cryptoSource);
        if (!scopeId)
        {
            return { scopeId: null, cleanupComplete, persistenceAvailable: false };
        }
        try
        {
            storage.setItem(COMMENT_PUBLIC_DRAFT_SCOPE_KEY, scopeId);
        }
        catch
        {
            return { scopeId: null, cleanupComplete, persistenceAvailable: false };
        }
    }

    const activePrefix = `${COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX}${scopeId}:`;
    for (const key of keys)
    {
        if (key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX) && !key.startsWith(activePrefix))
        {
            cleanupComplete = removeStorageItem(storage, key) && cleanupComplete;
        }
    }

    return { scopeId, cleanupComplete, persistenceAvailable: true };
}

export function createCommentPublicDraftStorageKey(input: {
    scopeId: string;
    articleId: number | null;
    replyId: string | null;
}): string
{
    if (!LOCAL_SCOPE_PATTERN.test(input.scopeId) || !Number.isSafeInteger(input.articleId) || (input.articleId ?? 0) <= 0)
    {
        return '';
    }
    const replySlot = input.replyId?.trim() ? encodeURIComponent(input.replyId.trim()) : 'root';
    return `${COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX}${input.scopeId}:${input.articleId}:${replySlot}`;
}

export function readCommentPublicDraft(storage: Storage, key: string): CommentPublicDraftReadResult
{
    if (!key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX))
    {
        return { draft: null, cleanupComplete: true };
    }
    try
    {
        const raw = storage.getItem(key);
        if (!raw)
        {
            return { draft: null, cleanupComplete: true };
        }
        const value = JSON.parse(raw) as Partial<PersistedPublicCommentDraft>;
        if (!isPersistedPublicCommentDraft(value))
        {
            return { draft: null, cleanupComplete: removeStorageItem(storage, key) };
        }
        return { draft: value, cleanupComplete: true };
    }
    catch
    {
        return { draft: null, cleanupComplete: false };
    }
}

export function writeCommentPublicDraft(
    storage: Storage,
    key: string,
    draft: PersistedPublicCommentDraft
): boolean
{
    if (!key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX) || !isPersistedPublicCommentDraft(draft))
    {
        return false;
    }
    try
    {
        storage.setItem(key, JSON.stringify(draft));
        return true;
    }
    catch
    {
        return false;
    }
}

export function removeCommentPublicDraft(storage: Storage, key: string): boolean
{
    if (!key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX))
    {
        return true;
    }
    return removeStorageItem(storage, key);
}

export function clearAllCommentDraftStorage(storage: Storage): boolean
{
    let keys: string[];
    try
    {
        keys = listStorageKeys(storage);
    }
    catch
    {
        return false;
    }

    let complete = true;
    for (const key of keys)
    {
        if (key === COMMENT_PUBLIC_DRAFT_SCOPE_KEY ||
      key.startsWith(COMMENT_PUBLIC_DRAFT_STORAGE_PREFIX) ||
      key.startsWith(LEGACY_COMMENT_DRAFT_STORAGE_PREFIX))
        {
            complete = removeStorageItem(storage, key) && complete;
        }
    }
    return complete;
}

function isPersistedPublicCommentDraft(value: Partial<PersistedPublicCommentDraft>): value is PersistedPublicCommentDraft
{
    return value.version === 3 &&
    typeof value.content === 'string' &&
    Boolean(value.content.trim()) &&
    typeof value.savedAt === 'number' &&
    Number.isFinite(value.savedAt) &&
    typeof value.policyHash === 'string' &&
    typeof value.clientMutationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.clientMutationId);
}

function listStorageKeys(storage: Storage): string[]
{
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1)
    {
        const key = storage.key(index);
        if (key)
        {
            keys.push(key);
        }
    }
    return keys;
}

function removeStorageItem(storage: Storage, key: string): boolean
{
    try
    {
        storage.removeItem(key);
        return true;
    }
    catch
    {
        return false;
    }
}

function createLocalScopeId(cryptoSource: Pick<Crypto, 'getRandomValues'> | null): string | null
{
    if (!cryptoSource || typeof cryptoSource.getRandomValues !== 'function')
    {
        return null;
    }
    const bytes = new Uint8Array(16);
    try
    {
        cryptoSource.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    catch
    {
        return null;
    }
    finally
    {
        bytes.fill(0);
    }
}

function getGlobalCrypto(): Pick<Crypto, 'getRandomValues'> | null
{
    return typeof globalThis.crypto === 'undefined' ? null : globalThis.crypto;
}
