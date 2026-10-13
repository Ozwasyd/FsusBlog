import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
    ARTICLE_RECOVERY_JOURNAL_DATABASE,
    articleRecoveryIdentityHash,
    articleRecoveryJournal,
    type ArticleRecoveryCoordinator,
    type ArticleRecoveryJournalRecord,
    type ArticleRecoveryJournalWriteStatus
} from './articleRecoveryJournal';

const captureSchema = 'fsusblog.article-capture-recovery.v1';
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const revisionPattern = /^[a-zA-Z0-9-]{8,128}$/u;
const inputKeys = ['schemaVersion', 'title', 'markdownContent'];
const envelopeKeys = ['schema', 'siteScope', 'ownerTabId', 'captureId', 'requestId', 'clientRevision', 'inputDigest', 'requestDigest', 'input'];

/** Exact supported projection of #2380 ArticleInboxCreateRequest; no URL/template/form fields. */
export interface ArticleCaptureInboxInput {
    readonly schemaVersion: 1;
    readonly title: string;
    readonly markdownContent: string;
}

/** Required actual authenticated actor/site source. This adapter issues no permission or site grant. */
export interface ArticleCaptureRecoveryScope {
    readonly owner: object;
    readonly adminPrincipalId: string;
    readonly siteScope: string;
    readonly canCreateInbox: boolean;
}

export interface ArticleCaptureRequestIdentity {
    readonly requestId: string;
    readonly clientRevision: string;
}

export interface ArticleCaptureRequestDescription extends ArticleCaptureRequestIdentity {
    readonly captureId: string;
    readonly inputDigest: string;
    readonly requestDigest: string;
    readonly input: ArticleCaptureInboxInput;
}

export type ArticleCaptureBlockedReason =
    | 'scope-retired'
    | 'busy'
    | 'coordination-unavailable'
    | 'capture-conflict'
    | 'input-invalid'
    | 'original-storage-unavailable'
    | 'coordination-changed'
    | 'original-record-changed';

export type ArticleCaptureStageResult =
    | Readonly<{ status: 'blocked'; reason: ArticleCaptureBlockedReason; serverOutcome: 'unknown'; }>
    | Readonly<{
        status: 'protected' | 'unprotected';
        protection: ArticleRecoveryJournalWriteStatus;
        request: ArticleCaptureRequestDescription;
        reason?: ArticleCaptureBlockedReason;
        serverOutcome: 'unknown';
    }>;

/** Digest-only discovery, not a restorable input, server receipt, permission, or open action. */
export interface ArticleCapturePendingRecord extends ArticleCaptureRequestIdentity {
    readonly journalId: string;
    readonly journalSourceHash: string;
    readonly captureId: string;
    readonly inputDigest: string;
    readonly requestDigest: string;
    readonly updatedAt: number;
    readonly expiresAt: number;
    readonly serverOutcome: 'unknown';
    readonly recovery: 'authoritative-reconciliation-required';
}

export type ArticleCaptureDiscoveryResult =
    | Readonly<{ status: 'blocked'; reason: ArticleCaptureBlockedReason; }>
    | Readonly<{ status: 'pending'; records: readonly ArticleCapturePendingRecord[]; malformed: number; }>;

export type ArticleCaptureDiscardResult = Readonly<{
    status: 'discarded' | 'absent' | 'blocked';
    reason?: ArticleCaptureBlockedReason;
    serverOutcome: 'unknown';
}>;

/** Missing genuine production hooks; no executable fake-success/reconciliation port is accepted. */
export const articleCaptureMissingHooks = Object.freeze([
    'actual-current-session-site-owner',
    'registered-generated-inbox-transport',
    'authenticated-transport-for-original-readonly-reconcile',
    'original-verified-create-receipt-custody',
    'source-url-and-explicit-inbox-template-request'
] as const);

interface CaptureEnvelope extends ArticleCaptureRequestDescription {
    schema: typeof captureSchema;
    siteScope: string;
    ownerTabId: string;
}

