import type { MarkdownEditorDispatchResult, MarkdownEditorResolvedSelection } from '@/fsusui/articlePositionMaps';
import { MARKDOWN_RENDERER_VERSION } from '@/fsusui/markdown';

import { ArticleEditorContinuityAdapter, type ArticleEditorContinuityPort } from './articleEditorContinuity';
import { ArticleFsusUiRenderProducer, type ArticleFsusUiRenderConfiguration } from './articleFsusUiRenderProducer';
import { ArticleRenderCache, type ArticleRenderCachePolicy, type ArticleRenderIdentity } from './articleRenderCache';
import { evaluateArticleRenderRefreshPolicy } from './articleRenderRefreshPolicy';
import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

import type { ArticleAnchorCaptureOptions, ArticleAnchorContextAdapter, ArticleAnchorSurface } from './articleAnchorContext';
import type { ArticleAttachmentContextAdapter, ArticleAttachmentTransactionPort } from './articleAttachmentContext';
import type { ArticleDocumentContext, ArticleDocumentContextAdapter, ArticleDocumentTaskLease } from './articleDocumentContext';
import type { ArticleEditorContinuityContext } from './articleEditorContinuity';

export interface ArticleEditorRuntimeBindingOptions
{
    readonly surface: ArticleAnchorSurface;
    readonly configuration: ArticleFsusUiRenderConfiguration;
    readonly identity: Pick<ArticleRenderIdentity, 'themeDigest' | 'locale'>;
    readonly cachePolicy: ArticleRenderCachePolicy;
}

/** Borrowed native capture and cancellation only; permission and action execution remain with the caller's canonical owners. */
export interface ArticleEditorCallerBinding
{
    readonly task: ArticleDocumentTaskLease;
    captureCurrent(): ArticleEditorContinuityContext;
    release(): void;
}

