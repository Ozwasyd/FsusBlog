import {
    captureMarkdownAttachmentInput,
    createMarkdownAttachmentCaptureSession,
    createMarkdownAttachmentJob,
    planMarkdownAttachmentResolve,
    planMarkdownAttachmentRemove,
    planMarkdownAttachmentInsert,
    resolveMarkdownClipboardPaste,
    type MarkdownAttachmentCaptureContext,
    type MarkdownAttachmentBatchIntent,
    type MarkdownAttachmentCaptureObservation,
    type MarkdownAttachmentFileConsumer,
    type MarkdownAttachmentTerminalCustody,
    type MarkdownAttachmentTerminalObservation,
    type MarkdownAttachmentTerminalConsumer,
    type MarkdownAttachmentTerminalCohortIssuer,
    type MarkdownAttachmentTerminalRevisionIssuer,
    type MarkdownAttachmentTerminalRevisionReservation,
    type MarkdownAttachmentTerminalApplicationEndIssuer,
    type MarkdownAttachmentTerminalApplicationEndHandle,
    type MarkdownAttachmentTerminalApplicationEndObservation,
    type MarkdownAttachmentItemIntent,
    type MarkdownAttachmentInputFile,
    type MarkdownAttachmentJob,
    type MarkdownAttachmentProviderResult,
    type MarkdownAttachmentSourceKind,
    type MarkdownClipboardTransfer,
    type MarkdownEditorTransaction
} from '@/fsusui/articleAttachments';
import type { MarkdownEditorDispatchResult, MarkdownEditorTransactionEvent } from '@/fsusui/articlePositionMaps';

import {
    validateArticleAnchorContext,
    type ArticleAnchorContext,
    type ArticleAnchorCaptureOptions,
    type ArticlePositionMapBinding,
    type ArticleAnchorContextAdapter
} from './articleAnchorContext';
import {
    createArticleDocumentContext,
    validateArticleDocumentTaskEnvelope,
    type ArticleDocumentContext,
    type ArticleDocumentContextAdapter,
    type ArticleDocumentTaskEnvelope,
    type ArticleDocumentTaskLease,
    type ArticleDocumentAttachmentRevisionCohort,
    type ArticleDocumentAttachmentRevisionTransition
} from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

import type { ArticleAttachmentNativeRevisionAssociation, ArticleAttachmentNativeRevisionProducer } from './articleAttachmentNativeRevision';


export const articleAttachmentIntentSchema = 'fsusblog.article-attachment-intent.v1' as const;
/** One bounded 100-image writer batch, shared by created and pending intents. */
export const articleAttachmentIntentCapacity = 100;

/** Created-stage metadata. Signals stay in the runtime handle, not the digest. */
export interface ArticleAttachmentIntent {
    readonly schema: typeof articleAttachmentIntentSchema;
    readonly state: 'created';
    readonly anchor: ArticleAnchorContext;
    readonly task: ArticleDocumentTaskEnvelope;
    readonly inputOrigin: MarkdownAttachmentSourceKind;
    readonly batchId: string;
    readonly itemId: string;
    readonly order: number;
    readonly candidate: Readonly<{ name: string; mimeType: string; byteLength: number; }>;
    readonly provider: string;
    readonly providerVersion: string;
    readonly contentDigest: string;
}

export interface ArticleAttachmentCreatedHandle {
    readonly intent: ArticleAttachmentIntent;
    readonly signal: AbortSignal;
    cancel(): void;
}

export const articleAttachmentLifecycleSchema = 'fsusblog.article-attachment-lifecycle.v1' as const;
export type ArticleAttachmentLifecycleState = 'anchored' | 'provider-pending' | 'cancelled' | 'stale' | 'removed' | 'transaction-committed' | 'failed';
export interface ArticleAttachmentLifecycleSnapshot {
    readonly schema: typeof articleAttachmentLifecycleSchema;
    readonly intent: ArticleAttachmentIntent;
    readonly anchor: ArticleAnchorContext;
    readonly task: ArticleDocumentTaskEnvelope;
    readonly predecessorTaskRef: string;
    readonly state: ArticleAttachmentLifecycleState;
    readonly attempt: number;
    readonly reason: string | null;
    readonly transactionRef: string | null;
    readonly providerResultDigest: string | null;
    readonly contentDigest: string;
}

export interface ArticleAttachmentPendingHandle {
    readonly snapshot: ArticleAttachmentLifecycleSnapshot;
    readonly signal: AbortSignal;
    readonly request: Readonly<{ batchId: string; itemId: string; requestId: string; documentIdentity: Readonly<{ id: string; epoch: number; }>; revision: number; }>;
    cancel(): void;
}

/** Local intent/node/transaction observation only; grants no asset, reference or cleanup authority. */
export interface ArticleAttachmentOwnedIntentObservation {
    readonly snapshot: ArticleAttachmentLifecycleSnapshot;
    readonly current: boolean;
    readonly intentRef: string;
    readonly nodeId: string | null;
    readonly transactionRef: string | null;
    readonly providerRef: string;
    readonly providerVersion: string;
    readonly contextDigest: string;
    readonly sourceOrder: number;
    /** null means the current source relation is unproved, not that the node is absent. */
    readonly sourceReferenced: boolean | null;
    readonly disposition: 'current' | 'cancelled' | 'removed' | 'stale' | 'failed';
    readonly sourceUrl: string | null;
}

export interface ArticleAttachmentTransactionPort {
    dispatch(transaction: MarkdownEditorTransaction): MarkdownEditorDispatchResult;
    commitSource(result: MarkdownEditorDispatchResult): void;
    binding(): ArticlePositionMapBinding;
}

/** The actual bound editor owns this synchronous native File loan. */
export interface ArticleAttachmentFilePort {
    withAttachmentFile(batch: MarkdownAttachmentBatchIntent, item: MarkdownAttachmentItemIntent,
        consume: MarkdownAttachmentFileConsumer): boolean;
}

export type ArticleAttachmentAcceptedCapture = {
    readonly status: 'admitted';
    readonly items: readonly Readonly<{ item: MarkdownAttachmentItemIntent; file: File; handle: ArticleAttachmentPendingHandle; }>[];
} | { readonly status: 'rejected'; readonly reason: string; };

export type ArticleAttachmentCapture = {
    readonly status: 'created';
    readonly handles: readonly ArticleAttachmentCreatedHandle[];
    readonly transaction: MarkdownEditorTransaction;
} | { readonly status: 'rejected' | 'non-attachment'; readonly reason: string; };

/** An authentic native terminal loan; absent port remains unavailable. */
export interface ArticleAttachmentTerminalPort {
    getAttachmentTerminalCohortIssuer?(): MarkdownAttachmentTerminalCohortIssuer | null;
    getAttachmentTerminalRevisionIssuer?(): MarkdownAttachmentTerminalRevisionIssuer | null;
    getAttachmentTerminalApplicationEndIssuer?(): MarkdownAttachmentTerminalApplicationEndIssuer | null;
    withAttachmentTerminalTransaction(observation: MarkdownAttachmentTerminalObservation,
        consume: MarkdownAttachmentTerminalConsumer): boolean;
}

/** Historical accepted native transaction; no task or work-settlement upgrade. */
export interface ArticleAttachmentNativeTerminalObservation {
    readonly observation: Extract<MarkdownAttachmentTerminalObservation, { phase: 'committed'; }>;
    readonly task: ArticleDocumentTaskEnvelope;
    readonly taskCompletion: 'unavailable' | 'completed';
    readonly sdkAcceptance?: 'accepted' | 'historical';
}

interface AcceptedNativeCapture {
    readonly stage: 'accepted';
    readonly entries: PendingInput[];
    cohort?: { readonly issuer: MarkdownAttachmentTerminalCohortIssuer; readonly acquisitionLease: ArticleDocumentTaskLease;
        token: ArticleDocumentAttachmentRevisionCohort | null; cleanupPending: boolean; withdrawn: boolean; };
}

interface CapturedInput {
    readonly batch: MarkdownAttachmentBatchIntent;
    readonly jobs: readonly MarkdownAttachmentJob[];
    readonly handles: readonly ArticleAttachmentCreatedHandle[];
    readonly leases: readonly ArticleDocumentTaskLease[];
    readonly transaction: MarkdownEditorTransaction;
}

interface PendingInput {
    readonly intent: ArticleAttachmentIntent;
    readonly controller: AbortController;
    readonly request: ArticleAttachmentPendingHandle['request'];
    job: MarkdownAttachmentJob;
    lease: ArticleDocumentTaskLease;
    snapshot: ArticleAttachmentLifecycleSnapshot;
    awaitingMap: boolean;
    completedLease?: ArticleDocumentTaskLease;
    sourceUrl?: string;
    removedContext?: ArticleDocumentContext;
    nativeCapture?: boolean;
    nativeInput?: { readonly capture: MarkdownAttachmentCaptureObservation; readonly item: MarkdownAttachmentItemIntent; };
    nativeCompletion?: MarkdownAttachmentTerminalCustody;
    nativeInputReleaseObserved?: boolean;
    nativeTerminal?: ArticleAttachmentNativeTerminalObservation;
    nativeFailure?: { readonly firstCause: unknown; latestCause: unknown; };
    nativeRevisionAssociation?: NativeRevisionAssociation;
    reservingNativeRevision?: boolean;
    nativeTransition?: ArticleDocumentAttachmentRevisionTransition;
    nativeSdkCleanupPending?: boolean;
    nativePublication?: { readonly transaction: MarkdownEditorTransactionEvent; readonly context: ArticleDocumentContext; };
    nativeFinalization?: { readonly observation: Extract<MarkdownAttachmentTerminalObservation, { phase: 'committed'; }>;
        readonly proof: Readonly<{ transactionRef: string; providerResultDigest: string; }>; sdkAccepted: boolean; };
    nativeFinishing?: boolean;
    nativeCleanupPending?: boolean;
    nativeLocalCleanupComplete?: boolean;
    nativeApplicationEndPending?: boolean;
    nativeApplicationEnd?: NativeApplicationEnd;
    nativeCleanupReentry?: { readonly cause: unknown; };
    file?: File;
    releaseFile?: () => void;
    nativeHandle?: ArticleAttachmentPendingHandle;
}

interface NativeApplicationEnd {
    readonly issuer: MarkdownAttachmentTerminalApplicationEndIssuer;
    readonly reservation: MarkdownAttachmentTerminalRevisionReservation;
    readonly custody: MarkdownAttachmentTerminalCustody;
    readonly lease: ArticleDocumentTaskLease;
    handle: MarkdownAttachmentTerminalApplicationEndHandle | null;
    observation: MarkdownAttachmentTerminalApplicationEndObservation | null;
}

interface NativeRevisionAssociation
{
    readonly association: ArticleAttachmentNativeRevisionAssociation;
    readonly entry: PendingInput;
    active: boolean;
    pendingCleanup: boolean;
    readonly revoke: () => void;
}