interface OwnedCapture {
    identity: ArticleCaptureRequestIdentity;
    inputDigest: string;
    requestDigest: string;
    record: Readonly<Omit<ArticleRecoveryJournalRecord, 'content'>> | null;
    protection: ArticleRecoveryJournalWriteStatus;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null
        && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function guid(value: string): string
{
    if (typeof value !== 'string' || !guidPattern.test(value) || value === '00000000-0000-0000-0000-000000000000')
    {
        throw new Error('capture_identity_invalid');
    }
    return value.toLowerCase();
}

function strictUtf8(value: string): Uint8Array
{
    const bytes = new TextEncoder().encode(value);
    if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== value)
    {
        throw new Error('capture_source_invalid_utf16');
    }
    return bytes;
}

function requireInput(value: unknown): ArticleCaptureInboxInput
{
    if (!exactKeys(value, inputKeys))
    {
        throw new Error('capture_input_invalid_or_unsupported');
    }
    const version = value.schemaVersion;
    const title = value.title;
    const markdownContent = value.markdownContent;
    if (version !== 1 || typeof title !== 'string' || typeof markdownContent !== 'string'
        || title.length > 256 || /\p{Cc}/u.test(title) || markdownContent.length > 200_000)
    {
        throw new Error('capture_input_invalid_or_unsupported');
    }
    strictUtf8(title);
    strictUtf8(markdownContent);
    // .NET Char.IsWhiteSpace admission, preserving BOM, line endings and every source byte.
    if (isDotNetWhitespace(title) && isDotNetWhitespace(markdownContent))
    {
        throw new Error('capture_input_empty');
    }
    return Object.freeze({ schemaVersion: 1, title, markdownContent });
}

function isDotNetWhitespace(value: string): boolean
{
    for (let index = 0; index < value.length; index += 1)
    {
        const code = value.charCodeAt(index);
        if (!((code >= 9 && code <= 13) || (code >= 0x2000 && code <= 0x200a)
            || [0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(code)))
        {
            return false;
        }
    }
    return true;
}

function commandDigest(parts: readonly Uint8Array[]): string
{
    // Exact ArticleTemplateReceiptContract.ComputeDigest framing: int32 LE length then bytes.
    const hash = sha256.create();
    for (const bytes of parts)
    {
        const length = new Uint8Array(4);
        new DataView(length.buffer).setInt32(0, bytes.length, true);
        hash.update(length).update(bytes);
    }
    return bytesToHex(hash.digest());
}

function guidBytes(value: string): Uint8Array
{
    const hex = guid(value).replaceAll('-', '');
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
    // Guid.ToByteArray(), not RFC network byte ordering.
    return Uint8Array.from([bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6], ...bytes.slice(8)]);
}

/** Client correlation projection of actual bc41079 request digests, never a verified receipt. */
export function describeArticleCaptureRequest(
    adminPrincipalId: string,
    captureId: string,
    identity: ArticleCaptureRequestIdentity,
    value: ArticleCaptureInboxInput
): ArticleCaptureRequestDescription
{
    if (!/^[1-9]\d{0,18}$/u.test(adminPrincipalId) || BigInt(adminPrincipalId) > 9_223_372_036_854_775_807n
        || !exactKeys(identity, ['requestId', 'clientRevision']) || typeof identity.requestId !== 'string'
        || typeof identity.clientRevision !== 'string' || !revisionPattern.test(identity.clientRevision))
    {
        throw new Error('capture_request_identity_invalid');
    }
    const input = requireInput(value);
    const requestId = guid(identity.requestId);
    const inputDigest = commandDigest(['article-inbox-create-input', '1', input.title, input.markdownContent].map(strictUtf8));
    const requestDigest = commandDigest([
        strictUtf8('2'), strictUtf8(adminPrincipalId), guidBytes(requestId),
        strictUtf8('article-inbox-create-input'), strictUtf8('1'), strictUtf8(inputDigest)
    ]);
    return Object.freeze({ captureId: guid(captureId), requestId, clientRevision: identity.clientRevision, input, inputDigest, requestDigest });
}

