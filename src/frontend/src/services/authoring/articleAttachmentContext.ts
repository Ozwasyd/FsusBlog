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
    type MarkdownAttachmentInputFile,
    type MarkdownAttachmentJob,
    type MarkdownAttachmentProviderResult,
    type MarkdownAttachmentSourceKind,
    type MarkdownClipboardTransfer,
    type MarkdownEditorTransaction
} from '@/fsusui/articleAttachments';
import type { MarkdownEditorDispatchResult } from '@/fsusui/articlePositionMaps';

import {
    validateArticleAnchorContext,
    type ArticleAnchorContext,
    type ArticlePositionMapBinding,
    type ArticleAnchorContextAdapter
} from './articleAnchorContext';
import {
    createArticleDocumentContext,
    validateArticleDocumentTaskEnvelope,
    type ArticleDocumentContext,
    type ArticleDocumentContextAdapter,
    type ArticleDocumentTaskEnvelope,
    type ArticleDocumentTaskLease
} from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';


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

export type ArticleAttachmentCapture = {
    readonly status: 'created';
    readonly handles: readonly ArticleAttachmentCreatedHandle[];
    readonly transaction: MarkdownEditorTransaction;
} | { readonly status: 'rejected' | 'non-attachment'; readonly reason: string; };

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
    private readonly captured = new WeakMap<object, CapturedInput>();
    private readonly pending = new Map<string, PendingInput>();
    private readonly pendingHandles = new WeakMap<object, PendingInput>();
    private readonly ownedOperations = new Set<string>();
    private readonly lifecycleLog: ArticleAttachmentLifecycleSnapshot[] = [];
    private readonly unsubscribe: () => void;

    public constructor(owner: ArticleDocumentContextAdapter, provider: string, providerVersion: string,
        anchors?: ArticleAnchorContextAdapter)
    {
        this.anchors = anchors;
        if (![provider, providerVersion].every(value => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(value)))
        {
            throw new Error('article-attachment-provider-identity-invalid');
        }
        this.owner = owner;
        this.provider = provider;
        this.providerVersion = providerVersion;
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
        if (this.disposed || !this.anchors || !record || record.leases.some(lease => !lease.isCurrent()))
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
            const controller = new AbortController();
            const lease = this.owner.beginTask('attachment', `attachment-provider:${++this.sequence}`, this.providerVersion);
            const job = createMarkdownAttachmentJob(handle.intent.itemId, { batchId: record.batch.batchId,
                itemId: handle.intent.itemId, documentIdentity: this.owner.documentIdentity,
                revision: this.owner.context.sourceRevision, range: plannedJob.range, signalController: controller });
            const entry: PendingInput = { intent: handle.intent, controller, lease, job, awaitingMap: false,
                request: Object.freeze({ batchId: record.batch.batchId, itemId: handle.intent.itemId, requestId: lease.envelope.requestId,
                    documentIdentity: this.owner.documentIdentity, revision: this.owner.context.sourceRevision }),
                snapshot: this.sealLifecycle({ schema: articleAttachmentLifecycleSchema, intent: handle.intent,
                    anchor, task: lease.envelope, predecessorTaskRef: handle.intent.task.taskRef,
                    state: 'anchored', attempt: 1, reason: null, transactionRef: this.transactionRef(result), providerResultDigest: null }) };
            this.pending.set(handle.intent.task.taskRef, entry);
            this.record(entry.snapshot);
            entry.snapshot = this.sealLifecycle({ ...entry.snapshot, state: 'provider-pending' });
            this.record(entry.snapshot);
            return this.pendingHandle(entry);
        });
        this.observeTransaction(result, binding);
        return Object.freeze(handles);
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
            if (this.ownedOperations.has(entry.intent.task.taskRef))
            {
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
        entry.controller.abort('attachment-completion-committed');
        this.record(entry.snapshot);
        this.observeTransaction(dispatched, binding);
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
        if (this.disposed || !previous || !['failed', 'cancelled'].includes(previous.snapshot.state)
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
        return handle;
    }

    private findPending(handle: ArticleAttachmentPendingHandle): PendingInput
    {
        const entry = this.pendingHandles.get(handle);
        if (!entry || this.pending.get(entry.intent.task.taskRef) !== entry || entry.controller.signal.aborted)
        {
            throw new Error('attachment-pending-handle-invalid');
        }
        return entry;
    }

    private finish(entry: PendingInput, state: 'cancelled' | 'stale' | 'removed' | 'failed', reason: string): ArticleAttachmentLifecycleSnapshot
    {
        entry.controller.abort(reason);
        entry.lease.cancel(reason);
        entry.awaitingMap = false;
        entry.snapshot = this.sealLifecycle({ ...entry.snapshot, state, reason, task: entry.lease.envelope });
        if (this.pending.get(entry.intent.task.taskRef) === entry)
        {
            this.pending.delete(entry.intent.task.taskRef);
        }
        this.record(entry.snapshot);
        return entry.snapshot;
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
        for (const entry of this.pending.values())
        {
            this.finish(entry, 'cancelled', reason);
        }
        for (const lease of this.leases)
        {
            lease.cancel(reason);
        }
        this.leases.clear();
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