/** Compose existing owners on the writer binding; no second document, cache algorithm or body store. */
export function bindArticleEditorRuntime(
    owner: ArticleDocumentContextAdapter,
    anchors: ArticleAnchorContextAdapter,
    attachments: ArticleAttachmentContextAdapter,
    transactions: ArticleAttachmentTransactionPort,
    readSource: () => string,
    editor: ArticleEditorContinuityPort,
    options: ArticleEditorRuntimeBindingOptions
)
{
    if (!['live', 'source'].includes(options.surface) || typeof editor.dispatchTransaction !== 'function')
    {
        throw new Error('article-editor-runtime-binding-invalid');
    }
    const configuration = Object.freeze({ ...options.configuration });
    const producer = new ArticleFsusUiRenderProducer(request =>
    {
        if (!owner.isCurrentContext(request.context))
        {
            throw new Error('article-editor-render-context-stale');
        }
        return readSource();
    }, configuration, options.cachePolicy.maxEntryBytes);
    const cache = new ArticleRenderCache(owner, {
        rendererVersion: MARKDOWN_RENDERER_VERSION, projectionVersion: MARKDOWN_RENDERER_VERSION,
        featureConfigurationDigest: digest(configuration), ...options.identity
    }, producer, options.cachePolicy);
    const continuity = new ArticleEditorContinuityAdapter(owner, anchors, cache, editor, options.surface);
    let disposed = false;
    let toolLease: ArticleDocumentTaskLease | null = null;
    const callerReleases = new Set<() => void>();
    const current = (): void =>
    {
        if (disposed)
        {
            throw new Error('article-editor-runtime-binding-disposed');
        }
    };
    return Object.freeze({
        continuity,
        anchors,
        get context()
        {
            return owner.context;
        },
        get renderState()
        {
            return cache.state;
        },
        get attachmentTaskLeases()
        {
            return attachments.currentTaskLeases;
        },
        get retainedRender()
        {
            const state = cache.state;
            return state.content === null ? null : producer.resolve(state.content.result);
        },
        positionBinding: () =>
        {
            current();
            return transactions.binding();
        },
        /** Keep this actual runtime binding with the loan; supplied options must describe the host's current surface/tool/viewport. */
        borrowCompareTask: (producerRef: string, readCaptureOptions: () => ArticleAnchorCaptureOptions,
            producerVersion?: string): ArticleEditorCallerBinding =>
        {
            current();
            if (typeof readCaptureOptions !== 'function')
            {
                throw new Error('article-editor-caller-capture-options-required');
            }
            const task = owner.beginTask('compare', producerRef, producerVersion);
            if (disposed || task.signal.aborted || !task.isCurrent())
            {
                task.cancel('article-editor-caller-binding-unavailable');
                throw new Error('article-editor-caller-context-stale');
            }
            let released = false;
            const release = (): void =>
            {
                if (released)
                {
                    return;
                }
                released = true;
                task.signal.removeEventListener('abort', release);
                callerReleases.delete(release);
                if (!task.signal.aborted)
                {
                    task.cancel('article-editor-caller-release');
                }
            };
            const requireCurrent = (): void =>
            {
                current();
                if (released || task.signal.aborted || !task.isCurrent()
                    || !owner.isCurrentContext(task.envelope.context))
                {
                    throw new Error('article-editor-caller-context-stale');
                }
            };
            callerReleases.add(release);
            task.signal.addEventListener('abort', release, { once: true });
            return Object.freeze({
                task,
                captureCurrent: (): ArticleEditorContinuityContext =>
                {
                    requireCurrent();
                    const captureOptions = readCaptureOptions();
                    requireCurrent();
                    const captured = continuity.capture(transactions.binding(), captureOptions);
                    requireCurrent();
                    return captured;
                },
                release
            });
        },
        /** Borrowed commands must carry the exact current context and public native revision guard. */
        dispatchTransaction: (context: ArticleDocumentContext,
            transaction: Parameters<ArticleEditorContinuityPort['dispatchTransaction']>[0]): MarkdownEditorDispatchResult =>
        {
            current();
            if (!owner.isCurrentContext(context) || transaction.documentIdentity?.id !== context.documentId
                || transaction.documentIdentity.epoch !== context.documentEpoch
                || transaction.expectedRevision !== context.sourceRevision)
            {
                throw new Error('article-editor-command-context-stale');
            }
            const result = editor.dispatchTransaction(transaction);
            if (result.accepted && (!attachments.consumeTransaction(result, transactions)
                || !continuity.observeTransaction(editor, result)))
            {
                // Dispatch already occurred. Never fabricate an inverse transaction or rollback receipt.
                throw new Error('article-editor-command-observation-invalid');
            }
            return result;
        },
        consumeTransaction: (result: MarkdownEditorDispatchResult): boolean =>
            !disposed && attachments.consumeTransaction(result, transactions) && continuity.observeTransaction(editor, result),
        consumeSelection: (event: { documentIdentity: { id: string; epoch: number; }; revision: number; selection: MarkdownEditorResolvedSelection; }): boolean =>
            !disposed && event.documentIdentity.id === owner.context.documentId && event.documentIdentity.epoch === owner.context.documentEpoch
            && continuity.observeSelection(editor, { document: owner.context, revision: event.revision, selection: event.selection }),
        consumeFocus: (event: 'focusin' | 'focusout'): boolean => !disposed && continuity.observeFocus(editor, { document: owner.context, event }),
        initialize: (): boolean =>
        {
            current();
            const result = editor.dispatchTransaction({ changes: [], history: 'skip', origin: 'programmatic',
                documentIdentity: owner.documentIdentity, expectedRevision: owner.context.sourceRevision });
            return attachments.consumeTransaction(result, transactions) && continuity.observeTransaction(editor, result);
        },
        autoRefresh: () =>
        {
            current();
            return cache.autoRefresh(evaluateArticleRenderRefreshPolicy(owner.context, readSource()));
        },
        beginToolTask: (tool: 'publish-preview' | 'source-compare'): ArticleDocumentTaskLease =>
        {
            current();
            if (!['publish-preview', 'source-compare'].includes(tool))
            {
                throw new Error('article-editor-tool-invalid');
            }
            toolLease?.cancel('article-editor-tool-superseded');
            toolLease = owner.beginTask(tool === 'publish-preview' ? 'preview' : 'compare',
                tool === 'publish-preview' ? 'article-write:preview' : 'article-write:source-compare', 'article-editor-tools:v1');
            return toolLease;
        },
        cancelToolTask: (): void =>
        {
            toolLease?.cancel('article-editor-tool-closed');
            toolLease = null;
        },
        dispose: (): void =>
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            for (const release of Array.from(callerReleases))
            {
                release();
            }
            toolLease?.cancel('article-editor-runtime-release');
            toolLease = null;
            continuity.dispose();
            cache.dispose();
        }
    });
}

export type ArticleEditorRuntimeBinding = ReturnType<typeof bindArticleEditorRuntime>;