function identityScope(scope: ArticleCaptureRecoveryScope): string
{
    return JSON.stringify([captureSchema, scope.adminPrincipalId, scope.siteScope]);
}

function validSiteScope(value: string): boolean
{
    if (typeof value !== 'string' || value.length === 0 || value.length > 128
        || value !== value.trim() || /\p{Cc}/u.test(value) || strictUtf8(value).length > 512)
    {
        return false;
    }
    if (/^https?:\/\//iu.test(value))
    {
        const url = new URL(value);
        return url.username === '' && url.password === '' && url.search === '' && url.hash === '';
    }
    return true;
}

function encodeEnvelope(value: CaptureEnvelope): string
{
    return JSON.stringify({
        schema: captureSchema, siteScope: value.siteScope, ownerTabId: value.ownerTabId,
        captureId: value.captureId, requestId: value.requestId, clientRevision: value.clientRevision,
        inputDigest: value.inputDigest, requestDigest: value.requestDigest, input: value.input
    });
}

function captureTabId(ownerTabId: string, captureId: string, requestId: string): string
{
    const value = `capture-${ownerTabId}-${captureId}-${requestId}`;
    if (!revisionPattern.test(value))
    {
        throw new Error('capture_original_tab_bound');
    }
    return value;
}

function decodeEnvelope(record: ArticleRecoveryJournalRecord, scope: ArticleCaptureRecoveryScope): CaptureEnvelope | null
{
    try
    {
        const value: unknown = JSON.parse(record.content);
        if (!exactKeys(value, envelopeKeys) || value.schema !== captureSchema || value.siteScope !== scope.siteScope
            || typeof value.ownerTabId !== 'string' || typeof value.captureId !== 'string'
            || typeof value.requestId !== 'string' || typeof value.clientRevision !== 'string')
        {
            return null;
        }
        const request = describeArticleCaptureRequest(scope.adminPrincipalId, value.captureId,
            { requestId: value.requestId, clientRevision: value.clientRevision }, requireInput(value.input));
        const envelope: CaptureEnvelope = { ...request, schema: captureSchema, siteScope: scope.siteScope, ownerTabId: value.ownerTabId };
        return value.inputDigest === request.inputDigest && value.requestDigest === request.requestDigest
            && record.articleId === null && record.baseRevisionId === null && record.serverRevision === null
            && record.clientRevision === request.clientRevision && record.tabId === captureTabId(envelope.ownerTabId, request.captureId, request.requestId)
            && record.content === encodeEnvelope(envelope) ? envelope : null;
    }
    catch
    {
        return null;
    }
}

/**
 * Independent, unactivated capture adapter over the SOLE original journal/coordinator.
 * Borrow genuine current actor/site and actual capture/coordinator identities. Native Web
 * Locks serialize only local capture operations, with ifAvailable refusal and no queue.
 * Recovery discovery is metadata-only until the original authoritative lookup exists.
 */
export class ArticleCaptureRecovery
{
    readonly #scope: ArticleCaptureRecoveryScope;
    readonly #captureId: string;
    readonly #coordinator: ArticleRecoveryCoordinator;
    readonly #ownerTabId: string;
    readonly #readScope: () => ArticleCaptureRecoveryScope | null;
    readonly #unsubscribe: () => void;
    #owned: OwnedCapture | null = null;
    #busy = false;
    #retired = false;
    #detached = false;
    #observed = 0;

    constructor(captureId: string, coordinator: ArticleRecoveryCoordinator, readScope: () => ArticleCaptureRecoveryScope | null)
    {
        const scope = readScope();
        if (!scope || typeof scope.owner !== 'object' || scope.owner === null || scope.canCreateInbox !== true
            || typeof scope.adminPrincipalId !== 'string' || !/^[1-9]\d{0,18}$/u.test(scope.adminPrincipalId)
            || BigInt(scope.adminPrincipalId) > 9_223_372_036_854_775_807n
            || !validSiteScope(scope.siteScope) || !revisionPattern.test(coordinator.tabId))
        {
            throw new Error('capture_actual_scope_unavailable');
        }
        this.#scope = Object.freeze({ owner: scope.owner, adminPrincipalId: scope.adminPrincipalId, siteScope: scope.siteScope, canCreateInbox: true });
        this.#captureId = guid(captureId);
        this.#coordinator = coordinator;
        this.#ownerTabId = coordinator.tabId;
        this.#readScope = readScope;
        this.#unsubscribe = coordinator.subscribe(message =>
        {
            if (message.articleKey === 'create')
            {
                this.#observed += 1;
            }
        });
    }

    #current(): boolean
    {
        if (this.#retired)
        {
            return false;
        }
        try
        {
            const current = this.#readScope();
            const same = current?.owner === this.#scope.owner
                && current.adminPrincipalId === this.#scope.adminPrincipalId && current.siteScope === this.#scope.siteScope
                && current.canCreateInbox === true && this.#coordinator.tabId === this.#ownerTabId;
            if (!same || this.#retired)
            {
                this.#retireBinding();
                return false;
            }
            return true;
        }
        catch
        {
            this.#retireBinding();
            return false;
        }
    }

    #retireBinding(): void
    {
        this.#retired = true;
        if (!this.#detached)
        {
            this.#detached = true;
            this.#unsubscribe();
        }
    }

    async #exclusive<T>(operation: () => Promise<T>, unavailable: T): Promise<T>
    {
        const locks = typeof navigator === 'undefined' ? null : navigator.locks;
        if (!locks)
        {
            return unavailable;
        }
        const identityHash = await articleRecoveryIdentityHash(identityScope(this.#scope));
        return locks.request(`${ARTICLE_RECOVERY_JOURNAL_DATABASE}:capture:${identityHash}:${this.#captureId}`,
            { mode: 'exclusive', ifAvailable: true }, lock => lock ? operation() : Promise.resolve(unavailable));
    }

    /** Persist one immutable actual request; repeated/changed attempts require explicit discard/new identities. */
    async stage(identity: ArticleCaptureRequestIdentity, input: ArticleCaptureInboxInput): Promise<ArticleCaptureStageResult>
    {
        const blocked = (reason: ArticleCaptureBlockedReason): ArticleCaptureStageResult => Object.freeze({ status: 'blocked', reason, serverOutcome: 'unknown' });
        if (this.#busy)
        {
            return blocked('busy');
        }
        this.#busy = true;
        let description: ArticleCaptureRequestDescription | null = null;
        try
        {
            if (!this.#current())
            {
                return blocked('scope-retired');
            }
            const request = describeArticleCaptureRequest(this.#scope.adminPrincipalId, this.#captureId, identity, input);
            description = request;
            const envelope: CaptureEnvelope = { ...request, schema: captureSchema, siteScope: this.#scope.siteScope, ownerTabId: this.#ownerTabId };
            const tabId = captureTabId(this.#ownerTabId, this.#captureId, request.requestId);
            const result = await this.#exclusive<ArticleCaptureStageResult>(async () =>
            {
                if (!this.#current())
                {
                    return blocked('scope-retired');
                }
                const before = await articleRecoveryJournal.list(identityScope(this.#scope), null);
                if (!this.#current())
                {
                    return blocked('scope-retired');
                }
                if (before.status !== 'ready')
                {
                    return Object.freeze({ status: 'unprotected', protection: 'unavailable', request, serverOutcome: 'unknown' });
                }
                if (this.#owned)
                {
                    if (this.#owned.identity.requestId !== request.requestId || this.#owned.identity.clientRevision !== request.clientRevision
                        || this.#owned.inputDigest !== request.inputDigest)
                    {
                        return blocked('capture-conflict');
                    }
                    const expected = this.#owned.record;
                    const actual = before.records.find(record => record.id === expected?.id);
                    if (actual && expected && Object.entries(expected).some(([key, value]) => actual[key as keyof ArticleRecoveryJournalRecord] !== value))
                    {
                        return blocked('original-record-changed');
                    }
                    if (!actual)
                    {
                        this.#owned.record = null;
                        this.#owned.protection = 'unavailable';
                    }
                    // A repeated operation never writes/slides TTL, even after expiry or cleanup.
                    return Object.freeze({ status: actual ? 'protected' : 'unprotected', protection: this.#owned.protection, request, serverOutcome: 'unknown' });
                }
                if (before.records.some(record => decodeEnvelope(record, this.#scope)?.captureId === this.#captureId
                    || (record.tabId.startsWith('capture-') && record.tabId.slice(-73, -37) === this.#captureId)))
                {
                    return blocked('capture-conflict');
                }
                const stored = await articleRecoveryJournal.write({
                    identityId: identityScope(this.#scope), articleId: null, tabId,
                    baseRevisionId: null, serverRevision: null, clientRevision: request.clientRevision, content: encodeEnvelope(envelope)
                });
                let record: Readonly<Omit<ArticleRecoveryJournalRecord, 'content'>> | null = null;
                if (stored.record)
                {
                    const { content, ...metadata } = stored.record;
                    if (content === encodeEnvelope(envelope))
                    {
                        record = Object.freeze(metadata);
                    }
                }
                // Retain only original completed-write coordinates for exact cleanup, even if reread fails.
                // Protection is not admitted until the actual original integrity reread succeeds below.
                this.#owned = {
                    identity: Object.freeze({ requestId: request.requestId, clientRevision: request.clientRevision }),
                    inputDigest: request.inputDigest, requestDigest: request.requestDigest, record,
                    protection: stored.status === 'stored' ? 'unavailable' : stored.status
                };
                if (!this.#current())
                {
                    // The only row this operation wrote belongs to the retired, original scope.
                    if (stored.record)
                    {
                        await articleRecoveryJournal.discard(stored.record.id);
                    }
                    return blocked('scope-retired');
                }
                if (stored.status === 'stored' && stored.record)
                {
                    const reread = await articleRecoveryJournal.list(identityScope(this.#scope), null);
                    const actual = reread.records.find(candidate => candidate.id === stored.record?.id && candidate.content === encodeEnvelope(envelope));
                    if (!this.#current())
                    {
                        await articleRecoveryJournal.discard(stored.record.id);
                        return blocked('scope-retired');
                    }
                    if (reread.status !== 'ready')
                    {
                        return Object.freeze({ status: 'unprotected', protection: 'unavailable', request, serverOutcome: 'unknown' });
                    }
                    if (!actual || !decodeEnvelope(actual, this.#scope))
                    {
                        return blocked('original-record-changed');
                    }
                    const { content, ...metadata } = actual;
                    if (content === encodeEnvelope(envelope))
                    {
                        record = Object.freeze(metadata);
                    }
                }
                this.#owned = {
                    identity: Object.freeze({ requestId: request.requestId, clientRevision: request.clientRevision }),
                    inputDigest: request.inputDigest, requestDigest: request.requestDigest, record, protection: stored.status
                };
                if (record)
                {
                    this.#coordinator.notify('changed', null);
                }
                return Object.freeze({ status: record ? 'protected' : 'unprotected', protection: stored.status, request, serverOutcome: 'unknown' });
            }, Object.freeze({ status: 'unprotected', protection: 'unavailable', reason: 'coordination-unavailable', request, serverOutcome: 'unknown' }));
            return this.#current() ? result : blocked('scope-retired');
        }
        catch
        {
            return description && this.#current()
                ? Object.freeze({ status: 'unprotected', protection: 'unavailable', request: description, serverOutcome: 'unknown' })
                : blocked(this.#retired ? 'scope-retired' : 'input-invalid');
        }
        finally
        {
            this.#busy = false;
            if (this.#retired && this.#owned)
            {
                try
                {
                    await this.#discardOwned();
                }
                catch
                {
                    // Keep original cleanup coordinates; no deletion or server-outcome claim on failure.
                }
            }
        }
    }

    /** Original expiry/integrity cleanup runs first; no recovered title/body is exposed as ready. */
    async discover(): Promise<ArticleCaptureDiscoveryResult>
    {
        if (!this.#current())
        {
            return Object.freeze({ status: 'blocked', reason: 'scope-retired' });
        }
        const observed = this.#observed;
        const read = await articleRecoveryJournal.list(identityScope(this.#scope), null);
        if (!this.#current() || observed !== this.#observed)
        {
            return Object.freeze({ status: 'blocked', reason: this.#retired ? 'scope-retired' : 'coordination-changed' });
        }
        if (read.status !== 'ready')
        {
            return Object.freeze({ status: 'blocked', reason: 'original-storage-unavailable' });
        }
        const records: ArticleCapturePendingRecord[] = [];
        let malformed = 0;
        for (const record of read.records)
        {
            const envelope = decodeEnvelope(record, this.#scope);
            if (!envelope)
            {
                malformed += 1;
                continue;
            }
            records.push(Object.freeze({
                journalId: record.id, journalSourceHash: record.sourceHash, captureId: envelope.captureId,
                requestId: envelope.requestId, clientRevision: envelope.clientRevision,
                inputDigest: envelope.inputDigest, requestDigest: envelope.requestDigest,
                updatedAt: record.updatedAt, expiresAt: record.expiresAt, serverOutcome: 'unknown', recovery: 'authoritative-reconciliation-required'
            }));
        }
        return Object.freeze({ status: 'pending', records: Object.freeze(records), malformed });
    }

    async #discardOwned(): Promise<ArticleCaptureDiscardResult>
    {
        const owned = this.#owned;
        const expected = owned?.record;
        if (!owned || !expected)
        {
            this.#owned = null;
            return Object.freeze({ status: 'absent', serverOutcome: 'unknown' });
        }
        return this.#exclusive<ArticleCaptureDiscardResult>(async () =>
        {
            const read = await articleRecoveryJournal.list(identityScope(this.#scope), null);
            if (read.status !== 'ready')
            {
                return Object.freeze({ status: 'blocked', reason: 'original-storage-unavailable', serverOutcome: 'unknown' });
            }
            const record = read.records.find(candidate => candidate.id === owned.record?.id);
            if (!record)
            {
                this.#owned = null;
                return Object.freeze({ status: 'absent', serverOutcome: 'unknown' });
            }
            if (Object.entries(expected).some(([key, value]) => record[key as keyof ArticleRecoveryJournalRecord] !== value)
                || decodeEnvelope(record, this.#scope)?.requestDigest !== owned.requestDigest)
            {
                return Object.freeze({ status: 'blocked', reason: 'original-record-changed', serverOutcome: 'unknown' });
            }
            const discarded = await articleRecoveryJournal.discard(record.id);
            if (discarded)
            {
                this.#owned = null;
                this.#coordinator.notify('cleared', null);
            }
            return Object.freeze({ status: discarded ? 'discarded' : 'blocked', reason: discarded ? undefined : 'original-storage-unavailable', serverOutcome: 'unknown' });
        }, Object.freeze({ status: 'blocked', reason: 'coordination-unavailable', serverOutcome: 'unknown' }));
    }

    /** Local explicit discard only; cannot cancel a server operation or manufacture server absence. */
    async discardOwned(): Promise<ArticleCaptureDiscardResult>
    {
        this.#retireBinding();
        if (this.#busy)
        {
            return Object.freeze({ status: 'blocked', reason: 'busy', serverOutcome: 'unknown' });
        }
        this.#busy = true;
        try
        {
            return await this.#discardOwned();
        }
        finally
        {
            this.#busy = false;
        }
    }

    /** Revoke before any await. No server write, no borrowed coordinator disposal, no other-row cleanup. */
    async retire(): Promise<ArticleCaptureDiscardResult>
    {
        this.#retireBinding();
        if (this.#busy)
        {
            return Object.freeze({ status: 'blocked', reason: 'busy', serverOutcome: 'unknown' });
        }
        return this.discardOwned();
    }
}
