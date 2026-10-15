import { validateArticleAnchorContext } from './articleAnchorContext';
import { validateArticleDocumentContext } from './articleDocumentContext';
import { isArticleEditorSurface } from './articleEditorSurface';
import { validateArticleRenderCacheEntry } from './articleRenderCache';
import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

import type { ArticleAnchorContextAdapter } from './articleAnchorContext';
import type { ArticleDocumentContext, ArticleDocumentContextAdapter, ArticleDocumentTaskLease } from './articleDocumentContext';
import type { ArticleEditorContinuityAdapter, ArticleEditorContinuityReceipt } from './articleEditorContinuity';
import type { ArticleEditorRuntimeBinding } from './articleEditorRuntimeBinding';
import type { ArticleEditorSurface } from './articleEditorSurface';
import type { ArticleRenderIdentity, ArticleRenderReceipt, ArticleRenderRefreshWork, ArticleRenderState } from './articleRenderCache';

export const articleSourceCompareRequestSchema = 'fsusblog.article-source-compare-request.v1' as const;

/** CSS viewport dimensions already account for browser zoom; never divide them by a zoom factor again. */
export interface ArticleSourceCompareViewport
{
    readonly inlineSize: number;
    readonly mobile: boolean;
}

export interface ArticleSourceCompareRequest
{
    readonly schema: typeof articleSourceCompareRequestSchema;
    readonly document: ArticleDocumentContext;
    readonly taskRef: string;
    readonly requestId: string;
    readonly identity: ArticleRenderIdentity;
    readonly anchorDigest: string;
    readonly continuityRef: string;
    readonly originalSurface: ArticleEditorSurface;
    readonly contentDigest: string;
}

type LifecycleArguments = Parameters<ArticleEditorContinuityAdapter['toolLifecycle']>;
type SynchronizeArguments = Parameters<ArticleAnchorContextAdapter['synchronize']>;

interface CompareOperation
{
    readonly document: ArticleDocumentContext;
    readonly opening: ArticleEditorContinuityReceipt;
    readonly identity: ArticleRenderIdentity;
    invocation: ReturnType<ArticleEditorRuntimeBinding['autoRefresh']> | null;
    candidates: readonly ArticleRenderRefreshWork[];
    work: ArticleRenderRefreshWork | null;
    workReceipt: Promise<ArticleRenderReceipt> | null;
    terminal: Promise<void> | null;
    lease: ArticleDocumentTaskLease | null;
    request: ArticleSourceCompareRequest | null;
    associated: boolean;
    revoked: boolean;
    localEnded: boolean;
    terminalState: 'missing' | 'pending' | 'fulfilled' | 'rejected';
    settleAttempted: boolean;
    failures: readonly unknown[];
}

/** Read-only custody inspection; all futures and work objects belong to the original invocation. */
export type ArticleSourceCompareOperation = Readonly<Omit<CompareOperation, 'lease'>> & { readonly taskRef: string | null; };

const requestKeys = ['schema', 'document', 'taskRef', 'requestId', 'identity', 'anchorDigest', 'continuityRef', 'originalSurface', 'contentDigest'];
const identityKeys = ['rendererVersion', 'projectionVersion', 'featureConfigurationDigest', 'themeDigest', 'locale'];
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const ref = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{2,127}$/u.test(value);

function validIdentity(value: unknown): value is ArticleRenderIdentity
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const item = value as Record<string, unknown>;
    return Object.keys(item).length === identityKeys.length && identityKeys.every(key => Object.hasOwn(item, key))
        && typeof item.rendererVersion === 'string' && item.rendererVersion.length > 0
        && typeof item.projectionVersion === 'string' && item.projectionVersion.length > 0 && hash(item.featureConfigurationDigest)
        && hash(item.themeDigest) && typeof item.locale === 'string' && item.locale.length > 0;
}

export function isArticleSourceCompareAvailable(viewport: ArticleSourceCompareViewport): boolean
{
    return typeof viewport.mobile === 'boolean' && !viewport.mobile && Number.isFinite(viewport.inlineSize) && viewport.inlineSize >= 1024;
}

