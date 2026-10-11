import {
    calculateOpenArticleDocumentDigest
} from './openArticleDocumentRegistry';

export const articleDocumentContextSchema = 'fsusblog.article-document-context.v1' as const;
export const articleDocumentTaskEnvelopeSchema = 'fsusblog.article-document-task-envelope.v1' as const;
export const articleDocumentEpochReceiptSchema = 'fsusblog.article-document-epoch-receipt.v1' as const;

export const articleDocumentTaskKinds = [
    'render',
    'projection',
    'feature',
    'refresh',
    'attachment',
    'search',
    'outline',
    'preview',
    'compare'
] as const;

export type ArticleDocumentTaskKind = typeof articleDocumentTaskKinds[number];

export type ArticleDocumentEpochReason =
  | 'initial'
  | 'article-switch'
  | 'draft-switch'
  | 'entity-switch'
  | 'dispose';

export type ArticleDocumentTaskStatus = 'running' | 'completed' | 'aborted' | 'stale';

export interface ArticleDocumentContext {
    readonly schema: typeof articleDocumentContextSchema;
    readonly articleId: number | null;
    readonly draftId: string;
    readonly documentId: string;
    readonly documentEpoch: number;
    readonly sourceRevision: number;
    readonly draftRevision: string | null;
    readonly editorSessionId: string;
    readonly siteScope: string;
    readonly userScope: string;
    readonly sourceIdentityDigest: string;
    readonly contentDigest: string;
    readonly contextDigest: string;
}

export interface ArticleDocumentContextInput {
    readonly articleId: number | null;
    readonly draftId: string;
    readonly documentId: string;
    readonly documentEpoch: number;
    readonly sourceRevision: number;
    readonly draftRevision: string | null;
    readonly editorSessionId: string;
    readonly siteScope: string;
    readonly userScope: string;
    readonly content?: string;
    readonly contentDigest?: string;
}

export interface ArticleDocumentOpaqueIdentity {
    readonly id: string;
    readonly epoch: number;
}

export interface ArticleDocumentTaskEnvelope {
    readonly schema: typeof articleDocumentTaskEnvelopeSchema;
    readonly taskRef: string;
    readonly kind: ArticleDocumentTaskKind;
    readonly context: ArticleDocumentContext;
    readonly requestId: string;
    readonly producerRef: string;
    readonly producerVersion: string;
    readonly startedRevision: number;
    readonly completedRevision: number | null;
    readonly status: ArticleDocumentTaskStatus;
    readonly abortReason: string | null;
    readonly resultDigest: string | null;
    readonly contentDigest: string;
    readonly envelopeDigest: string;
}

export interface ArticleDocumentEpochReceipt {
    readonly schema: typeof articleDocumentEpochReceiptSchema;
    readonly receiptRef: string;
    readonly receiptSequence: number;
    readonly action: 'initialize' | 'switch' | 'dispose';
    readonly reason: ArticleDocumentEpochReason;
    readonly previousArticleId: number | null;
    readonly previousDraftId: string | null;
    readonly previousDocumentId: string | null;
    readonly previousDocumentEpoch: number | null;
    readonly articleId: number | null;
    readonly draftId: string;
    readonly documentId: string;
    readonly documentEpoch: number;
    readonly canceledTaskRefs: readonly string[];
    readonly contentDigest: string;
    readonly receiptDigest: string;
}

export type ArticleDocumentTaskRejectionReason =
  | 'task-aborted'
  | 'task-stale'
  | 'task-finished'
  | 'completed-revision-stale'
  | 'task-envelope-invalid';

export interface ArticleDocumentTaskAcceptance<T> {
    readonly accepted: boolean;
    readonly value: T | null;
    readonly reason: ArticleDocumentTaskRejectionReason | null;
    readonly envelope: ArticleDocumentTaskEnvelope;
}

export interface ArticleDocumentTaskLease {
    readonly taskRef: string;
    readonly signal: AbortSignal;
    readonly envelope: ArticleDocumentTaskEnvelope;
    isCurrent(): boolean;
    cancel(reason?: string): ArticleDocumentTaskEnvelope;
    complete(completedRevision?: number, value?: unknown): ArticleDocumentTaskEnvelope;
    accept<T>(value: T, completedRevision?: number): ArticleDocumentTaskAcceptance<T>;
}

export interface ArticleDocumentTaskRegistry {
    beginTask(
        kind: ArticleDocumentTaskKind,
        producerRef: string,
        producerVersion?: string
    ): ArticleDocumentTaskLease;
}

export interface ArticleDocumentContextAdapterOptions {
    readonly articleId: number | null;
    readonly draftId: string;
    readonly editorSessionId: string;
    readonly siteScope: string;
    readonly userScope: string;
    readonly content?: string;
    readonly documentEpoch?: number;
    readonly sourceRevision?: number;
    readonly draftRevision?: string | null;
}