const lifecycleKeys = ['schema', 'intent', 'anchor', 'task', 'predecessorTaskRef', 'state', 'attempt', 'reason', 'transactionRef', 'providerResultDigest', 'contentDigest'];
const lifecycleStates: readonly ArticleAttachmentLifecycleState[] = ['anchored', 'provider-pending', 'cancelled', 'stale', 'removed', 'transaction-committed', 'failed'];
export function validateArticleAttachmentLifecycle(value: unknown): value is ArticleAttachmentLifecycleSnapshot
{
    if (!exactKeys(value, lifecycleKeys) || value.schema !== articleAttachmentLifecycleSchema
        || !validateArticleAttachmentIntent(value.intent) || !validateArticleAnchorContext(value.anchor)
        || !validateArticleDocumentTaskEnvelope(value.task) || value.task.kind !== 'attachment'
        || value.task.producerVersion !== value.intent.providerVersion
        || value.task.context.contextDigest !== value.anchor.document.contextDigest
        || value.intent.anchor.document.documentId !== value.anchor.document.documentId
        || value.intent.anchor.document.documentEpoch !== value.anchor.document.documentEpoch
        || value.intent.anchor.document.articleId !== value.anchor.document.articleId
        || value.intent.anchor.document.draftId !== value.anchor.document.draftId
        || value.intent.anchor.document.editorSessionId !== value.anchor.document.editorSessionId
        || value.intent.anchor.document.userScope !== value.anchor.document.userScope
        || value.intent.anchor.document.siteScope !== value.anchor.document.siteScope
        || !ref(value.predecessorTaskRef) || !lifecycleStates.includes(value.state as ArticleAttachmentLifecycleState)
        || !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1
        || (value.reason !== null && !ref(value.reason)) || (value.transactionRef !== null && !ref(value.transactionRef))
        || (value.providerResultDigest !== null && (typeof value.providerResultDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.providerResultDigest))))
    {
        return false;
    }
    if (['anchored', 'provider-pending'].includes(String(value.state)) && (value.task.status !== 'running' || value.reason !== null))
    {
        return false;
    }
    if (value.state === 'transaction-committed' && (value.task.status !== 'completed' || value.transactionRef === null || value.providerResultDigest === null))
    {
        return false;
    }
    if (value.state === 'transaction-committed' && value.task.resultDigest !== calculateOpenArticleDocumentDigest({
        transactionRef: value.transactionRef, providerResultDigest: value.providerResultDigest
    }))
    {
        return false;
    }
    if (['cancelled', 'stale', 'removed', 'failed'].includes(String(value.state)) && (value.reason === null || value.task.status !== 'aborted'))
    {
        return false;
    }
    const { contentDigest, ...body } = value;
    return contentDigest === calculateOpenArticleDocumentDigest(body);
}

const keys = ['schema', 'state', 'anchor', 'task', 'inputOrigin', 'batchId', 'itemId', 'order', 'candidate', 'provider', 'providerVersion', 'contentDigest'];
const exactKeys = (value: unknown, names: readonly string[]): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const ref = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function validateArticleAttachmentIntent(value: unknown): value is ArticleAttachmentIntent
{
    if (!exactKeys(value, keys) || value.schema !== articleAttachmentIntentSchema || value.state !== 'created'
        || !validateArticleAnchorContext(value.anchor) || !validateArticleDocumentTaskEnvelope(value.task)
        || value.task.kind !== 'attachment' || value.task.status !== 'running'
        || value.task.context.contextDigest !== value.anchor.document.contextDigest
        || typeof value.inputOrigin !== 'string' || !['pick', 'paste', 'drop'].includes(value.inputOrigin)
        || !ref(value.batchId) || !ref(value.itemId) || !ref(value.provider) || !ref(value.providerVersion)
        || value.task.producerVersion !== value.providerVersion
        || !Number.isSafeInteger(value.order) || Number(value.order) < 0
        || !exactKeys(value.candidate, ['name', 'mimeType', 'byteLength'])
        || !ref(value.candidate.name) || !ref(value.candidate.mimeType)
        || !Number.isSafeInteger(value.candidate.byteLength) || Number(value.candidate.byteLength) < 0)
    {
        return false;
    }
    const { contentDigest, ...body } = value;
    return contentDigest === calculateOpenArticleDocumentDigest(body);
}

/** One input boundary, using FsusUI capture/clipboard policy and transaction plans. */
export class ArticleAttachmentContextAdapter
{
    private readonly owner: ArticleDocumentContextAdapter;
    private readonly anchors: ArticleAnchorContextAdapter | undefined;
    private readonly provider: string;
    private readonly providerVersion: string;
    private readonly captureSession = createMarkdownAttachmentCaptureSession();
    private sequence = 0;
    private disposed = false;
    private readonly leases = new Set<ArticleDocumentTaskLease>();
    private captureDocumentId: string;
    private readonly captured = new WeakMap<object, CapturedInput | AcceptedNativeCapture>();
    private readonly pending = new Map<string, PendingInput>();
    private readonly pendingHandles = new WeakMap<object, PendingInput>();
    private readonly ownedOperations = new Set<string>();
    private readonly lifecycleLog: ArticleAttachmentLifecycleSnapshot[] = [];
    private readonly unsubscribe: () => void;
    private readonly nativeRevisionAssociations = new WeakMap<ArticleAttachmentNativeRevisionAssociation, NativeRevisionAssociation>();
    private readonly nativeRevisionCleanup = new Set<NativeRevisionAssociation>();
    private nativeRevisionFailure: { readonly firstCause: unknown; latestCause: unknown; } | null = null;
    private readonly readNativeCohortIssuer?: () => MarkdownAttachmentTerminalCohortIssuer | null;
    private readonly nativeRevisionProducer: ArticleAttachmentNativeRevisionProducer;

    public constructor(owner: ArticleDocumentContextAdapter, provider: string, providerVersion: string,
        anchors?: ArticleAnchorContextAdapter, readNativeIssuer?: () => MarkdownAttachmentTerminalRevisionIssuer | null,
        readNativeEndIssuer?: () => MarkdownAttachmentTerminalApplicationEndIssuer | null,
        readNativeCohortIssuer?: () => MarkdownAttachmentTerminalCohortIssuer | null)
    {
        this.anchors = anchors;
        if (![provider, providerVersion].every(value => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(value)))
        {
            throw new Error('article-attachment-provider-identity-invalid');
        }
        this.owner = owner;
        this.provider = provider;
        this.providerVersion = providerVersion;
        const retainFailure = (cause: unknown): void =>
        {
            this.nativeRevisionFailure ??= { firstCause: cause, latestCause: cause };
            this.nativeRevisionFailure.latestCause = cause;
        };
        const originalEntry = (lease: ArticleDocumentTaskLease, custody: MarkdownAttachmentTerminalCustody): PendingInput | null =>
        {
            const record = this.captured.get(custody.capture);
            if (this.disposed || !record || !('stage' in record) || record.stage !== 'accepted')
            {
                return null;
            }
            const entry = record.entries.find(candidate => candidate.nativeInput?.capture === custody.capture
                && candidate.nativeInput.item === custody.item);
            return entry?.lease === lease && entry.nativeCompletion === custody
                && this.pending.get(entry.intent.task.taskRef) === entry && this.ownedOperations.has(entry.intent.task.taskRef)
                && !entry.controller.signal.aborted && !lease.signal.aborted ? entry : null;
        };
        const cancel = (record: NativeRevisionAssociation): boolean =>
        {
            record.active = false;
            record.pendingCleanup = true;
            this.nativeRevisionCleanup.add(record);
            try
            {
                if (record.association.issuer.cancelReservation(record.association.reservation, record.association.lease) !== true)
                {
                    throw new Error('attachment-native-revision-cancellation-unavailable');
                }
                record.entry.controller.signal.removeEventListener('abort', record.revoke);
                record.association.lease.signal.removeEventListener('abort', record.revoke);
                record.pendingCleanup = false;
                this.nativeRevisionCleanup.delete(record);
                return true;
            }
            catch (cause)
            {
                retainFailure(cause);
                throw cause;
            }
        };
        this.nativeRevisionProducer = Object.freeze({
            reserve: (lease: ArticleDocumentTaskLease, custody: MarkdownAttachmentTerminalCustody,
                continuation?: Readonly<{ cohort: ArticleDocumentAttachmentRevisionCohort; context: ArticleDocumentContext; }>) =>
            {
                const entry = originalEntry(lease, custody);
                const current = (): boolean => !!entry && (continuation
                    ? this.acceptedNativeCapture(entry)?.cohort?.token === continuation.cohort
                        && entry.snapshot.anchor.document === continuation.context
                        && this.owner.hasAttachmentRevisionCohortBinding(continuation.cohort, lease, custody, continuation.context)
                    : lease.isCurrent() && this.owner.isCurrentContext(entry.snapshot.anchor.document));
                if (!entry || entry.nativeRevisionAssociation || entry.reservingNativeRevision || !current())
                {
                    return null;
                }
                entry.reservingNativeRevision = true;
                let record: NativeRevisionAssociation | null = null;
                try
                {
                    const issuer = readNativeIssuer?.();
                    if (!issuer || originalEntry(lease, custody) !== entry || !current()
                        || this.owner.context.sourceRevision !== custody.beforeRevision)
                    {
                        return null;
                    }
                    const reservation = issuer.reserve(custody, lease);
                    if (!reservation)
                    {
                        return null;
                    }
                    const association = Object.freeze({ issuer, reservation, lease, custody });
                    const revoke = (): void =>
                    {
                        try
                        {
                            if (record)
                            {
                                cancel(record);
                            }
                        }
                        catch
                        {
                            // Actual raw failure and holder remain available to inspect/retry.
                        }
                    };
                    record = { association, entry, active: true, pendingCleanup: false, revoke };
                    entry.nativeRevisionAssociation = record;
                    this.nativeRevisionAssociations.set(association, record);
                    entry.nativeApplicationEndPending = true;
                    const endIssuer = readNativeEndIssuer?.();
                    if (!endIssuer)
                    {
                        throw new Error('attachment-native-application-end-owner-unavailable');
                    }
                    // Retain original acquisition custody before any fallible public owner read.
                    const end: NativeApplicationEnd = { issuer: endIssuer, reservation, custody, lease,
                        handle: null, observation: null };
                    entry.nativeApplicationEnd = end;
                    end.handle = endIssuer.reserve(custody, reservation, lease);
                    if (!end.handle)
                    {
                        throw new Error('attachment-native-application-end-reservation-unavailable');
                    }
                    entry.controller.signal.addEventListener('abort', revoke, { once: true });
                    lease.signal.addEventListener('abort', revoke, { once: true });
                    if (originalEntry(lease, custody) !== entry || readNativeIssuer?.() !== issuer || !current()
                        || !issuer.hasReservation(reservation, lease, 'applying') || originalEntry(lease, custody) !== entry)
                    {
                        cancel(record);
                        return null;
                    }
                    return association;
                }
                catch (cause)
                {
                    retainFailure(cause);
                    if (record?.active)
                    {
                        try
                        {
                            cancel(record);
                        }
                        catch
                        {
                            // Keep the primary raw cause; cleanup cause/holder are retained separately.
                        }
                    }
                    throw cause;
                }
                finally
                {
                    entry.reservingNativeRevision = false;
                }
            },
            hasAssociation: (association: ArticleAttachmentNativeRevisionAssociation,
                phase: 'applying' | 'accepted' | 'committed', transaction?: MarkdownEditorTransactionEvent): boolean =>
            {
                const record = this.nativeRevisionAssociations.get(association);
                const current = (): boolean => !!record && record.active && !record.pendingCleanup
                    && record.entry.nativeRevisionAssociation === record
                    && originalEntry(association.lease, association.custody) === record.entry;
                if (!current() || readNativeIssuer?.() !== association.issuer || !current())
                {
                    return false;
                }
                const token = record ? this.acceptedNativeCapture(record.entry)?.cohort?.token : null;
                const binding = (): boolean => !token || this.owner.hasAttachmentRevisionCohortBinding(token,
                    association.lease, association.custody, this.owner.context);
                return binding() && association.issuer.hasReservation(association.reservation, association.lease, phase, transaction)
                    && current() && readNativeIssuer?.() === association.issuer && current() && binding();
            },
            cancelAssociation: (association: ArticleAttachmentNativeRevisionAssociation): boolean =>
            {
                const record = this.nativeRevisionAssociations.get(association);
                return !!record && cancel(record);
            },
            inspectCleanup: () => Object.freeze({ pending: this.nativeRevisionCleanup.size,
                failed: this.nativeRevisionFailure !== null, firstCause: this.nativeRevisionFailure?.firstCause,
                latestCause: this.nativeRevisionFailure?.latestCause }),
            retryCleanup: (): boolean =>
            {
                let failed = false;
                let first: unknown;
                for (const record of Array.from(this.nativeRevisionCleanup))
                {
                    try
                    {
                        cancel(record);
                    }
                    catch (cause)
                    {
                        if (!failed)
                        {
                            first = cause;
                        }
                        failed = true;
                    }
                }
                if (failed)
                {
                    throw first;
                }
                return this.nativeRevisionCleanup.size === 0;
            }
        });
        this.readNativeCohortIssuer = readNativeCohortIssuer;
        this.captureDocumentId = owner.context.documentId;
        this.unsubscribe = owner.subscribeContext(context =>
        {
            for (const entry of this.pending.values())
            {
                if (context?.documentId !== entry.snapshot.anchor.document.documentId
                    || context.documentEpoch !== entry.snapshot.anchor.document.documentEpoch
                    || context.userScope !== entry.snapshot.anchor.document.userScope
                    || context.siteScope !== entry.snapshot.anchor.document.siteScope)
                {
                    this.finish(entry, 'cancelled', 'attachment-document-abort');
                }
                else if (context.contextDigest !== entry.snapshot.anchor.document.contextDigest)
                {
                    // A controlled transaction port commits the owner before consuming its map.
                    // No completion is admitted in this window; missing proof becomes stale.
                    entry.awaitingMap = true;
                    const expected = context.contextDigest;
                    queueMicrotask(() =>
                    {
                        if (entry.awaitingMap && this.owner.context.contextDigest === expected)
                        {
                            this.finish(entry, 'stale', 'attachment-position-map-missing');
                        }
                    });
                }
            }
        });
    }

