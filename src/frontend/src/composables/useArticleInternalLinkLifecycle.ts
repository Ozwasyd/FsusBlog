import { computed, getCurrentScope, onScopeDispose, shallowRef, watch, type Ref } from 'vue';

import type {
    InternalLinkPickerHeadingResult,
    InternalLinkPickerSearchResult
} from '@/components/admin/article/ArticleInternalLinkPicker.vue';
import type {
    ArticleInternalLinkPreviewContent,
    ArticleInternalLinkPreviewPresentation,
    ArticleInternalLinkPreviewRequest
} from '@/components/admin/article/ArticleInternalLinkPreview.vue';
import type { MarkdownEditorDispatchResult } from '@/fsusui/articlePositionMaps';
import type { FsusUiAuthoringCommand } from '@/fsusui/authoringCommands';
import type { ArticleAnchorCaptureOptions, ArticleAnchorContext } from '@/services/authoring/articleAnchorContext';
import type { ArticleDocumentContextAdapter, ArticleDocumentTaskLease } from '@/services/authoring/articleDocumentContext';
import type { ArticleEditorRuntimeBinding } from '@/services/authoring/articleEditorRuntimeBinding';

type CommandContext = Parameters<FsusUiAuthoringCommand['run']>[0];
type SearchRequest = Readonly<{ sessionKey: string; requestKey: string; query: string; }>;
type HeadingRequest = Readonly<{ sessionKey: string; requestKey: string; articleId: string; articleRevision: string; action: unknown; }>;
type PickerCancel = Readonly<{ sessionKey: string; scope: 'picker' | 'search' | 'headings';
    searchRequestKey: string | null; headingRequestKey: string | null; }>;
type PickerSelect = Readonly<{ sessionKey: string; searchRequestKey: string; }>;
type PreviewIntent = Readonly<{ targetKey: string; trigger: 'hover' | 'focus' | 'action'; }>;

/** These callbacks only deliver the components' existing, owner-admitted presentation.
 * They are not query/permission/URL authorities. Missing providers disclose no facts.
 */
export interface ArticleInternalLinkPresentationLoaders {
    search(request: SearchRequest, signal: AbortSignal): Promise<InternalLinkPickerSearchResult>;
    headings(request: HeadingRequest, signal: AbortSignal): Promise<InternalLinkPickerHeadingResult>;
    preview(intent: PreviewIntent, signal: AbortSignal): Promise<ArticleInternalLinkPreviewContent | null>;
}

interface LifecycleOptions {
    readonly owner: ArticleDocumentContextAdapter;
    readonly runtime: Readonly<Ref<ArticleEditorRuntimeBinding | null>>;
    readonly enabled: Readonly<Ref<boolean>>;
    readonly loaders: Readonly<Ref<ArticleInternalLinkPresentationLoaders | null>>;
    /** Opaque owner coordinate only; this is neither a URL nor permission proof. */
    readonly previewTarget: Readonly<Ref<string | null>>;
    readonly restoreOptions: () => Readonly<{ now: number; viewportHeight: number; reducedMotion: boolean; }>;
}

/** Product lifecycle only. Borrows the sole document, anchor and native transaction owners.
 * Canonical target/URL admission and insertion are deliberately unavailable until offered
 * by their real owner; an opaque picker action never grants permission to mutate.
 */