export function validateArticleSourceCompareRequest(value: unknown): value is ArticleSourceCompareRequest
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        return false;
    }
    const item = value as Record<string, unknown>;
    if (Object.keys(item).length !== requestKeys.length || !requestKeys.every(key => Object.hasOwn(item, key))
        || item.schema !== articleSourceCompareRequestSchema || !validateArticleDocumentContext(item.document)
        || !ref(item.taskRef) || !ref(item.requestId) || !validIdentity(item.identity)
        || !hash(item.anchorDigest) || !ref(item.continuityRef) || !isArticleEditorSurface(item.originalSurface))
    {
        return false;
    }
    const { contentDigest, ...unsigned } = item;
    return hash(contentDigest) && contentDigest === digest(unsigned);
}

/**
 * Temporary product lifecycle over the existing document, continuity, cache and semantic scroll owners.
 * The host moves the sole mounted editor to Source and acknowledges real focus/viewport observations.
 * Closing returns the owner's restoration plan; this module never declares that plan restored.
 */
export class ArticleSourceCompareSession
{
    private opening: ArticleEditorContinuityReceipt | null = null;
    private sourceTransitionRef: string | null = null;
    private activeOperation: CompareOperation | null = null;
    private readonly operations = new Set<CompareOperation>();
    private readonly abortListeners = new WeakMap<CompareOperation, () => void>();
    private identity: ArticleRenderIdentity | null = null;
    private syncEnabled = false;
    private unsubscribe: (() => void) | null = null;
    private readonly owner: ArticleDocumentContextAdapter;
    private readonly runtime: ArticleEditorRuntimeBinding;

    public constructor(
        owner: ArticleDocumentContextAdapter,
        runtime: ArticleEditorRuntimeBinding
    )
    {
        if (runtime.context.contextDigest !== owner.context.contextDigest)
        {
            throw new Error('article-source-compare-runtime-context-invalid');
        }
        this.owner = owner;
        this.runtime = runtime;
    }

    private get continuity(): ArticleEditorContinuityAdapter
    {
        return this.runtime.continuity;
    }

    private get anchors(): ArticleAnchorContextAdapter
    {
        return this.runtime.anchors;
    }

    public open(
        viewport: ArticleSourceCompareViewport,
        identity: ArticleRenderIdentity,
        binding: LifecycleArguments[1],
        capture: LifecycleArguments[2],
        restore: LifecycleArguments[3]
    ): { tool: ArticleEditorContinuityReceipt; source: ArticleEditorContinuityReceipt | null; }
    {
        if (this.opening !== null || this.hold || !isArticleSourceCompareAvailable(viewport) || !validIdentity(identity))
        {
            throw new Error('article-source-compare-open-invalid');
        }
        const tool = this.continuity.toolLifecycle('source-compare-open', binding, capture, restore);
        this.opening = tool;
        this.identity = Object.freeze({ ...identity });
        this.anchors.setSynchronization(false);
        const source = capture.surface === 'live'
            ? this.continuity.transitionSurface('source', binding, { ...capture, tool: 'source-compare' }, restore)
            : null;
        this.sourceTransitionRef = source?.requestRef ?? null;
        const document = this.owner.context;
        this.unsubscribe = this.owner.subscribeContext(current =>
        {
            if (current?.documentId !== document.documentId || current.documentEpoch !== document.documentEpoch
                || current.articleId !== document.articleId || current.draftId !== document.draftId
                || current.editorSessionId !== document.editorSessionId
                || current.siteScope !== document.siteScope || current.userScope !== document.userScope)
            {
                this.withdraw();
            }
            else
            {
                for (const operation of this.operations)
                {
                    if (operation.document.contextDigest !== current.contextDigest)
                    {
                        this.revokeOperation(operation, 'compare-context-changed');
                    }
                }
            }
        });
        return { tool, source };
    }