    public capture(input: {
        origin: MarkdownAttachmentSourceKind;
        anchor: ArticleAnchorContext;
        files?: readonly MarkdownAttachmentInputFile[];
        transfer?: MarkdownClipboardTransfer;
        context?: MarkdownAttachmentCaptureContext;
        eventFingerprint?: string;
        source: string;
    }): ArticleAttachmentCapture
    {
        if (this.disposed || !validateArticleAnchorContext(input.anchor)
            || !this.owner.isCurrentContext(input.anchor.document))
        {
            return { status: 'rejected', reason: 'document-context-invalid' };
        }
        if (!['pick', 'paste', 'drop'].includes(input.origin))
        {
            return { status: 'rejected', reason: 'input-origin-invalid' };
        }
        if (typeof input.source !== 'string')
        {
            return { status: 'rejected', reason: 'source-context-invalid' };
        }
        try
        {
            createArticleDocumentContext({ ...this.owner.context, content: input.source });
        }
        catch
        {
            return { status: 'rejected', reason: 'source-context-invalid' };
        }
        if (this.captureDocumentId !== this.owner.context.documentId)
        {
            this.captureSession.clear();
            this.captureDocumentId = this.owner.context.documentId;
        }
        let files = input.files ?? [];
        if (input.origin !== 'pick')
        {
            const clipboard = resolveMarkdownClipboardPaste({
                source: input.source, selection: { ...input.anchor.range, direction: input.anchor.direction },
                documentIdentity: this.owner.documentIdentity, currentIdentity: this.owner.documentIdentity,
                revision: this.owner.context.sourceRevision, expectedRevision: this.owner.context.sourceRevision,
                origin: input.origin, files: input.transfer?.files ?? files.map(file => ({
                    name: file.name, type: file.mimeType ?? file.type ?? '', size: file.byteLength ?? file.size ?? 0
                })), items: input.transfer?.items,
                readonly: input.context?.readonly, disabled: input.context?.disabled, composing: input.context?.isComposing
            });
            if (clipboard.rejected)
            {
                return { status: 'rejected', reason: clipboard.rejected };
            }
            if (clipboard.action !== 'attachment-intent' || !clipboard.attachmentIntent)
            {
                return { status: 'non-attachment', reason: clipboard.action };
            }
            files = clipboard.attachmentIntent.files;
        }
        const captured = captureMarkdownAttachmentInput({
            sourceKind: input.origin, documentIdentity: this.owner.documentIdentity,
            revision: this.owner.context.sourceRevision,
            anchor: { nodeId: input.anchor.nodeId, range: input.anchor.range }, files,
            context: { ...input.context, currentRevision: this.owner.context.sourceRevision },
            eventFingerprint: input.eventFingerprint, session: this.captureSession
        });
        if (!captured.ok)
        {
            return { status: 'rejected', reason: captured.rejected };
        }
        if (captured.batch.items.some(item => !ref(item.name) || !ref(item.mimeType)
            || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0))
        {
            return { status: 'rejected', reason: 'file-candidate-invalid' };
        }
        if (captured.batch.items.length + this.leases.size + this.pending.size > articleAttachmentIntentCapacity)
        {
            return { status: 'rejected', reason: 'created-intent-capacity' };
        }
        const planned = planMarkdownAttachmentInsert(input.source, captured.batch.anchor, captured.batch);
        const createdLeases: ArticleDocumentTaskLease[] = [];
        const handles = captured.batch.items.map(item =>
        {
            const lease = this.owner.beginTask('attachment', `attachment-input:${++this.sequence}`, this.providerVersion);
            this.leases.add(lease);
            createdLeases.push(lease);
            lease.signal.addEventListener('abort', () => this.leases.delete(lease), { once: true });
            const body = {
                schema: articleAttachmentIntentSchema, state: 'created' as const,
                anchor: input.anchor, task: lease.envelope, inputOrigin: input.origin,
                batchId: captured.batch.batchId, itemId: item.itemId, order: item.order,
                candidate: Object.freeze({ name: item.name, mimeType: item.mimeType, byteLength: item.byteLength }),
                provider: this.provider, providerVersion: this.providerVersion
            };
            const intent: ArticleAttachmentIntent = Object.freeze({
                ...body, contentDigest: calculateOpenArticleDocumentDigest(body)
            });
            return Object.freeze({ intent, signal: lease.signal, cancel: () => lease.cancel('attachment-input-cancelled') });
        });
        const result: ArticleAttachmentCapture = Object.freeze({
            status: 'created', handles: Object.freeze(handles),
            transaction: Object.freeze({
                ...planned.transaction, documentIdentity: this.owner.documentIdentity,
                expectedRevision: this.owner.context.sourceRevision
            })
        });
        this.captured.set(result, { batch: captured.batch, jobs: planned.jobs, handles,
            leases: createdLeases, transaction: result.transaction });
        return result;
    }

    public get lifecycleReceipts(): readonly ArticleAttachmentLifecycleSnapshot[]
    {
        return this.lifecycleLog.map(value => structuredClone(value));
    }

    public get currentTaskLeases(): readonly ArticleDocumentTaskLease[]
    {
        return Object.freeze([...this.pending.values()].filter(entry => !entry.awaitingMap && entry.lease.isCurrent()).map(entry => entry.lease));
    }

    /** Borrow the original commitCreated/retry handle. Cloned receipts are never capabilities.
     * Completed nodes are attested only at their exact commit revision; later edits fail closed.
     * Terminal handles remain weakly owned observations, never current source/cleanup proof.
     */
    public readOwnedIntent(handle: ArticleAttachmentPendingHandle,
        binding: ArticlePositionMapBinding): ArticleAttachmentOwnedIntentObservation | null
    {
        const entry = this.pendingHandles.get(handle);
        if (this.disposed || !entry)
        {
            return null;
        }
        const snapshot = entry.snapshot;
        const pending = snapshot.state === 'provider-pending' || snapshot.state === 'anchored';
        const completed = snapshot.state === 'transaction-committed';
        let sourceReferenced: boolean | null = null;
        let current = !entry.awaitingMap && !this.ownedOperations.has(entry.intent.task.taskRef)
            && snapshot.intent === entry.intent && handle.snapshot === snapshot
            && handle.request === entry.request && handle.signal === entry.controller.signal
            && entry.intent.provider === this.provider && entry.intent.providerVersion === this.providerVersion
            && this.owner.isCurrentContext(snapshot.anchor.document)
            && this.owner.isCurrentContext(binding.document)
            && (pending
                ? this.pending.get(entry.intent.task.taskRef) === entry && entry.lease.isCurrent()
                    && !entry.controller.signal.aborted && entry.lease.envelope === snapshot.task
                : completed && entry.completedLease?.envelope === snapshot.task
                    && snapshot.task.status === 'completed'
                    && snapshot.task.completedRevision === binding.document.sourceRevision
                    && this.pending.get(entry.intent.task.taskRef) === undefined);
        if (this.owner.isCurrentContext(binding.document))
        {
            try
            {
                const sourceContext = createArticleDocumentContext({ ...binding.document, content: binding.map.source });
                if (sourceContext.contextDigest !== binding.document.contextDigest)
                {
                    throw new Error('attachment-owned-source-binding-invalid');
                }
                const identityCurrent = binding.map.documentIdentity.id === binding.document.documentId
                    && binding.map.documentIdentity.epoch === binding.document.documentEpoch;
                const range = snapshot.anchor.range;
                const mapCurrent = identityCurrent
                    && this.owner.isCurrentContext(snapshot.anchor.document);
                let present = false;
                if (mapCurrent && range.start < range.end && range.end <= binding.map.source.length)
                {
                    const visual = binding.map.sourceSelectionToVisual({ anchor: range.start, focus: range.end });
                    const mapped = binding.map.visualAnchorToSourceSelection(visual);
                    const point = binding.map.sourcePositionToVisual({ offset: range.end, affinity: snapshot.anchor.affinity });
                    present = Math.min(mapped.anchor, mapped.focus) === range.start
                        && Math.max(mapped.anchor, mapped.focus) === range.end
                        && point.anchorId === snapshot.anchor.nodeId
                        && binding.map.syntax.some(node => node.id === snapshot.anchor.nodeId)
                        && snapshot.transactionRef !== null;
                    sourceReferenced = present ? true : null;
                }
                else if (snapshot.state === 'removed' && entry.removedContext
                    && this.owner.isCurrentContext(entry.removedContext) && identityCurrent)
                {
                    sourceReferenced = false;
                }
                current = current && present;
            }
            catch
            {
                current = false;
            }
        }
        else
        {
            current = false;
        }
        const disposition = current ? 'current' : (['cancelled', 'removed', 'failed'].includes(snapshot.state)
            ? snapshot.state as 'cancelled' | 'removed' | 'failed' : 'stale');
        return Object.freeze({ snapshot, current, intentRef: entry.intent.task.taskRef,
            nodeId: snapshot.anchor.nodeId, transactionRef: snapshot.transactionRef,
            providerRef: entry.intent.provider, providerVersion: entry.intent.providerVersion,
            contextDigest: snapshot.anchor.document.contextDigest, sourceOrder: entry.intent.order,
            sourceReferenced, disposition, sourceUrl: current && completed ? entry.sourceUrl ?? null : null });
    }

