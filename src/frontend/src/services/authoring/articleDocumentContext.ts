import {
    calculateOpenArticleDocumentDigest,
    inspectRetainedArticleDocumentHandle,
    retainedArticleDocumentHandleBelongsTo,
    revokeRetainedArticleDocumentScope,
    revokeRetainedArticleDocumentScopeSet,
    subscribeRetainedArticleDocumentHandle
} from './openArticleDocumentRegistry';

import type {
    OpenArticleDocumentRegistry,
    RetainedArticleDocumentHandle,
    RetainedArticleDocumentInspection
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
    /** Producer acknowledgement after its real work/cleanup has actually settled. */
    settle(): void;
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

export interface ArticleDocumentRetainedScopeReaders {
    readPrincipalIdentityId(): string | null;
    readSiteScope(): string | null;
}

declare const preparedDocumentBrand: unique symbol;

export interface ArticleDocumentRetainedPreparation {
    readonly [preparedDocumentBrand]: true;
    readonly context: ArticleDocumentContext;
}

export interface ArticleDocumentRetainedInspection {
    readonly registry: RetainedArticleDocumentInspection;
    readonly context: ArticleDocumentContext;
    readonly principalIdentityId: string;
    readonly registryRevisionMatchesDocument: boolean;
    readonly pendingTaskRefs: readonly string[];
    readonly invalidationFailed: boolean;
    readonly consumerInvalidationState: 'not-requested' | 'pending' | 'settled' | 'failed';
    readonly admissionClosed: boolean;
}

export interface ArticleDocumentRetainedConsumer {
    /** Release actual Writer effects/ports; the producer retains this object on failure. */
    invalidateDocument(observation: ArticleDocumentRetainedInspection): void | Promise<void>;
}

export interface ArticleDocumentRetainedBinding {
    readonly handle: RetainedArticleDocumentHandle;
    readonly adapter: ArticleDocumentContextAdapter;
    inspect(): ArticleDocumentRetainedInspection;
    subscribeLifetime(listener: (observation: ArticleDocumentRetainedInspection) => void): () => void;
    attachConsumer<T extends ArticleDocumentRetainedConsumer>(create: (binding: ArticleDocumentRetainedBinding) => T): T;
}

interface ArticleDocumentRetainedOwner {
    readonly registry: OpenArticleDocumentRegistry;
    readonly adapter: ArticleDocumentContextAdapter;
    readonly scope: ArticleDocumentRetainedScopeReaders;
    readonly principalIdentityId: string;
    readonly siteScope: string;
    scopeRetired: boolean;
    handle: RetainedArticleDocumentHandle | null;
    binding: ArticleDocumentRetainedBinding | null;
    consumer: ArticleDocumentRetainedConsumer | null;
    consumerFactory: ((binding: ArticleDocumentRetainedBinding) => ArticleDocumentRetainedConsumer) | null;
    attachingConsumer: boolean;
    invalidationFailed: boolean;
    consumerInvalidationState: ArticleDocumentRetainedInspection['consumerInvalidationState'];
    pendingConsumerInvalidation: Promise<void> | null;
    lastState: RetainedArticleDocumentInspection['state'];
    readonly listeners: Set<(observation: ArticleDocumentRetainedInspection) => void>;
}

interface ArticleDocumentOwnerAdmission {
    readonly handle: RetainedArticleDocumentHandle;
    readonly adapter: ArticleDocumentContextAdapter;
    readonly context: ArticleDocumentContext;
    readonly scopeRetirementSequence: number;
}

interface ArticleDocumentPrimaryHandover {
    readonly handle: RetainedArticleDocumentHandle;
    readonly primary: ArticleDocumentContextBinding;
    readonly previous: ArticleDocumentContext;
    readonly target: ArticleDocumentContext;
    readonly isReleased: () => boolean;
    published: boolean;
}

// Only this module's original authority can enter the adapter's handover operation.
const primaryHandoverPorts = new WeakMap<ArticleDocumentContextAdapter, {
    readonly handover: (previous: ArticleDocumentContext, target: ArticleDocumentContext,
        validate: () => void, bind: () => ArticleDocumentRetainedBinding, publish: () => void) => ArticleDocumentRetainedBinding;
}>();

// A borrowed primary remains writable while prepared, but actual retirement
// closes admission synchronously even when canonical cleanup is still queued.
const preparedPrimaryGuards = new WeakMap<ArticleDocumentContextAdapter, { readonly isAdmitted: () => boolean; }>();

// An adapter guard belongs to its original handle custody, never an article index.
const retainedAdapterGuards = new WeakMap<ArticleDocumentContextAdapter, {
    readonly isAdmitted: () => boolean;
    readonly inspect: () => RetainedArticleDocumentInspection;
}>();

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

const taskFinalizationTokens = new WeakMap<ArticleDocumentTaskLeaseImpl, object>();

class ArticleDocumentTaskLeaseImpl implements ArticleDocumentTaskLease
{
    #currentEnvelope: ArticleDocumentTaskEnvelope;
    #finished = false;
    #finishing = false;
    #cancelReason: string | null = null;
    #owner: ArticleDocumentContextAdapter;
    #controller: AbortController;
    #taskKey: string;

    public constructor(owner: ArticleDocumentContextAdapter, controller: AbortController,
        taskKey: string, envelope: ArticleDocumentTaskEnvelope)
    {
        this.#owner = owner;
        this.#controller = controller;
        this.#taskKey = taskKey;
        this.#currentEnvelope = envelope;
    }

    public get taskRef(): string
    {
        return this.#currentEnvelope.taskRef;
    }

    public get signal(): AbortSignal
    {
        return this.#controller.signal;
    }

    public get envelope(): ArticleDocumentTaskEnvelope
    {
        return this.#currentEnvelope;
    }

    public isCurrent(): boolean
    {
        return !this.#finished && this.#owner.isTaskCurrent(this);
    }

    public cancel(reason = 'task-canceled'): ArticleDocumentTaskEnvelope
    {
        assertAbortReason(reason);
        if (this.#finished)
        {
            return this.#currentEnvelope;
        }
        if (this.#finishing)
        {
            this.#cancelReason ??= reason;
            this.#controller.abort(reason);
            return this.#currentEnvelope;
        }
        this.#finalize('aborted', null, null, reason);
        this.#controller.abort(reason);
        return this.#currentEnvelope;
    }

    public complete(completedRevision?: number, value?: unknown): ArticleDocumentTaskEnvelope
    {
        if (this.#finished || this.#finishing)
        {
            return this.#currentEnvelope;
        }
        return this.#finishResult(value, completedRevision);
    }

    public accept<T>(value: T, completedRevision?: number): ArticleDocumentTaskAcceptance<T>
    {
        if (this.#finished || this.#finishing)
        {
            return { accepted: false, value: null, reason: 'task-finished', envelope: this.#currentEnvelope };
        }
        const envelope = this.#finishResult(value, completedRevision);
        const accepted = envelope.status === 'completed';
        return { accepted, value: accepted ? value : null,
            reason: accepted ? null : envelope.status === 'aborted' ? 'task-aborted'
                : completedRevision !== undefined && completedRevision !== this.#owner.context.sourceRevision
                    ? 'completed-revision-stale' : 'task-stale', envelope };
    }

    #finishResult(value: unknown, completedRevision?: number): ArticleDocumentTaskEnvelope
    {
        return this.#finalize('completed', completedRevision ?? this.#owner.context.sourceRevision, value, null);
    }

    #finalize(status: Exclude<ArticleDocumentTaskStatus, 'running'>, completedRevision: number | null,
        value: unknown, reason: string | null): ArticleDocumentTaskEnvelope
    {
        const token = Object.freeze({});
        this.#finishing = true;
        taskFinalizationTokens.set(this, token);
        try
        {
            const envelope = this.#owner.finishTask(this, status, completedRevision, value, reason, token);
            this.#currentEnvelope = envelope;
            this.#finished = true;
            return envelope;
        }
        finally
        {
            taskFinalizationTokens.delete(this);
            this.#finishing = false;
            // A failing result getter must leave recoverable custody. If a real
            // cancellation arrived during it, publish that terminal after failure.
            if (!this.#finished && this.#cancelReason)
            {
                this.cancel(this.#cancelReason);
            }
        }
    }

    public get registryKey(): string
    {
        return this.#taskKey;
    }

    public settle(): void
    {
        if (!this.#finished)
        {
            throw new Error('article-document-task-not-terminal');
        }
        this.#owner.settleTask(this);
    }
}

export class ArticleDocumentContextAdapter implements ArticleDocumentTaskRegistry
{
    #current: ArticleDocumentContext;
    #activeTasks = new Map<string, ArticleDocumentTaskLeaseImpl>();
    #pendingTasks = new Set<ArticleDocumentTaskLeaseImpl>();
    #receiptsLog: ArticleDocumentEpochReceipt[] = [];
    #completedTaskEnvelopeLog: ArticleDocumentTaskEnvelope[] = [];
    #taskSequence = 0;
    #taskStartsPending = new Set<string>();
    #contextMutationPending = false;
    #taskCancellationDepth = 0;
    #receiptSequence = 0;
    #disposed = false;
    #contextListeners = new Set<(context: ArticleDocumentContext | null) => void>();

    public subscribeContext(listener: (context: ArticleDocumentContext | null) => void): () => void
    {
        if (this.#disposed)
        {
            listener(null);
            return () => undefined;
        }
        this.#contextListeners.add(listener);
        return () =>
        {
            this.#contextListeners.delete(listener);
        };
    }

    #notifyContext(): void
    {
        for (const listener of this.#contextListeners)
        {
            listener(this.#disposed ? null : this.#current);
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
        this.#current = initialContext;
        this.#receiptsLog.push(this.#createReceipt('initialize', 'initial', null, []));
        primaryHandoverPorts.set(this, {
            handover: (previous, target, validate, bind, publish) => this.#handoverPrimary(previous, target, validate, bind, publish)
        });
    }

    #handoverPrimary(previous: ArticleDocumentContext, target: ArticleDocumentContext,
        validate: () => void, bind: () => ArticleDocumentRetainedBinding, publish: () => void): ArticleDocumentRetainedBinding
    {
        if (this.#contextMutationPending || retainedAdapterGuards.has(this))
        {
            throw new Error('article-document-primary-handover-unavailable');
        }
        this.#contextMutationPending = true;
        let published = false;
        try
        {
            this.#assertContextMutation();
            validate();
            if (this.#current !== previous || this.#disposed)
            {
                throw new Error('article-document-primary-handover-context-changed');
            }
            const canceledTaskRefs = this.cancelAll('retained-primary-handover');
            validate();
            if (this.#current !== previous || this.#disposed)
            {
                throw new Error('article-document-primary-handover-context-changed');
            }
            this.#current = target;
            published = true;
            publish();
            this.#receiptsLog.push(this.#createReceipt('switch', 'entity-switch', previous, canceledTaskRefs));
            const binding = bind();
            this.#notifyContext();
            validate();
            return binding;
        }
        catch (error)
        {
            if (published)
            {
                // No rollback can undo real abort callbacks or a published context.
                // Retire this document adapter; underlying work remains pending.
                this.#disposed = true;
                try
                {
                    this.#notifyContext();
                }
                catch
                {
                    // Preserve the original refusal; the authority retains custody.
                }
            }
            throw error;
        }
        finally
        {
            this.#contextMutationPending = false;
        }
    }

    public get context(): ArticleDocumentContext
    {
        return this.#current;
    }

    public get documentIdentity(): ArticleDocumentOpaqueIdentity
    {
        return Object.freeze({
            id: this.#current.documentId,
            epoch: this.#current.documentEpoch
        });
    }

    public get receipts(): readonly ArticleDocumentEpochReceipt[]
    {
        return this.#receiptsLog.map(clone);
    }

    public get completedTaskEnvelopes(): readonly ArticleDocumentTaskEnvelope[]
    {
        return this.#completedTaskEnvelopeLog.map(clone);
    }

    public get activeTaskRefs(): readonly string[]
    {
        return [...this.#activeTasks.keys()].sort();
    }

    public get pendingTaskRefs(): readonly string[]
    {
        return [...this.#pendingTasks].map(task => task.taskRef).sort();
    }

    #assertRetainedAdmission(): void
    {
        if (!this.#isRetainedAdmitted())
        {
            throw new Error('article-document-retained-owner-unavailable');
        }
    }

    #isRetainedAdmitted(): boolean
    {
        if (preparedPrimaryGuards.get(this)?.isAdmitted() === false)
        {
            return false;
        }
        const guard = retainedAdapterGuards.get(this);
        if (!guard)
        {
            return true;
        }
        if (!guard.isAdmitted())
        {
            return false;
        }
        const observation = guard.inspect();
        return guard.isAdmitted() && observation.state === 'live';
    }

    #assertContextMutation(): void
    {
        this.#assertRetainedAdmission();
        if (this.#disposed)
        {
            throw new Error('article-document-context-disposed');
        }
        if (this.#taskCancellationDepth > 0)
        {
            throw new Error('article-document-context-cancellation-in-progress');
        }
    }

    public beginTask(
        kind: ArticleDocumentTaskKind,
        producerRef: string,
        producerVersion = 'v1.0'
    ): ArticleDocumentTaskLease
    {
        if (this.#contextMutationPending)
        {
            throw new Error('article-document-context-mutation-in-progress');
        }
        assertTaskInput(kind, producerRef, producerVersion);
        const taskKey = `${kind}\u0000${producerRef}`;
        const startedContext = this.#current;
        if (this.#taskStartsPending.has(taskKey))
        {
            throw new Error('article-document-task-start-in-progress');
        }
        this.#taskStartsPending.add(taskKey);
        try
        {
            this.#assertRetainedAdmission();
            if (this.#disposed)
            {
                throw new Error('article-document-context-disposed');
            }
            if (this.#taskCancellationDepth > 0)
            {
                throw new Error('article-document-task-cancellation-in-progress');
            }
            this.#taskCancellationDepth += 1;
            try
            {
                this.#activeTasks.get(taskKey)?.cancel('task-superseded');
            }
            finally
            {
                this.#taskCancellationDepth -= 1;
            }
            const contextCurrent = this.isCurrentContext(startedContext);
            if (this.#disposed || !contextCurrent || this.#current !== startedContext || this.#activeTasks.has(taskKey))
            {
                throw new Error('article-document-task-start-context-changed');
            }
            this.#taskSequence += 1;
            const taskRef = `task:${this.#taskSequence.toString(36)}`;
            const requestId = `request:${this.#taskSequence.toString(36)}`;
            const controller = new AbortController();
            const envelope = sealTaskEnvelope({
                taskRef,
                kind,
                context: this.#current,
                requestId,
                producerRef,
                producerVersion,
                startedRevision: this.#current.sourceRevision,
                completedRevision: null,
                status: 'running',
                abortReason: null,
                resultDigest: null
            });
            const lease = new ArticleDocumentTaskLeaseImpl(this, controller, taskKey, envelope);
            this.#activeTasks.set(taskKey, lease);
            this.#pendingTasks.add(lease);
            return Object.freeze(lease);
        }
        finally
        {
            this.#taskStartsPending.delete(taskKey);
        }

    }

    public switchDocument(input: ArticleDocumentSwitchInput): ArticleDocumentEpochReceipt | null
    {
        if (this.#contextMutationPending)
        {
            throw new Error('article-document-context-mutation-in-progress');
        }
        this.#contextMutationPending = true;
        try
        {
            if (retainedAdapterGuards.has(this))
            {
                throw new Error('article-document-retained-switch-requires-registry');
            }
            this.#assertContextMutation();
            if (this.#disposed)
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
            const siteScope = input.siteScope ?? this.#current.siteScope;
            const userScope = input.userScope ?? this.#current.userScope;
            if (!isStableRef(siteScope) || !isStableRef(userScope))
            {
                throw new Error('article-document-switch-scope-invalid');
            }
            if (this.#current.articleId === input.articleId
                && this.#current.draftId === input.draftId
                && this.#current.siteScope === siteScope
                && this.#current.userScope === userScope)
            {
                return null;
            }
            const previous = this.#current;
            const canceledTaskRefs = this.cancelAll('document-switch');
            const nextEpoch = previous.documentEpoch + 1;
            if (!Number.isSafeInteger(nextEpoch))
            {
                throw new Error('article-document-epoch-exhausted');
            }
            this.#current = createArticleDocumentContext({
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
            const receipt = this.#createReceipt('switch', input.reason ?? 'entity-switch', previous, canceledTaskRefs);
            this.#receiptsLog.push(receipt);
            this.#contextMutationPending = false;
            this.#notifyContext();
            return clone(receipt);
        }
        finally
        {
            this.#contextMutationPending = false;
        }

    }

    public updateSource(content: string, sourceRevision?: number): ArticleDocumentContext
    {
        if (this.#contextMutationPending)
        {
            throw new Error('article-document-context-mutation-in-progress');
        }
        this.#contextMutationPending = true;
        try
        {
            this.#assertContextMutation();
            if (this.#disposed)
            {
                throw new Error('article-document-context-disposed');
            }
            if (typeof content !== 'string')
            {
                throw new Error('article-document-source-invalid');
            }
            const nextContentDigest = contentDigestFor(content);
            if (nextContentDigest === this.#current.contentDigest && sourceRevision === undefined)
            {
                return this.#current;
            }
            const nextRevision = sourceRevision ?? this.#current.sourceRevision + 1;
            if (!isSourceRevision(nextRevision) || nextRevision <= this.#current.sourceRevision)
            {
                throw new Error('article-document-source-revision-must-advance');
            }
            this.cancelAll('source-revision-changed');
            this.#assertContextMutation();
            this.#current = createArticleDocumentContext({
                articleId: this.#current.articleId,
                draftId: this.#current.draftId,
                documentId: this.#current.documentId,
                documentEpoch: this.#current.documentEpoch,
                sourceRevision: nextRevision,
                draftRevision: this.#current.draftRevision,
                editorSessionId: this.#current.editorSessionId,
                siteScope: this.#current.siteScope,
                userScope: this.#current.userScope,
                content
            });
            this.#contextMutationPending = false;
            this.#notifyContext();
            return this.#current;
        }
        finally
        {
            this.#contextMutationPending = false;
        }

    }

    public updateDraftRevision(draftRevision: string | null): ArticleDocumentContext
    {
        if (this.#contextMutationPending)
        {
            throw new Error('article-document-context-mutation-in-progress');
        }
        this.#contextMutationPending = true;
        try
        {
            this.#assertContextMutation();
            if (this.#disposed)
            {
                throw new Error('article-document-context-disposed');
            }
            if (!isDraftRevision(draftRevision))
            {
                throw new Error('article-document-draft-revision-invalid');
            }
            if (draftRevision === this.#current.draftRevision)
            {
                return this.#current;
            }
            this.cancelAll('draft-revision-changed');
            this.#assertContextMutation();
            this.#current = createArticleDocumentContext({
                articleId: this.#current.articleId,
                draftId: this.#current.draftId,
                documentId: this.#current.documentId,
                documentEpoch: this.#current.documentEpoch,
                sourceRevision: this.#current.sourceRevision,
                draftRevision,
                editorSessionId: this.#current.editorSessionId,
                siteScope: this.#current.siteScope,
                userScope: this.#current.userScope,
                contentDigest: this.#current.contentDigest
            });
            this.#contextMutationPending = false;
            this.#notifyContext();
            return this.#current;
        }
        finally
        {
            this.#contextMutationPending = false;
        }

    }

    public isCurrentContext(context: ArticleDocumentContext): boolean
    {
        const retained = this.#isRetainedAdmitted();
        return !this.#disposed
            && retained
            && validateArticleDocumentContext(context)
            && context.contextDigest === this.#current.contextDigest;
    }

    public acceptTaskResult<T>(
        lease: ArticleDocumentTaskLease,
        value: T,
        completedRevision?: number
    ): ArticleDocumentTaskAcceptance<T>
    {
        if (!(lease instanceof ArticleDocumentTaskLeaseImpl) || !this.#activeTasksHas(lease))
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
        const refs = [...this.#activeTasks.values()].map(task => task.taskRef).sort();
        // Synchronous abort listeners must not register work outside this cancellation snapshot.
        this.#taskCancellationDepth += 1;
        try
        {
            for (const task of [...this.#activeTasks.values()])
            {
                task.cancel(reason);
            }
        }
        finally
        {
            this.#taskCancellationDepth -= 1;
        }
        return refs;
    }

    public dispose(): ArticleDocumentEpochReceipt | null
    {
        if (retainedAdapterGuards.has(this) && retainedAdapterGuards.get(this)?.inspect().state !== 'revoked')
        {
            throw new Error('article-document-retained-dispose-requires-revocation');
        }
        if (this.#disposed)
        {
            return null;
        }
        const canceledTaskRefs = this.cancelAll('dispose');
        this.#disposed = true;
        this.#notifyContext();
        this.#contextListeners.clear();
        const receipt = this.#createReceipt('dispose', 'dispose', this.#current, canceledTaskRefs);
        this.#receiptsLog.push(receipt);
        return clone(receipt);
    }

    public isTaskCurrent(task: ArticleDocumentTaskLeaseImpl): boolean
    {
        const retained = this.#isRetainedAdmitted();
        return !this.#disposed
            && retained
            && this.#activeTasksHas(task)
            && !task.signal.aborted
            && task.envelope.context.contextDigest === this.#current.contextDigest;
    }

    public finishTask(
        task: ArticleDocumentTaskLeaseImpl,
        status: Exclude<ArticleDocumentTaskStatus, 'running'>,
        completedRevision: number | null,
        value: unknown,
        abortReason: string | null,
        operationToken?: object
    ): ArticleDocumentTaskEnvelope
    {
        if (!operationToken || taskFinalizationTokens.get(task) !== operationToken || !this.#pendingTasks.has(task))
        {
            throw new Error('article-document-task-finalization-invalid');
        }
        const eligible = status === 'completed' && this.isTaskCurrent(task) && completedRevision === this.#current.sourceRevision;
        const resultDigest = eligible && value !== null && value !== undefined
            ? calculateOpenArticleDocumentDigest(value) : null;
        const current = status === 'completed' && this.isTaskCurrent(task);
        const accepted = status === 'completed' && current && completedRevision === this.#current.sourceRevision;
        const finalStatus = status === 'completed' && !accepted ? task.signal.aborted ? 'aborted' : 'stale' : status;
        const cancellationReason = task.signal.aborted && isStableRef(task.signal.reason) ? task.signal.reason : null;
        const envelope = sealTaskEnvelope({
            taskRef: task.envelope.taskRef,
            kind: task.envelope.kind,
            context: task.envelope.context,
            requestId: task.envelope.requestId,
            producerRef: task.envelope.producerRef,
            producerVersion: task.envelope.producerVersion,
            startedRevision: task.envelope.startedRevision,
            completedRevision: finalStatus === 'completed' ? completedRevision ?? task.envelope.context.sourceRevision
                : status === 'completed' ? this.#current.sourceRevision : completedRevision ?? task.envelope.context.sourceRevision,
            status: finalStatus,
            abortReason: accepted ? null : abortReason ?? cancellationReason ?? (task.signal.aborted ? 'task-aborted' : 'task-stale'),
            resultDigest: accepted ? resultDigest : null
        });
        if (this.#activeTasks.get(task.registryKey) === task)
        {
            this.#activeTasks.delete(task.registryKey);
        }
        this.#completedTaskEnvelopeLog.push(envelope);
        return envelope;
    }

    #activeTasksHas(task: ArticleDocumentTaskLeaseImpl): boolean
    {
        return this.#activeTasks.get(task.registryKey) === task;
    }

    public settleTask(task: ArticleDocumentTaskLeaseImpl): void
    {
        if (task.envelope.status === 'running')
        {
            throw new Error('article-document-task-not-terminal');
        }
        this.#pendingTasks.delete(task);
    }

    #createReceipt(
        action: ArticleDocumentEpochReceipt['action'],
        reason: ArticleDocumentEpochReason,
        previous: ArticleDocumentContext | null,
        canceledTaskRefs: readonly string[]
    ): ArticleDocumentEpochReceipt
    {
        this.#receiptSequence += 1;
        const base = {
            schema: articleDocumentEpochReceiptSchema,
            receiptRef: `epoch-receipt:${this.#receiptSequence.toString(36)}`,
            receiptSequence: this.#receiptSequence,
            action,
            reason,
            previousArticleId: previous?.articleId ?? null,
            previousDraftId: previous?.draftId ?? null,
            previousDocumentId: previous?.documentId ?? null,
            previousDocumentEpoch: previous?.documentEpoch ?? null,
            articleId: this.#current.articleId,
            draftId: this.#current.draftId,
            documentId: this.#current.documentId,
            documentEpoch: this.#current.documentEpoch,
            canceledTaskRefs: [...canceledTaskRefs].sort(),
            contentDigest: this.#current.contentDigest
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
    #adapter: ArticleDocumentContextAdapter | null = null;
    #bindings = new Set<number>();
    #bindingSequence = 0;
    #bindingCustody = new WeakMap<ArticleDocumentContextBinding, {
        readonly adapter: ArticleDocumentContextAdapter;
        readonly isReleased: () => boolean;
    }>();
    #preparations = new WeakMap<ArticleDocumentRetainedPreparation, ArticleDocumentRetainedOwner>();
    #primaryHandovers = new WeakMap<ArticleDocumentRetainedPreparation, ArticleDocumentPrimaryHandover>();
    #retainedOwners = new WeakMap<RetainedArticleDocumentHandle, ArticleDocumentRetainedOwner>();
    #ownersByAdapter = new WeakMap<ArticleDocumentContextAdapter, ArticleDocumentRetainedOwner>();
    #scopedOwners = new Set<ArticleDocumentRetainedOwner>();
    #scopeRevocationPending = false;
    #retainedRegistry: OpenArticleDocumentRegistry | null = null;
    #pendingHandleAdmissions = new WeakSet<RetainedArticleDocumentHandle>();
    #pendingAdapterAdmissions = new WeakSet<ArticleDocumentContextAdapter>();
    #preparedOwners = new Set<ArticleDocumentRetainedOwner>();
    #scopeRetirementSequence = 0;
    #scopeRetirementQueue: { siteScope: string; principalIdentityId: string; }[] = [];
    #currentScopeRetirement: { siteScope: string; principalIdentityId: string; } | null = null;

    public acquire(input: ArticleDocumentAuthorityInput): ArticleDocumentContextBinding
    {
        this.#assertAuthorityInput(input);
        if (this.#adapter && preparedPrimaryGuards.get(this.#adapter)?.isAdmitted() === false)
        {
            throw new Error('article-document-retained-owner-unavailable');
        }
        if (this.#adapter && (this.#ownersByAdapter.has(this.#adapter) || this.#pendingAdapterAdmissions.has(this.#adapter)))
        {
            throw new Error('article-document-retained-acquire-requires-handle');
        }
        if (!this.#adapter)
        {
            this.#adapter = createArticleDocumentContextAdapter({
                articleId: input.articleId,
                draftId: this.#draftIdFor(input.articleId),
                editorSessionId: nextOpaqueEditorSessionId(),
                siteScope: input.siteScope,
                userScope: input.userScope,
                content: input.content
            });
        }
        else if (this.#adapter.context.articleId !== input.articleId
            || this.#adapter.context.siteScope !== input.siteScope
            || this.#adapter.context.userScope !== input.userScope)
        {
            this.#switchAdapterDocument(this.#adapter, {
                articleId: input.articleId,
                content: input.content,
                reason: 'entity-switch'
            }, input.siteScope, input.userScope);
        }

        this.#bindingSequence += 1;
        const bindingId = this.#bindingSequence;
        const adapter = this.#adapter;
        this.#bindings.add(bindingId);
        let released = false;

        const binding: ArticleDocumentContextBinding = Object.freeze({
            adapter,
            switchDocument: (switchInput: ArticleDocumentAuthoritySwitchInput) =>
            {
                if (released || this.#adapter !== adapter)
                {
                    throw new Error('article-document-context-binding-released');
                }
                return this.#switchAdapterDocument(
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
                this.#bindings.delete(bindingId);
                if (this.#bindings.size === 0 && this.#adapter === adapter && !this.#ownersByAdapter.has(adapter))
                {
                    adapter.cancelAll('component-unmounted');
                }
            }
        });
        this.#bindingCustody.set(binding, { adapter, isReleased: () => released });
        return binding;
    }

    /** Issue original identities before Registry admission; expose no writable adapter. */
    public prepareRetainedDocument(registry: OpenArticleDocumentRegistry, input: ArticleDocumentAuthorityInput,
        scope: ArticleDocumentRetainedScopeReaders): ArticleDocumentRetainedPreparation
    {
        this.#assertRetainedOwnerAdmission();
        this.#assertAuthorityInput(input);
        const adapter = createArticleDocumentContextAdapter({ ...input,
            draftId: this.#draftIdFor(input.articleId), editorSessionId: nextOpaqueEditorSessionId() });
        const owner = this.#createRetainedOwner(registry, adapter, scope);
        const preparation = Object.freeze({ context: adapter.context }) as ArticleDocumentRetainedPreparation;
        this.#preparations.set(preparation, owner);
        this.#preparedOwners.add(owner);
        return preparation;
    }

    /** Borrow a loaded, unretained primary; canonical identity comes only from the genuine handle. */
    public preparePrimaryRetainedHandover(registry: OpenArticleDocumentRegistry, handle: RetainedArticleDocumentHandle,
        primary: ArticleDocumentContextBinding, scope: ArticleDocumentRetainedScopeReaders): ArticleDocumentRetainedPreparation
    {
        this.#assertRetainedOwnerAdmission();
        const custody = this.#bindingCustody.get(primary);
        if (!custody || custody.isReleased() || primary.adapter !== custody.adapter || this.#bindings.size !== 1
            || [...this.#preparedOwners].some(owner => owner.adapter === custody.adapter))
        {
            throw new Error('article-document-primary-binding-invalid');
        }
        if (!retainedArticleDocumentHandleBelongsTo(handle, registry))
        {
            throw new Error('article-document-retained-association-invalid');
        }
        const admission = this.#reserveRetainedOwner(handle, custody.adapter);
        try
        {
            const observation = inspectRetainedArticleDocumentHandle(handle);
            const entry = observation.entry;
            const previous = admission.context;
            if (observation.state !== 'live' || entry?.identity.articleId !== previous.articleId
                || entry.identity.draftId !== previous.draftId
                || entry.documentContext.sourceRevision !== `source-revision:${previous.sourceRevision}`
                || entry.documentContext.draftRevision !== previous.draftRevision)
            {
                throw new Error('article-document-primary-handover-source-mismatch');
            }
            if (entry.identity.documentId === previous.documentId && entry.documentContext.documentEpoch === previous.documentEpoch)
            {
                throw new Error('article-document-primary-handover-not-required');
            }
            const target = createArticleDocumentContext({ ...previous,
                documentId: entry.identity.documentId, documentEpoch: entry.documentContext.documentEpoch });
            const owner = this.#createRetainedOwner(registry, custody.adapter, scope);
            const handover = { handle, primary, previous, target, isReleased: custody.isReleased, published: false };
            this.#assertPrimaryHandover(owner, handover, admission.scopeRetirementSequence);
            const preparation = Object.freeze({ context: target }) as ArticleDocumentRetainedPreparation;
            this.#preparations.set(preparation, owner);
            this.#primaryHandovers.set(preparation, handover);
            this.#preparedOwners.add(owner);
            preparedPrimaryGuards.set(owner.adapter, { isAdmitted: () => !owner.scopeRetired && !owner.invalidationFailed });
            return preparation;
        }
        finally
        {
            this.#releaseRetainedOwnerAdmission(admission);
        }
    }

    /** Reuse the primary's genuine original binding and native identity exactly once. */
    public adoptPrimaryRetainedDocument(registry: OpenArticleDocumentRegistry, handle: RetainedArticleDocumentHandle,
        primary: ArticleDocumentContextBinding, scope: ArticleDocumentRetainedScopeReaders): ArticleDocumentRetainedBinding
    {
        this.#assertRetainedOwnerAdmission();
        const custody = this.#bindingCustody.get(primary);
        if (!custody || custody.isReleased() || primary.adapter !== custody.adapter)
        {
            throw new Error('article-document-primary-binding-invalid');
        }
        if (!retainedArticleDocumentHandleBelongsTo(handle, registry))
        {
            throw new Error('article-document-retained-association-invalid');
        }
        if (this.#pendingHandleAdmissions.has(handle) || this.#pendingAdapterAdmissions.has(custody.adapter))
        {
            throw new Error('article-document-retained-admission-in-progress');
        }
        if ([...this.#preparedOwners].some(owner => !owner.handle && owner.adapter === custody.adapter))
        {
            throw new Error('article-document-primary-handover-prepared');
        }
        const previous = this.#ownersByAdapter.get(custody.adapter);
        if (previous)
        {
            if (previous.handle !== handle || previous.registry !== registry || !previous.binding)
            {
                throw new Error('article-document-primary-already-retained');
            }
            if (previous.binding.inspect().registry.state === 'revoked' || previous.scopeRetired)
            {
                throw new Error('article-document-retained-owner-revoked');
            }
            return previous.binding;
        }
        const admission = this.#reserveRetainedOwner(handle, custody.adapter);
        try
        {
            return this.#bindRetainedOwner(handle, this.#createRetainedOwner(registry, custody.adapter, scope), admission,
                () => !custody.isReleased() && primary.adapter === custody.adapter);
        }
        finally
        {
            this.#releaseRetainedOwnerAdmission(admission);
        }
    }

    public acquireRetainedDocument(handle: RetainedArticleDocumentHandle,
        preparation?: ArticleDocumentRetainedPreparation): ArticleDocumentRetainedBinding
    {
        this.#assertRetainedOwnerAdmission();
        if (this.#pendingHandleAdmissions.has(handle))
        {
            throw new Error('article-document-retained-admission-in-progress');
        }
        const existing = this.#retainedOwners.get(handle);
        if (existing?.binding)
        {
            if (preparation && this.#preparations.get(preparation) !== existing)
            {
                throw new Error('article-document-retained-preparation-conflict');
            }
            const observation = existing.binding.inspect();
            if (observation.registry.state === 'revoked' || existing.scopeRetired)
            {
                throw new Error('article-document-retained-owner-revoked');
            }
            return existing.binding;
        }
        const owner = preparation ? this.#preparations.get(preparation) : null;
        if (!owner || owner.handle || owner.scopeRetired)
        {
            throw new Error('article-document-retained-preparation-invalid');
        }
        const admission = this.#reserveRetainedOwner(handle, owner.adapter);
        try
        {
            const handover = preparation ? this.#primaryHandovers.get(preparation) : null;
            if (handover)
            {
                const port = primaryHandoverPorts.get(owner.adapter);
                if (!port || handover.handle !== handle || owner.adapter.context !== handover.previous)
                {
                    throw new Error('article-document-primary-handover-invalid');
                }
                const validate = () => this.#assertPrimaryHandover(owner, handover, admission.scopeRetirementSequence);
                try
                {
                    return port.handover(handover.previous, handover.target, validate,
                        () => this.#bindRetainedOwner(handle, owner, { ...admission, context: handover.target },
                            () => !handover.isReleased() && handover.primary.adapter === owner.adapter && this.#bindings.size === 1),
                        () =>
                        {
                            handover.published = true;
                        });
                }
                catch (error)
                {
                    if (handover.published)
                    {
                        owner.invalidationFailed = true;
                    }
                    throw error;
                }
            }
            return this.#bindRetainedOwner(handle, owner, admission);
        }
        finally
        {
            this.#releaseRetainedOwnerAdmission(admission);
        }
    }

    public discardRetainedPreparation(preparation: ArticleDocumentRetainedPreparation): void
    {
        const owner = this.#preparations.get(preparation);
        if (!owner || owner.handle || owner.scopeRetired || this.#pendingAdapterAdmissions.has(owner.adapter))
        {
            throw new Error('article-document-retained-preparation-not-unused');
        }
        const handover = this.#primaryHandovers.get(preparation);
        if (handover?.published)
        {
            throw new Error('article-document-primary-handover-already-published');
        }
        if (!this.#primaryHandovers.has(preparation))
        {
            owner.adapter.dispose();
        }
        else
        {
            preparedPrimaryGuards.delete(owner.adapter);
        }
        this.#preparations.delete(preparation);
        this.#primaryHandovers.delete(preparation);
        this.#preparedOwners.delete(owner);
    }

    #assertPrimaryHandover(owner: ArticleDocumentRetainedOwner, handover: ArticleDocumentPrimaryHandover,
        scopeRetirementSequence: number): void
    {
        const principal = owner.scope.readPrincipalIdentityId();
        const site = owner.scope.readSiteScope();
        const target = handover.target;
        const current = owner.adapter.isCurrentContext(owner.adapter.context);
        const observation = inspectRetainedArticleDocumentHandle(handover.handle);
        const entry = observation.entry;
        if (owner.scopeRetired || owner.invalidationFailed || handover.isReleased() || this.#bindings.size !== 1
            || this.#adapter !== owner.adapter
            || handover.primary.adapter !== owner.adapter || principal !== owner.principalIdentityId
            || site !== target.siteScope || scopeRetirementSequence !== this.#scopeRetirementSequence
            || observation.state !== 'live' || entry?.identity.articleId !== target.articleId
            || entry.identity.draftId !== target.draftId || entry.identity.documentId !== target.documentId
            || entry.documentContext.documentEpoch !== target.documentEpoch
            || entry.documentContext.sourceRevision !== `source-revision:${target.sourceRevision}`
            || entry.documentContext.draftRevision !== target.draftRevision
            || (owner.adapter.context !== handover.previous && owner.adapter.context !== target)
            || !current)
        {
            throw new Error('article-document-primary-handover-admission-changed');
        }
    }

    /** Scope cleanup is final admission revocation; actual consumer/task custody remains. */
    public revokeRetainedScope(siteScope: string, principalIdentityId: string): void
    {
        const target = { siteScope, principalIdentityId };
        // Close the actual target custody before returning even when another scope
        // is notifying. Canonical notifications and cleanup stay in the drain.
        for (const owner of new Set([...this.#scopedOwners, ...this.#preparedOwners]))
        {
            if (owner.siteScope === siteScope && owner.principalIdentityId === principalIdentityId)
            {
                owner.scopeRetired = true;
            }
        }
        const isSame = (entry: typeof target): boolean => entry.siteScope === siteScope && entry.principalIdentityId === principalIdentityId;
        if ((this.#currentScopeRetirement && isSame(this.#currentScopeRetirement)) || this.#scopeRetirementQueue.some(isSame))
        {
            return;
        }
        this.#scopeRetirementSequence += 1;
        this.#scopeRetirementQueue.push(target);
        if (this.#scopeRevocationPending)
        {
            return;
        }
        this.#scopeRevocationPending = true;
        const cleanupFailures: unknown[] = [];
        try
        {
            while (this.#scopeRetirementQueue.length > 0)
            {
                const current = this.#scopeRetirementQueue.shift();
                if (!current)
                {
                    break;
                }
                this.#currentScopeRetirement = current;
                const targets = [...new Set([...this.#scopedOwners, ...this.#preparedOwners])].filter(owner =>
                    owner.siteScope === current.siteScope && owner.principalIdentityId === current.principalIdentityId);
                const handles: RetainedArticleDocumentHandle[] = [];
                for (const owner of targets)
                {
                    owner.scopeRetired = true;
                    if (owner.handle)
                    {
                        handles.push(owner.handle);
                    }
                }
                revokeRetainedArticleDocumentScopeSet(handles);
                for (const owner of targets)
                {
                    if (!owner.handle)
                    {
                        try
                        {
                            owner.adapter.dispose();
                        }
                        catch (error)
                        {
                            owner.invalidationFailed = true;
                            cleanupFailures.push(error);
                        }
                    }
                }
            }
        }
        finally
        {
            this.#scopeRevocationPending = false;
            this.#currentScopeRetirement = null;
        }
        if (cleanupFailures.length > 0)
        {
            throw new AggregateError(cleanupFailures, 'article-document-retained-scope-cleanup-failed');
        }
    }

    #assertRetainedOwnerAdmission(): void
    {
        if (this.#scopeRevocationPending)
        {
            throw new Error('article-document-scope-revocation-in-progress');
        }
    }

    #createRetainedOwner(registry: OpenArticleDocumentRegistry, adapter: ArticleDocumentContextAdapter,
        scope: ArticleDocumentRetainedScopeReaders): ArticleDocumentRetainedOwner
    {
        const scopeRetirementSequence = this.#scopeRetirementSequence;
        const context = adapter.context;
        const principalIdentityId = scope.readPrincipalIdentityId();
        if (!principalIdentityId?.trim() || scope.readSiteScope() !== context.siteScope
            || context.userScope !== `user:${principalIdentityId}`.replace(/[^a-zA-Z0-9._:-]/gu, '-'))
        {
            throw new Error('article-document-retained-scope-invalid');
        }
        if (scopeRetirementSequence !== this.#scopeRetirementSequence)
        {
            throw new Error('article-document-retained-scope-retired-during-admission');
        }
        if (this.#retainedRegistry && this.#retainedRegistry !== registry)
        {
            throw new Error('article-document-retained-registry-owner-mismatch');
        }
        this.#retainedRegistry = registry;
        return { registry, adapter, scope, principalIdentityId, siteScope: context.siteScope, scopeRetired: false, handle: null, binding: null,
            consumer: null, consumerFactory: null, attachingConsumer: false, invalidationFailed: false,
            consumerInvalidationState: 'not-requested', pendingConsumerInvalidation: null,
            lastState: 'live', listeners: new Set() };
    }

    #readRetainedRegistry(owner: ArticleDocumentRetainedOwner): RetainedArticleDocumentInspection
    {
        if (!owner.handle)
        {
            throw new Error('article-document-retained-owner-not-bound');
        }
        if (owner.scope.readPrincipalIdentityId() !== owner.principalIdentityId
            || owner.scope.readSiteScope() !== owner.adapter.context.siteScope)
        {
            revokeRetainedArticleDocumentScope(owner.handle);
        }
        return inspectRetainedArticleDocumentHandle(owner.handle);
    }

    #inspectRetainedOwner(owner: ArticleDocumentRetainedOwner): ArticleDocumentRetainedInspection
    {
        const registry = this.#readRetainedRegistry(owner);
        const context = owner.adapter.context;
        return Object.freeze({ registry, context, principalIdentityId: owner.principalIdentityId,
            registryRevisionMatchesDocument: registry.entry?.documentContext.sourceRevision === `source-revision:${context.sourceRevision}`
                && registry.entry.documentContext.draftRevision === context.draftRevision,
            pendingTaskRefs: owner.adapter.pendingTaskRefs, invalidationFailed: owner.invalidationFailed,
            consumerInvalidationState: owner.consumerInvalidationState,
            admissionClosed: owner.scopeRetired || owner.invalidationFailed || registry.state !== 'live' });
    }

    #assertRetainedConsumerAdmission(owner: ArticleDocumentRetainedOwner): void
    {
        if (owner.scopeRetired || owner.invalidationFailed)
        {
            throw new Error('article-document-retained-consumer-unavailable');
        }
        const observation = this.#readRetainedRegistry(owner);
        if (owner.scopeRetired || owner.invalidationFailed || observation.state !== 'live')
        {
            throw new Error('article-document-retained-consumer-admission-changed');
        }
    }

    #reserveRetainedOwner(handle: RetainedArticleDocumentHandle, adapter: ArticleDocumentContextAdapter): ArticleDocumentOwnerAdmission
    {
        if (this.#pendingHandleAdmissions.has(handle) || this.#pendingAdapterAdmissions.has(adapter)
            || this.#retainedOwners.has(handle) || this.#ownersByAdapter.has(adapter))
        {
            throw new Error('article-document-retained-admission-in-progress');
        }
        this.#pendingHandleAdmissions.add(handle);
        this.#pendingAdapterAdmissions.add(adapter);
        return { handle, adapter, context: adapter.context, scopeRetirementSequence: this.#scopeRetirementSequence };
    }

    #releaseRetainedOwnerAdmission(admission: ArticleDocumentOwnerAdmission): void
    {
        this.#pendingHandleAdmissions.delete(admission.handle);
        this.#pendingAdapterAdmissions.delete(admission.adapter);
    }

    #bindRetainedOwner(handle: RetainedArticleDocumentHandle, owner: ArticleDocumentRetainedOwner,
        admission: ArticleDocumentOwnerAdmission, validatePrimary?: () => boolean): ArticleDocumentRetainedBinding
    {
        if (!retainedArticleDocumentHandleBelongsTo(handle, owner.registry) || this.#retainedOwners.has(handle)
            || this.#ownersByAdapter.has(owner.adapter))
        {
            throw new Error('article-document-retained-association-invalid');
        }
        const initial = inspectRetainedArticleDocumentHandle(handle);
        const context = owner.adapter.context;
        const entry = initial.entry;
        if (owner.scopeRetired || context !== admission.context || initial.state !== 'live' || entry?.identity.articleId !== context.articleId
            || entry.identity.draftId !== context.draftId || entry.identity.documentId !== context.documentId
            || entry.documentContext.documentEpoch !== context.documentEpoch
            || entry.documentContext.sourceRevision !== `source-revision:${context.sourceRevision}`
            || entry.documentContext.draftRevision !== context.draftRevision || !owner.adapter.isCurrentContext(context))
        {
            throw new Error('article-document-retained-context-mismatch');
        }
        // Reread original principal/site sources before installing ownership.
        const principal = owner.scope.readPrincipalIdentityId();
        const site = owner.scope.readSiteScope();
        const current = inspectRetainedArticleDocumentHandle(handle);
        if (principal !== owner.principalIdentityId || site !== context.siteScope || current.state !== 'live'
            || current.registryRevision !== initial.registryRevision || current.entry?.contentDigest !== entry.contentDigest
            || owner.scopeRetired || admission.scopeRetirementSequence !== this.#scopeRetirementSequence
            || owner.adapter.context !== admission.context || !owner.adapter.isCurrentContext(context)
            || (validatePrimary && !validatePrimary()) || this.#retainedOwners.has(handle) || this.#ownersByAdapter.has(owner.adapter))
        {
            throw new Error('article-document-retained-admission-changed');
        }
        owner.handle = handle;
        const binding: ArticleDocumentRetainedBinding = Object.freeze({ handle, adapter: owner.adapter,
            inspect: () => this.#inspectRetainedOwner(owner),
            subscribeLifetime: (listener: (observation: ArticleDocumentRetainedInspection) => void) =>
            {
                owner.listeners.add(listener);
                return () =>
                {
                    owner.listeners.delete(listener);
                };
            },
            attachConsumer: <T extends ArticleDocumentRetainedConsumer>(create: (retained: ArticleDocumentRetainedBinding) => T): T =>
            {
                if (owner.attachingConsumer)
                {
                    throw new Error('article-document-retained-consumer-unavailable');
                }
                // Reserve before the first external reader, including cached reads.
                owner.attachingConsumer = true;
                try
                {
                    if (owner.consumerFactory && !owner.consumer)
                    {
                        throw new Error('article-document-retained-consumer-attachment-unsettled');
                    }
                    this.#assertRetainedConsumerAdmission(owner);
                    if (owner.consumer)
                    {
                        if (owner.consumerFactory !== create)
                        {
                            throw new Error('article-document-retained-consumer-already-attached');
                        }
                        return owner.consumer as T;
                    }
                    owner.consumerFactory = create;
                    try
                    {
                        const consumer = create(binding);
                        if ([...this.#scopedOwners].some(other => other !== owner && other.consumer === consumer))
                        {
                            throw new Error('article-document-retained-consumer-owned-elsewhere');
                        }
                        owner.consumer = consumer;
                        this.#assertRetainedConsumerAdmission(owner);
                        if (!owner.consumer || typeof owner.consumer.invalidateDocument !== 'function')
                        {
                            throw new Error('article-document-retained-consumer-invalid');
                        }
                        // The method property may be a getter. Both it and the
                        // subsequent original scope readers can retire admission.
                        this.#assertRetainedConsumerAdmission(owner);
                        return owner.consumer as T;
                    }
                    catch (error)
                    {
                        owner.invalidationFailed = true;
                        // Keep the returned consumer and exact factory. If real
                        // canonical revocation already finished before the factory
                        // returned, complete its missed notification now. Queued
                        // retirement leaves cleanup to the original drain.
                        try
                        {
                            if (inspectRetainedArticleDocumentHandle(handle).state === 'revoked')
                            {
                                this.#invalidateRetainedConsumer(owner);
                            }
                        }
                        catch
                        {
                            owner.invalidationFailed = true;
                        }
                        throw error;
                    }
                }
                finally
                {
                    owner.attachingConsumer = false;
                }
            }
        });
        owner.binding = binding;
        this.#retainedOwners.set(handle, owner);
        this.#ownersByAdapter.set(owner.adapter, owner);
        this.#scopedOwners.add(owner);
        retainedAdapterGuards.set(owner.adapter, {
            isAdmitted: () => !owner.scopeRetired && !owner.invalidationFailed,
            inspect: () => this.#readRetainedRegistry(owner)
        });
        const stopSubscription = subscribeRetainedArticleDocumentHandle(handle, () => this.#notifyRetainedOwner(owner));
        // Subscription is installed before the final external readers. A revoke in
        // this window is observed and its real pending resources remain retained.
        try
        {
            if (this.#readRetainedRegistry(owner).state !== 'live' || owner.scopeRetired || owner.invalidationFailed
                || owner.adapter.context !== admission.context
                || (validatePrimary && !validatePrimary()))
            {
                this.#notifyRetainedOwner(owner);
                throw new Error('article-document-retained-admission-changed');
            }
        }
        catch (error)
        {
            // No binding/consumer escaped the still-held reservation. Roll back
            // unpublished live admission; actual revocation keeps recovery custody.
            if (inspectRetainedArticleDocumentHandle(handle).state !== 'revoked')
            {
                stopSubscription();
                this.#retainedOwners.delete(handle);
                this.#ownersByAdapter.delete(owner.adapter);
                this.#scopedOwners.delete(owner);
                retainedAdapterGuards.delete(owner.adapter);
                owner.handle = null;
                owner.binding = null;
                if (this.#bindings.size === 0 && this.#adapter === owner.adapter)
                {
                    owner.adapter.cancelAll('component-unmounted');
                }
            }
            throw error;
        }
        return binding;
    }

    #notifyRetainedOwner(owner: ArticleDocumentRetainedOwner): void
    {
        const observation = this.#inspectRetainedOwner(owner);
        const state = observation.registry.state;
        const changedState = state !== owner.lastState;
        owner.lastState = state;
        if (state !== 'live')
        {
            owner.adapter.cancelAll(state === 'revoked' ? 'retained-owner-revoked' : 'retained-owner-blocked');
            if (state === 'revoked')
            {
                try
                {
                    owner.adapter.dispose();
                }
                catch
                {
                    owner.invalidationFailed = true;
                }
            }
            if (state === 'revoked' && changedState && owner.consumer)
            {
                this.#invalidateRetainedConsumer(owner);
            }
        }
        for (const listener of [...owner.listeners])
        {
            try
            {
                listener(this.#inspectRetainedOwner(owner));
            }
            catch
            {
                owner.invalidationFailed = true;
            }
        }
    }

    #invalidateRetainedConsumer(owner: ArticleDocumentRetainedOwner): void
    {
        if (!owner.consumer || owner.consumerInvalidationState !== 'not-requested')
        {
            return;
        }
        owner.consumerInvalidationState = 'pending';
        try
        {
            const pending = owner.consumer.invalidateDocument(this.#inspectRetainedOwner(owner));
            if (!pending)
            {
                owner.consumerInvalidationState = 'settled';
                return;
            }
            // Preserve the ACTUAL returned cleanup promise; do not invent a task,
            // recovery token, timeout completion or zero-resource receipt.
            owner.pendingConsumerInvalidation = pending;
            void pending.then(() =>
            {
                owner.consumerInvalidationState = 'settled';
                owner.pendingConsumerInvalidation = null;
            }, () =>
            {
                owner.consumerInvalidationState = 'failed';
                owner.invalidationFailed = true;
            });
        }
        catch
        {
            owner.consumerInvalidationState = 'failed';
            owner.invalidationFailed = true;
        }
    }

    public get context(): ArticleDocumentContext | null
    {
        return this.#adapter?.context ?? null;
    }

    #switchAdapterDocument(
        adapter: ArticleDocumentContextAdapter,
        input: ArticleDocumentAuthoritySwitchInput,
        siteScope: string,
        userScope: string
    ): ArticleDocumentEpochReceipt | null
    {
        if (this.#pendingAdapterAdmissions.has(adapter))
        {
            throw new Error('article-document-retained-admission-in-progress');
        }
        const retainsCurrentDraft = input.articleId === null
            && adapter.context.articleId === null
            && input.reason !== 'draft-switch'
            && adapter.context.siteScope === siteScope
            && adapter.context.userScope === userScope;
        const draftId = retainsCurrentDraft
            ? adapter.context.draftId
            : this.#draftIdFor(input.articleId);
        return adapter.switchDocument({
            ...input,
            draftId,
            siteScope,
            userScope
        });
    }

    #draftIdFor(articleId: number | null): string
    {
        return articleId === null ? nextOpaqueDraftId() : `article:${articleId}`;
    }

    #assertAuthorityInput(input: ArticleDocumentAuthorityInput): void
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
