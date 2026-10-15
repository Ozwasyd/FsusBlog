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
import type { ArticleRenderIdentity, ArticleRenderState } from './articleRenderCache';

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
    private currentRequest: ArticleSourceCompareRequest | null = null;
    private lease: ArticleDocumentTaskLease | null = null;
    private identity: ArticleRenderIdentity | null = null;
    private syncEnabled = false;
    private unsubscribe: (() => void) | null = null;

    public constructor(
        private readonly owner: ArticleDocumentContextAdapter,
        private readonly runtime: ArticleEditorRuntimeBinding
    )
    {
        if (runtime.context.contextDigest !== owner.context.contextDigest)
        {
            throw new Error('article-source-compare-runtime-context-invalid');
        }
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
        if (this.opening !== null || !isArticleSourceCompareAvailable(viewport) || !validIdentity(identity))
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
        });
        this.createRequest(tool.before.anchor.contentDigest);
        return { tool, source };
    }

    public get state(): {
        open: boolean;
        sourceReady: boolean;
        synchronization: boolean;
        request: ArticleSourceCompareRequest | null;
        render: ArticleRenderState | null;
    }
    {
        const currentTask = this.lease?.isCurrent() === true;
        // Revision cancellation expires the request, while the same tool keeps its retained pane and can request a fresh lease.
        const revisionInvalidated = this.lease !== null && this.lease.signal.aborted
            && (this.lease.envelope.abortReason === 'source-revision-changed' || this.lease.envelope.abortReason === 'draft-revision-changed')
            && this.owner.isCurrentContext(this.owner.context);
        const available = currentTask || revisionInvalidated;
        const sourceReady = this.opening !== null && available && (this.sourceTransitionRef === null
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
            request: currentTask ? this.currentRequest : null,
            render: valid ? render : null
        };
    }

    public get signal(): AbortSignal | null
    {
        return this.lease?.signal ?? null;
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
        this.createRequest(current.anchor.contentDigest);
        const lease = this.lease!;
        const request = this.currentRequest!;
        const receipt = await this.runtime.autoRefresh();
        if (!this.owner.isCurrentContext(request.document) || lease.signal.aborted || this.currentRequest !== request)
        {
            return 'stale';
        }
        if (receipt?.status !== 'committed' || receipt.task.context.contextDigest !== request.document.contextDigest
            || digest(receipt.identity) !== digest(request.identity) || receipt.result?.resultRef === null || !receipt.result?.resultDigest)
        {
            return 'invalid';
        }
        // The canonical producer/cache verifies the actual result; continuity supplies tool admission only.
        return this.continuity.inspectToolResult(lease, {
            tool: 'source-compare', taskRef: lease.taskRef, contextDigest: request.document.contextDigest,
            resultRef: receipt.result.resultRef, resultDigest: receipt.result.resultDigest
        });
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
    }

    private createRequest(anchorDigest: string): void
    {
        this.lease?.cancel('compare-superseded');
        this.lease = this.runtime.beginToolTask('source-compare');
        const value = {
            schema: articleSourceCompareRequestSchema,
            document: this.owner.context,
            taskRef: this.lease.taskRef,
            requestId: this.lease.envelope.requestId,
            identity: this.identity!,
            anchorDigest,
            continuityRef: this.opening!.requestRef,
            originalSurface: this.opening!.before.anchor.surface
        };
        this.currentRequest = Object.freeze({ ...value, contentDigest: digest(value) });
    }

    private withdraw(): void
    {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.lease?.cancel('compare-closed');
        this.lease = null;
        this.opening = null;
        this.sourceTransitionRef = null;
        this.currentRequest = null;
        this.identity = null;
        this.syncEnabled = false;
        this.anchors.setSynchronization(false);
    }
}
