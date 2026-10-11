export const ARTICLE_RECOVERY_JOURNAL_DATABASE = 'fsusblog-article-recovery-journal';
export const ARTICLE_RECOVERY_JOURNAL_STORE = 'entries';
export const ARTICLE_RECOVERY_JOURNAL_SCHEMA = 'fsusblog.article-recovery-journal.v2';
export const ARTICLE_RECOVERY_JOURNAL_PAYLOAD_CODEC = 'utf8-v1';
export const ARTICLE_RECOVERY_JOURNAL_TTL_HOURS = 168;
export const ARTICLE_RECOVERY_JOURNAL_TTL_MS = ARTICLE_RECOVERY_JOURNAL_TTL_HOURS * 60 * 60 * 1000;
export const ARTICLE_RECOVERY_JOURNAL_MAX_CONTENT_BYTES = 1024 * 1024;
export const ARTICLE_RECOVERY_JOURNAL_MAX_STORED_BYTES = 1024 * 1024;
export const ARTICLE_RECOVERY_JOURNAL_MAX_SCOPE_ENTRIES = 8;
export const ARTICLE_RECOVERY_JOURNAL_MAX_TOTAL_ENTRIES = 32;
export const ARTICLE_RECOVERY_JOURNAL_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const ARTICLE_RECOVERY_JOURNAL_PRIVACY_NOTICE
    = '未同步正文以明文暂存在本机浏览器 IndexedDB，未加密，最长 7 天；服务端确认、发布、删除、登出或显式丢弃后立即删除。同源脚本与本机账户可读取该暂存。';

const ARTICLE_RECOVERY_JOURNAL_VERSION = 1;
const ARTICLE_RECOVERY_COORDINATION_CHANNEL = 'fsus-article-recovery-journal-v1';
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ARTICLE_KEY_PATTERN = /^(?:create|edit:[1-9]\d*)$/u;
const CLIENT_REVISION_PATTERN = /^[a-zA-Z0-9-]{8,128}$/u;
const TAB_ID_PATTERN = /^[a-zA-Z0-9-]{8,128}$/u;
const RECORD_KEYS = new Set([
    'id',
    'schema',
    'identityHash',
    'articleKey',
    'articleId',
    'tabId',
    'baseRevisionId',
    'serverRevision',
    'clientRevision',
    'sourceHash',
    'payloadCodec',
    'payload',
    'createdAt',
    'updatedAt',
    'expiresAt',
    'contentBytes',
    'storedBytes'
]);

export type ArticleRecoveryJournalWriteStatus =
  | 'stored'
  | 'unavailable'
  | 'oversize'
  | 'quota-exceeded'
  | 'capacity-exceeded';

export type ArticleRecoveryJournalReadStatus = 'ready' | 'unavailable';

export type ArticleRecoveryDivergence =
  | 'none'
  | 'newer-server-draft'
  | 'newer-current-revision';

export interface ArticleRecoveryJournalRecord {
    id: string;
    schema: typeof ARTICLE_RECOVERY_JOURNAL_SCHEMA;
    identityHash: string;
    articleKey: string;
    articleId: number | null;
    tabId: string;
    baseRevisionId: string | null;
    serverRevision: number | null;
    clientRevision: string;
    sourceHash: string;
    content: string;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    contentBytes: number;
    storedBytes: number;
}

interface ArticleRecoveryJournalStoredRecord {
    id: string;
    schema: typeof ARTICLE_RECOVERY_JOURNAL_SCHEMA;
    identityHash: string;
    articleKey: string;
    articleId: number | null;
    tabId: string;
    baseRevisionId: string | null;
    serverRevision: number | null;
    clientRevision: string;
    sourceHash: string;
    payloadCodec: typeof ARTICLE_RECOVERY_JOURNAL_PAYLOAD_CODEC;
    payload: Uint8Array;
    createdAt: number;
    updatedAt: number;
    expiresAt: number;
    contentBytes: number;
    storedBytes: number;
}

export interface ArticleRecoveryJournalWriteInput {
    identityId: string;
    articleId: number | null;
    tabId: string;
    baseRevisionId: string | null;
    serverRevision: number | null;
    clientRevision: string;
    content: string;
}

export interface ArticleRecoveryJournalWriteResult {
    status: ArticleRecoveryJournalWriteStatus;
    record: ArticleRecoveryJournalRecord | null;
}

/** Actual mounted Writer/native facts; null from the reader means released ownership. */
export interface ArticleRecoveryJournalCheckpointSource extends ArticleRecoveryJournalWriteInput {
    readonly owner: object;
    readonly mountedEditor: object;
    readonly siteScope: string;
    readonly draftKey: string;
    readonly registryRevision: number;
    readonly associationRevision: number;
    readonly editorSessionRef: string;
    readonly documentId: string;
    readonly draftId: string;
    readonly documentEpoch: number;
    readonly editorRevision: number;
    readonly sourceRevision: string | null;
    readonly draftRevision: string | null;
}

declare const articleRecoveryCheckpointBrand: unique symbol;

/** Process-local capability, accepted only by the issuing original journal binding. */
export interface ArticleRecoveryJournalCheckpoint {
    readonly [articleRecoveryCheckpointBrand]: true;
}

export type ArticleRecoveryJournalCheckpointInfo = Readonly<Omit<
    ArticleRecoveryJournalCheckpointSource, 'owner' | 'mountedEditor' | 'content' | 'identityId'
> & {
    identityHash: string;
    sourceHash: string;
    expiresAt: number;
}>;

export interface ArticleRecoveryJournalCheckpointBinding {
    /** Completes original IndexedDB persistence before issuing custody; busy/cancel/stale refuse. */
    prepare(signal?: AbortSignal): Promise<ArticleRecoveryJournalCheckpoint | null>;
    /** Checks owner-local custody and independently rereads the actual mounted source synchronously. */
    inspect(token: ArticleRecoveryJournalCheckpoint): ArticleRecoveryJournalCheckpointInfo | null;
    /** Same synchronous owner-local admission check as inspect. */
    validate(token: ArticleRecoveryJournalCheckpoint): boolean;
    /** Rereads original storage and verifies integrity/ownership; never applies content to an editor. */
    restore(token: ArticleRecoveryJournalCheckpoint): Promise<Readonly<ArticleRecoveryJournalRecord> | null>;
    invalidate(): void;
    release(): void;
}

