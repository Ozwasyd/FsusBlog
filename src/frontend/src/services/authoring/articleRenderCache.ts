import {
    type ArticleDocumentContext,
    type ArticleDocumentContextAdapter,
    type ArticleDocumentTaskEnvelope,
    type ArticleDocumentTaskLease,
    validateArticleDocumentContext,
    validateArticleDocumentTaskEnvelope
} from './articleDocumentContext';
import { admitArticleRenderRefreshDecision, type ArticleRenderRefreshDecision } from './articleRenderRefreshPolicy';
import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

export const articleRenderCacheSchema = 'fsusblog.article-render-cache.v1' as const;
export const articleRenderReceiptSchema = 'fsusblog.article-render-receipt.v1' as const;
export const articleRenderStateSchema = 'fsusblog.article-render-state.v1' as const;

export interface ArticleRenderIdentity {
    readonly rendererVersion: string;
    readonly projectionVersion: string;
    readonly featureConfigurationDigest: string;
    readonly themeDigest: string;
    readonly locale: string;
}

export interface ArticleRenderRequest {
    readonly context: ArticleDocumentContext;
    readonly requestId: string;
    readonly identity: ArticleRenderIdentity;
    readonly signal: AbortSignal;
}

/** Read-only consumer slice of the original producer's actual per-request work. */
export interface ArticleRenderProducerRequestWork {
    readonly request: ArticleRenderRequest;
    readonly terminal: Promise<void>;
    readonly resultRef: string | null;
}

// References are owned and verified by the FsusUI consumer, never draft content.
export interface ArticleRenderResult {
    readonly contextDigest: string;
    readonly requestId: string;
    readonly identity: ArticleRenderIdentity;
    readonly status: 'valid' | 'partial' | 'fatal' | 'projection-failed';
    readonly resultRef: string | null;
    readonly resultDigest: string | null;
    readonly reason: string | null;
    readonly fallbackRefs: readonly string[];
    readonly longTaskRefs: readonly string[];
    readonly layoutObservationRefs: readonly string[];
}

export interface ArticleRenderProducer {
    render(request: ArticleRenderRequest): Promise<ArticleRenderResult>;
    // Must check the actual public result/projection and its retained reference.
    verify(request: ArticleRenderRequest, result: ArticleRenderResult): boolean;
    release(resultRef: string): void;
    /** Missing capability is held, never replaced with an inferred terminal. */
    getRequestWork?(request: ArticleRenderRequest): ArticleRenderProducerRequestWork | null;
}

export interface ArticleRenderCacheEntry {
    readonly schema: typeof articleRenderCacheSchema;
    readonly context: ArticleDocumentContext;
    readonly identity: ArticleRenderIdentity;
    readonly result: ArticleRenderResult;
    readonly createdAt: number;
    readonly cacheDigest: string;
}

export interface ArticleRenderReceipt {
    readonly schema: typeof articleRenderReceiptSchema;
    readonly task: ArticleDocumentTaskEnvelope;
    readonly identity: ArticleRenderIdentity;
    readonly result: ArticleRenderResult | null;
    readonly status: 'committed' | 'failed' | 'canceled' | 'rejected';
    readonly reason: string | null;
    readonly startedAt: number;
    readonly completedAt: number;
    readonly receiptDigest: string;
}

export interface ArticleRenderState {
    readonly schema: typeof articleRenderStateSchema;
    readonly content: ArticleRenderCacheEntry | null;
    readonly fallback: 'source' | 'loading' | null;
    readonly currentRevision: number;
    readonly cachedRevision: number | null;
    readonly stale: boolean;
    readonly reason: string | null;
    readonly refreshState: 'idle' | 'running' | 'failed' | 'canceled';
    readonly lastValidTime: number | null;
    readonly failure: string | null;
    readonly actionIds: readonly ('render-refresh' | 'render-cancel' | 'render-retry')[];
}

/** Original refresh work, distinct from the public cancellation/admission response. */
export interface ArticleRenderRefreshWork {
    readonly taskRef: string;
    readonly receipt: Promise<ArticleRenderReceipt>;
    /** Resolves only after actual render and required cleanup, then original lease.settle(). */
    readonly terminal: Promise<void>;
    /** Producer future observation only; fulfilled does not attest cleanup. */
    readonly productionState: 'pending' | 'fulfilled' | 'rejected';
    readonly resultRef: string | null;
    readonly cleanupFailure: Error | null;
    readonly producerFailure: Error | null;
    readonly producerWork: ArticleRenderProducerRequestWork | null;
}