    public get state(): {
        open: boolean;
        sourceReady: boolean;
        synchronization: boolean;
        hold: boolean;
        request: ArticleSourceCompareRequest | null;
        render: ArticleRenderState | null;
    }
    {
        const operation = this.activeOperation;
        const currentTask = operation !== null && !operation.revoked && operation.lease?.isCurrent() === true;
        // Session readiness and the retained pane do not require a running refresh admission lease.
        const available = this.opening !== null && this.owner.isCurrentContext(this.owner.context);
        const sourceReady = available && !this.hold && (this.sourceTransitionRef === null
            || this.continuity.receipts.some(receipt => receipt.requestRef === this.sourceTransitionRef && receipt.status === 'restored'));
        const render = this.opening === null || !available ? null : this.runtime.renderState;
        const valid = render?.content === null || render === null || validateArticleRenderCacheEntry(render.content)
            && render.currentRevision === this.owner.context.sourceRevision
            && render.content.context.documentId === this.owner.context.documentId
            && render.content.context.documentEpoch === this.owner.context.documentEpoch
            && render.content.context.articleId === this.owner.context.articleId && render.content.context.draftId === this.owner.context.draftId
            && render.content.context.editorSessionId === this.owner.context.editorSessionId
            && render.content.context.siteScope === this.owner.context.siteScope && render.content.context.userScope === this.owner.context.userScope
            && digest(render.content.identity) === digest(this.identity);
        return {
            open: this.opening !== null,
            sourceReady,
            synchronization: this.syncEnabled,
            hold: this.hold,
            request: currentTask ? operation.request : null,
            render: valid ? render : null
        };
    }

    public get signal(): AbortSignal | null
    {
        return this.activeOperation?.lease?.signal ?? null;
    }

    public get pendingOperations(): readonly ArticleSourceCompareOperation[]
    {
        return Object.freeze([...this.operations].map(operation =>
        {
            const { lease, ...observation } = operation;
            return Object.freeze({ ...observation, taskRef: lease?.taskRef ?? null,
                candidates: Object.freeze([...operation.candidates]), failures: Object.freeze([...operation.failures]) });
        }));
    }

    private get hold(): boolean
    {
        return [...this.operations].some(operation => operation.failures.length > 0);
    }

    /** The sole producer's retained payload; the host must not start another renderer for this tool. */
    public get retainedRender(): ArticleEditorRuntimeBinding['retainedRender']
    {
        return this.state.render?.content ? this.runtime.retainedRender : null;
    }

    public adaptViewport(viewport: ArticleSourceCompareViewport, binding: LifecycleArguments[1], capture: LifecycleArguments[2], restore: LifecycleArguments[3]): ArticleEditorContinuityReceipt | null
    {
        return this.opening !== null && !isArticleSourceCompareAvailable(viewport) ? this.close(binding, capture, restore) : null;
    }

