import { initMarkdownRuntime } from '@/fsusui/markdown';

import type { ArticleDocumentContextAdapter } from './articleDocumentContext';
import type { ArticleEditorContinuityAdapter, ArticleEditorContinuityReceipt } from './articleEditorContinuity';
import type { ArticleEditorRuntimeBinding } from './articleEditorRuntimeBinding';
import type { ArticleEditorSurface } from './articleEditorSurface';
import type { ArticleLiveCapabilityEnvironment, ArticleLiveCapabilityRequest, ArticleLiveCapabilitySession, ArticleLiveCapabilityState } from './articleLiveCapability';

type TransitionArguments = Parameters<ArticleEditorContinuityAdapter['transitionSurface']>;
type Initialization = Awaited<ReturnType<typeof initMarkdownRuntime>>;

export interface ArticleEditorSurfaceRuntimeState extends ArticleLiveCapabilityState
{
    readonly desiredSurface: ArticleEditorSurface;
    readonly escaped: boolean;
    readonly pending: ArticleEditorContinuityReceipt | null;
    readonly documentCurrent: boolean;
}

/**
 * Product actions over the sole Writer binding. Preference is read from its existing owner,
 * never stored here. The host presents the returned target only for awaiting-ack admission,
 * then supplies actual focus/viewport acknowledgement to canonical continuity.
 */
export class ArticleEditorSurfaceRuntime
{
    private escaped = false;
    private recoveryRequest: ArticleLiveCapabilityRequest | null = null;
    private pendingRef: string | null = null;
    private disposed = false;
    private readonly unsubscribe: () => void;
    private readonly owner: ArticleDocumentContextAdapter;
    private readonly binding: ArticleEditorRuntimeBinding;
    private readonly capabilities: ArticleLiveCapabilitySession;
    private readonly readPreference: () => unknown;

    public constructor(
        owner: ArticleDocumentContextAdapter,
        binding: ArticleEditorRuntimeBinding,
        capabilities: ArticleLiveCapabilitySession,
        readPreference: () => unknown
    )
    {
        this.owner = owner;
        this.binding = binding;
        this.capabilities = capabilities;
        this.readPreference = readPreference;
        this.assertCurrent();
        let document = owner.context;
        this.unsubscribe = owner.subscribeContext(current =>
        {
            if (current?.documentId !== document.documentId || current.documentEpoch !== document.documentEpoch
                || current.siteScope !== document.siteScope || current.userScope !== document.userScope)
            {
                this.capabilities.cancel();
                this.escaped = false;
                this.recoveryRequest = null;
                this.cancelPending();
                if (current !== null)
                {
                    document = current;
                }
            }
        });
    }

    public get state(): ArticleEditorSurfaceRuntimeState
    {
        const policy = this.capabilities.state(this.readPreference());
        const pending = this.pendingRef === null ? null
            : this.binding.continuity.receipts.slice().reverse().find(receipt => receipt.requestRef === this.pendingRef) ?? null;
        return Object.freeze({
            ...policy,
            desiredSurface: this.escaped ? 'source' as const : policy.effectiveSurface,
            escaped: this.escaped,
            pending,
            documentCurrent: !this.disposed && this.owner.isCurrentContext(this.binding.context)
        });
    }

    public beginCapability(environment: ArticleLiveCapabilityEnvironment): ArticleLiveCapabilityRequest
    {
        this.assertCurrent();
        return this.capabilities.begin(environment);
    }

    /** Typed producer results alone authorize Live; runtime initialization never supplies a capability. */
    public receiveCapability(request: ArticleLiveCapabilityRequest, value: unknown): ReturnType<ArticleLiveCapabilitySession['commit']>
    {
        this.assertCurrent();
        const admission = this.capabilities.commit(request, value);
        if (admission === 'accepted' && request === this.recoveryRequest)
        {
            const capability = this.capabilities.state(this.readPreference()).capability;
            if (capability === 'supported' || capability === 'feature-degraded')
            {
                this.escaped = false;
            }
            this.recoveryRequest = null;
        }
        return admission;
    }

    /** Explicit user Source escape is session-only, including a local feature-degradation escape. */
    public escapeToSource(capture: TransitionArguments[2], restore: TransitionArguments[3]): ArticleEditorContinuityReceipt | null
    {
        this.assertCurrent();
        this.escaped = true;
        return this.applyDecision(capture, restore);
    }

    /**
     * Execute the existing public runtime initialization, retaining Source until a fresh typed
     * capability arrives. The returned native result is diagnostic, never a recovery receipt.
     */
    public async recover(environment: ArticleLiveCapabilityEnvironment): Promise<{
        request: ArticleLiveCapabilityRequest;
        initialization: Initialization;
        admission: 'current' | 'stale';
    }>
    {
        this.assertCurrent();
        const request = this.capabilities.begin(environment);
        this.recoveryRequest = request;
        const initialization = await initMarkdownRuntime();
        const current = !this.disposed && this.recoveryRequest === request && !request.signal.aborted
            && this.owner.isCurrentContext(request.document);
        return { request, initialization, admission: current ? 'current' : 'stale' };
    }

    /** Execute canonical transition/dispatch admission. Same-document tools keep their own restoration bookmark. */
    public applyDecision(capture: TransitionArguments[2], restore: TransitionArguments[3]): ArticleEditorContinuityReceipt | null
    {
        this.assertCurrent();
        const state = this.state;
        if (state.pending && ['planned', 'awaiting-ack', 'paused'].includes(state.pending.status))
        {
            const intent = this.binding.anchors.userIntent;
            const current = this.owner.isCurrentContext(state.pending.before.document)
                && state.pending.anchorCommand?.intent.generation === intent.generation;
            if (state.pending.targetSurface === state.desiredSurface && current
                && (state.pending.status !== 'paused' || intent.state === 'manual'))
            {
                return state.pending;
            }
            this.cancelPending();
        }
        this.pendingRef = null;
        if (capture.surface === state.desiredSurface || capture.tool !== 'none')
        {
            return null;
        }
        const planned = this.binding.continuity.transitionSurface(state.desiredSurface,
            this.binding.positionBinding(), capture, restore);
        this.pendingRef = planned.requestRef;
        return planned.status === 'planned' ? this.binding.continuity.apply(planned.requestRef) : planned;
    }

    /** Withdraw only this domain's plan; no editor, attachment, tool or document lease is released. */
    public cancelPending(): void
    {
        if (this.pendingRef !== null)
        {
            this.binding.continuity.cancelRestoration(this.pendingRef);
            this.pendingRef = null;
        }
    }

    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.unsubscribe();
        this.cancelPending();
        this.capabilities.cancel();
        this.recoveryRequest = null;
    }

    private assertCurrent(): void
    {
        if (this.disposed || !this.owner.isCurrentContext(this.binding.context))
        {
            throw new Error('article-editor-surface-runtime-stale');
        }
        // This existing method also rejects a released Writer binding before any native side effect.
        this.binding.positionBinding();
    }
}