export interface ArticleRenderCachePolicy {
    readonly maxEntryBytes: number;
    readonly maxAgeMs: number;
    readonly maxReceipts: number;
}

const identityKeys = ['rendererVersion', 'projectionVersion', 'featureConfigurationDigest', 'themeDigest', 'locale'];
const resultKeys = ['contextDigest', 'requestId', 'identity', 'status', 'resultRef', 'resultDigest', 'reason', 'fallbackRefs', 'longTaskRefs', 'layoutObservationRefs'];
const cacheKeys = ['schema', 'context', 'identity', 'result', 'createdAt', 'cacheDigest'];
const receiptKeys = ['schema', 'task', 'identity', 'result', 'status', 'reason', 'startedAt', 'completedAt', 'receiptDigest'];
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const isRef = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/u.test(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const exactKeys = (value: unknown, keys: readonly string[]): boolean => value !== null
    && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const refsValid = (value: unknown): boolean => Array.isArray(value) && value.length <= 64
    && value.every(isRef) && new Set(value).size === value.length;
const identityValid = (value: ArticleRenderIdentity): boolean => exactKeys(value, identityKeys)
    && isRef(value.rendererVersion) && isRef(value.projectionVersion)
    && isDigest(value.featureConfigurationDigest) && isDigest(value.themeDigest) && isRef(value.locale);
const identitiesEqual = (left: ArticleRenderIdentity, right: ArticleRenderIdentity): boolean => digest(left) === digest(right);
const sameDocument = (left: ArticleDocumentContext, right: ArticleDocumentContext): boolean =>
    left.articleId === right.articleId && left.draftId === right.draftId
    && left.documentId === right.documentId && left.documentEpoch === right.documentEpoch
    && left.editorSessionId === right.editorSessionId && left.siteScope === right.siteScope
    && left.userScope === right.userScope && left.draftRevision === right.draftRevision;

const seal = <T extends object>(value: T): T =>
{
    for (const child of Object.values(value))
    {
        if (child && typeof child === 'object')
        {
            seal(child);
        }
    }
    return Object.freeze(value);
};

export function validateArticleRenderResult(value: unknown): value is ArticleRenderResult
{
    if (!exactKeys(value, resultKeys))
    {
        return false;
    }
    const result = value as ArticleRenderResult;
    if (!isDigest(result.contextDigest) || !isRef(result.requestId) || !identityValid(result.identity)
        || !['valid', 'partial', 'fatal', 'projection-failed'].includes(result.status)
        || (result.reason !== null && !isRef(result.reason))
        || !refsValid(result.fallbackRefs) || !refsValid(result.longTaskRefs) || !refsValid(result.layoutObservationRefs))
    {
        return false;
    }
    const usable = result.status === 'valid' || result.status === 'partial';
    return usable
        ? isRef(result.resultRef) && isDigest(result.resultDigest)
            && (result.status === 'valid' ? result.reason === null && result.fallbackRefs.length === 0
                : result.reason !== null && result.fallbackRefs.length > 0)
        : result.resultRef === null && result.resultDigest === null && result.reason !== null;
}

export function validateArticleRenderCacheEntry(value: unknown): value is ArticleRenderCacheEntry
{
    if (!exactKeys(value, cacheKeys))
    {
        return false;
    }
    const entry = value as ArticleRenderCacheEntry;
    if (entry.schema !== articleRenderCacheSchema || !validateArticleDocumentContext(entry.context)
        || !identityValid(entry.identity) || !validateArticleRenderResult(entry.result)
        || !['valid', 'partial'].includes(entry.result.status)
        || entry.result.contextDigest !== entry.context.contextDigest
        || !identitiesEqual(entry.identity, entry.result.identity) || !isTime(entry.createdAt))
    {
        return false;
    }
    const { cacheDigest, ...unsigned } = entry;
    return isDigest(cacheDigest) && cacheDigest === digest(unsigned);
}

export function validateArticleRenderReceipt(value: unknown): value is ArticleRenderReceipt
{
    if (!exactKeys(value, receiptKeys))
    {
        return false;
    }
    const receipt = value as ArticleRenderReceipt;
    if (receipt.schema !== articleRenderReceiptSchema || !validateArticleDocumentTaskEnvelope(receipt.task)
        || !identityValid(receipt.identity) || !isTime(receipt.startedAt)
        || !isTime(receipt.completedAt) || receipt.completedAt < receipt.startedAt
        || !['committed', 'failed', 'canceled', 'rejected'].includes(receipt.status)
        || (receipt.reason !== null && !isRef(receipt.reason)))
    {
        return false;
    }
    if (receipt.result !== null && (!validateArticleRenderResult(receipt.result)
        || receipt.result.contextDigest !== receipt.task.context.contextDigest
        || receipt.result.requestId !== receipt.task.requestId
        || !identitiesEqual(receipt.identity, receipt.result.identity)))
    {
        return false;
    }
    if (receipt.status === 'committed' && (receipt.task.status !== 'completed' || receipt.result === null
        || !['valid', 'partial'].includes(receipt.result.status) || receipt.reason !== null
        || receipt.task.resultDigest !== digest(receipt.result)))
    {
        return false;
    }
    if (receipt.status !== 'committed' && receipt.reason === null)
    {
        return false;
    }
    if (receipt.task.kind !== 'refresh' || receipt.task.startedRevision !== receipt.task.context.sourceRevision
        || (receipt.status === 'committed' && receipt.task.completedRevision !== receipt.task.startedRevision)
        || (receipt.status === 'canceled' && (receipt.task.status !== 'aborted' || receipt.result !== null))
        || (receipt.status === 'rejected' && !['aborted', 'stale'].includes(receipt.task.status)))
    {
        return false;
    }
    const { receiptDigest, ...unsigned } = receipt;
    return isDigest(receiptDigest) && receiptDigest === digest(unsigned);
}

export function validateArticleRenderState(value: unknown): value is ArticleRenderState
{
    if (!exactKeys(value, ['schema', 'content', 'fallback', 'currentRevision', 'cachedRevision', 'stale', 'reason',
        'refreshState', 'lastValidTime', 'failure', 'actionIds']))
    {
        return false;
    }
    const state = value as ArticleRenderState;
    if (state.schema !== articleRenderStateSchema || !Number.isSafeInteger(state.currentRevision)
        || state.currentRevision < 0 || typeof state.stale !== 'boolean'
        || !['idle', 'running', 'failed', 'canceled'].includes(state.refreshState)
        || (state.failure !== null && !isRef(state.failure)) || (state.reason !== null && !isRef(state.reason))
        || !Array.isArray(state.actionIds) || new Set(state.actionIds).size !== state.actionIds.length
        || !state.actionIds.every((action: unknown) => typeof action === 'string'
            && ['render-refresh', 'render-cancel', 'render-retry'].includes(action)))
    {
        return false;
    }
    if (state.content === null)
    {
        return !state.stale && state.cachedRevision === null && state.lastValidTime === null
            && state.fallback === (state.refreshState === 'running' ? 'loading' : 'source');
    }
    return validateArticleRenderCacheEntry(state.content) && state.fallback === null
        && state.cachedRevision === state.content.context.sourceRevision
        && state.lastValidTime === state.content.createdAt && state.cachedRevision <= state.currentRevision
        && state.stale === (state.cachedRevision < state.currentRevision);
}

// One bounded entry per owning context/session; no global lookup or persistence.
export class ArticleRenderCache
{
    private entry: ArticleRenderCacheEntry | null = null;
    private entryRequest: ArticleRenderRequest | null = null;
    private identity: ArticleRenderIdentity;
    private active: ArticleDocumentTaskLease | null = null;
    private refreshState: ArticleRenderState['refreshState'] = 'idle';
    private failure: string | null = null;
    private policyReason: string | null = null;
    private readonly receiptLog: ArticleRenderReceipt[] = [];
    private readonly unsubscribe: () => void;
    private disposed = false;
    private entryReleasePending = false;
    private entryReleaseFailure: Error | null = null;
    // Original futures/failed cleanup custody only; no second body or resource ledger.
    private readonly refreshWork = new Set<ArticleRenderRefreshWork>();
    private readonly adapter: ArticleDocumentContextAdapter;
    private readonly producer: ArticleRenderProducer;
    private readonly policy: ArticleRenderCachePolicy;
    private readonly clock: () => number;

    public constructor(
        adapter: ArticleDocumentContextAdapter,
        identity: ArticleRenderIdentity,
        producer: ArticleRenderProducer,
        policy: ArticleRenderCachePolicy,
        clock: () => number = Date.now
    )
    {
        this.adapter = adapter;
        this.producer = producer;
        this.policy = policy;
        this.clock = clock;
        if (!identityValid(identity) || !Number.isSafeInteger(policy.maxEntryBytes) || policy.maxEntryBytes < 1
            || !isTime(policy.maxAgeMs) || policy.maxAgeMs === 0
            || !Number.isSafeInteger(policy.maxReceipts) || policy.maxReceipts < 1 || policy.maxReceipts > 256)
        {
            throw new Error('article-render-cache-input-invalid');
        }
        this.identity = seal(structuredClone(identity));
        this.policy = Object.freeze({ ...policy });
        this.unsubscribe = adapter.subscribeContext(context =>
        {
            if (context === null)
            {
                this.dispose();
            }
            else
            {
                this.active = null;
                this.refreshState = 'idle';
                this.failure = null;
                this.policyReason = null;
                if (this.entry && !sameDocument(this.entry.context, context))
                {
                    this.clearEntry();
                }
                // A new owner never retains the previous user's content-free receipts either.
                if (context.userScope !== this.receiptLog.at(-1)?.task.context.userScope)
                {
                    this.receiptLog.length = 0;
                }
            }
        });
    }

    public get receipts(): readonly ArticleRenderReceipt[]
    {
        return this.receiptLog.slice();
    }

    public setIdentity(identity: ArticleRenderIdentity): void
    {
        if (!identityValid(identity))
        {
            throw new Error('article-render-identity-invalid');
        }
        if (identitiesEqual(this.identity, identity))
        {
            return;
        }
        this.cancel();
        this.clearEntry();
        this.identity = seal(structuredClone(identity));
        this.refreshState = 'idle';
        this.failure = null;
        this.policyReason = null;
    }

    public get state(): ArticleRenderState
    {
        const context = this.adapter.context;
        let retainedResultValid = true;
        if (this.entry)
        {
            try
            {
                retainedResultValid = this.entryRequest !== null
                    && this.producer.verify(this.entryRequest, this.entry.result);
            }
            catch
            {
                retainedResultValid = false;
            }
        }
        if (this.entry && (!validateArticleRenderCacheEntry(this.entry)
            || !retainedResultValid
            || !sameDocument(this.entry.context, context) || !identitiesEqual(this.identity, this.entry.identity)
            || this.entry.context.sourceRevision > context.sourceRevision
            || (this.entry.context.sourceRevision === context.sourceRevision
                && this.entry.context.contextDigest !== context.contextDigest)
            || this.clock() - this.entry.createdAt >= this.policy.maxAgeMs))
        {
            this.clearEntry();
            if (!retainedResultValid)
            {
                this.failure = 'render-cache-verification-failed';
                this.refreshState = this.active?.isCurrent() ? 'running' : 'failed';
            }
        }
        const stale = this.entry !== null && this.entry.context.sourceRevision < context.sourceRevision;
        return seal({
            schema: articleRenderStateSchema,
            content: this.entry,
            fallback: this.entry ? null : this.refreshState === 'running' ? 'loading' : 'source',
            currentRevision: context.sourceRevision,
            cachedRevision: this.entry?.context.sourceRevision ?? null,
            stale,
            reason: this.failure ?? (stale ? this.policyReason ?? 'source-revision-changed'
                : this.entry ? null : this.policyReason ?? 'no-valid-result'),
            refreshState: this.refreshState,
            lastValidTime: this.entry?.createdAt ?? null,
            failure: this.failure,
            actionIds: this.disposed ? [] : this.refreshState === 'running' ? ['render-cancel']
                : this.refreshState === 'failed' ? ['render-retry', 'render-refresh'] : ['render-refresh']
        });
    }

    public async autoRefresh(decision: ArticleRenderRefreshDecision): Promise<ArticleRenderReceipt | null>
    {
        if (!admitArticleRenderRefreshDecision(decision, this.adapter.context, this.identity.projectionVersion))
        {
            throw new Error('article-render-policy-invalid');
        }
        this.policyReason = decision.allowed ? null : decision.reason;
        if (!decision.allowed)
        {
            return null;
        }
        return this.refresh();
    }

    public cancel(): void
    {
        this.active?.cancel('render-canceled');
    }

    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.cancel();
        this.clearEntry();
        this.receiptLog.length = 0;
        this.unsubscribe?.();
    }

    public get pendingRefreshWork(): readonly ArticleRenderRefreshWork[]
    {
        return [...this.refreshWork];
    }

    public async refresh(): Promise<ArticleRenderReceipt>
    {
        return this.startRefresh().receipt;
    }

    public startRefresh(): ArticleRenderRefreshWork
    {
        if (this.disposed)
        {
            throw new Error('article-render-cache-disposed');
        }
        this.cancel();
        const task = this.adapter.beginTask('refresh', 'article-render-cache', 'v1.0');
        this.active = task;
        const request = Object.freeze({ context: task.envelope.context, requestId: task.envelope.requestId,
            identity: this.identity, signal: task.signal });
        const startedAt = this.clock();
        this.refreshState = 'running';
        this.failure = null;
        const cancellation = Symbol('render-canceled');
        let resolveAbort: (value: typeof cancellation) => void = () => undefined;
        const canceled = new Promise<typeof cancellation>(resolve =>
        {
            resolveAbort = resolve;
        });
        const onAbort = () =>
        {
            if (this.active === task)
            {
                this.active = null;
                this.refreshState = 'canceled';
            }
            resolveAbort(cancellation);
        };
        task.signal.addEventListener('abort', onAbort, { once: true });
        const notProduced = Symbol('article-render-not-produced');
        let producedResult: unknown = notProduced;
        let productionState: ArticleRenderRefreshWork['productionState'] = 'pending';
        let committed = false;
        let committedRef: string | null = null;
        let producerWork: ArticleRenderProducerRequestWork | null = null;
        let requestWorkFailure: Error | null = null;
        let releaseAttempted = false;
        let cleanupFailure: Error | null = null;
        let producerFailure: Error | null = null;
        const rememberCleanupFailure = (cause: unknown): void =>
        {
            cleanupFailure ??= new Error('article-render-cleanup-failed', { cause });
        };
        const classifyUncommitted = (): void =>
        {
            if (committed || releaseAttempted || producedResult === notProduced)
            {
                return;
            }
            // Reserve before validators/getters/verification callbacks. Their
            // failure is not permission to retry cleanup or infer no resources.
            releaseAttempted = true;
            try
            {
                if (!validateArticleRenderResult(producedResult))
                {
                    producerFailure ??= new Error('article-render-producer-output-invalid', { cause: producedResult });
                    return;
                }
                const resultRef = producedResult.resultRef;
                if (resultRef === null)
                {
                    // Even a schema-valid fatal/projection-failed null reference
                    // supplies no producer-bound no-resource/cleanup endpoint.
                    producerFailure ??= new Error('article-render-no-resource-terminal-unconfirmed', { cause: producedResult });
                    return;
                }
                if (producedResult.contextDigest !== request.context.contextDigest
                    || producedResult.requestId !== request.requestId
                    || !identitiesEqual(producedResult.identity, request.identity)
                    || !this.producer.verify(request, producedResult))
                {
                    producerFailure ??= new Error('article-render-producer-result-unconfirmed', { cause: producedResult });
                    return;
                }
            }
            catch (error)
            {
                producerFailure ??= new Error('article-render-producer-result-unconfirmed', { cause: error });
                throw error;
            }
        };
        const produced = Promise.resolve().then(() =>
        {
            const rendering = this.producer.render(request);
            try
            {
                producerWork = this.producer.getRequestWork?.(request) ?? null;
            }
            catch (cause)
            {
                // Still await the original rendering future; lookup failure must
                // not replace it with an early rejected wrapper and lose custody.
                requestWorkFailure = new Error('article-render-request-work-lookup-failed', { cause });
            }
            return rendering;
        }).then(value =>
        {
            producedResult = value;
            productionState = 'fulfilled';
            return value;
        }, (error: unknown) =>
        {
            productionState = 'rejected';
            throw error;
        });
        if (task.signal.aborted)
        {
            onAbort();
        }
        const receipt = (async (): Promise<ArticleRenderReceipt> =>
        {
            let result: ArticleRenderResult | null = null;
            let status: ArticleRenderReceipt['status'] = 'rejected';
            let reason: string | null = 'render-result-invalid';
            try
            {
                const value = await Promise.race([produced, canceled]);
                if (value === cancellation)
                {
                    status = 'canceled';
                    reason = 'render-canceled';
                }
                else if (task.isCurrent() && identitiesEqual(this.identity, request.identity)
                    && validateArticleRenderResult(value) && value.contextDigest === request.context.contextDigest
                    && value.requestId === request.requestId && identitiesEqual(value.identity, request.identity)
                    && this.producer.verify(request, value))
                {
                    result = seal(structuredClone(value));
                    if (value.status === 'fatal' || value.status === 'projection-failed')
                    {
                        status = 'failed';
                        reason = value.reason;
                        task.complete();
                    }
                    else
                    {
                        const unsigned = { schema: articleRenderCacheSchema, context: request.context,
                            identity: request.identity, result, createdAt: this.clock() };
                        const entry = seal({ ...unsigned, cacheDigest: digest(unsigned) });
                        if (!validateArticleRenderCacheEntry(entry))
                        {
                            producerFailure ??= new Error('article-render-producer-output-invalid', { cause: value });
                        }
                        else if (new TextEncoder().encode(JSON.stringify(entry)).byteLength > this.policy.maxEntryBytes)
                        {
                            status = 'failed';
                            reason = 'cache-size-limit';
                            task.complete();
                        }
                        else if (task.accept(result).accepted)
                        {
                            try
                            {
                                this.clearEntry();
                            }
                            catch (error)
                            {
                                rememberCleanupFailure(error);
                                throw error;
                            }
                            // Release is an external producer callback. Its return
                            // cannot authorize commit after reentry/owner retirement.
                            if (!this.disposed && this.active === task && !task.signal.aborted
                                && this.adapter.isCurrentContext(request.context)
                                && identitiesEqual(this.identity, request.identity))
                            {
                                this.entry = entry;
                                this.entryRequest = request;
                                committed = true;
                                committedRef = entry.result.resultRef;
                                status = 'committed';
                                reason = null;
                            }
                        }
                    }
                }
            }
            catch (cause)
            {
                if (producedResult !== notProduced && !cleanupFailure)
                {
                    producerFailure ??= new Error('article-render-admission-terminal-unconfirmed', { cause });
                }
                status = task.signal.aborted ? 'canceled' : 'failed';
                reason = cleanupFailure ? 'render-cleanup-failed'
                    : task.signal.aborted ? 'render-canceled' : 'render-producer-failed';
            }
            finally
            {
                task.signal.removeEventListener('abort', onAbort);
                try
                {
                    classifyUncommitted();
                }
                catch
                {
                    status = 'failed';
                    reason = cleanupFailure ? 'render-cleanup-failed' : 'render-producer-failed';
                }
            }
            if (task.envelope.status === 'running')
            {
                task.cancel(reason ?? 'render-result-rejected');
            }
            if (this.active === task)
            {
                this.active = null;
                this.refreshState = status === 'committed' ? 'idle' : status === 'canceled' ? 'canceled' : 'failed';
                this.failure = status === 'failed' || status === 'rejected' ? reason : null;
            }
            const unsigned = { schema: articleRenderReceiptSchema, task: task.envelope, identity: request.identity,
                result, status, reason, startedAt, completedAt: Math.max(startedAt, this.clock()) };
            const receipt = seal({ ...unsigned, receiptDigest: digest(unsigned) });
            if (!this.disposed && sameDocument(request.context, this.adapter.context))
            {
                this.receiptLog.push(receipt);
                while (this.receiptLog.length > this.policy.maxReceipts)
                {
                    this.receiptLog.shift();
                }
            }
            return receipt;
        })();
        const terminal = Promise.resolve().then(async (): Promise<void> =>
        {
            // Await the real producer future, never the cancellation race alone.
            try
            {
                await produced;
            }
            catch (cause)
            {
                // No returned ref or explicit failure-cleanup endpoint exists.
                // Preserve that producer's obligation rather than infer cleanup.
                producerFailure = new Error('article-render-producer-terminal-unconfirmed', { cause });
            }
            await receipt;
            // Both success and rejection require the ORIGINAL work for this exact
            // request object. Result shape/source/null does not authorize cleanup.
            const lookupFailure = requestWorkFailure;
            if (lookupFailure)
            {
                throw lookupFailure;
            }
            const actualWork = producerWork ?? this.producer.getRequestWork?.(request);
            const actualTerminal = actualWork?.terminal;
            if (!actualWork || actualWork.request !== request || !Object.isFrozen(actualWork)
                || !(actualTerminal instanceof Promise))
            {
                throw work.producerFailure ?? new Error('article-render-request-terminal-unconfirmed');
            }
            producerWork = actualWork;
            await actualTerminal;
            if (actualWork.request !== request || actualWork.terminal !== actualTerminal
                || this.producer.getRequestWork?.(request) !== actualWork)
            {
                throw new Error('article-render-request-terminal-binding-changed');
            }
            const ownedRef = actualWork.resultRef;
            if (ownedRef !== null && !isRef(ownedRef))
            {
                throw new Error('article-render-producer-cleanup-reference-invalid');
            }
            if (committed)
            {
                if (committedRef === null || ownedRef !== committedRef)
                {
                    throw new Error('article-render-transferred-reference-unconfirmed');
                }
            }
            else if (ownedRef !== null)
            {
                try
                {
                    this.releaseReference(ownedRef);
                }
                catch (cause)
                {
                    rememberCleanupFailure(cause);
                    throw work.cleanupFailure ?? new Error('article-render-cleanup-failed', { cause });
                }
            }
            const failure = work.cleanupFailure;
            if (failure)
            {
                throw failure;
            }
            // Logical producer/admission errors remain observable. Only the bound
            // real terminal above can discharge their resource obligation.
            task.settle();
            this.refreshWork.delete(work);
        });
        const work: ArticleRenderRefreshWork = Object.freeze({
            taskRef: task.taskRef,
            receipt,
            terminal,
            get productionState(): ArticleRenderRefreshWork['productionState']
            {
                return productionState;
            },
            get resultRef(): string | null
            {
                if (producedResult && typeof producedResult === 'object' && 'resultRef' in producedResult)
                {
                    const reference = producedResult.resultRef;
                    return typeof reference === 'string' ? reference : null;
                }
                return null;
            },
            get cleanupFailure(): Error | null
            {
                return cleanupFailure;
            },
            get producerFailure(): Error | null
            {
                return producerFailure;
            },
            get producerWork(): ArticleRenderProducerRequestWork | null
            {
                return producerWork;
            }
        });
        this.refreshWork.add(work);
        // Observe internal rejection without changing the exported rejected future.
        // Failed work/ref custody remains in this same cache and original lease.
        void terminal.catch(() => undefined);
        return work;
    }

    private clearEntry(): void
    {
        if (this.entryReleasePending || this.entryReleaseFailure)
        {
            throw this.entryReleaseFailure ?? new Error('article-render-entry-release-pending');
        }
        const old = this.entry;
        this.entryReleasePending = true;
        try
        {
            if (old?.result.resultRef)
            {
                this.releaseReference(old.result.resultRef);
            }
        }
        catch (cause)
        {
            this.entryReleaseFailure = new Error('article-render-entry-release-failed', { cause });
            throw this.entryReleaseFailure;
        }
        finally
        {
            this.entryReleasePending = false;
        }
        // A release failure must retain the original entry/reference custody.
        this.entry = null;
        this.entryRequest = null;
    }

    private releaseReference(resultRef: string): void
    {
        const cleanup: unknown = this.producer.release(resultRef);
        if (cleanup !== undefined)
        {
            // The original contract is synchronous. Keep an undeclared future
            // in failure custody; do not silently treat its return as cleanup.
            if (cleanup instanceof Promise)
            {
                void cleanup.catch(() => undefined);
            }
            throw new Error('article-render-cleanup-endpoint-missing', { cause: cleanup });
        }
    }
}