    /** Admission consumes the exact local capture capability and a real public dispatch. */
    public commitCreated(capture: ArticleAttachmentCapture, port: ArticleAttachmentTransactionPort): readonly ArticleAttachmentPendingHandle[]
    {
        const record = this.captured.get(capture);
        if (this.disposed || !this.anchors || !record || 'stage' in record || record.leases.some(lease => !lease.isCurrent()))
        {
            throw new Error('attachment-created-admission-invalid');
        }
        this.captured.delete(capture);
        const before = this.owner.context;
        let result: MarkdownEditorDispatchResult;
        try
        {
            result = port.dispatch(record.transaction);
        }
        catch
        {
            record.leases.forEach(lease => lease.cancel('attachment-insert-dispatch-failed'));
            throw new Error('attachment-insert-dispatch-failed');
        }
        if (!result.accepted || !result.positionMap || result.beforeRevision !== before.sourceRevision
            || result.revision <= result.beforeRevision || result.documentIdentity.id !== before.documentId
            || result.documentIdentity.epoch !== before.documentEpoch)
        {
            record.leases.forEach(lease => lease.cancel('attachment-insert-rejected'));
            throw new Error('attachment-insert-rejected');
        }
        let binding: ArticlePositionMapBinding;
        try
        {
            port.commitSource(result);
            binding = port.binding();
            this.assertCurrentResult(result, binding);
        }
        catch
        {
            record.leases.forEach(lease => lease.cancel('attachment-insert-binding-invalid'));
            throw new Error('attachment-insert-binding-invalid');
        }
        const handles = record.handles.map((handle, index) =>
        {
            const plannedJob = record.jobs[index];
            if (!plannedJob?.range)
            {
                throw new Error('attachment-public-job-missing');
            }
            const anchor = this.anchors!.capture(binding, { ...plannedJob.range, direction: 'none' },
                { affinity: 'after', viewportOffset: handle.intent.anchor.viewportOffset,
                    percentage: handle.intent.anchor.percentage, surface: handle.intent.anchor.surface, tool: handle.intent.anchor.tool });
            return this.createPending(handle.intent, record.batch, plannedJob.range, anchor, result);
        });
        this.observeTransaction(result, binding);
        // Only the synchronous input transfer has ended. Provider work retains its own lease.
        for (const lease of record.leases)
        {
            lease.cancel('attachment-input-transferred');
            lease.settle();
        }
        return Object.freeze(handles);
    }

    /** Admit the native dispatch once. Never recapture, replan or dispatch its placeholders. */
    public admitAcceptedCapture(input: {
        batch: MarkdownAttachmentBatchIntent;
        capture: MarkdownAttachmentCaptureObservation | undefined;
        anchorOptions: ArticleAnchorCaptureOptions;
    }, port: ArticleAttachmentTransactionPort & Partial<ArticleAttachmentFilePort>): ArticleAttachmentAcceptedCapture
    {
        const { batch, capture } = input;
        const reject = (reason: string): ArticleAttachmentAcceptedCapture => ({ status: 'rejected', reason });
        if (this.disposed || !this.anchors || !capture || typeof port.withAttachmentFile !== 'function')
        {
            return reject('capture-unavailable');
        }
        if (this.captured.has(capture))
        {
            return reject('capture-already-admitted');
        }
        // The same weak registry reserves reentry and retains a consumed tombstone.
        // This marker conveys no File, pending handle or persistent authority.
        const acceptedCapture: AcceptedNativeCapture = { stage: 'accepted', entries: [] };
        this.captured.set(capture, acceptedCapture);
        const files: File[] = [];
        const handles: ArticleAttachmentPendingHandle[] = [];
        try
        {
            if (capture.batch !== batch || !batch.items.length || batch.signal.aborted)
            {
                return reject('capture-not-original');
            }
            for (const item of batch.items)
            {
                let count = 0;
                let original = false;
                const lent = port.withAttachmentFile(batch, item, (file, observation) =>
                {
                    count += 1;
                    original = observation === capture && observation.batch === batch;
                    if (original)
                    {
                        files.push(file);
                    }
                });
                if (!lent || count !== 1 || !original)
                {
                    return reject('capture-not-original');
                }
            }
            const result = capture.transaction;
            const current = this.owner.context;
            const identity = this.owner.documentIdentity;
            const sameIdentity = (value: Readonly<{ id: string; epoch: number; }>): boolean =>
                value.id === identity.id && value.epoch === identity.epoch;
            if (!sameIdentity(batch.documentIdentity) || !sameIdentity(batch.anchor.documentIdentity)
                || !sameIdentity(result.documentIdentity) || !result.accepted || !result.positionMap
                || result.beforeRevision !== batch.revision || batch.anchor.revision !== batch.revision
                || result.transaction.expectedRevision !== batch.revision
                || !result.transaction.documentIdentity || !sameIdentity(result.transaction.documentIdentity)
                || !Number.isSafeInteger(result.revision) || result.revision < result.beforeRevision
                || current.sourceRevision !== result.revision)
            {
                return reject('context-stale');
            }
            const binding = port.binding();
            this.assertCurrentResult(result, binding);
            if (capture.placements.length !== batch.items.length || capture.plan.jobs.length !== batch.items.length
                || capture.plan.transaction.changes.length !== result.transaction.changes.length
                || capture.plan.transaction.changes.some((change, index) =>
                {
                    const applied = result.transaction.changes[index];
                    return change.from !== applied.from || change.to !== applied.to || change.insert !== applied.insert;
                })
                || capture.plan.transaction.origin !== result.transaction.origin
                || capture.plan.transaction.history !== result.transaction.history)
            {
                return reject('transaction-invalid');
            }
            for (const [index, item] of batch.items.entries())
            {
                const placement = capture.placements[index];
                const job = capture.plan.jobs[index];
                const file = files[index];
                if (item.order !== index || item.signal.aborted || !ref(item.name) || !ref(item.mimeType)
                    || file.name !== item.name || file.type !== item.mimeType || file.size !== item.byteLength
                    || placement.item !== item || !Object.isFrozen(placement.range)
                    || job.itemId !== item.itemId || job.batchId !== batch.batchId
                    || !job.documentIdentity || !sameIdentity(job.documentIdentity) || job.revision !== batch.revision || job.attempt !== 1
                    || !['pending', 'progress'].includes(job.phase)
                    || !Number.isSafeInteger(placement.range.start) || !Number.isSafeInteger(placement.range.end)
                    || placement.range.start < 0 || placement.range.end <= placement.range.start
                    || placement.range.end > result.value.length)
                {
                    return reject('transaction-invalid');
                }
            }
            if (batch.items.length + this.leases.size + this.pending.size > articleAttachmentIntentCapacity)
            {
                return reject('capacity-exceeded');
            }
            for (const [index, item] of batch.items.entries())
            {
                const range = capture.placements[index].range;
                const anchor = this.anchors.capture(binding, { ...range, direction: 'none' }, input.anchorOptions);
                // Original issuance at the current post-dispatch context. No pre-context lease is revived.
                const created = this.owner.beginTask('attachment', `attachment-input:${++this.sequence}`, this.providerVersion);
                const body = { schema: articleAttachmentIntentSchema, state: 'created' as const, anchor,
                    task: created.envelope, inputOrigin: batch.sourceKind, batchId: batch.batchId,
                    itemId: item.itemId, order: item.order,
                    candidate: Object.freeze({ name: item.name, mimeType: item.mimeType, byteLength: item.byteLength }),
                    provider: this.provider, providerVersion: this.providerVersion };
                const intent = Object.freeze({ ...body, contentDigest: calculateOpenArticleDocumentDigest(body) });
                try
                {
                    const handle = this.createPending(intent, batch, range, anchor, result, files[index], item, capture);
                    handles.push(handle);
                    const entry = this.pendingHandles.get(handle);
                    if (entry)
                    {
                        acceptedCapture.entries.push(entry);
                    }
                }
                finally
                {
                    created.cancel('attachment-input-transferred');
                }
                // A failed transfer must retain its unfinished cleanup obligation.
                created.settle();
            }
            return Object.freeze({ status: 'admitted', items: Object.freeze(batch.items.map((item, index) =>
                Object.freeze({ item, file: files[index], handle: handles[index] }))) });
        }
        catch
        {
            handles.forEach(handle => handle.cancel());
            return reject('transaction-invalid');
        }
    }

    private acceptedNativeCapture(entry: PendingInput): AcceptedNativeCapture | null
    {
        const capture = entry.nativeInput?.capture;
        const record = capture ? this.captured.get(capture) : null;
        return record && 'stage' in record && record.stage === 'accepted' && record.entries.includes(entry) ? record : null;
    }

    /** Fresh genuine SDK/native continuation for this original entry; never ordinary current. */
    private nativeContinuation(entry: PendingInput): ArticleDocumentContext | null
    {
        const token = this.acceptedNativeCapture(entry)?.cohort?.token;
        if (!token || this.disposed || entry.awaitingMap || entry.nativeCleanupPending
            || this.pending.get(entry.intent.task.taskRef) !== entry || entry.controller.signal.aborted
            || entry.lease.signal.aborted || entry.lease.envelope.status !== 'running')
        {
            return null;
        }
        const context = this.owner.readAttachmentRevisionContinuation(token, entry.lease);
        // Only private original holder/context checks follow the final native proof.
        return context && this.owner.context === context && entry.snapshot.anchor.document === context
            && this.pending.get(entry.intent.task.taskRef) === entry && !entry.awaitingMap
            && !entry.nativeCleanupPending && !entry.controller.signal.aborted && !entry.lease.signal.aborted
            && this.acceptedNativeCapture(entry)?.cohort?.token === token ? context : null;
    }

    /** Restrictive routing only: an original cohort holder must never use generic admission. */
    public hasNativeUploadCohort(handle: ArticleAttachmentPendingHandle): boolean
    {
        const entry = this.pendingHandles.get(handle);
        return !!entry?.nativeCapture && !!this.acceptedNativeCapture(entry)?.cohort;
    }

    /** Exact original File/handle/lease plus actual public map and fresh native-backed proof. */
    public readNativeUploadContinuation(handle: ArticleAttachmentPendingHandle, file: File,
        lease: ArticleDocumentTaskLease, documentOwner: ArticleDocumentContextAdapter,
        binding: ArticlePositionMapBinding): ArticleDocumentContext | null
    {
        const entry = this.pendingHandles.get(handle);
        if (!entry?.nativeCapture || this.owner !== documentOwner || entry.lease !== lease || entry.file !== file
            || entry.nativeHandle !== handle || handle.snapshot !== entry.snapshot || entry.snapshot.task !== lease.envelope
            || handle.request !== entry.request || handle.signal !== entry.controller.signal
            || !entry.nativeInput || entry.nativeInput.capture.batch.items[entry.nativeInput.item.order] !== entry.nativeInput.item
            || entry.nativeInput.capture.batch.signal.aborted || entry.nativeInput.item.signal.aborted
            || binding.document !== entry.snapshot.anchor.document)
        {
            return null;
        }
        // Map/retained readers run before the final original SDK/native proof.
        this.assertNativeSourceBinding(binding);
        const observation = this.readOwnedIntent(handle, binding);
        if (observation?.snapshot !== entry.snapshot || observation.sourceReferenced !== true)
        {
            return null;
        }
        return this.nativeContinuation(entry);
    }