    public async refresh(binding: LifecycleArguments[1], capture: LifecycleArguments[2]): Promise<'eligible' | 'stale' | 'invalid'>
    {
        if (!this.state.sourceReady || capture.surface !== 'source' || capture.tool !== 'source-compare')
        {
            return 'invalid';
        }
        const current = this.continuity.capture(binding, capture);
        if (!validateArticleAnchorContext(current.anchor))
        {
            return 'invalid';
        }
        const opening = this.opening;
        const identity = this.identity;
        this.revokeActive('compare-superseded');
        if (opening === null || identity === null || this.opening !== opening || this.activeOperation !== null
            || !this.owner.isCurrentContext(current.document))
        {
            return 'stale';
        }
        if (this.hold)
        {
            return 'invalid';
        }
        const operation: CompareOperation = {
            document: current.document, opening, identity,
            invocation: null, candidates: [], work: null, workReceipt: null, terminal: null, lease: null, request: null,
            associated: false, revoked: false, localEnded: false, terminalState: 'missing', settleAttempted: false, failures: []
        };
        this.operations.add(operation);
        this.activeOperation = operation;
        try
        {
            const previous = new Set(this.runtime.pendingRefreshWork);
            operation.invocation = this.runtime.autoRefresh();
            // Canonical autoRefresh registers its work synchronously. Preserve the whole difference before the first await.
            operation.candidates = this.runtime.pendingRefreshWork.filter(work => !previous.has(work));
            if (operation.candidates.length !== 1)
            {
                throw new Error('article-source-compare-work-unconfirmed');
            }
            const work = operation.candidates[0];
            operation.work = work;
            operation.workReceipt = work.receipt;
            operation.terminal = work.terminal;
            if (!Object.isFrozen(work) || !(operation.workReceipt instanceof Promise) || !(operation.terminal instanceof Promise))
            {
                throw new Error('article-source-compare-terminal-unconfirmed');
            }
            operation.terminalState = 'pending';
            // Observe the original terminal; never replace it with a receipt/cancellation or an inferred completion.
            void operation.terminal.then(() =>
            {
                operation.terminalState = 'fulfilled';
                this.trySettle(operation);
            }, (cause: unknown) =>
            {
                operation.terminalState = 'rejected';
                this.recordFailure(operation, cause);
            });
            if (!operation.revoked && this.activeOperation === operation && this.opening === operation.opening
                && this.owner.isCurrentContext(operation.document))
            {
                this.createRequest(operation, current.anchor.contentDigest);
            }
            else
            {
                this.recordFailure(operation, new Error('article-source-compare-admission-unavailable'));
            }
        }
        catch (cause)
        {
            this.recordFailure(operation, cause);
        }
        let result: 'eligible' | 'stale' | 'invalid' = 'invalid';
        try
        {
            // Even a failed lookup must observe and retain the original invocation.
            const receipt = operation.invocation === null ? null : await operation.invocation;
            const work = operation.work;
            if (work !== null && operation.workReceipt !== null && receipt !== null && work.taskRef === receipt.task.taskRef
                && await operation.workReceipt === receipt && work.receipt === operation.workReceipt && work.terminal === operation.terminal)
            {
                operation.associated = true;
            }
            else
            {
                this.recordFailure(operation, new Error('article-source-compare-receipt-unconfirmed'));
            }
            const lease = operation.lease;
            const request = operation.request;
            if (operation.associated && operation.failures.length === 0)
            {
                if (operation.revoked || lease === null || request === null || lease.signal.aborted
                    || !this.owner.isCurrentContext(operation.document) || this.activeOperation !== operation
                    || this.opening !== operation.opening)
                {
                    result = 'stale';
                }
                else if (receipt?.status === 'committed' && receipt.task.context.contextDigest === request.document.contextDigest
                    && digest(receipt.identity) === digest(request.identity) && receipt.result?.resultRef && receipt.result.resultDigest)
                {
                    // Actual result verification remains with the producer/cache; continuity supplies tool admission only.
                    result = this.continuity.inspectToolResult(lease, {
                        tool: 'source-compare', taskRef: lease.taskRef, contextDigest: request.document.contextDigest,
                        resultRef: receipt.result.resultRef, resultDigest: receipt.result.resultDigest
                    });
                }
            }
        }
        catch (cause)
        {
            this.recordFailure(operation, cause);
            operation.localEnded = true;
            throw cause;
        }
        operation.localEnded = true;
        this.trySettle(operation);
        return result;
    }

    public setSynchronization(enabled: boolean): void
    {
        if (this.opening === null || typeof enabled !== 'boolean')
        {
            throw new Error('article-source-compare-sync-invalid');
        }
        this.anchors.setSynchronization(enabled);
        this.syncEnabled = enabled;
    }

    public synchronize(...args: SynchronizeArguments): ReturnType<ArticleAnchorContextAdapter['synchronize']>
    {
        const state = this.state;
        if (!state.sourceReady || !state.synchronization || !state.render?.content || state.render.stale
            || args[1].tool !== 'source-compare' || !this.owner.isCurrentContext(args[0].document))
        {
            return null;
        }
        return this.anchors.synchronize(...args);
    }

    public close(binding: LifecycleArguments[1], capture: LifecycleArguments[2], restore: LifecycleArguments[3]): ArticleEditorContinuityReceipt
    {
        if (this.opening === null)
        {
            throw new Error('article-source-compare-not-open');
        }
        if (this.sourceTransitionRef !== null)
        {
            this.continuity.cancelRestoration(this.sourceTransitionRef);
        }
        const receipt = this.continuity.toolLifecycle('source-compare-close', binding, capture, restore);
        this.withdraw();
        return receipt;
    }