export function useArticleInternalLinkLifecycle(options: LifecycleOptions)
{
    const phase = shallowRef<'picker' | 'preview' | 'closing' | null>(null);
    const sessionKey = shallowRef('');
    const searchResult = shallowRef<InternalLinkPickerSearchResult | null>(null);
    const headingResult = shallowRef<InternalLinkPickerHeadingResult | null>(null);
    const previewRequest = shallowRef<ArticleInternalLinkPreviewRequest | null>(null);
    const previewPresentation = shallowRef<ArticleInternalLinkPreviewPresentation | null>(null);
    let captured: { runtime: ArticleEditorRuntimeBinding; anchor: ArticleAnchorContext;
        transactions: MarkdownEditorDispatchResult[]; revision: number; } | null = null;
    let searchTask: ArticleDocumentTaskLease | null = null;
    let headingTask: ArticleDocumentTaskLease | null = null;
    let previewTask: ArticleDocumentTaskLease | null = null;
    let removeCommandAbort: (() => void) | null = null;
    let disposed = false;
    let sequence = 0;

    const current = (): ArticleEditorRuntimeBinding | null =>
    {
        const runtime = options.runtime.value;
        try
        {
            return !disposed && options.enabled.value && runtime !== null && captured?.runtime === runtime
                && options.owner.isCurrentContext(runtime.context)
                && options.owner.isCurrentContext(runtime.positionBinding().document)
                && captured.anchor.document.documentId === runtime.context.documentId
                && captured.anchor.document.documentEpoch === runtime.context.documentEpoch ? runtime : null;
        }
        catch
        {
            return null;
        }
    };
    const cancelSearch = (): void =>
    {
        const task = searchTask;
        searchTask = null;
        task?.cancel('internal-link-search-canceled');
        searchResult.value = null;
    };
    const cancelHeadings = (): void =>
    {
        const task = headingTask;
        headingTask = null;
        task?.cancel('internal-link-headings-canceled');
        headingResult.value = null;
    };
    const cancelPreview = (): void =>
    {
        const task = previewTask;
        previewTask = null;
        task?.cancel('internal-link-preview-canceled');
        previewRequest.value = null;
        previewPresentation.value = null;
    };
    const clearRequests = (): void =>
    {
        cancelSearch();
        cancelHeadings();
        cancelPreview();
    };
    const close = (): void =>
    {
        clearRequests();
        if (captured !== null)
        {
            phase.value = 'closing';
        }
    };
    const revoke = (): void =>
    {
        clearRequests();
        removeCommandAbort?.();
        removeCommandAbort = null;
        captured = null;
        sessionKey.value = '';
        phase.value = null;
    };

    const capture = (context: CommandContext, captureOptions: ArticleAnchorCaptureOptions): boolean =>
    {
        const runtime = options.runtime.value;
        if (disposed || !options.enabled.value || runtime === null || phase.value !== null
            || context.readonly || context.signal.aborted)
        {
            return false;
        }
        try
        {
            const binding = runtime.positionBinding();
            if (!options.owner.isCurrentContext(runtime.context) || !options.owner.isCurrentContext(binding.document)
                || context.documentIdentity.id !== binding.document.documentId
                || context.documentIdentity.epoch !== binding.document.documentEpoch
                || context.revision !== binding.document.sourceRevision || context.value !== binding.map.source)
            {
                return false;
            }
            const anchor = runtime.anchors.capture(binding, { ...context.selection, direction: context.selection.direction ?? 'none' }, captureOptions);
            captured = { runtime, anchor, transactions: [], revision: context.revision };
            sessionKey.value = `${binding.document.contextDigest}:internal-link:${++sequence}`;
            const abort = (): void =>
            {
                const previewOnly = phase.value === 'preview';
                close();
                if (previewOnly)
                {
                    closed();
                }
            };
            context.signal.addEventListener('abort', abort, { once: true });
            removeCommandAbort = () => context.signal.removeEventListener('abort', abort);
            return true;
        }
        catch
        {
            revoke();
            return false;
        }
    };
    const openFromCommand = (context: CommandContext, captureOptions: ArticleAnchorCaptureOptions): boolean =>
    {
        if (!capture(context, captureOptions))
        {
            return false;
        }
        phase.value = 'picker';
        return true;
    };

    const requestSearch = async (request: SearchRequest): Promise<boolean> =>
    {
        if (phase.value !== 'picker' || request.sessionKey !== sessionKey.value || current() === null)
        {
            return false;
        }
        cancelSearch();
        cancelHeadings();
        cancelPreview();
        const loader = options.loaders.value;
        if (loader === null)
        {
            searchResult.value = { requestKey: request.requestKey, state: 'error', articles: [], message: '文章查询尚未接入。' };
            return false;
        }
        const task = options.owner.beginTask('feature', 'internal-link:search', 'internal-link-lifecycle:v1');
        searchTask = task;
        searchResult.value = { requestKey: request.requestKey, state: 'loading', articles: [], message: null };
        task.signal.addEventListener('abort', () =>
        {
            if (searchTask === task)
            {
                searchTask = null;
                searchResult.value = null;
                cancelHeadings();
            }
        }, { once: true });
        try
        {
            const result = await loader.search(request, task.signal);
            if (searchTask !== task || !task.isCurrent() || current() === null || result.requestKey !== request.requestKey)
            {
                return false;
            }
            searchResult.value = result;
            return true;
        }
        catch
        {
            if (searchTask === task && task.isCurrent())
            {
                searchResult.value = { requestKey: request.requestKey, state: 'error', articles: [], message: '文章查询不可用。' };
            }
            return false;
        }
    };
    const requestHeadings = async (request: HeadingRequest): Promise<boolean> =>
    {
        if (phase.value !== 'picker' || request.sessionKey !== sessionKey.value || current() === null
            || searchResult.value?.state !== 'ready' || !searchTask?.isCurrent()
            || !searchResult.value.articles.some(article => article.id === request.articleId && article.revision === request.articleRevision
                && article.unavailableText === null && article.headingsAction === request.action && request.action != null))
        {
            return false;
        }
        cancelHeadings();
        const loader = options.loaders.value;
        if (loader === null)
        {
            return false;
        }
        const task = options.owner.beginTask('feature', 'internal-link:headings', 'internal-link-lifecycle:v1');
        headingTask = task;
        headingResult.value = { requestKey: request.requestKey, articleId: request.articleId, articleRevision: request.articleRevision,
            state: 'loading', headings: [], message: null };
        task.signal.addEventListener('abort', () =>
        {
            if (headingTask === task)
            {
                headingTask = null;
                headingResult.value = null;
            }
        }, { once: true });
        try
        {
            const result = await loader.headings(request, task.signal);
            if (headingTask !== task || !task.isCurrent() || current() === null || result.requestKey !== request.requestKey
                || result.articleId !== request.articleId || result.articleRevision !== request.articleRevision)
            {
                return false;
            }
            headingResult.value = result;
            return true;
        }
        catch
        {
            if (headingTask === task && task.isCurrent())
            {
                headingResult.value = { requestKey: request.requestKey, articleId: request.articleId,
                    articleRevision: request.articleRevision, state: 'error', headings: [], message: '章节查询不可用。' };
            }
            return false;
        }
    };
    const requestPreview = async (intent: PreviewIntent): Promise<boolean> =>
    {
        if ((phase.value !== 'picker' && phase.value !== 'preview') || current() === null || !intent.targetKey
            || intent.targetKey !== options.previewTarget.value)
        {
            return false;
        }
        cancelPreview();
        const loader = options.loaders.value;
        if (loader === null)
        {
            return false;
        }
        const task = options.owner.beginTask('feature', 'internal-link:preview', 'internal-link-lifecycle:v1');
        previewTask = task;
        const request = Object.freeze({ targetKey: intent.targetKey, signal: task.signal });
        previewRequest.value = request;
        previewPresentation.value = { request, state: 'loading' };
        task.signal.addEventListener('abort', () =>
        {
            if (previewTask === task)
            {
                previewTask = null;
                previewRequest.value = null;
                previewPresentation.value = null;
            }
        }, { once: true });
        try
        {
            const content = await loader.preview(intent, task.signal);
            if (previewTask !== task || !task.isCurrent() || current() === null)
            {
                return false;
            }
            previewPresentation.value = content === null ? { request, state: 'empty' } : { request, state: 'ready', content };
            return true;
        }
        catch
        {
            if (previewTask === task && task.isCurrent())
            {
                previewPresentation.value = { request, state: 'error' };
            }
            return false;
        }
    };
    const openPreviewFromCommand = (context: CommandContext, captureOptions: ArticleAnchorCaptureOptions, intent: PreviewIntent): Promise<boolean> =>
    {
        if (options.loaders.value === null || !intent.targetKey || intent.targetKey !== options.previewTarget.value
            || !capture(context, captureOptions))
        {
            return Promise.resolve(false);
        }
        phase.value = 'preview';
        return requestPreview(intent);
    };

    // Forward only the real already-observed native transaction. The anchor owner
    // verifies the complete chain; this consumer neither synthesizes maps nor rebases.
    const observeTransaction = (result: MarkdownEditorDispatchResult): boolean =>
    {
        const runtime = current();
        if (!captured || runtime === null || !result.accepted || result.revision <= captured.revision
            || result.beforeRevision !== captured.revision || !result.positionMap
            || result.documentIdentity?.id !== runtime.context.documentId || result.documentIdentity.epoch !== runtime.context.documentEpoch
            || result.revision !== runtime.context.sourceRevision || result.value !== runtime.positionBinding().map.source)
        {
            return false;
        }
        captured.transactions.push(result);
        captured.revision = result.revision;
        return true;
    };
    const closed = (): boolean =>
    {
        if (phase.value !== 'closing' || !captured)
        {
            return false;
        }
        const runtime = current();
        const saved = captured;
        try
        {
            if (runtime === null)
            {
                return false;
            }
            const command = runtime.anchors.restore(saved.anchor, runtime.positionBinding(), {
                ...options.restoreOptions(), origin: 'tool', transactions: saved.transactions
            });
            if (command.status !== 'ready' || !command.range || !['exact', 'rebased'].includes(command.kind ?? '')
                || command.rebase.some(outcome => outcome !== 'mapped'))
            {
                return false;
            }
            const result = runtime.dispatchTransaction(runtime.context, { changes: [], history: 'skip', origin: 'programmatic',
                expectedRevision: runtime.context.sourceRevision, documentIdentity: options.owner.documentIdentity,
                selection: { ...command.range, direction: command.direction } });
            return result.accepted;
        }
        catch
        {
            return false;
        }
        finally
        {
            revoke();
        }
    };
    const cancel = (event: PickerCancel): void =>
    {
        if (event.sessionKey !== sessionKey.value)
        {
            return;
        }
        if (event.scope === 'picker')
        {
            close();
        }
        else if (event.scope === 'search' && event.searchRequestKey === searchResult.value?.requestKey)
        {
            cancelSearch();
            cancelHeadings();
        }
        else if (event.scope === 'headings' && event.headingRequestKey === headingResult.value?.requestKey)
        {
            cancelHeadings();
        }
    };
    const select = (event: PickerSelect): false =>
    {
        if (phase.value === 'picker' && event.sessionKey === sessionKey.value
            && event.searchRequestKey === searchResult.value?.requestKey)
        {
            close();
        }
        // No canonical target+URL authority is published for this adapter. Never
        // execute an opaque action or substitute an example URL/Markdown token.
        return false;
    };
    const updateModelValue = (value: boolean): void =>
    {
        if (!value && phase.value === 'picker')
        {
            close();
        }
    };
    const dismissPreview = (event: Readonly<{ request: ArticleInternalLinkPreviewRequest; }>): boolean =>
    {
        if (event.request !== previewRequest.value)
        {
            return false;
        }
        cancelPreview();
        if (phase.value !== 'preview')
        {
            return true;
        }
        close();
        return closed();
    };
    const unsubscribe = options.owner.subscribeContext(context =>
    {
        if (!captured)
        {
            return;
        }
        if (context?.documentId !== captured.anchor.document.documentId
            || context.documentEpoch !== captured.anchor.document.documentEpoch)
        {
            revoke();
        }
        else
        {
            clearRequests();
        }
    });
    const stopWatch = watch([options.runtime, options.enabled, options.loaders], () =>
    {
        if (current() === null)
        {
            revoke();
        }
        else
        {
            clearRequests();
        }
    }, { flush: 'sync' });
    const stopTargetWatch = watch(options.previewTarget, () =>
    {
        cancelPreview();
        if (phase.value === 'preview')
        {
            close();
            closed();
        }
    }, { flush: 'sync' });
    const dispose = (): void =>
    {
        disposed = true;
        unsubscribe();
        stopWatch();
        stopTargetWatch();
        revoke();
    };
    if (getCurrentScope())
    {
        onScopeDispose(dispose);
    }
    return { openFromCommand, openPreviewFromCommand, requestSearch, requestHeadings, requestPreview,
        observeTransaction, cancel, select, updateModelValue, closed, dismissPreview,
        // The component's open event is notification only; never open the target twice.
        previewOpened: (request: ArticleInternalLinkPreviewRequest) => dismissPreview({ request }), dispose,
        pickerProps: computed(() => ({ modelValue: phase.value === 'picker', sessionKey: sessionKey.value,
            searchResult: searchResult.value, headingResult: headingResult.value,
            selectionUnavailableText: '目标链接解析与提交尚未接入，不能插入。' })),
        previewProps: computed(() => ({ targetKey: options.previewTarget.value,
            request: previewRequest.value, presentation: previewPresentation.value })) };
}