    private assertNativeSourceBinding(binding: ArticlePositionMapBinding): void
    {
        const context = createArticleDocumentContext({ ...binding.document, content: binding.map.source });
        if (context.contextDigest !== binding.document.contextDigest
            || binding.map.documentIdentity.id !== binding.document.documentId
            || binding.map.documentIdentity.epoch !== binding.document.documentEpoch)
        {
            throw new Error('attachment-native-source-binding-invalid');
        }
    }

    /** Native admissions require the exact File; the original explicit-capture route is unchanged. */
    public matchesCapturedFile(handle: ArticleAttachmentPendingHandle, file: File): boolean
    {
        const entry = this.pendingHandles.get(handle);
        return !!entry && (!entry.nativeCapture || entry.file === file);
    }

    /** Borrow the SAME admitted pending handle and lease for the original native request. */
    public readNativeUploadBinding(batch: MarkdownAttachmentBatchIntent, item: MarkdownAttachmentItemIntent, file: File):
        Readonly<{ intent: ArticleAttachmentPendingHandle; lease: ArticleDocumentTaskLease; }> | null
    {
        for (const entry of this.pending.values())
        {
            if (entry.nativeInput?.capture.batch === batch && entry.nativeInput.item === item
                && entry.file === file && entry.nativeHandle && !entry.controller.signal.aborted
                && !batch.signal.aborted && !item.signal.aborted && (this.acceptedNativeCapture(entry)?.cohort ? this.nativeContinuation(entry) : entry.lease.isCurrent())
                && entry.nativeHandle.snapshot.task === entry.lease.envelope)
            {
                return Object.freeze({ intent: entry.nativeHandle, lease: entry.lease });
            }
        }
        return null;
    }

    private createPending(intent: ArticleAttachmentIntent, batch: MarkdownAttachmentBatchIntent,
        range: Readonly<{ start: number; end: number; }>, anchor: ArticleAnchorContext,
        result: MarkdownEditorDispatchResult, file?: File, item?: MarkdownAttachmentItemIntent,
        capture?: MarkdownAttachmentCaptureObservation): ArticleAttachmentPendingHandle
    {
        const controller = new AbortController();
        const lease = this.owner.beginTask('attachment', `attachment-provider:${++this.sequence}`, this.providerVersion);
        const job = createMarkdownAttachmentJob(intent.itemId, { batchId: batch.batchId, itemId: intent.itemId,
            documentIdentity: this.owner.documentIdentity, revision: this.owner.context.sourceRevision,
            range, signalController: controller });
        const entry: PendingInput = { intent, controller, lease, job, awaitingMap: false,
            request: Object.freeze({ batchId: batch.batchId, itemId: intent.itemId, requestId: lease.envelope.requestId,
                documentIdentity: this.owner.documentIdentity, revision: this.owner.context.sourceRevision }),
            snapshot: this.sealLifecycle({ schema: articleAttachmentLifecycleSchema, intent, anchor,
                task: lease.envelope, predecessorTaskRef: intent.task.taskRef, state: 'anchored', attempt: 1,
                reason: null, transactionRef: this.transactionRef(result), providerResultDigest: null }) };
        this.pending.set(intent.task.taskRef, entry);
        this.record(entry.snapshot);
        entry.snapshot = this.sealLifecycle({ ...entry.snapshot, state: 'provider-pending' });
        this.record(entry.snapshot);
        if (file && item)
        {
            entry.nativeCapture = true;
            entry.file = file;
            if (capture)
            {
                entry.nativeInput = { capture, item };
            }
            const cancel = (): void =>
            {
                // Only this original application's actual release may defer input revocation.
                if (entry.nativeCompletion?.isReleasingInput())
                {
                    entry.nativeInputReleaseObserved = true;
                    return;
                }
                this.finish(entry, 'cancelled', 'attachment-native-input-revoked');
            };
            entry.releaseFile = () =>
            {
                batch.signal.removeEventListener('abort', cancel);
                item.signal.removeEventListener('abort', cancel);
                entry.file = undefined;
                entry.releaseFile = undefined;
            };
            batch.signal.addEventListener('abort', cancel, { once: true });
            item.signal.addEventListener('abort', cancel, { once: true });
            if (batch.signal.aborted || item.signal.aborted)
            {
                cancel();
            }
        }
        return this.pendingHandle(entry);
    }

    public readNativeTerminalTransaction(handle: ArticleAttachmentPendingHandle): ArticleAttachmentNativeTerminalObservation | null
    {
        return this.pendingHandles.get(handle)?.nativeTerminal ?? null;
    }

    /** The original SDK binds this producer through the existing owned composition. */
    public getNativeRevisionProducer(): ArticleAttachmentNativeRevisionProducer
    {
        return this.nativeRevisionProducer;
    }

    public readNativeTerminalFailure(handle: ArticleAttachmentPendingHandle): Readonly<{ firstCause: unknown; latestCause: unknown; }> | null
    {
        const failure = this.pendingHandles.get(handle)?.nativeFailure;
        return failure ? Object.freeze({ ...failure }) : null;
    }

    /** Observe only the SAME captured native application's source-produced evidence. */
    public inspectNativeApplicationEnd(handle: ArticleAttachmentPendingHandle): MarkdownAttachmentTerminalApplicationEndObservation | null
    {
        const entry = this.pendingHandles.get(handle);
        return entry?.nativeCapture ? this.readNativeApplicationEnd(entry) : null;
    }

    /** Retry original native cleanup and Main duties independently; never replay publication. */
    public retryNativeApplicationEnd(handle: ArticleAttachmentPendingHandle): MarkdownAttachmentTerminalApplicationEndObservation | null
    {
        const entry = this.pendingHandles.get(handle);
        if (!entry?.nativeCapture || this.pending.get(entry.intent.task.taskRef) !== entry)
        {
            return entry?.nativeApplicationEnd?.observation ?? null;
        }
        let failed = false;
        let firstCause: unknown;
        for (const work of [() => this.readNativeApplicationEnd(entry, true),
            () => this.finishNativeEntry(entry, 'attachment-native-application-end-cleanup-retry')])
        {
            try
            {
                work();
            }
            catch (cause)
            {
                if (!failed)
                {
                    firstCause = cause;
                }
                failed = true;
                entry.nativeFailure ??= { firstCause: cause, latestCause: cause };
                entry.nativeFailure.latestCause = cause;
            }
        }
        if (failed)
        {
            throw firstCause;
        }
        return entry.nativeApplicationEnd?.observation ?? null;
    }

    private readNativeApplicationEnd(entry: PendingInput, retry = false): MarkdownAttachmentTerminalApplicationEndObservation | null
    {
        const end = entry.nativeApplicationEnd;
        if (!end?.handle)
        {
            return null; // Unescaped acquisition is not a native ended/empty-resource receipt.
        }
        entry.nativeApplicationEndPending = true;
        try
        {
            const observation = retry ? end.issuer.retry(end.handle, end.lease) : end.issuer.inspect(end.handle, end.lease);
            if (!observation)
            {
                return null;
            }
            if (observation.applicationRef !== end.handle || observation.custody !== end.custody
                || observation.reservation !== end.reservation || observation.leaseRef !== entry.lease
                || end.lease !== entry.lease
                || (entry.nativePublication && observation.transaction !== entry.nativePublication.transaction))
            {
                throw new Error('attachment-native-application-end-binding-invalid');
            }
            end.observation = observation;
            // Physical native stack/cleanup only. Provider/network/SDK task work stays separate.
            entry.nativeApplicationEndPending = observation.unsupportedWork
                || !end.issuer.hasEnded(end.handle, end.lease, observation);
            return observation;
        }
        catch (cause)
        {
            entry.nativeFailure ??= { firstCause: cause, latestCause: cause };
            entry.nativeFailure.latestCause = cause;
            throw cause;
        }
    }

    /** Original accepted lease after real Main cleanup and the original native end proof. */
    public readCleanedNativeLease(handle: ArticleAttachmentPendingHandle): ArticleDocumentTaskLease | null
    {
        const entry = this.pendingHandles.get(handle);
        const lease = entry?.lease;
        const end = entry?.nativeApplicationEnd;
        const clean = (): boolean => !!entry && !!lease && !!end?.handle
            && entry.nativeCapture === true && entry.completedLease === lease
            && entry.nativeFinalization?.sdkAccepted === true && lease.envelope.status === 'completed'
            && entry.lease === lease && entry.nativeApplicationEnd === end
            && entry.nativeHandle === handle && entry.nativeLocalCleanupComplete === true
            && entry.nativeCleanupPending === false && !entry.nativeFinishing && !entry.reservingNativeRevision
            && entry.nativeSdkCleanupPending === false && !entry.nativeTransition
            && !entry.nativeCleanupReentry && !this.ownedOperations.has(entry.intent.task.taskRef)
            && this.pending.get(entry.intent.task.taskRef) !== entry;
        if (!entry || !lease || !clean())
        {
            return null;
        }
        const observation = this.readNativeApplicationEnd(entry);
        // Only original private state checks follow the stored issuer's exact ended proof.
        return observation && entry.nativeApplicationEndPending === false && clean() ? lease : null;
    }

    /** Genuine returned SDK publication, from this adapter's SAME private entry/event. */
    public hasNativeSourcePublication(transaction: MarkdownEditorDispatchResult, context: ArticleDocumentContext): boolean
    {
        for (const entry of this.pending.values())
        {
            if (entry.nativePublication?.transaction === transaction && entry.nativePublication.context === context
                && this.owner.context === context && entry.nativeTransition && entry.nativeCompletion
                && !entry.controller.signal.aborted && !entry.lease.signal.aborted
                && this.ownedOperations.has(entry.intent.task.taskRef))
            {
                return true;
            }
        }
        return false;
    }

    /** Same original resource holders; no aggregate editor census or work-settlement claim. */
    public inspectNativeTransitionCleanup(): Readonly<{ pending: number; }>
    {
        return Object.freeze({ pending: [...this.pending.values()].filter(entry => entry.nativeCleanupPending === true
            || entry.nativeApplicationEndPending === true
            || entry.nativeSdkCleanupPending === true
            || entry.nativeTerminal?.taskCompletion === 'completed').length });
    }

    public retryNativeTransitionCleanup(handle: ArticleAttachmentPendingHandle): boolean
    {
        const entry = this.pendingHandles.get(handle);
        if (!entry || this.pending.get(entry.intent.task.taskRef) !== entry || !entry.nativeCapture)
        {
            return false;
        }
        this.finish(entry, 'cancelled', 'attachment-native-cleanup-retry');
        return this.pending.get(entry.intent.task.taskRef) !== entry;
    }