interface ArticleRecoveryCheckpointCustody {
    token: ArticleRecoveryJournalCheckpoint;
    source: Omit<ArticleRecoveryJournalCheckpointSource, 'content'>;
    record: Omit<ArticleRecoveryJournalRecord, 'content'>;
    info: ArticleRecoveryJournalCheckpointInfo;
}

interface ArticleRecoveryCheckpointBindingState {
    readSource: () => ArticleRecoveryJournalCheckpointSource | null;
    custody: ArticleRecoveryCheckpointCustody | null;
    generation: number;
}

function sameCheckpointSource(
    left: Omit<ArticleRecoveryJournalCheckpointSource, 'content'>,
    right: ArticleRecoveryJournalCheckpointSource
): boolean
{
    return left.owner === right.owner
        && left.mountedEditor === right.mountedEditor
        && left.siteScope === right.siteScope
        && left.draftKey === right.draftKey
        && left.registryRevision === right.registryRevision
        && left.associationRevision === right.associationRevision
        && left.identityId === right.identityId
        && left.articleId === right.articleId
        && left.tabId === right.tabId
        && left.baseRevisionId === right.baseRevisionId
        && left.serverRevision === right.serverRevision
        && left.clientRevision === right.clientRevision
        && left.editorSessionRef === right.editorSessionRef
        && left.documentId === right.documentId
        && left.draftId === right.draftId
        && left.documentEpoch === right.documentEpoch
        && left.editorRevision === right.editorRevision
        && left.sourceRevision === right.sourceRevision
        && left.draftRevision === right.draftRevision;
}

function validCheckpointSource(source: ArticleRecoveryJournalCheckpointSource): boolean
{
    return typeof source.owner === 'object' && source.owner !== null
        && typeof source.mountedEditor === 'object' && source.mountedEditor !== null
        && source.siteScope.trim().length > 0
        && source.draftKey.trim().length > 0
        && Number.isSafeInteger(source.registryRevision) && source.registryRevision >= 0
        && Number.isSafeInteger(source.associationRevision) && source.associationRevision >= 0
        && source.identityId.trim().length > 0
        && (source.articleId === null || (Number.isSafeInteger(source.articleId) && source.articleId > 0))
        && TAB_ID_PATTERN.test(source.tabId)
        && CLIENT_REVISION_PATTERN.test(source.clientRevision)
        && isNullableRevision(source.baseRevisionId)
        && isNullableServerRevision(source.serverRevision)
        && source.editorSessionRef.trim().length > 0
        && source.documentId.trim().length > 0
        && source.draftId.trim().length > 0
        && Number.isSafeInteger(source.documentEpoch) && source.documentEpoch >= 0
        && Number.isSafeInteger(source.editorRevision) && source.editorRevision >= 0
        && (source.sourceRevision === null || typeof source.sourceRevision === 'string')
        && (source.draftRevision === null || typeof source.draftRevision === 'string');
}

export type ArticleRecoveryFlushResult = ArticleRecoveryJournalWriteResult | null;

export interface ArticleRecoveryJournalReadResult {
    status: ArticleRecoveryJournalReadStatus;
    records: readonly ArticleRecoveryJournalRecord[];
    removedInvalidRecords: number;
}

export interface ArticleRecoveryJournalConfirmation {
    id: string;
    clientRevision: string;
    sourceHash: string;
}

export interface ArticleRecoveryAuthoritativeState {
    currentRevisionId: string | null;
    serverRevision: number | null;
}

export interface ArticleRecoveryComparisonSource {
    label: string;
    content: string;
}

export type ArticleRecoveryOperationKind = 'compare' | 'recover' | 'discard';

export interface ArticleRecoveryOperationState {
    kind: ArticleRecoveryOperationKind | null;
    error: string;
}

export interface ArticleRecoveryLifecycleEnvironment {
    document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
    window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'>;
}

interface ArticleRecoveryJournalOptions {
    indexedDB?: IDBFactory | null;
    now?: () => number;
}

interface ArticleRecoveryCoordinationMessage {
    schema: 'fsusblog.article-recovery-coordination.v1';
    type: 'changed' | 'cleared';
    articleKey: string;
    tabId: string;
    at: number;
}

type BroadcastChannelConstructor = new (name: string) => BroadcastChannel;

function getGlobalIndexedDb(): IDBFactory | null
{
    return typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB;
}

function bytesToHex(bytes: Uint8Array): string
{
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string>
{
    const bytes = new TextEncoder().encode(value);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
}

function encodeArticleRecoveryPayload(content: string): Uint8Array
{
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > ARTICLE_RECOVERY_JOURNAL_MAX_STORED_BYTES)
    {
        throw new Error('article_recovery_payload_oversize');
    }
    return bytes;
}

