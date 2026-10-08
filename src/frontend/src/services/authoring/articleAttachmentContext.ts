import {
    captureMarkdownAttachmentInput,
    createMarkdownAttachmentCaptureSession,
    planMarkdownAttachmentInsert,
    resolveMarkdownClipboardPaste,
    type MarkdownAttachmentCaptureContext,
    type MarkdownAttachmentInputFile,
    type MarkdownAttachmentSourceKind,
    type MarkdownClipboardTransfer,
    type MarkdownEditorTransaction
} from '@/fsusui/articleAttachments';

import {
    validateArticleAnchorContext,
    type ArticleAnchorContext
} from './articleAnchorContext';
import {
    createArticleDocumentContext,
    validateArticleDocumentTaskEnvelope,
    type ArticleDocumentContextAdapter,
    type ArticleDocumentTaskEnvelope,
    type ArticleDocumentTaskLease
} from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

export const articleAttachmentIntentSchema = 'fsusblog.article-attachment-intent.v1' as const;

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
    private readonly provider: string;
    private readonly providerVersion: string;
    private readonly captureSession = createMarkdownAttachmentCaptureSession();
    private sequence = 0;
    private disposed = false;
    private readonly leases = new Set<ArticleDocumentTaskLease>();
    private captureDocumentId: string;

    public constructor(owner: ArticleDocumentContextAdapter, provider: string, providerVersion: string)
    {
        if (![provider, providerVersion].every(value => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(value)))
        {
            throw new Error('article-attachment-provider-identity-invalid');
        }
        this.owner = owner;
        this.provider = provider;
        this.providerVersion = providerVersion;
        this.captureDocumentId = owner.context.documentId;
    }

    public capture(input: {
        origin: MarkdownAttachmentSourceKind;
        anchor: ArticleAnchorContext;
        files?: readonly MarkdownAttachmentInputFile[];
        transfer?: MarkdownClipboardTransfer;
        context?: MarkdownAttachmentCaptureContext;
        eventFingerprint?: string;
        source: string;
    }): {
        status: 'created';
        handles: readonly ArticleAttachmentCreatedHandle[];
        transaction: MarkdownEditorTransaction;
    } | { status: 'rejected' | 'non-attachment'; reason: string; }
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
        if (captured.batch.items.length + this.leases.size > 64)
        {
            return { status: 'rejected', reason: 'created-intent-capacity' };
        }
        const planned = planMarkdownAttachmentInsert(input.source, captured.batch.anchor, captured.batch);
        const handles = captured.batch.items.map(item =>
        {
            const lease = this.owner.beginTask('attachment', `attachment-input:${++this.sequence}`, this.providerVersion);
            this.leases.add(lease);
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
        return {
            status: 'created', handles: Object.freeze(handles),
            transaction: Object.freeze({
                ...planned.transaction, documentIdentity: this.owner.documentIdentity,
                expectedRevision: this.owner.context.sourceRevision
            })
        };
    }

    public dispose(): void
    {
        this.disposed = true;
        for (const lease of this.leases)
        {
            lease.cancel('attachment-input-disposed');
        }
        this.leases.clear();
        this.captureSession.clear();
    }
}