    /** Consume the original native transaction, never generic complete's second dispatch. */
    public observeNativeTerminal(observation: MarkdownAttachmentTerminalObservation,
        port: ArticleAttachmentTransactionPort & Partial<ArticleAttachmentTerminalPort>): boolean
    {
        if (this.disposed || typeof port.withAttachmentTerminalTransaction !== 'function')
        {
            return false;
        }
        return port.withAttachmentTerminalTransaction(observation, original =>
        {
            if (original !== observation)
            {
                return false;
            }
            const custody = original.custody;
            const capture = custody.capture;
            const record = this.captured.get(capture);
            if (!record || !('stage' in record) || record.stage !== 'accepted'
                || capture.batch !== custody.batch || custody.batch.items[custody.item.order] !== custody.item
                || !capture.plan.jobs.some(job => job === custody.jobRef) || custody.attempt !== 1
                || custody.jobRef.attempt !== custody.attempt || custody.result.status !== 'resolved'
                || custody.result.batchId !== custody.batch.batchId || custody.result.itemId !== custody.item.itemId
                || custody.result.documentIdentity.id !== custody.batch.documentIdentity.id
                || custody.result.documentIdentity.epoch !== custody.batch.documentIdentity.epoch
                || custody.result.revision !== custody.batch.revision)
            {
                return false;
            }
            const entry = record.entries.find(candidate => candidate.nativeInput?.capture === capture
                && candidate.nativeInput.item === custody.item);
            if (!entry)
            {
                return false;
            }
            try
            {
                if (original.phase === 'applying')
                {
                    const continuation = this.acceptedNativeCapture(entry)?.cohort?.token
                        ? this.nativeContinuation(entry) : null;
                    if (entry.nativeCompletion || entry.awaitingMap || entry.controller.signal.aborted
                        || this.pending.get(entry.intent.task.taskRef) !== entry
                        || (record.cohort ? !continuation : (!entry.lease.isCurrent()
                            || !this.owner.isCurrentContext(entry.snapshot.anchor.document)))
                        || this.owner.context.sourceRevision !== custody.beforeRevision || !custody.hasCustody())
                    {
                        return false;
                    }
                    entry.nativeCompletion = custody;
                    entry.nativeInputReleaseObserved = false;
                    this.ownedOperations.add(entry.intent.task.taskRef);
                    // Only the actual original SDK asks the genuine installed producer to reserve.
                    entry.nativeSdkCleanupPending = true;
                    entry.nativeTransition = this.owner.reserveAttachmentRevisionTransition(entry.lease, custody, this.nativeRevisionProducer, record.cohort?.token ?? undefined) ?? undefined;
                    if (!entry.nativeTransition)
                    {
                        entry.nativeSdkCleanupPending = false;
                    }
                    if (entry.nativeTransition && !record.cohort)
                    {
                        const issuer = this.readNativeCohortIssuer?.();
                        if (!issuer)
                        {
                            throw new Error('attachment-native-cohort-owner-unavailable');
                        }
                        // Retain the same capture holder before fallible native/SDK acquisition.
                        record.cohort = { issuer, acquisitionLease: entry.lease, token: null, cleanupPending: true, withdrawn: false };
                        const members = capture.batch.items.map((item, index) =>
                        {
                            const member = record.entries[index];
                            if (!member || member.nativeInput?.item !== item || member.nativeInput.capture !== capture
                                || this.pending.get(member.intent.task.taskRef) !== member || !member.file)
                            {
                                throw new Error('attachment-native-cohort-roster-invalid');
                            }
                            return Object.freeze({ item, jobRef: capture.plan.jobs[index], leaseRef: member.lease });
                        });
                        record.cohort.token = this.owner.reserveAttachmentRevisionCohort(entry.nativeTransition, issuer, members);
                        if (!record.cohort.token)
                        {
                            throw new Error('attachment-native-cohort-reservation-unavailable');
                        }
                        record.cohort.cleanupPending = false;
                    }
                    return !!entry.nativeTransition && custody.hasCustody()
                        && this.pending.get(entry.intent.task.taskRef) === entry && !entry.controller.signal.aborted
                        && !entry.lease.signal.aborted && this.owner.context.sourceRevision === custody.beforeRevision;
                }
                if (entry.nativeCompletion !== custody)
                {
                    return false;
                }
                if (original.phase === 'refused')
                {
                    entry.nativeFailure ??= { firstCause: original.cause, latestCause: original.cause };
                    entry.nativeFailure.latestCause = original.cause;
                    if (this.pending.get(entry.intent.task.taskRef) === entry)
                    {
                        this.finish(entry, entry.nativeInputReleaseObserved ? 'cancelled' : 'failed',
                            entry.nativeInputReleaseObserved ? 'attachment-native-input-revoked' : 'attachment-native-completion-refused');
                    }
                    return false;
                }
                if (original.phase === 'accepted')
                {
                    if (!entry.nativeTransition)
                    {
                        return false;
                    }
                    const context = this.owner.publishAttachmentRevisionTransition(entry.nativeTransition, original.transaction);
                    entry.nativePublication = { transaction: original.transaction, context };
                    // Original Writer synchronizes its real form against this private publication.
                    port.commitSource(original.transaction);
                    this.assertCurrentResult(original.transaction, port.binding());
                    this.synchronizeNativeCohortPeers(record, entry, original.transaction, context, port);
                    entry.awaitingMap = false;
                    return this.pending.get(entry.intent.task.taskRef) === entry && !entry.controller.signal.aborted
                        && !entry.lease.signal.aborted && this.owner.context === context && custody.hasCustody();
                }
                const transaction = original.transaction;
                if (this.pending.get(entry.intent.task.taskRef) !== entry || entry.controller.signal.aborted
                    || !custody.hasCustody() || !transaction.accepted || !transaction.positionMap
                    || transaction.beforeRevision !== custody.beforeRevision || transaction.revision <= transaction.beforeRevision
                    || transaction.transaction.expectedRevision !== transaction.beforeRevision
                    || transaction.transaction.metadata?.attachmentItemId !== custody.item.itemId
                    || transaction.documentIdentity.id !== custody.batch.documentIdentity.id
                    || transaction.documentIdentity.epoch !== custody.batch.documentIdentity.epoch)
                {
                    return false;
                }
                this.assertCurrentResult(transaction, port.binding());
                if (entry.nativeTransition && entry.nativePublication?.transaction === transaction)
                {
                    const proof = Object.freeze({ transactionRef: this.transactionRef(transaction),
                        providerResultDigest: calculateOpenArticleDocumentDigest(custody.result) });
                    entry.nativeFinalization = { observation: original, proof, sdkAccepted: false };
                    const accepted = this.owner.acceptAttachmentRevisionTransition(entry.nativeTransition, transaction, proof);
                    if (!accepted.accepted || accepted.envelope !== entry.lease.envelope)
                    {
                        throw new Error('attachment-native-same-lease-completion-refused');
                    }
                    entry.nativeFinalization.sdkAccepted = true;
                    // SDK returns success only after its actual association withdrawal succeeds.
                    entry.nativeSdkCleanupPending = false;
                    entry.nativeTransition = undefined;
                    this.finishNativeEntry(entry, 'attachment-native-completion-committed');
                    // Main's admission response does not acknowledge native stack/provider settlement.
                    return entry.nativeLocalCleanupComplete === true && custody.hasCustody();
                }
                // updateSource genuinely aborts old-revision leases. Preserve the SAME lease,
                // accepted transaction and original handle; never mint a completed replacement.
                entry.nativeTerminal = Object.freeze({ observation: original, task: entry.lease.envelope,
                    taskCompletion: 'unavailable' as const });
                this.finish(entry, 'cancelled', 'attachment-native-task-transition-unavailable');
                return false;
            }
            catch (cause)
            {
                entry.nativeFailure ??= { firstCause: cause, latestCause: cause };
                entry.nativeFailure.latestCause = cause;
                try
                {
                    this.finishNativeEntry(entry, 'attachment-native-transition-failed');
                }
                catch (cleanupCause)
                {
                    entry.nativeFailure.latestCause = cleanupCause;
                }
                throw cause;
            }
            finally
            {
                // accepted is intermediate: the original native owner still emits refused
                // after our unavailable publication response, with this SAME custody.
                if (original.phase === 'committed' || original.phase === 'refused')
                {
                    this.ownedOperations.delete(entry.intent.task.taskRef);
                    entry.nativeCompletion = undefined;
                }
            }
        });
    }

    private synchronizeNativeCohortPeers(record: AcceptedNativeCapture, applying: PendingInput,
        transaction: MarkdownEditorTransactionEvent, context: ArticleDocumentContext, port: ArticleAttachmentTransactionPort): void
    {
        const token = record.cohort?.token;
        if (!token || !transaction.positionMap || !this.anchors)
        {
            throw new Error('attachment-native-cohort-publication-unavailable');
        }
        for (const entry of record.entries)
        {
            if (entry === applying || entry.nativeFinalization?.sdkAccepted)
            {
                continue;
            }
            const snapshot = entry.snapshot;
            const lease = entry.lease;
            const binding = port.binding();
            this.assertCurrentResult(transaction, binding);
            if (binding.document !== context || snapshot.anchor.document.sourceRevision !== transaction.beforeRevision
                || !this.owner.hasAttachmentRevisionCohortPublication(token, lease, transaction, context))
            {
                throw new Error('attachment-native-cohort-peer-publication-invalid');
            }
            const mapped = transaction.positionMap.mapRange(snapshot.anchor.range);
            const range = { start: transaction.positionMap.map(snapshot.anchor.range.start, 1),
                end: transaction.positionMap.map(snapshot.anchor.range.end, -1) };
            if (mapped.deleted !== false || mapped.partiallyDeleted !== false || !mapped.range
                || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
                || range.start < 0 || range.end <= range.start || range.end > transaction.value.length)
            {
                throw new Error('attachment-native-cohort-peer-map-invalid');
            }
            const anchor = this.anchors.capture(binding, { ...range, direction: snapshot.anchor.direction },
                { affinity: snapshot.anchor.affinity, viewportOffset: snapshot.anchor.viewportOffset,
                    percentage: snapshot.anchor.percentage, surface: snapshot.anchor.surface, tool: snapshot.anchor.tool });
            const next = this.sealLifecycle({ ...snapshot, anchor, task: lease.envelope,
                transactionRef: this.transactionRef(transaction) });
            if (entry.snapshot !== snapshot || entry.lease !== lease || this.pending.get(entry.intent.task.taskRef) !== entry
                || entry.controller.signal.aborted || lease.signal.aborted
                || !this.owner.hasAttachmentRevisionCohortPublication(token, lease, transaction, context))
            {
                throw new Error('attachment-native-cohort-peer-publication-revoked');
            }
            entry.job.range = anchor.range;
            entry.snapshot = next;
            entry.awaitingMap = false;
            this.record(next);
        }
    }

    /** FsusUI emits transaction before model update; commit through the existing document owner. */
    public consumeTransaction(result: MarkdownEditorDispatchResult, port: ArticleAttachmentTransactionPort): boolean
    {
        if (this.disposed || !result.accepted)
        {
            return false;
        }
        const current = this.owner.context;
        if (result.documentIdentity.id !== current.documentId || result.documentIdentity.epoch !== current.documentEpoch)
        {
            return false;
        }
        if (!Number.isSafeInteger(result.beforeRevision) || !Number.isSafeInteger(result.revision)
            || result.revision < result.beforeRevision
            || (result.beforeRevision !== current.sourceRevision && result.revision !== current.sourceRevision))
        {
            for (const entry of this.pending.values())
            {
                this.finish(entry, 'stale', 'attachment-transaction-chain-invalid');
            }
            return false;
        }
        if (result.revision === current.sourceRevision)
        {
            try
            {
                this.assertCurrentResult(result, port.binding());
            }
            catch
            {
                return false;
            }
        }
        try
        {
            // Repeated events proved identical current bytes before touching the source owner.
            port.commitSource(result);
            const binding = port.binding();
            this.assertCurrentResult(result, binding);
            this.observeTransaction(result, binding);
            return true;
        }
        catch
        {
            if (this.owner.context.contextDigest !== current.contextDigest)
            {
                for (const entry of this.pending.values())
                {
                    this.finish(entry, 'stale', 'attachment-transaction-binding-invalid');
                }
            }
            return false;
        }
    }