function decodeArticleRecoveryPayload(payload: Uint8Array): string
{
    if (payload.byteLength > ARTICLE_RECOVERY_JOURNAL_MAX_CONTENT_BYTES)
    {
        throw new Error('article_recovery_payload_oversize');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
}

export function articleRecoveryArticleKey(articleId: number | null): string
{
    return articleId === null ? 'create' : `edit:${articleId}`;
}

export function createArticleRecoveryTabId(): string
{
    if (typeof globalThis.crypto?.randomUUID === 'function')
    {
        return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function createArticleRecoveryClientRevision(): string
{
    return createArticleRecoveryTabId();
}

export async function articleRecoverySourceHash(content: string): Promise<string>
{
    return sha256Hex(`${ARTICLE_RECOVERY_JOURNAL_SCHEMA}:source:${content}`);
}

export async function articleRecoveryIdentityHash(identityId: string): Promise<string>
{
    return sha256Hex(`${ARTICLE_RECOVERY_JOURNAL_SCHEMA}:identity:${identityId}`);
}

export function assessArticleRecoveryDivergence(
    record: ArticleRecoveryJournalRecord,
    authoritative: ArticleRecoveryAuthoritativeState
): ArticleRecoveryDivergence
{
    if (record.baseRevisionId !== authoritative.currentRevisionId)
    {
        return 'newer-current-revision';
    }
    if (authoritative.serverRevision !== null
    && (record.serverRevision === null || authoritative.serverRevision > record.serverRevision))
    {
        return 'newer-server-draft';
    }
    return 'none';
}

function comparisonExcerpt(content: string): string
{
    const excerpt = content.replace(/\s+/gu, ' ').trim().slice(0, 120);
    return excerpt || '（空正文）';
}

export function summarizeArticleRecoveryComparison(
    record: ArticleRecoveryJournalRecord,
    sources: readonly ArticleRecoveryComparisonSource[]
): string
{
    const comparisons = sources.map(source =>
    {
        const relation = source.content === record.content ? '内容相同' : '内容不同';
        return `${source.label} ${source.content.length.toLocaleString()} 字，${relation}，摘要“${comparisonExcerpt(source.content)}”`;
    });
    return [
        `未同步正文 ${record.content.length.toLocaleString()} 字，摘要“${comparisonExcerpt(record.content)}”`,
        ...comparisons
    ].join('；');
}

export function createArticleRecoveryOperationRunner(
    onStateChange: (state: ArticleRecoveryOperationState) => void
): (
    kind: ArticleRecoveryOperationKind,
    failureMessage: string,
    operation: () => void | Promise<void>
) => Promise<boolean>
{
    let activeOperation: ArticleRecoveryOperationKind | null = null;
    return async (kind, failureMessage, operation) =>
    {
        if (activeOperation !== null)
        {
            return false;
        }
        activeOperation = kind;
        onStateChange({ kind, error: '' });
        try
        {
            await operation();
            onStateChange({ kind: null, error: '' });
            return true;
        }
        catch
        {
            onStateChange({ kind: null, error: failureMessage });
            return false;
        }
        finally
        {
            activeOperation = null;
        }
    };
}

function isNullableRevision(value: unknown): value is string | null
{
    return value === null || (typeof value === 'string' && /^\d+$/u.test(value));
}

function isNullableServerRevision(value: unknown): value is number | null
{
    return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function normalizeStoredRecord(
    value: unknown,
    now: number
): ArticleRecoveryJournalStoredRecord | null
{
    if (typeof value !== 'object' || value === null)
    {
        return null;
    }
    const raw = value as Partial<ArticleRecoveryJournalStoredRecord>;
    if (Object.keys(raw).some(key => !RECORD_KEYS.has(key))
    || raw.schema !== ARTICLE_RECOVERY_JOURNAL_SCHEMA
    || typeof raw.id !== 'string'
    || typeof raw.identityHash !== 'string'
    || !HASH_PATTERN.test(raw.identityHash)
    || typeof raw.articleKey !== 'string'
    || !ARTICLE_KEY_PATTERN.test(raw.articleKey)
    || (raw.articleId !== null && (!Number.isSafeInteger(raw.articleId) || Number(raw.articleId) < 1))
    || articleRecoveryArticleKey(raw.articleId ?? null) !== raw.articleKey
    || typeof raw.tabId !== 'string'
    || !TAB_ID_PATTERN.test(raw.tabId)
    || !isNullableRevision(raw.baseRevisionId)
    || !isNullableServerRevision(raw.serverRevision)
    || typeof raw.clientRevision !== 'string'
    || !CLIENT_REVISION_PATTERN.test(raw.clientRevision)
    || typeof raw.sourceHash !== 'string'
    || !HASH_PATTERN.test(raw.sourceHash)
    || raw.payloadCodec !== ARTICLE_RECOVERY_JOURNAL_PAYLOAD_CODEC
    || !(raw.payload instanceof Uint8Array)
    || typeof raw.createdAt !== 'number'
    || !Number.isFinite(raw.createdAt)
    || typeof raw.updatedAt !== 'number'
    || !Number.isFinite(raw.updatedAt)
    || typeof raw.expiresAt !== 'number'
    || !Number.isFinite(raw.expiresAt)
    || raw.expiresAt <= now
    || raw.createdAt > raw.updatedAt
    || raw.expiresAt > raw.updatedAt + ARTICLE_RECOVERY_JOURNAL_TTL_MS
    || raw.expiresAt > now + ARTICLE_RECOVERY_JOURNAL_TTL_MS
    || typeof raw.contentBytes !== 'number'
    || !Number.isSafeInteger(raw.contentBytes)
    || raw.contentBytes < 0
    || raw.contentBytes > ARTICLE_RECOVERY_JOURNAL_MAX_CONTENT_BYTES
    || typeof raw.storedBytes !== 'number'
    || !Number.isSafeInteger(raw.storedBytes)
    || raw.storedBytes < 0
    || raw.storedBytes > ARTICLE_RECOVERY_JOURNAL_MAX_STORED_BYTES
    || raw.payload.byteLength !== raw.storedBytes)
    {
        return null;
    }
    const expectedId = `${raw.identityHash}:${raw.articleKey}:${raw.tabId}`;
    if (raw.id !== expectedId)
    {
        return null;
    }
    return raw as ArticleRecoveryJournalStoredRecord;
}

async function hydrateStoredRecord(
    stored: ArticleRecoveryJournalStoredRecord
): Promise<ArticleRecoveryJournalRecord>
{
    const content = decodeArticleRecoveryPayload(stored.payload);
    const contentBytes = new TextEncoder().encode(content).byteLength;
    const sourceHash = await articleRecoverySourceHash(content);
    if (contentBytes !== stored.contentBytes || sourceHash !== stored.sourceHash)
    {
        throw new Error('article_recovery_payload_integrity_mismatch');
    }
    return {
        id: stored.id,
        schema: stored.schema,
        identityHash: stored.identityHash,
        articleKey: stored.articleKey,
        articleId: stored.articleId,
        tabId: stored.tabId,
        baseRevisionId: stored.baseRevisionId,
        serverRevision: stored.serverRevision,
        clientRevision: stored.clientRevision,
        sourceHash: stored.sourceHash,
        content,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        expiresAt: stored.expiresAt,
        contentBytes: stored.contentBytes,
        storedBytes: stored.storedBytes
    };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T>
{
    return new Promise<T>((resolve, reject) =>
    {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('article_recovery_indexeddb_request_failed'));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void>
{
    return new Promise<void>((resolve, reject) =>
    {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('article_recovery_indexeddb_transaction_failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('article_recovery_indexeddb_transaction_aborted'));
    });
}

function openDatabase(indexedDB: IDBFactory): Promise<IDBDatabase>
{
    return new Promise<IDBDatabase>((resolve, reject) =>
    {
        let request: IDBOpenDBRequest;
        try
        {
            request = indexedDB.open(ARTICLE_RECOVERY_JOURNAL_DATABASE, ARTICLE_RECOVERY_JOURNAL_VERSION);
        }
        catch (error: unknown)
        {
            reject(error instanceof Error
                ? error
                : new Error('article_recovery_indexeddb_open_failed', { cause: error }));
            return;
        }
        request.onupgradeneeded = () =>
        {
            const database = request.result;
            if (!database.objectStoreNames.contains(ARTICLE_RECOVERY_JOURNAL_STORE))
            {
                database.createObjectStore(ARTICLE_RECOVERY_JOURNAL_STORE, { keyPath: 'id' });
            }
        };
        request.onsuccess = () =>
        {
            const database = request.result;
            database.onversionchange = () => database.close();
            resolve(database);
        };
        request.onerror = () => reject(request.error ?? new Error('article_recovery_indexeddb_open_failed'));
        request.onblocked = () => reject(new Error('article_recovery_indexeddb_open_blocked'));
    });
}

function classifyWriteFailure(error: unknown): ArticleRecoveryJournalWriteStatus
{
    if (error instanceof Error && error.message === 'article_recovery_payload_oversize')
    {
        return 'oversize';
    }
    return error instanceof DOMException && error.name === 'QuotaExceededError'
        ? 'quota-exceeded'
        : 'unavailable';
}

function sameStoredRecordSnapshot(left: unknown, right: unknown): boolean
{
    if (Object.is(left, right))
    {
        return true;
    }
    if (left instanceof Uint8Array && right instanceof Uint8Array)
    {
        return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
    }
    if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    {
        return false;
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return keys.length === Object.keys(rightRecord).length
        && keys.every(key => Object.hasOwn(rightRecord, key) && sameStoredRecordSnapshot(leftRecord[key], rightRecord[key]));
}

async function deleteRecordIds(
    database: IDBDatabase,
    records: readonly { id: string; value: unknown; }[],
    now: number,
    onDeleting: (id: string) => void
): Promise<number>
{
    if (records.length === 0)
    {
        return 0;
    }
    const transaction = database.transaction(ARTICLE_RECOVERY_JOURNAL_STORE, 'readwrite');
    const completed = transactionDone(transaction);
    const store = transaction.objectStore(ARTICLE_RECOVERY_JOURNAL_STORE);
    const current = await Promise.all(records.map(record => requestResult<unknown>(store.get(record.id))));
    let removed = 0;
    for (const [index, observed] of records.entries())
    {
        const value = current[index];
        // A valid replacement must not be deleted using an earlier read's invalid IDs.
        if (value !== undefined && (normalizeStoredRecord(value, now) === null || sameStoredRecordSnapshot(observed.value, value)))
        {
            onDeleting(observed.id);
            store.delete(observed.id);
            removed += 1;
        }
    }
    await completed;
    return removed;
}

export class ArticleRecoveryJournal
{
    private readonly configuredIndexedDb: IDBFactory | null | undefined;
    private readonly now: () => number;
    readonly #checkpointBindings = new Set<ArticleRecoveryCheckpointBindingState>();
    #checkpointDatabase: IDBDatabase | null = null;
    #preparingCheckpoint = false;

    constructor(options: ArticleRecoveryJournalOptions = {})
    {
        this.configuredIndexedDb = options.indexedDB;
        this.now = options.now ?? (() => Date.now());
    }

    private resolveIndexedDb(): IDBFactory | null
    {
        return this.configuredIndexedDb === undefined ? getGlobalIndexedDb() : this.configuredIndexedDb;
    }

    /**
     * Binds an independent reader of the actual Writer/native owner. No scope facts
     * are inferred from routes, record IDs, hashes or the recovery tab identifier.
     * Call release on original owner release and invalidate on external coordination.
     */
    bindCheckpointSource(
        readSource: () => ArticleRecoveryJournalCheckpointSource | null
    ): ArticleRecoveryJournalCheckpointBinding
    {
        if (this.#checkpointBindings.size >= ARTICLE_RECOVERY_JOURNAL_MAX_TOTAL_ENTRIES)
        {
            throw new Error('article_recovery_checkpoint_binding_capacity');
        }
        const state: ArticleRecoveryCheckpointBindingState = { readSource, custody: null, generation: 0 };
        this.#checkpointBindings.add(state);
        return Object.freeze({
            prepare: (signal?: AbortSignal) => this.prepareCheckpoint(state, signal),
            inspect: (token: ArticleRecoveryJournalCheckpoint) => this.inspectCheckpoint(state, token),
            validate: (token: ArticleRecoveryJournalCheckpoint) => this.inspectCheckpoint(state, token) !== null,
            restore: (token: ArticleRecoveryJournalCheckpoint) => this.restoreCheckpoint(state, token),
            invalidate: () => this.invalidateCheckpointBinding(state),
            release: () =>
            {
                this.invalidateCheckpointBinding(state);
                this.#checkpointBindings.delete(state);
                state.readSource = () => null;
                if (this.#checkpointBindings.size === 0)
                {
                    this.#checkpointDatabase?.close();
                    this.#checkpointDatabase = null;
                }
            }
        });
    }

    /** Revokes capabilities and outstanding prepares before original cleanup/mutation. */
    invalidateCheckpoints(): void
    {
        for (const state of this.#checkpointBindings)
        {
            this.invalidateCheckpointBinding(state);
        }
        this.#checkpointDatabase?.close();
        this.#checkpointDatabase = null;
    }

    private invalidateCheckpointBinding(state: ArticleRecoveryCheckpointBindingState): void
    {
        state.generation += 1;
        state.custody = null;
    }

    private readCheckpointSource(state: ArticleRecoveryCheckpointBindingState): ArticleRecoveryJournalCheckpointSource | null
    {
        if (!this.#checkpointBindings.has(state))
        {
            return null;
        }
        try
        {
            const source = state.readSource();
            const snapshot = source && validCheckpointSource(source) ? Object.freeze({ ...source }) : null;
            return this.#checkpointBindings.has(state) ? snapshot : null;
        }
        catch
        {
            return null;
        }
    }

    private inspectCheckpoint(
        state: ArticleRecoveryCheckpointBindingState,
        token: ArticleRecoveryJournalCheckpoint
    ): ArticleRecoveryJournalCheckpointInfo | null
    {
        const now = this.now();
        const custody = state.custody;
        const source = this.readCheckpointSource(state);
        if (!custody || state.custody !== custody || custody.token !== token || !source
            || !sameCheckpointSource(custody.source, source)
            || custody.record.expiresAt <= now)
        {
            // A foreign token must not revoke the legitimate token as a side effect.
            if (custody?.token === token && state.custody === custody)
            {
                this.invalidateCheckpointBinding(state);
            }
            return null;
        }
        return custody.info;
    }

    private async prepareCheckpoint(
        state: ArticleRecoveryCheckpointBindingState,
        signal?: AbortSignal
    ): Promise<ArticleRecoveryJournalCheckpoint | null>
    {
        if (signal?.aborted || this.#preparingCheckpoint)
        {
            return null;
        }
        this.#preparingCheckpoint = true;
        const cancel = () => this.invalidateCheckpointBinding(state);
        signal?.addEventListener('abort', cancel, { once: true });
        try
        {
            const source = this.readCheckpointSource(state);
            const indexedDB = this.resolveIndexedDb();
            if (!source || !indexedDB || signal?.aborted)
            {
                return null;
            }
            // The original record can be overwritten in place: revoke old custody first.
            this.invalidateCheckpoints();
            const generation = state.generation;
            if (!this.#checkpointDatabase)
            {
                const database = await openDatabase(indexedDB);
                database.onversionchange = () =>
                {
                    if (this.#checkpointDatabase !== database)
                    {
                        database.close();
                        return;
                    }
                    this.invalidateCheckpoints();
                    database.close();
                    if (this.#checkpointDatabase === database)
                    {
                        this.#checkpointDatabase = null;
                    }
                };
                database.onclose = () =>
                {
                    if (this.#checkpointDatabase === database)
                    {
                        this.invalidateCheckpoints();
                    }
                };
                if (state.generation !== generation || !this.#checkpointBindings.has(state))
                {
                    database.close();
                    return null;
                }
                this.#checkpointDatabase = database;
            }
            if (signal?.aborted || state.generation !== generation || !this.#checkpointBindings.has(state))
            {
                return null;
            }
            const result = await this.persist(source);
            if (result.status !== 'stored' || !result.record)
            {
                return null;
            }
            const read = await this.list(source.identityId, source.articleId);
            const record = read.records.find(candidate => candidate.id === result.record?.id);
            const current = this.readCheckpointSource(state);
            if (read.status !== 'ready' || !record || !current || signal?.aborted
                || Object.entries(result.record).some(([key, value]) => record[key as keyof ArticleRecoveryJournalRecord] !== value)
                || state.generation !== generation || !sameCheckpointSource(source, current)
                || source.content !== current.content || record.expiresAt <= this.now())
            {
                return null;
            }
            const { content: sourceContent, owner, mountedEditor, identityId, ...publicSource } = source;
            const { content: recordContent, ...recordMetadata } = record;
            if (sourceContent !== recordContent)
            {
                return null;
            }
            // Only scalar custody survives prepare; body restoration stays in IndexedDB.
            const token = Object.freeze({}) as ArticleRecoveryJournalCheckpoint;
            state.custody = {
                token,
                source: Object.freeze({ ...publicSource, owner, mountedEditor, identityId }),
                record: Object.freeze(recordMetadata),
                info: Object.freeze({
                    ...publicSource,
                    identityHash: record.identityHash,
                    sourceHash: record.sourceHash,
                    expiresAt: record.expiresAt
                })
            };
            return token;
        }
        catch
        {
            return null;
        }
        finally
        {
            signal?.removeEventListener('abort', cancel);
            this.#preparingCheckpoint = false;
            if (![...this.#checkpointBindings].some(binding => binding.custody !== null))
            {
                this.#checkpointDatabase?.close();
                this.#checkpointDatabase = null;
            }
        }
    }

    private async restoreCheckpoint(
        state: ArticleRecoveryCheckpointBindingState,
        token: ArticleRecoveryJournalCheckpoint
    ): Promise<Readonly<ArticleRecoveryJournalRecord> | null>
    {
        if (!this.inspectCheckpoint(state, token) || !state.custody)
        {
            return null;
        }
        const custody = state.custody;
        const result = await this.list(custody.source.identityId, custody.source.articleId);
        const record = result.records.find(candidate => candidate.id === custody.record.id);
        if (result.status !== 'ready' || !record || !this.inspectCheckpoint(state, token)
            || Object.entries(custody.record).some(([key, value]) => record[key as keyof ArticleRecoveryJournalRecord] !== value))
        {
            if (state.custody === custody)
            {
                this.invalidateCheckpointBinding(state);
            }
            return null;
        }
        return Object.freeze({ ...record });
    }

    async write(input: ArticleRecoveryJournalWriteInput): Promise<ArticleRecoveryJournalWriteResult>
    {
        this.invalidateCheckpoints();
        try
        {
            return await this.persist(Object.freeze({ ...input }));
        }
        finally
        {
            this.invalidateCheckpoints();
        }
    }

    private async persist(input: ArticleRecoveryJournalWriteInput): Promise<ArticleRecoveryJournalWriteResult>
    {
        const indexedDB = this.resolveIndexedDb();
        if (!indexedDB || !input.identityId.trim())
        {
            return { status: 'unavailable', record: null };
        }
        const contentBytes = new TextEncoder().encode(input.content).byteLength;
        if (contentBytes > ARTICLE_RECOVERY_JOURNAL_MAX_CONTENT_BYTES)
        {
            return { status: 'oversize', record: null };
        }

        let database: IDBDatabase | null = null;
        try
        {
            const payload = encodeArticleRecoveryPayload(input.content);
            const storedBytes = payload.byteLength;
            const [identityHash, sourceHash] = await Promise.all([
                articleRecoveryIdentityHash(input.identityId),
                articleRecoverySourceHash(input.content)
            ]);
            const articleKey = articleRecoveryArticleKey(input.articleId);
            const now = this.now();
            const id = `${identityHash}:${articleKey}:${input.tabId}`;
            database = await openDatabase(indexedDB);
            const transaction = database.transaction(ARTICLE_RECOVERY_JOURNAL_STORE, 'readwrite');
            const store = transaction.objectStore(ARTICLE_RECOVERY_JOURNAL_STORE);
            const rawRecords = await requestResult(store.getAll()) as unknown[];
            const activeRecords: ArticleRecoveryJournalStoredRecord[] = [];
            for (const raw of rawRecords)
            {
                const record = normalizeStoredRecord(raw, now);
                if (record)
                {
                    activeRecords.push(record);
                }
                else if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown; }).id === 'string')
                {
                    store.delete((raw as { id: string; }).id);
                }
            }
            const previous = activeRecords.find(record => record.id === id);
            const scopeCount = activeRecords.filter(record => (
                record.identityHash === identityHash
        && record.articleKey === articleKey
        && record.id !== id
            )).length;
            const totalCount = activeRecords.filter(record => record.id !== id).length;
            const totalBytes = activeRecords
                .filter(record => record.id !== id)
                .reduce((sum, record) => sum + record.storedBytes, 0);
            if (scopeCount >= ARTICLE_RECOVERY_JOURNAL_MAX_SCOPE_ENTRIES
        || totalCount >= ARTICLE_RECOVERY_JOURNAL_MAX_TOTAL_ENTRIES
        || totalBytes + storedBytes > ARTICLE_RECOVERY_JOURNAL_MAX_TOTAL_BYTES)
            {
                await transactionDone(transaction);
                return { status: 'capacity-exceeded', record: null };
            }

            const storedRecord: ArticleRecoveryJournalStoredRecord = {
                id,
                schema: ARTICLE_RECOVERY_JOURNAL_SCHEMA,
                identityHash,
                articleKey,
                articleId: input.articleId,
                tabId: input.tabId,
                baseRevisionId: input.baseRevisionId,
                serverRevision: input.serverRevision,
                clientRevision: input.clientRevision,
                sourceHash,
                payloadCodec: ARTICLE_RECOVERY_JOURNAL_PAYLOAD_CODEC,
                payload,
                createdAt: previous?.createdAt ?? now,
                updatedAt: now,
                expiresAt: now + ARTICLE_RECOVERY_JOURNAL_TTL_MS,
                contentBytes,
                storedBytes
            };
            store.put(storedRecord);
            await transactionDone(transaction);
            return {
                status: 'stored',
                record: {
                    id,
                    schema: ARTICLE_RECOVERY_JOURNAL_SCHEMA,
                    identityHash,
                    articleKey,
                    articleId: input.articleId,
                    tabId: input.tabId,
                    baseRevisionId: input.baseRevisionId,
                    serverRevision: input.serverRevision,
                    clientRevision: input.clientRevision,
                    sourceHash,
                    content: input.content,
                    createdAt: storedRecord.createdAt,
                    updatedAt: now,
                    expiresAt: storedRecord.expiresAt,
                    contentBytes,
                    storedBytes
                }
            };
        }
        catch (error: unknown)
        {
            return { status: classifyWriteFailure(error), record: null };
        }
        finally
        {
            database?.close();
        }
    }

    async list(identityId: string, articleId: number | null): Promise<ArticleRecoveryJournalReadResult>
    {
        const checkpointCustodies = [...this.#checkpointBindings].map(binding => ({ binding, custody: binding.custody }));
        const indexedDB = this.resolveIndexedDb();
        if (!indexedDB || !identityId.trim())
        {
            return { status: 'unavailable', records: [], removedInvalidRecords: 0 };
        }
        let database: IDBDatabase | null = null;
        try
        {
            const identityHash = await articleRecoveryIdentityHash(identityId);
            const articleKey = articleRecoveryArticleKey(articleId);
            const now = this.now();
            database = await openDatabase(indexedDB);
            const transaction = database.transaction(ARTICLE_RECOVERY_JOURNAL_STORE, 'readonly');
            const rawRecords = await requestResult(transaction.objectStore(ARTICLE_RECOVERY_JOURNAL_STORE).getAll()) as unknown[];
            await transactionDone(transaction);
            const invalidRecords: { id: string; value: unknown; }[] = [];
            const candidates: ArticleRecoveryJournalRecord[] = [];
            for (const raw of rawRecords)
            {
                const stored = normalizeStoredRecord(raw, now);
                const rawId = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown; }).id : null;
                if (!stored)
                {
                    if (typeof rawId === 'string')
                    {
                        invalidRecords.push({ id: rawId, value: raw });
                    }
                    continue;
                }
                if (stored.identityHash !== identityHash || stored.articleKey !== articleKey)
                {
                    continue;
                }
                try
                {
                    candidates.push(await hydrateStoredRecord(stored));
                }
                catch
                {
                    invalidRecords.push({ id: stored.id, value: raw });
                }
            }
            const removedInvalidRecords = await deleteRecordIds(database, invalidRecords, this.now(), (id) =>
            {
                // This is an actual conditional storage deletion, not a stale read's observation.
                for (const binding of this.#checkpointBindings)
                {
                    if (binding.custody?.record.id === id)
                    {
                        this.invalidateCheckpointBinding(binding);
                    }
                }
            });
            for (const { binding, custody } of checkpointCustodies)
            {
                if (!custody || binding.custody !== custody
                    || custody.record.identityHash !== identityHash || custody.record.articleKey !== articleKey)
                {
                    continue;
                }
                const candidate = candidates.find(record => record.id === custody.record.id);
                if (!candidate || Object.entries(custody.record).some(([key, value]) => candidate[key as keyof ArticleRecoveryJournalRecord] !== value))
                {
                    this.invalidateCheckpointBinding(binding);
                }
            }
            candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.tabId.localeCompare(right.tabId));
            return {
                status: 'ready',
                records: Object.freeze(candidates),
                removedInvalidRecords
            };
        }
        catch
        {
            return { status: 'unavailable', records: [], removedInvalidRecords: 0 };
        }
        finally
        {
            database?.close();
        }
    }

    async confirm(confirmation: ArticleRecoveryJournalConfirmation): Promise<boolean>
    {
        this.invalidateCheckpoints();
        const indexedDB = this.resolveIndexedDb();
        if (!indexedDB)
        {
            return false;
        }
        let database: IDBDatabase | null = null;
        try
        {
            database = await openDatabase(indexedDB);
            const transaction = database.transaction(ARTICLE_RECOVERY_JOURNAL_STORE, 'readwrite');
            const store = transaction.objectStore(ARTICLE_RECOVERY_JOURNAL_STORE);
            const record = normalizeStoredRecord(
                await requestResult(store.get(confirmation.id)),
                this.now()
            );
            const matched = record?.clientRevision === confirmation.clientRevision
        && record.sourceHash === confirmation.sourceHash;
            if (matched)
            {
                store.delete(confirmation.id);
            }
            await transactionDone(transaction);
            return matched;
        }
        catch
        {
            return false;
        }
        finally
        {
            this.invalidateCheckpoints();
            database?.close();
        }
    }

    async discard(recordId: string): Promise<boolean>
    {
        this.invalidateCheckpoints();
        const indexedDB = this.resolveIndexedDb();
        if (!indexedDB)
        {
            return false;
        }
        let database: IDBDatabase | null = null;
        try
        {
            database = await openDatabase(indexedDB);
            const transaction = database.transaction(ARTICLE_RECOVERY_JOURNAL_STORE, 'readwrite');
            const store = transaction.objectStore(ARTICLE_RECOVERY_JOURNAL_STORE);
            const existing = await requestResult<unknown>(store.get(recordId));
            if (existing !== undefined)
            {
                store.delete(recordId);
            }
            await transactionDone(transaction);
            return existing !== undefined;
        }
        catch
        {
            return false;
        }
        finally
        {
            this.invalidateCheckpoints();
            database?.close();
        }
    }

    async clearScope(identityId: string, articleId: number | null): Promise<number>
    {
        this.invalidateCheckpoints();
        try
        {
            const identityHash = await articleRecoveryIdentityHash(identityId);
            return this.clearMatching(record => (
                record.identityHash === identityHash
        && record.articleKey === articleRecoveryArticleKey(articleId)
            ));
        }
        catch
        {
            return 0;
        }
    }

    async clearArticle(articleId: number): Promise<number>
    {
        this.invalidateCheckpoints();
        return this.clearMatching(record => record.articleKey === articleRecoveryArticleKey(articleId));
    }

    private async clearMatching(
        matches: (record: Partial<ArticleRecoveryJournalStoredRecord>) => boolean
    ): Promise<number>
    {
        const indexedDB = this.resolveIndexedDb();
        if (!indexedDB)
        {
            return 0;
        }
        let database: IDBDatabase | null = null;
        try
        {
            database = await openDatabase(indexedDB);
            const transaction = database.transaction(ARTICLE_RECOVERY_JOURNAL_STORE, 'readwrite');
            const store = transaction.objectStore(ARTICLE_RECOVERY_JOURNAL_STORE);
            const rawRecords = await requestResult(store.getAll()) as unknown[];
            let removed = 0;
            for (const raw of rawRecords)
            {
                if (typeof raw !== 'object' || raw === null)
                {
                    continue;
                }
                const record = raw as Partial<ArticleRecoveryJournalStoredRecord>;
                if (typeof record.id === 'string' && matches(record))
                {
                    store.delete(record.id);
                    removed += 1;
                }
            }
            await transactionDone(transaction);
            return removed;
        }
        catch
        {
            return 0;
        }
        finally
        {
            this.invalidateCheckpoints();
            database?.close();
        }
    }
}

interface ArticleRecoveryFlushOperation {
    sequence: number;
    input: ArticleRecoveryJournalWriteInput;
    settled: boolean;
    promise: Promise<ArticleRecoveryFlushResult>;
    resolve: (result: ArticleRecoveryFlushResult) => void;
    reject: (error: unknown) => void;
}

export class ArticleRecoveryFlushOwner
{
    private latest: ArticleRecoveryJournalWriteInput | null = null;
    private latestSequence = 0;
    private lastStoredSequence = 0;
    private lastStoredResult: ArticleRecoveryJournalWriteResult | null = null;
    private inFlight: ArticleRecoveryFlushOperation | null = null;
    private pending: ArticleRecoveryFlushOperation | null = null;

    constructor(
        private readonly writer: (
            input: ArticleRecoveryJournalWriteInput
        ) => Promise<ArticleRecoveryJournalWriteResult>
    )
    {}

    stage(input: ArticleRecoveryJournalWriteInput): void
    {
        if (this.latest?.identityId === input.identityId
        && this.latest.articleId === input.articleId
        && this.latest.tabId === input.tabId
        && this.latest.baseRevisionId === input.baseRevisionId
        && this.latest.serverRevision === input.serverRevision
        && this.latest.clientRevision === input.clientRevision
        && this.latest.content === input.content)
        {
            return;
        }
        this.latest = {
            ...input
        };
        this.latestSequence += 1;
        if (this.pending)
        {
            this.pending.resolve(null);
            this.pending = this.createOperation(this.latestSequence, this.latest);
        }
    }

    flush(): Promise<ArticleRecoveryFlushResult>
    {
        if (!this.latest)
        {
            return Promise.resolve(null);
        }

        const sequence = this.latestSequence;
        if (sequence === this.lastStoredSequence && this.lastStoredResult)
        {
            return Promise.resolve(this.lastStoredResult);
        }
        if (this.inFlight?.sequence === sequence && !this.inFlight.settled)
        {
            return this.inFlight.promise;
        }
        if (this.pending?.sequence === sequence)
        {
            return this.pending.promise;
        }

        const operation = this.createOperation(sequence, this.latest);
        if (this.inFlight)
        {
            if (this.pending)
            {
                this.pending.resolve(null);
            }
            this.pending = operation;
        }
        else
        {
            this.startOperation(operation);
        }
        return operation.promise;
    }

    markConfirmed(confirmation: ArticleRecoveryJournalConfirmation): void
    {
        const stored = this.lastStoredResult?.record;
        if (this.latest?.clientRevision !== confirmation.clientRevision
        || stored?.id !== confirmation.id
        || stored.sourceHash !== confirmation.sourceHash)
        {
            return;
        }
        this.latest = null;
        this.lastStoredResult = null;
        this.lastStoredSequence = 0;
    }

    async drain(): Promise<void>
    {
        while (this.inFlight || this.pending)
        {
            if (!this.inFlight && this.pending)
            {
                const operation = this.pending;
                this.pending = null;
                this.startOperation(operation);
            }
            await this.inFlight?.promise.catch(() => undefined);
            await Promise.resolve();
        }
    }

    clear(): void
    {
        this.pending?.resolve(null);
        this.pending = null;
        this.latest = null;
        this.lastStoredResult = null;
        this.lastStoredSequence = 0;
        this.latestSequence += 1;
    }

    pendingClientRevision(): string | null
    {
        return this.latest?.clientRevision ?? null;
    }

    private createOperation(
        sequence: number,
        input: ArticleRecoveryJournalWriteInput
    ): ArticleRecoveryFlushOperation
    {
        let resolveOperation!: (result: ArticleRecoveryFlushResult) => void;
        let rejectOperation!: (error: unknown) => void;
        const promise = new Promise<ArticleRecoveryFlushResult>((resolve, reject) =>
        {
            resolveOperation = resolve;
            rejectOperation = reject;
        });
        void promise.catch(() => undefined);
        return {
            sequence,
            input: { ...input },
            settled: false,
            promise,
            resolve: resolveOperation,
            reject: rejectOperation
        };
    }

    private startOperation(operation: ArticleRecoveryFlushOperation): void
    {
        this.inFlight = operation;
        void this.writer(operation.input)
            .then(result =>
            {
                operation.settled = true;
                if (result.status === 'stored')
                {
                    this.lastStoredSequence = operation.sequence;
                    this.lastStoredResult = result;
                }
                operation.resolve(result);
            }, error =>
            {
                operation.settled = true;
                operation.reject(error);
            })
            .finally(() =>
            {
                if (this.inFlight === operation)
                {
                    this.inFlight = null;
                }
                const next = this.pending;
                this.pending = null;
                if (next)
                {
                    this.startOperation(next);
                }
            });
    }
}

export function bindArticleRecoveryLifecycleFlush(
    flush: () => void | Promise<unknown>,
    environment: ArticleRecoveryLifecycleEnvironment,
    intervalMs: number
): () => void
{
    let disposed = false;
    const requestFlush = (): void =>
    {
        if (!disposed)
        {
            void Promise.resolve(flush()).catch(() => undefined);
        }
    };
    const handleVisibilityChange = (): void =>
    {
        if (environment.document.visibilityState === 'hidden')
        {
            requestFlush();
        }
    };
    const handlePageHide = (): void => requestFlush();
    const handleBeforeUnload = (): void => requestFlush();

    environment.document.addEventListener('visibilitychange', handleVisibilityChange);
    environment.window.addEventListener('pagehide', handlePageHide);
    environment.window.addEventListener('beforeunload', handleBeforeUnload);
    const timer = environment.window.setInterval(requestFlush, intervalMs);

    return () =>
    {
        disposed = true;
        environment.document.removeEventListener('visibilitychange', handleVisibilityChange);
        environment.window.removeEventListener('pagehide', handlePageHide);
        environment.window.removeEventListener('beforeunload', handleBeforeUnload);
        environment.window.clearInterval(timer);
    };
}

function parseCoordinationMessage(value: unknown): ArticleRecoveryCoordinationMessage | null
{
    if (typeof value !== 'object' || value === null)
    {
        return null;
    }
    const raw = value as Partial<ArticleRecoveryCoordinationMessage>;
    if (raw.schema !== 'fsusblog.article-recovery-coordination.v1'
    || (raw.type !== 'changed' && raw.type !== 'cleared')
    || typeof raw.articleKey !== 'string'
    || !ARTICLE_KEY_PATTERN.test(raw.articleKey)
    || typeof raw.tabId !== 'string'
    || !TAB_ID_PATTERN.test(raw.tabId)
    || typeof raw.at !== 'number'
    || !Number.isFinite(raw.at))
    {
        return null;
    }
    return {
        schema: 'fsusblog.article-recovery-coordination.v1',
        type: raw.type,
        articleKey: raw.articleKey,
        tabId: raw.tabId,
        at: raw.at
    };
}

export class ArticleRecoveryCoordinator
{
    readonly tabId: string;
    private channel: BroadcastChannel | null = null;
    private readonly subscribers = new Set<(message: ArticleRecoveryCoordinationMessage) => void>();

    constructor(options: {
        tabId?: string;
        BroadcastChannel?: BroadcastChannelConstructor | null;
    } = {})
    {
        this.tabId = options.tabId ?? createArticleRecoveryTabId();
        const BroadcastChannelImpl = options.BroadcastChannel === undefined
            ? (typeof globalThis.BroadcastChannel === 'function' ? globalThis.BroadcastChannel : null)
            : options.BroadcastChannel;
        if (BroadcastChannelImpl)
        {
            this.channel = new BroadcastChannelImpl(ARTICLE_RECOVERY_COORDINATION_CHANNEL);
            this.channel.addEventListener('message', this.handleMessage);
        }
    }

    subscribe(subscriber: (message: ArticleRecoveryCoordinationMessage) => void): () => void
    {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }

    notify(type: ArticleRecoveryCoordinationMessage['type'], articleId: number | null): void
    {
        this.channel?.postMessage({
            schema: 'fsusblog.article-recovery-coordination.v1',
            type,
            articleKey: articleRecoveryArticleKey(articleId),
            tabId: this.tabId,
            at: Date.now()
        } satisfies ArticleRecoveryCoordinationMessage);
    }

    dispose(): void
    {
        this.channel?.removeEventListener('message', this.handleMessage);
        this.channel?.close();
        this.channel = null;
        this.subscribers.clear();
    }

    private handleMessage = (event: MessageEvent): void =>
    {
        const message = parseCoordinationMessage(event.data);
        if (!message || message.tabId === this.tabId)
        {
            return;
        }
        articleRecoveryJournal.invalidateCheckpoints();
        for (const subscriber of this.subscribers)
        {
            subscriber(message);
        }
    };
}

export const articleRecoveryJournal = new ArticleRecoveryJournal();