    public dispose(): void
    {
        if (this.opening !== null)
        {
            throw new Error('article-source-compare-close-required');
        }
        this.withdraw();
        if (this.operations.size > 0)
        {
            throw new Error('article-source-compare-work-pending');
        }
    }

    private createRequest(operation: CompareOperation, anchorDigest: string): void
    {
        const lease = this.runtime.beginToolTask('source-compare');
        operation.lease = lease;
        const onAbort = (): void =>
        {
            operation.revoked = true;
            this.trySettle(operation);
        };
        this.abortListeners.set(operation, onAbort);
        lease.signal.addEventListener('abort', onAbort, { once: true });
        if (lease.signal.aborted)
        {
            onAbort();
        }
        if (operation.revoked || this.activeOperation !== operation || this.opening !== operation.opening
            || !lease.isCurrent() || lease.envelope.context.contextDigest !== operation.document.contextDigest)
        {
            this.revokeOperation(operation, 'compare-request-stale');
            return;
        }
        const value = {
            schema: articleSourceCompareRequestSchema,
            document: operation.document,
            taskRef: lease.taskRef,
            requestId: lease.envelope.requestId,
            identity: operation.identity,
            anchorDigest,
            continuityRef: operation.opening.requestRef,
            originalSurface: operation.opening.before.anchor.surface
        };
        operation.request = Object.freeze({ ...value, contentDigest: digest(value) });
    }

    private recordFailure(operation: CompareOperation, cause: unknown): void
    {
        operation.failures = [...operation.failures, cause];
        operation.revoked = true;
        try
        {
            operation.lease?.cancel('compare-operation-failed');
        }
        catch (failure)
        {
            operation.failures = [...operation.failures, failure];
        }
    }

    private revokeActive(reason: string): void
    {
        const operation = this.activeOperation;
        this.activeOperation = null;
        if (operation !== null)
        {
            this.revokeOperation(operation, reason);
        }
    }

    private revokeOperation(operation: CompareOperation, reason: string): void
    {
        operation.revoked = true;
        try
        {
            operation.lease?.cancel(reason);
        }
        catch (cause)
        {
            this.recordFailure(operation, cause);
        }
        this.trySettle(operation);
    }

    private trySettle(operation: CompareOperation): void
    {
        if (!operation.localEnded || !operation.revoked || !operation.associated || operation.terminalState !== 'fulfilled'
            || operation.failures.length > 0 || operation.settleAttempted || operation.lease === null || operation.work === null)
        {
            return;
        }
        try
        {
            const lease = operation.lease;
            if (!lease.signal.aborted || lease.envelope.status === 'running')
            {
                return;
            }
            if (operation.work.terminal !== operation.terminal || operation.work.receipt !== operation.workReceipt)
            {
                throw new Error('article-source-compare-work-binding-changed');
            }
            operation.settleAttempted = true;
            lease.settle();
            const onAbort = this.abortListeners.get(operation);
            if (onAbort)
            {
                lease.signal.removeEventListener('abort', onAbort);
            }
            this.abortListeners.delete(operation);
            this.operations.delete(operation);
            if (this.activeOperation === operation)
            {
                this.activeOperation = null;
            }
        }
        catch (cause)
        {
            this.recordFailure(operation, cause);
        }
    }

    private withdraw(): void
    {
        const unsubscribe = this.unsubscribe;
        const operations = [...this.operations];
        // Close session admission before abort callbacks can reenter; the original operation records stay retained.
        this.unsubscribe = null;
        this.activeOperation = null;
        this.opening = null;
        this.sourceTransitionRef = null;
        this.identity = null;
        this.syncEnabled = false;
        this.anchors.setSynchronization(false);
        for (const operation of operations)
        {
            this.revokeOperation(operation, 'compare-closed');
        }
        unsubscribe?.();
    }
}