    /** Consume committed maps in order. Partial/deleted nodes cannot receive late results. */
    public observeTransaction(result: MarkdownEditorDispatchResult, binding: ArticlePositionMapBinding): void
    {
        if (this.disposed || !result.accepted || !this.anchors)
        {
            return;
        }
        try
        {
            this.assertCurrentResult(result, binding);
        }
        catch
        {
            for (const entry of this.pending.values())
            {
                this.finish(entry, 'stale', 'attachment-transaction-binding-invalid');
            }
            return;
        }
        for (const entry of this.pending.values())
        {
            if (this.ownedOperations.has(entry.intent.task.taskRef) || entry.nativeCleanupPending
                || entry.nativeTerminal?.taskCompletion === 'completed')
            {
                continue;
            }
            if (entry.nativeCapture && this.acceptedNativeCapture(entry)?.cohort
                && entry.snapshot.anchor.document.contextDigest !== binding.document.contextDigest)
            {
                this.finish(entry, 'stale', 'attachment-native-cohort-map-unavailable');
                continue;
            }
            if (entry.snapshot.anchor.document.contextDigest === binding.document.contextDigest)
            {
                continue;
            }
            let mapped: ReturnType<NonNullable<MarkdownEditorDispatchResult['positionMap']>['mapRange']>;
            try
            {
                if (result.beforeRevision !== entry.snapshot.anchor.document.sourceRevision || !result.positionMap)
                {
                    throw new Error('attachment-position-map-chain-invalid');
                }
                mapped = result.positionMap.mapRange(entry.snapshot.anchor.range);
                if (!mapped.deleted && !mapped.partiallyDeleted && mapped.range)
                {
                    // Attachment content owns neither adjacent insertion. Both associations
                    // come from the public map; no Blog offset arithmetic or parser is used.
                    mapped = { ...mapped, range: {
                        start: result.positionMap.map(entry.snapshot.anchor.range.start, 1),
                        end: result.positionMap.map(entry.snapshot.anchor.range.end, -1)
                    } };
                }
            }
            catch
            {
                this.finish(entry, 'stale', 'attachment-position-map-invalid');
                continue;
            }
            if (mapped.deleted)
            {
                entry.removedContext = binding.document;
                this.finish(entry, 'removed', 'attachment-node-deleted');
            }
            else if (typeof mapped.deleted !== 'boolean' || typeof mapped.partiallyDeleted !== 'boolean'
                || mapped.partiallyDeleted || !mapped.range || !Number.isSafeInteger(mapped.range.start)
                || !Number.isSafeInteger(mapped.range.end) || mapped.range.start < 0
                || mapped.range.start >= mapped.range.end || mapped.range.end > result.value.length)
            {
                this.finish(entry, 'stale', 'attachment-anchor-stale');
            }
            else
            {
                const anchor = this.anchors.capture(binding, { ...mapped.range, direction: entry.snapshot.anchor.direction },
                    { affinity: entry.snapshot.anchor.affinity, viewportOffset: entry.snapshot.anchor.viewportOffset,
                        percentage: entry.snapshot.anchor.percentage, surface: entry.snapshot.anchor.surface, tool: entry.snapshot.anchor.tool });
                const predecessor = entry.lease.taskRef;
                entry.lease.cancel('attachment-anchor-rebased');
                entry.lease = this.owner.beginTask('attachment', `attachment-provider:${++this.sequence}`, this.providerVersion);
                entry.job.range = anchor.range;
                entry.awaitingMap = false;
                entry.snapshot = this.sealLifecycle({ ...entry.snapshot, anchor, task: entry.lease.envelope,
                    predecessorTaskRef: predecessor, transactionRef: this.transactionRef(result) });
                this.record(entry.snapshot);
            }
        }
    }

    public complete(handle: ArticleAttachmentPendingHandle, result: MarkdownAttachmentProviderResult,
        port: ArticleAttachmentTransactionPort): ArticleAttachmentLifecycleSnapshot
    {
        const entry = this.findPending(handle);
        // Generic dispatch cannot carry FsusUI's authentic native job authority.
        // Refuse before mutation until that public completion composition is bound.
        if (entry.nativeCapture)
        {
            return this.finish(entry, 'failed', 'attachment-native-completion-unavailable');
        }
        if (result.batchId !== entry.request.batchId || result.itemId !== entry.request.itemId
            || result.documentIdentity?.id !== entry.request.documentIdentity.id
            || result.documentIdentity.epoch !== entry.request.documentIdentity.epoch || result.revision !== entry.request.revision)
        {
            return this.finish(entry, 'stale', 'attachment-provider-identity-invalid');
        }
        if (entry.awaitingMap || !this.owner.isCurrentContext(entry.snapshot.anchor.document)
            || !entry.lease.isCurrent() || entry.controller.signal.aborted)
        {
            return this.finish(entry, 'stale', 'attachment-provider-context-stale');
        }
        if (result.status !== 'resolved')
        {
            return this.finish(entry, result.status === 'cancelled' ? 'cancelled' : 'failed', 'attachment-provider-failed');
        }
        const job = { ...entry.job, range: entry.job.range ? { ...entry.job.range } : undefined };
        const plan = planMarkdownAttachmentResolve(port.binding().map.source, job, result);
        if (!plan.accepted || !plan.transaction)
        {
            return this.finish(entry, 'failed', 'attachment-provider-result-rejected');
        }
        const beforeRevision = this.owner.context.sourceRevision;
        this.ownedOperations.add(entry.intent.task.taskRef);
        let dispatched: MarkdownEditorDispatchResult;
        try
        {
            dispatched = port.dispatch({ ...plan.transaction, documentIdentity: this.owner.documentIdentity,
                expectedRevision: beforeRevision, metadata: Object.freeze({ attachmentItemId: entry.intent.itemId }) });
        }
        catch
        {
            return this.finish(entry, 'failed', 'attachment-completion-dispatch-failed');
        }
        finally
        {
            this.ownedOperations.delete(entry.intent.task.taskRef);
        }
        // Dispatch and binding callbacks may synchronously revoke this exact handle.
        if (this.pending.get(entry.intent.task.taskRef) !== entry || entry.controller.signal.aborted)
        {
            return entry.snapshot;
        }
        if (!dispatched.accepted)
        {
            return this.finish(entry, 'failed', 'attachment-completion-transaction-rejected');
        }
        if (dispatched.beforeRevision !== beforeRevision || dispatched.revision <= beforeRevision
            || dispatched.documentIdentity.id !== entry.request.documentIdentity.id
            || dispatched.documentIdentity.epoch !== entry.request.documentIdentity.epoch)
        {
            return this.finish(entry, 'stale', 'attachment-completion-identity-invalid');
        }
        let binding: ArticlePositionMapBinding;
        try
        {
            port.commitSource(dispatched);
            binding = port.binding();
            this.assertCurrentResult(dispatched, binding);
        }
        catch
        {
            return this.finish(entry, 'stale', 'attachment-completion-binding-invalid');
        }
        if (this.pending.get(entry.intent.task.taskRef) !== entry || entry.controller.signal.aborted)
        {
            return entry.snapshot;
        }
        const anchor = this.anchors!.capture(binding, { ...job.range!, direction: entry.snapshot.anchor.direction },
            { affinity: entry.snapshot.anchor.affinity, viewportOffset: entry.snapshot.anchor.viewportOffset,
                percentage: entry.snapshot.anchor.percentage, surface: entry.snapshot.anchor.surface, tool: entry.snapshot.anchor.tool });
        // The old request finishes; a successor lease attests only to this exact public commit.
        const predecessor = entry.lease.taskRef;
        entry.lease.cancel('attachment-completion-committed');
        const lease = this.owner.beginTask('attachment', `attachment-commit:${++this.sequence}`, this.providerVersion);
        const proof = { transactionRef: this.transactionRef(dispatched), providerResultDigest: calculateOpenArticleDocumentDigest(result) };
        lease.accept(proof);
        entry.completedLease = lease;
        entry.sourceUrl = result.payload.href;
        entry.awaitingMap = false;
        entry.snapshot = this.sealLifecycle({ ...entry.snapshot, anchor, task: lease.envelope,
            predecessorTaskRef: predecessor, state: 'transaction-committed', reason: null, ...proof });
        this.pending.delete(entry.intent.task.taskRef);
        entry.releaseFile?.();
        entry.controller.abort('attachment-completion-committed');
        this.record(entry.snapshot);
        this.observeTransaction(dispatched, binding);
        // This successor attests only to the completed synchronous public commit.
        // The predecessor provider's actual future is not supplied by this callback.
        lease.settle();
        return entry.snapshot;
    }

    public remove(handle: ArticleAttachmentPendingHandle, port: ArticleAttachmentTransactionPort): ArticleAttachmentLifecycleSnapshot
    {
        const entry = this.findPending(handle);
        if (entry.awaitingMap || !this.owner.isCurrentContext(entry.snapshot.anchor.document))
        {
            return this.finish(entry, 'stale', 'attachment-remove-context-stale');
        }
        const plan = planMarkdownAttachmentRemove(port.binding().map.source, { ...entry.job });
        const before = this.owner.context;
        this.ownedOperations.add(entry.intent.task.taskRef);
        let result: MarkdownEditorDispatchResult;
        try
        {
            result = port.dispatch({ ...plan.transaction, documentIdentity: this.owner.documentIdentity,
                expectedRevision: before.sourceRevision, metadata: Object.freeze({ attachmentItemId: entry.intent.itemId }) });
        }
        catch
        {
            return this.finish(entry, 'failed', 'attachment-remove-dispatch-failed');
        }
        finally
        {
            this.ownedOperations.delete(entry.intent.task.taskRef);
        }
        if (!result.accepted)
        {
            return this.finish(entry, 'failed', 'attachment-remove-transaction-rejected');
        }
        if (result.beforeRevision !== before.sourceRevision || result.revision <= before.sourceRevision
            || result.documentIdentity.id !== before.documentId || result.documentIdentity.epoch !== before.documentEpoch)
        {
            return this.finish(entry, 'stale', 'attachment-remove-identity-invalid');
        }
        let binding: ArticlePositionMapBinding;
        try
        {
            port.commitSource(result);
            binding = port.binding();
            this.assertCurrentResult(result, binding);
        }
        catch
        {
            return this.finish(entry, 'stale', 'attachment-remove-binding-invalid');
        }
        const snapshot = this.finish(entry, 'removed', 'attachment-node-removed');
        try
        {
            if (result.positionMap?.mapRange(entry.snapshot.anchor.range).deleted)
            {
                entry.removedContext = binding.document;
            }
        }
        catch
        {
            // A missing tombstone observation does not undo or fail the already committed removal.
        }
        this.observeTransaction(result, binding);
        return snapshot;
    }