export interface ArticleDocumentSwitchInput {
    readonly articleId: number | null;
    readonly draftId: string;
    readonly content?: string;
    readonly sourceRevision?: number;
    readonly draftRevision?: string | null;
    readonly siteScope?: string;
    readonly userScope?: string;
    readonly reason?: Exclude<ArticleDocumentEpochReason, 'initial' | 'dispose'>;
}

export interface ArticleDocumentAuthorityInput {
    readonly articleId: number | null;
    readonly siteScope: string;
    readonly userScope: string;
    readonly content?: string;
}

export interface ArticleDocumentAuthoritySwitchInput {
    readonly articleId: number | null;
    readonly content?: string;
    readonly sourceRevision?: number;
    readonly draftRevision?: string | null;
    readonly reason?: Exclude<ArticleDocumentEpochReason, 'initial' | 'dispose'>;
}

export interface ArticleDocumentContextBinding {
    readonly adapter: ArticleDocumentContextAdapter;
    switchDocument(input: ArticleDocumentAuthoritySwitchInput): ArticleDocumentEpochReceipt | null;
    release(): void;
}

const stableRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const articleDocumentSwitchReasons = ['article-switch', 'draft-switch', 'entity-switch'] as const;

const contextKeys = [
    'schema',
    'articleId',
    'draftId',
    'documentId',
    'documentEpoch',
    'sourceRevision',
    'draftRevision',
    'editorSessionId',
    'siteScope',
    'userScope',
    'sourceIdentityDigest',
    'contentDigest',
    'contextDigest'
] as const;

const taskEnvelopeKeys = [
    'schema',
    'taskRef',
    'kind',
    'context',
    'requestId',
    'producerRef',
    'producerVersion',
    'startedRevision',
    'completedRevision',
    'status',
    'abortReason',
    'resultDigest',
    'contentDigest',
    'envelopeDigest'
] as const;

const receiptKeys = [
    'schema',
    'receiptRef',
    'receiptSequence',
    'action',
    'reason',
    'previousArticleId',
    'previousDraftId',
    'previousDocumentId',
    'previousDocumentEpoch',
    'articleId',
    'draftId',
    'documentId',
    'documentEpoch',
    'canceledTaskRefs',
    'contentDigest',
    'receiptDigest'
] as const;

let opaqueDocumentSequence = 0;
let opaqueDraftSequence = 0;
let opaqueEditorSessionSequence = 0;

const hasExactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
{
    if (!value || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }

    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isStableRef = (value: unknown): value is string =>
    typeof value === 'string' && stableRefPattern.test(value);

const isDigest = (value: unknown): value is string =>
    typeof value === 'string' && digestPattern.test(value);

const isArticleId = (value: unknown): value is number | null =>
    value === null || (Number.isSafeInteger(value) && Number(value) > 0);

const isSourceRevision = (value: unknown): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0;

const isDraftRevision = (value: unknown): value is string | null =>
    value === null || isStableRef(value);

const isArticleDocumentSwitchReason = (
    value: unknown
): value is Exclude<ArticleDocumentEpochReason, 'initial' | 'dispose'> =>
    articleDocumentSwitchReasons.includes(value as typeof articleDocumentSwitchReasons[number]);

const assertAbortReason = (reason: string): void =>
{
    if (!isStableRef(reason))
    {
        throw new Error('article-document-task-abort-reason-invalid');
    }
};

const clone = <T>(value: T): T => structuredClone(value);

const contentDigestFor = (content: string): string =>
    calculateOpenArticleDocumentDigest({
        schema: articleDocumentContextSchema,
        content
    });

const sourceIdentityDigestFor = (value: Pick<
    ArticleDocumentContext,
    'articleId'
    | 'draftId'
    | 'documentId'
    | 'documentEpoch'
    | 'sourceRevision'
    | 'draftRevision'
    | 'editorSessionId'
    | 'siteScope'
    | 'userScope'
>): string => calculateOpenArticleDocumentDigest({
    schema: articleDocumentContextSchema,
    articleId: value.articleId,
    draftId: value.draftId,
    documentId: value.documentId,
    documentEpoch: value.documentEpoch,
    sourceRevision: value.sourceRevision,
    draftRevision: value.draftRevision,
    editorSessionId: value.editorSessionId,
    siteScope: value.siteScope,
    userScope: value.userScope
});

const contextDigestFor = (value: Omit<ArticleDocumentContext, 'contextDigest'>): string =>
    calculateOpenArticleDocumentDigest(value);

const envelopeDigestFor = (value: Omit<ArticleDocumentTaskEnvelope, 'envelopeDigest'>): string =>
    calculateOpenArticleDocumentDigest(value);

const receiptDigestFor = (value: Omit<ArticleDocumentEpochReceipt, 'receiptDigest'>): string =>
    calculateOpenArticleDocumentDigest(value);

const nextOpaqueDocumentId = (): string =>
{
    opaqueDocumentSequence += 1;
    return `document:${opaqueDocumentSequence.toString(36)}`;
};

const nextOpaqueDraftId = (): string =>
{
    opaqueDraftSequence += 1;
    return `draft:${opaqueDraftSequence.toString(36)}`;
};

const nextOpaqueEditorSessionId = (): string =>
{
    opaqueEditorSessionSequence += 1;
    return `editor-session:${opaqueEditorSessionSequence.toString(36)}`;
};

const assertContextInput = (input: ArticleDocumentContextInput): void =>
{
    if (!isArticleId(input.articleId)
        || !isStableRef(input.draftId)
        || !isStableRef(input.documentId)
        || !Number.isSafeInteger(input.documentEpoch)
        || input.documentEpoch < 1
        || !isSourceRevision(input.sourceRevision)
        || !isDraftRevision(input.draftRevision)
        || !isStableRef(input.editorSessionId)
        || !isStableRef(input.siteScope)
        || !isStableRef(input.userScope)
        || (input.content !== undefined && typeof input.content !== 'string')
        || (input.contentDigest !== undefined && !isDigest(input.contentDigest))
        || (input.content !== undefined
            && input.contentDigest !== undefined
            && input.contentDigest !== contentDigestFor(input.content)))
    {
        throw new Error('article-document-context-input-invalid');
    }
};

export function createArticleDocumentContext(input: ArticleDocumentContextInput): ArticleDocumentContext
{
    assertContextInput(input);
    const base = {
        schema: articleDocumentContextSchema,
        articleId: input.articleId,
        draftId: input.draftId,
        documentId: input.documentId,
        documentEpoch: input.documentEpoch,
        sourceRevision: input.sourceRevision,
        draftRevision: input.draftRevision,
        editorSessionId: input.editorSessionId,
        siteScope: input.siteScope,
        userScope: input.userScope,
        sourceIdentityDigest: sourceIdentityDigestFor(input),
        contentDigest: input.contentDigest ?? contentDigestFor(input.content ?? '')
    };
    const context: ArticleDocumentContext = {
        ...base,
        contextDigest: contextDigestFor(base)
    };
    return Object.freeze(context);
}

export function validateArticleDocumentContext(value: unknown): value is ArticleDocumentContext
{
    if (!hasExactKeys(value, contextKeys))
    {
        return false;
    }

    const context = value as unknown as ArticleDocumentContext;
    if (context.schema !== articleDocumentContextSchema
        || !isArticleId(context.articleId)
        || !isStableRef(context.draftId)
        || !isStableRef(context.documentId)
        || !Number.isSafeInteger(context.documentEpoch)
        || context.documentEpoch < 1
        || !isSourceRevision(context.sourceRevision)
        || !isDraftRevision(context.draftRevision)
        || !isStableRef(context.editorSessionId)
        || !isStableRef(context.siteScope)
        || !isStableRef(context.userScope)
        || !isDigest(context.sourceIdentityDigest)
        || !isDigest(context.contentDigest)
        || !isDigest(context.contextDigest))
    {
        return false;
    }

    const { contextDigest: _contextDigest, ...unsignedContext } = context;
    void _contextDigest;
    return context.sourceIdentityDigest === sourceIdentityDigestFor(context)
        && context.contextDigest === contextDigestFor(unsignedContext);
}

export const verifyArticleDocumentContext = validateArticleDocumentContext;

const assertTaskInput = (
    kind: ArticleDocumentTaskKind,
    producerRef: string,
    producerVersion: string
): void =>
{
    if (!articleDocumentTaskKinds.includes(kind)
        || !isStableRef(producerRef)
        || !isStableRef(producerVersion))
    {
        throw new Error('article-document-task-input-invalid');
    }
};

const sealTaskEnvelope = (
    input: Omit<ArticleDocumentTaskEnvelope, 'schema' | 'contentDigest' | 'envelopeDigest'>
): ArticleDocumentTaskEnvelope =>
{
    const base = {
        schema: articleDocumentTaskEnvelopeSchema,
        ...input,
        contentDigest: input.context.contentDigest
    };
    return Object.freeze({
        ...base,
        envelopeDigest: envelopeDigestFor(base)
    });
};

export function validateArticleDocumentTaskEnvelope(value: unknown): value is ArticleDocumentTaskEnvelope
{
    if (!hasExactKeys(value, taskEnvelopeKeys))
    {
        return false;
    }

    const envelope = value as unknown as ArticleDocumentTaskEnvelope;
    if (envelope.schema !== articleDocumentTaskEnvelopeSchema
        || !isStableRef(envelope.taskRef)
        || !articleDocumentTaskKinds.includes(envelope.kind)
        || !validateArticleDocumentContext(envelope.context)
        || !isStableRef(envelope.requestId)
        || !isStableRef(envelope.producerRef)
        || !isStableRef(envelope.producerVersion)
        || !isSourceRevision(envelope.startedRevision)
        || (envelope.completedRevision !== null && !isSourceRevision(envelope.completedRevision))
        || !(['running', 'completed', 'aborted', 'stale'] as const).includes(envelope.status)
        || (envelope.abortReason !== null && !isStableRef(envelope.abortReason))
        || (envelope.resultDigest !== null && !isDigest(envelope.resultDigest))
        || !isDigest(envelope.contentDigest)
        || !isDigest(envelope.envelopeDigest)
        || envelope.contentDigest !== envelope.context.contentDigest)
    {
        return false;
    }

    if (envelope.status === 'running' && envelope.completedRevision !== null)
    {
        return false;
    }
    if (envelope.status !== 'running' && envelope.completedRevision === null)
    {
        return false;
    }

    const { envelopeDigest: _envelopeDigest, ...unsignedEnvelope } = envelope;
    void _envelopeDigest;
    return envelope.envelopeDigest === envelopeDigestFor(unsignedEnvelope);
}

export const verifyArticleDocumentTaskEnvelope = validateArticleDocumentTaskEnvelope;

export function validateArticleDocumentEpochReceipt(value: unknown): value is ArticleDocumentEpochReceipt
{
    if (!hasExactKeys(value, receiptKeys))
    {
        return false;
    }

    const receipt = value as unknown as ArticleDocumentEpochReceipt;
    if (receipt.schema !== articleDocumentEpochReceiptSchema
        || !isStableRef(receipt.receiptRef)
        || !Number.isSafeInteger(receipt.receiptSequence)
        || receipt.receiptSequence < 1
        || !(['initialize', 'switch', 'dispose'] as const).includes(receipt.action)
        || !(['initial', 'article-switch', 'draft-switch', 'entity-switch', 'dispose'] as const).includes(receipt.reason)
        || !isArticleId(receipt.previousArticleId)
        || !isDraftRevision(receipt.previousDraftId)
        || !isDraftRevision(receipt.previousDocumentId)
        || (receipt.previousDocumentEpoch !== null
            && (!Number.isSafeInteger(receipt.previousDocumentEpoch) || receipt.previousDocumentEpoch < 1))
        || !isArticleId(receipt.articleId)
        || !isStableRef(receipt.draftId)
        || !isStableRef(receipt.documentId)
        || !Number.isSafeInteger(receipt.documentEpoch)
        || receipt.documentEpoch < 1
        || !Array.isArray(receipt.canceledTaskRefs)
        || !receipt.canceledTaskRefs.every(isStableRef)
        || new Set(receipt.canceledTaskRefs).size !== receipt.canceledTaskRefs.length
        || !isDigest(receipt.contentDigest)
        || !isDigest(receipt.receiptDigest))
    {
        return false;
    }

    if (receipt.action === 'initialize'
        && (receipt.reason !== 'initial'
            || receipt.previousArticleId !== null
            || receipt.previousDraftId !== null
            || receipt.previousDocumentId !== null
            || receipt.previousDocumentEpoch !== null))
    {
        return false;
    }
    if (receipt.action === 'dispose' && receipt.reason !== 'dispose')
    {
        return false;
    }
    if (receipt.action === 'switch'
        && (receipt.reason === 'initial' || receipt.reason === 'dispose'
            || receipt.previousDocumentId === null
            || receipt.previousDocumentEpoch === null))
    {
        return false;
    }

    const { receiptDigest: _receiptDigest, ...unsignedReceipt } = receipt;
    void _receiptDigest;
    return receipt.receiptDigest === receiptDigestFor(unsignedReceipt);
}

export const verifyArticleDocumentEpochReceipt = validateArticleDocumentEpochReceipt;

class ArticleDocumentTaskLeaseImpl implements ArticleDocumentTaskLease
{
    private currentEnvelope: ArticleDocumentTaskEnvelope;
    private finished = false;
    private readonly owner: ArticleDocumentContextAdapter;
    private readonly controller: AbortController;
    private readonly taskKey: string;

    public constructor(
        owner: ArticleDocumentContextAdapter,
        controller: AbortController,
        taskKey: string,
        envelope: ArticleDocumentTaskEnvelope
    )
    {
        this.owner = owner;
        this.controller = controller;
        this.taskKey = taskKey;
        this.currentEnvelope = envelope;
    }

    public get taskRef(): string
    {
        return this.currentEnvelope.taskRef;
    }

    public get signal(): AbortSignal
    {
        return this.controller.signal;
    }

    public get envelope(): ArticleDocumentTaskEnvelope
    {
        return this.currentEnvelope;
    }

    public isCurrent(): boolean
    {
        return !this.finished && this.owner.isTaskCurrent(this);
    }

    public cancel(reason = 'task-canceled'): ArticleDocumentTaskEnvelope
    {
        assertAbortReason(reason);
        if (!this.finished)
        {
            this.controller.abort(reason);
            this.finished = true;
            this.currentEnvelope = this.owner.finishTask(this, 'aborted', null, null, reason);
        }
        return this.currentEnvelope;
    }

    public complete(completedRevision?: number, value?: unknown): ArticleDocumentTaskEnvelope
    {
        if (this.finished)
        {
            return this.currentEnvelope;
        }
        const accepted = this.isCurrent()
            && (completedRevision === undefined || completedRevision === this.owner.context.sourceRevision);
        this.finished = true;
        this.currentEnvelope = this.owner.finishTask(
            this,
            accepted ? 'completed' : (this.signal.aborted ? 'aborted' : 'stale'),
            accepted ? (completedRevision ?? this.owner.context.sourceRevision) : this.owner.context.sourceRevision,
            accepted ? value : null,
            accepted ? null : (this.signal.aborted ? 'task-aborted' : 'task-stale')
        );
        return this.currentEnvelope;
    }

    public accept<T>(value: T, completedRevision?: number): ArticleDocumentTaskAcceptance<T>
    {
        if (this.finished)
        {
            return {
                accepted: false,
                value: null,
                reason: 'task-finished',
                envelope: this.currentEnvelope
            };
        }
        const accepted = this.isCurrent()
            && (completedRevision === undefined || completedRevision === this.owner.context.sourceRevision);
        this.finished = true;
        this.currentEnvelope = this.owner.finishTask(
            this,
            accepted ? 'completed' : (this.signal.aborted ? 'aborted' : 'stale'),
            accepted ? (completedRevision ?? this.owner.context.sourceRevision) : this.owner.context.sourceRevision,
            accepted ? value : null,
            accepted ? null : (this.signal.aborted ? 'task-aborted' : 'task-stale')
        );
        return {
            accepted,
            value: accepted ? value : null,
            reason: accepted
                ? null
                : this.signal.aborted
                    ? 'task-aborted'
                    : completedRevision !== undefined && completedRevision !== this.owner.context.sourceRevision
                        ? 'completed-revision-stale'
                        : 'task-stale',
            envelope: this.currentEnvelope
        };
    }

    public get registryKey(): string
    {
        return this.taskKey;
    }
}

export class ArticleDocumentContextAdapter implements ArticleDocumentTaskRegistry
{
    private current: ArticleDocumentContext;
    private readonly activeTasks = new Map<string, ArticleDocumentTaskLeaseImpl>();
    private readonly receiptsLog: ArticleDocumentEpochReceipt[] = [];
    private readonly completedTaskEnvelopeLog: ArticleDocumentTaskEnvelope[] = [];
    private taskSequence = 0;
    private taskCancellationDepth = 0;
    private receiptSequence = 0;
    private disposed = false;
    private readonly contextListeners = new Set<(context: ArticleDocumentContext | null) => void>();

    public subscribeContext(listener: (context: ArticleDocumentContext | null) => void): () => void
    {
        if (this.disposed)
        {
            listener(null);
            return () => undefined;
        }
        this.contextListeners.add(listener);
        return () =>
        {
            this.contextListeners.delete(listener);
        };
    }

    private notifyContext(): void
    {
        for (const listener of this.contextListeners)
        {
            listener(this.disposed ? null : this.current);
        }
    }

    public constructor(options: ArticleDocumentContextAdapterOptions)
    {
        const initialContext = createArticleDocumentContext({
            articleId: options.articleId,
            draftId: options.draftId,
            documentId: nextOpaqueDocumentId(),
            documentEpoch: options.documentEpoch ?? 1,
            sourceRevision: options.sourceRevision ?? 0,
            draftRevision: options.draftRevision ?? null,
            editorSessionId: options.editorSessionId,
            siteScope: options.siteScope,
            userScope: options.userScope,
            content: options.content ?? ''
        });
        this.current = initialContext;
        this.receiptsLog.push(this.createReceipt('initialize', 'initial', null, []));
    }

    public get context(): ArticleDocumentContext
    {
        return this.current;
    }

    public get documentIdentity(): ArticleDocumentOpaqueIdentity
    {
        return Object.freeze({
            id: this.current.documentId,
            epoch: this.current.documentEpoch
        });
    }

    public get receipts(): readonly ArticleDocumentEpochReceipt[]
    {
        return this.receiptsLog.map(clone);
    }

    public get completedTaskEnvelopes(): readonly ArticleDocumentTaskEnvelope[]
    {
        return this.completedTaskEnvelopeLog.map(clone);
    }

    public get activeTaskRefs(): readonly string[]
    {
        return [...this.activeTasks.keys()].sort();
    }

    public beginTask(
        kind: ArticleDocumentTaskKind,
        producerRef: string,
        producerVersion = 'v1.0'
    ): ArticleDocumentTaskLease
    {
        if (this.disposed)
        {
            throw new Error('article-document-context-disposed');
        }
        if (this.taskCancellationDepth > 0)
        {
            throw new Error('article-document-task-cancellation-in-progress');
        }
        assertTaskInput(kind, producerRef, producerVersion);
        const taskKey = `${kind}\u0000${producerRef}`;
        const startedContext = this.current;
        this.taskCancellationDepth += 1;
        try
        {
            this.activeTasks.get(taskKey)?.cancel('task-superseded');
        }
        finally
        {
            this.taskCancellationDepth -= 1;
        }
        if (this.disposed || !this.isCurrentContext(startedContext))
        {
            throw new Error('article-document-task-start-context-changed');
        }
        this.taskSequence += 1;
        const taskRef = `task:${this.taskSequence.toString(36)}`;
        const requestId = `request:${this.taskSequence.toString(36)}`;
        const controller = new AbortController();
        const envelope = sealTaskEnvelope({
            taskRef,
            kind,
            context: this.current,
            requestId,
            producerRef,
            producerVersion,
            startedRevision: this.current.sourceRevision,
            completedRevision: null,
            status: 'running',
            abortReason: null,
            resultDigest: null
        });
        const lease = new ArticleDocumentTaskLeaseImpl(this, controller, taskKey, envelope);
        this.activeTasks.set(taskKey, lease);
        return lease;
    }

    public switchDocument(input: ArticleDocumentSwitchInput): ArticleDocumentEpochReceipt | null
    {
        if (this.disposed)
        {
            throw new Error('article-document-context-disposed');
        }
        if (!isArticleId(input.articleId) || !isStableRef(input.draftId))
        {
            throw new Error('article-document-switch-input-invalid');
        }
        if (input.reason !== undefined && !isArticleDocumentSwitchReason(input.reason))
        {
            throw new Error('article-document-switch-reason-invalid');
        }
        const siteScope = input.siteScope ?? this.current.siteScope;
        const userScope = input.userScope ?? this.current.userScope;
        if (!isStableRef(siteScope) || !isStableRef(userScope))
        {
            throw new Error('article-document-switch-scope-invalid');
        }
        if (this.current.articleId === input.articleId
            && this.current.draftId === input.draftId
            && this.current.siteScope === siteScope
            && this.current.userScope === userScope)
        {
            return null;
        }
        const previous = this.current;
        const canceledTaskRefs = this.cancelAll('document-switch');
        const nextEpoch = previous.documentEpoch + 1;
        if (!Number.isSafeInteger(nextEpoch))
        {
            throw new Error('article-document-epoch-exhausted');
        }
        this.current = createArticleDocumentContext({
            articleId: input.articleId,
            draftId: input.draftId,
            documentId: nextOpaqueDocumentId(),
            documentEpoch: nextEpoch,
            sourceRevision: input.sourceRevision ?? 0,
            draftRevision: input.draftRevision ?? null,
            editorSessionId: previous.editorSessionId,
            siteScope,
            userScope,
            content: input.content ?? ''
        });
        const receipt = this.createReceipt('switch', input.reason ?? 'entity-switch', previous, canceledTaskRefs);
        this.receiptsLog.push(receipt);
        this.notifyContext();
        return clone(receipt);
    }

    public updateSource(content: string, sourceRevision?: number): ArticleDocumentContext
    {
        if (this.disposed)
        {
            throw new Error('article-document-context-disposed');
        }
        if (typeof content !== 'string')
        {
            throw new Error('article-document-source-invalid');
        }
        const nextContentDigest = contentDigestFor(content);
        if (nextContentDigest === this.current.contentDigest && sourceRevision === undefined)
        {
            return this.current;
        }
        const nextRevision = sourceRevision ?? this.current.sourceRevision + 1;
        if (!isSourceRevision(nextRevision) || nextRevision <= this.current.sourceRevision)
        {
            throw new Error('article-document-source-revision-must-advance');
        }
        this.cancelAll('source-revision-changed');
        this.current = createArticleDocumentContext({
            articleId: this.current.articleId,
            draftId: this.current.draftId,
            documentId: this.current.documentId,
            documentEpoch: this.current.documentEpoch,
            sourceRevision: nextRevision,
            draftRevision: this.current.draftRevision,
            editorSessionId: this.current.editorSessionId,
            siteScope: this.current.siteScope,
            userScope: this.current.userScope,
            content
        });
        this.notifyContext();
        return this.current;
    }

    public updateDraftRevision(draftRevision: string | null): ArticleDocumentContext
    {
        if (!isDraftRevision(draftRevision))
        {
            throw new Error('article-document-draft-revision-invalid');
        }
        if (draftRevision === this.current.draftRevision)
        {
            return this.current;
        }
        this.cancelAll('draft-revision-changed');
        this.current = createArticleDocumentContext({
            articleId: this.current.articleId,
            draftId: this.current.draftId,
            documentId: this.current.documentId,
            documentEpoch: this.current.documentEpoch,
            sourceRevision: this.current.sourceRevision,
            draftRevision,
            editorSessionId: this.current.editorSessionId,
            siteScope: this.current.siteScope,
            userScope: this.current.userScope,
            contentDigest: this.current.contentDigest
        });
        this.notifyContext();
        return this.current;
    }

    public isCurrentContext(context: ArticleDocumentContext): boolean
    {
        return !this.disposed
            && validateArticleDocumentContext(context)
            && context.contextDigest === this.current.contextDigest;
    }

    public acceptTaskResult<T>(
        lease: ArticleDocumentTaskLease,
        value: T,
        completedRevision?: number
    ): ArticleDocumentTaskAcceptance<T>
    {
        if (!(lease instanceof ArticleDocumentTaskLeaseImpl) || !this.activeTasksHas(lease))
        {
            const envelope = lease.envelope;
            return {
                accepted: false,
                value: null,
                reason: 'task-envelope-invalid',
                envelope
            };
        }
        return lease.accept(value, completedRevision);
    }

    public cancelAll(reason = 'task-canceled'): readonly string[]
    {
        assertAbortReason(reason);
        const refs = [...this.activeTasks.values()].map(task => task.taskRef).sort();
        // Synchronous abort listeners must not register work outside this cancellation snapshot.
        this.taskCancellationDepth += 1;
        try
        {
            for (const task of [...this.activeTasks.values()])
            {
                task.cancel(reason);
            }
        }
        finally
        {
            this.taskCancellationDepth -= 1;
        }
        return refs;
    }

    public dispose(): ArticleDocumentEpochReceipt | null
    {
        if (this.disposed)
        {
            return null;
        }
        const canceledTaskRefs = this.cancelAll('dispose');
        this.disposed = true;
        this.notifyContext();
        this.contextListeners.clear();
        const receipt = this.createReceipt('dispose', 'dispose', this.current, canceledTaskRefs);
        this.receiptsLog.push(receipt);
        return clone(receipt);
    }

    public isTaskCurrent(task: ArticleDocumentTaskLeaseImpl): boolean
    {
        return !this.disposed
            && this.activeTasksHas(task)
            && !task.signal.aborted
            && task.envelope.context.contextDigest === this.current.contextDigest;
    }

    public finishTask(
        task: ArticleDocumentTaskLeaseImpl,
        status: Exclude<ArticleDocumentTaskStatus, 'running'>,
        completedRevision: number | null,
        value: unknown,
        abortReason: string | null
    ): ArticleDocumentTaskEnvelope
    {
        const current = this.activeTasks.get(task.registryKey);
        if (current === task)
        {
            this.activeTasks.delete(task.registryKey);
        }
        const envelope = sealTaskEnvelope({
            taskRef: task.envelope.taskRef,
            kind: task.envelope.kind,
            context: task.envelope.context,
            requestId: task.envelope.requestId,
            producerRef: task.envelope.producerRef,
            producerVersion: task.envelope.producerVersion,
            startedRevision: task.envelope.startedRevision,
            completedRevision: completedRevision ?? task.envelope.context.sourceRevision,
            status,
            abortReason,
            resultDigest: status === 'completed' && value !== null && value !== undefined
                ? calculateOpenArticleDocumentDigest(value)
                : null
        });
        this.completedTaskEnvelopeLog.push(envelope);
        return envelope;
    }

    private activeTasksHas(task: ArticleDocumentTaskLeaseImpl): boolean
    {
        return this.activeTasks.get(task.registryKey) === task;
    }

    private createReceipt(
        action: ArticleDocumentEpochReceipt['action'],
        reason: ArticleDocumentEpochReason,
        previous: ArticleDocumentContext | null,
        canceledTaskRefs: readonly string[]
    ): ArticleDocumentEpochReceipt
    {
        this.receiptSequence += 1;
        const base = {
            schema: articleDocumentEpochReceiptSchema,
            receiptRef: `epoch-receipt:${this.receiptSequence.toString(36)}`,
            receiptSequence: this.receiptSequence,
            action,
            reason,
            previousArticleId: previous?.articleId ?? null,
            previousDraftId: previous?.draftId ?? null,
            previousDocumentId: previous?.documentId ?? null,
            previousDocumentEpoch: previous?.documentEpoch ?? null,
            articleId: this.current.articleId,
            draftId: this.current.draftId,
            documentId: this.current.documentId,
            documentEpoch: this.current.documentEpoch,
            canceledTaskRefs: [...canceledTaskRefs].sort(),
            contentDigest: this.current.contentDigest
        };
        return Object.freeze({
            ...base,
            receiptDigest: receiptDigestFor(base)
        });
    }
}

export function createArticleDocumentContextAdapter(
    options: ArticleDocumentContextAdapterOptions
): ArticleDocumentContextAdapter
{
    return new ArticleDocumentContextAdapter(options);
}

/**
 * Owns the production adapter across Vue component lifecycles. Component
 * mounts acquire a binding; releasing the last binding cancels its work but
 * deliberately retains the document identity and epoch for a later remount.
 */
export class ArticleDocumentContextAuthority
{
    private adapter: ArticleDocumentContextAdapter | null = null;
    private readonly bindings = new Set<number>();
    private bindingSequence = 0;

    public acquire(input: ArticleDocumentAuthorityInput): ArticleDocumentContextBinding
    {
        this.assertAuthorityInput(input);
        if (!this.adapter)
        {
            this.adapter = createArticleDocumentContextAdapter({
                articleId: input.articleId,
                draftId: this.draftIdFor(input.articleId),
                editorSessionId: nextOpaqueEditorSessionId(),
                siteScope: input.siteScope,
                userScope: input.userScope,
                content: input.content
            });
        }
        else if (this.adapter.context.articleId !== input.articleId
            || this.adapter.context.siteScope !== input.siteScope
            || this.adapter.context.userScope !== input.userScope)
        {
            this.switchAdapterDocument(this.adapter, {
                articleId: input.articleId,
                content: input.content,
                reason: 'entity-switch'
            }, input.siteScope, input.userScope);
        }

        this.bindingSequence += 1;
        const bindingId = this.bindingSequence;
        const adapter = this.adapter;
        this.bindings.add(bindingId);
        let released = false;

        return Object.freeze({
            adapter,
            switchDocument: (switchInput: ArticleDocumentAuthoritySwitchInput) =>
            {
                if (released || this.adapter !== adapter)
                {
                    throw new Error('article-document-context-binding-released');
                }
                return this.switchAdapterDocument(
                    adapter,
                    switchInput,
                    adapter.context.siteScope,
                    adapter.context.userScope
                );
            },
            release: () =>
            {
                if (released)
                {
                    return;
                }
                released = true;
                this.bindings.delete(bindingId);
                if (this.bindings.size === 0 && this.adapter === adapter)
                {
                    adapter.cancelAll('component-unmounted');
                }
            }
        });
    }

    public get context(): ArticleDocumentContext | null
    {
        return this.adapter?.context ?? null;
    }

    private switchAdapterDocument(
        adapter: ArticleDocumentContextAdapter,
        input: ArticleDocumentAuthoritySwitchInput,
        siteScope: string,
        userScope: string
    ): ArticleDocumentEpochReceipt | null
    {
        const retainsCurrentDraft = input.articleId === null
            && adapter.context.articleId === null
            && input.reason !== 'draft-switch'
            && adapter.context.siteScope === siteScope
            && adapter.context.userScope === userScope;
        const draftId = retainsCurrentDraft
            ? adapter.context.draftId
            : this.draftIdFor(input.articleId);
        return adapter.switchDocument({
            ...input,
            draftId,
            siteScope,
            userScope
        });
    }

    private draftIdFor(articleId: number | null): string
    {
        return articleId === null ? nextOpaqueDraftId() : `article:${articleId}`;
    }

    private assertAuthorityInput(input: ArticleDocumentAuthorityInput): void
    {
        if (!isArticleId(input.articleId)
            || !isStableRef(input.siteScope)
            || !isStableRef(input.userScope)
            || (input.content !== undefined && typeof input.content !== 'string'))
        {
            throw new Error('article-document-authority-input-invalid');
        }
    }
}

export const articleDocumentContextAuthority = new ArticleDocumentContextAuthority();