    /** A retry is a new provider lease/signal; old completion capabilities remain cancelled. */
    public retry(handle: ArticleAttachmentPendingHandle): ArticleAttachmentPendingHandle
    {
        const previous = this.pendingHandles.get(handle);
        if (this.disposed || !previous || previous.nativeCapture || !['failed', 'cancelled'].includes(previous.snapshot.state)
            || !this.owner.isCurrentContext(previous.snapshot.anchor.document) || this.pending.has(previous.intent.task.taskRef))
        {
            throw new Error('attachment-retry-context-invalid');
        }
        const controller = new AbortController();
        const lease = this.owner.beginTask('attachment', `attachment-provider:${++this.sequence}`, this.providerVersion);
        const job = createMarkdownAttachmentJob(previous.intent.itemId, { batchId: previous.request.batchId,
            itemId: previous.intent.itemId, documentIdentity: this.owner.documentIdentity, revision: this.owner.context.sourceRevision,
            attempt: previous.job.attempt + 1, range: previous.snapshot.anchor.range, signalController: controller });
        const entry: PendingInput = { intent: previous.intent, controller, lease, job, awaitingMap: false,
            request: Object.freeze({ ...previous.request, revision: this.owner.context.sourceRevision, requestId: lease.envelope.requestId }),
            snapshot: this.sealLifecycle({ ...previous.snapshot, task: lease.envelope, predecessorTaskRef: previous.lease.taskRef,
                state: 'provider-pending', attempt: job.attempt, reason: null, providerResultDigest: null }) };
        this.pending.set(entry.intent.task.taskRef, entry);
        this.record(entry.snapshot);
        return this.pendingHandle(entry);
    }

    public replace(handle: ArticleAttachmentPendingHandle, file: MarkdownAttachmentInputFile,
        port: ArticleAttachmentTransactionPort): readonly ArticleAttachmentPendingHandle[]
    {
        const entry = this.findPending(handle);
        if (entry.nativeCapture)
        {
            throw new Error('attachment-native-capture-required');
        }
        if (entry.awaitingMap || !this.owner.isCurrentContext(entry.snapshot.anchor.document))
        {
            throw new Error('attachment-replace-context-stale');
        }
        const capture = this.capture({ origin: 'pick', anchor: entry.snapshot.anchor, files: [file], source: port.binding().map.source });
        if (capture.status !== 'created')
        {
            throw new Error('attachment-replace-capture-rejected');
        }
        return this.commitCreated(capture, port);
    }

    private pendingHandle(entry: PendingInput): ArticleAttachmentPendingHandle
    {
        const handle = Object.freeze({ get snapshot()
        {
            return entry.snapshot;
        }, signal: entry.controller.signal,
        request: entry.request, cancel: () =>
        {
            if (this.pending.get(entry.intent.task.taskRef) === entry)
            {
                this.finish(entry, 'cancelled', 'attachment-provider-cancelled');
            }
        } });
        this.pendingHandles.set(handle, entry);
        if (entry.nativeCapture)
        {
            entry.nativeHandle = handle;
        }
        return handle;
    }

    private findPending(handle: ArticleAttachmentPendingHandle): PendingInput
    {
        const entry = this.pendingHandles.get(handle);
        if (!entry || this.pending.get(entry.intent.task.taskRef) !== entry || entry.controller.signal.aborted || entry.nativeCleanupPending
            || entry.nativeTerminal?.taskCompletion === 'completed')
        {
            throw new Error('attachment-pending-handle-invalid');
        }
        return entry;
    }

    private finish(entry: PendingInput, state: 'cancelled' | 'stale' | 'removed' | 'failed', reason: string): ArticleAttachmentLifecycleSnapshot
    {
        if (entry.nativeCapture && (entry.nativeCleanupPending || entry.nativeSdkCleanupPending || entry.nativeFinalization))
        {
            return this.finishNativeEntry(entry, reason, state);
        }
        if (this.pending.get(entry.intent.task.taskRef) !== entry)
        {
            return entry.snapshot;
        }
        this.pending.delete(entry.intent.task.taskRef);
        entry.releaseFile?.();
        entry.lease.cancel(reason);
        entry.awaitingMap = false;
        entry.snapshot = this.sealLifecycle({ ...entry.snapshot, state, reason, task: entry.lease.envelope });
        // Publish terminal ownership before synchronous abort listeners can reenter.
        entry.controller.abort(reason);
        this.record(entry.snapshot);
        return entry.snapshot;
    }

    /** Attempt actual original duties without contradicting a completed historical SDK lease. */
    private finishNativeEntry(entry: PendingInput, reason: string,
        state: 'cancelled' | 'stale' | 'removed' | 'failed' = 'failed'): ArticleAttachmentLifecycleSnapshot
    {
        entry.nativeCleanupPending = true;
        entry.nativeLocalCleanupComplete = false;
        if (entry.nativeFinishing)
        {
            const cause = new Error('attachment-native-cleanup-reentrant');
            entry.nativeCleanupReentry ??= { cause };
            entry.nativeFailure ??= { firstCause: cause, latestCause: cause };
            entry.nativeFailure.latestCause = cause;
            throw cause;
        }
        entry.nativeFinishing = true;
        entry.nativeCleanupReentry = undefined;
        entry.awaitingMap = false;
        let failed = false;
        let first: unknown;
        const run = (work: () => void): void =>
        {
            try
            {
                work();
            }
            catch (cause)
            {
                if (!failed)
                {
                    first = cause;
                }
                failed = true;
                entry.nativeFailure ??= { firstCause: cause, latestCause: cause };
                entry.nativeFailure.latestCause = cause;
            }
        };
        try
        {
            run(() =>
            {
                const cohort = this.acceptedNativeCapture(entry)?.cohort;
                if (cohort && !cohort.withdrawn && !entry.nativeFinalization?.sdkAccepted)
                {
                    cohort.cleanupPending = true;
                    if (this.owner.cancelAttachmentRevisionCohort(cohort.token ?? cohort.acquisitionLease, reason) !== true)
                    {
                        throw new Error('attachment-native-cohort-cleanup-unconfirmed');
                    }
                    cohort.cleanupPending = false;
                    cohort.withdrawn = true;
                }
            });
            run(() =>
            {
                if (entry.nativeSdkCleanupPending)
                {
                    if (this.owner.cancelAttachmentRevisionTransition(entry.nativeTransition ?? entry.lease, reason) !== true)
                    {
                        throw new Error('attachment-native-sdk-cleanup-unconfirmed');
                    }
                    entry.nativeSdkCleanupPending = false;
                    entry.nativeTransition = undefined;
                }
            });
            run(() =>
            {
                if (entry.lease.envelope.status === 'running')
                {
                    entry.lease.cancel(reason);
                }
            });
            run(() =>
            {
                const finalization = entry.nativeFinalization;
                if (entry.lease.envelope.status === 'completed' && finalization)
                {
                    entry.completedLease = entry.lease;
                    entry.nativeTerminal = Object.freeze({ observation: finalization.observation, task: entry.lease.envelope,
                        taskCompletion: 'completed' as const, sdkAcceptance: finalization.sdkAccepted ? 'accepted' as const : 'historical' as const });
                    if (entry.snapshot.task !== entry.lease.envelope)
                    {
                        entry.snapshot = this.sealLifecycle({ ...entry.snapshot, task: entry.lease.envelope,
                            state: 'transaction-committed', reason: null, ...finalization.proof });
                        this.record(entry.snapshot);
                    }
                }
                else if (entry.lease.envelope.status === 'aborted')
                {
                    entry.snapshot = this.sealLifecycle({ ...entry.snapshot, state, reason, task: entry.lease.envelope });
                    this.record(entry.snapshot);
                }
                else
                {
                    throw new Error('attachment-native-terminal-task-unconfirmed');
                }
            });
            run(() => entry.releaseFile?.());
            run(() => entry.controller.abort(reason));
            run(() =>
            {
                if (entry.nativeCleanupReentry)
                {
                    throw entry.nativeCleanupReentry.cause;
                }
            });
            if (failed)
            {
                throw first;
            }
            entry.nativeLocalCleanupComplete = true;
            run(() => this.readNativeApplicationEnd(entry));
            run(() =>
            {
                if (entry.nativeCleanupReentry)
                {
                    throw entry.nativeCleanupReentry.cause;
                }
            });
            if (failed)
            {
                throw first;
            }
            if (entry.nativeApplicationEndPending)
            {
                return entry.snapshot;
            }
            if (this.pending.get(entry.intent.task.taskRef) === entry)
            {
                this.pending.delete(entry.intent.task.taskRef);
            }
            entry.nativeCleanupPending = false;
            return entry.snapshot;
        }
        finally
        {
            entry.nativeFinishing = false;
        }
    }

    private sealLifecycle(value: Omit<ArticleAttachmentLifecycleSnapshot, 'contentDigest'> | ArticleAttachmentLifecycleSnapshot): ArticleAttachmentLifecycleSnapshot
    {
        const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest')) as Omit<ArticleAttachmentLifecycleSnapshot, 'contentDigest'>;
        const result = { ...body, contentDigest: calculateOpenArticleDocumentDigest(body) };
        const freeze = (item: unknown): void =>
        {
            if (!item || typeof item !== 'object')
            {
                return;
            }
            Object.values(item).forEach(child =>
            {
                if (child && typeof child === 'object')
                {
                    freeze(child);
                }
            });
            Object.freeze(item);
        };
        freeze(result);
        return result;
    }

    private record(snapshot: ArticleAttachmentLifecycleSnapshot): void
    {
        this.lifecycleLog.push(snapshot);
        while (this.lifecycleLog.length > 64)
        {
            this.lifecycleLog.shift();
        }
    }

    private transactionRef(result: MarkdownEditorDispatchResult): string
    {
        return `attachment-transaction:${result.documentIdentity.id}:${result.documentIdentity.epoch}:${result.beforeRevision}:${result.revision}`;
    }

    private assertCurrentResult(result: MarkdownEditorDispatchResult, binding: ArticlePositionMapBinding): void
    {
        if (!result.accepted || !this.owner.isCurrentContext(binding.document)
            || result.documentIdentity.id !== binding.document.documentId || result.documentIdentity.epoch !== binding.document.documentEpoch
            || result.revision !== binding.document.sourceRevision || binding.map.source !== result.value
            || binding.map.documentIdentity.id !== binding.document.documentId || binding.map.documentIdentity.epoch !== binding.document.documentEpoch)
        {
            throw new Error('attachment-transaction-binding-invalid');
        }
        createArticleDocumentContext({ ...binding.document, content: result.value });
    }

    public cancelPending(reason: string): void
    {
        if (!ref(reason))
        {
            throw new Error('attachment-cancel-reason-invalid');
        }
        let failed = false;
        let first: unknown;
        const run = (work: () => void): void =>
        {
            try
            {
                work();
            }
            catch (cause)
            {
                if (!failed)
                {
                    first = cause;
                }
                failed = true;
            }
        };
        for (const entry of [...this.pending.values()])
        {
            run(() =>
            {
                this.finish(entry, 'cancelled', reason);
            });
        }
        for (const lease of [...this.leases])
        {
            run(() =>
            {
                lease.cancel(reason);
                this.leases.delete(lease);
            });
        }
        if (failed)
        {
            throw first;
        }
    }

    public dispose(): void
    {
        this.disposed = true;
        this.cancelPending('attachment-input-disposed');
        this.unsubscribe();
        this.captureSession.clear();
        this.lifecycleLog.length = 0;
    }
}
