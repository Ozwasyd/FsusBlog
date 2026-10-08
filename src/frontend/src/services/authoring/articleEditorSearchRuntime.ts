import { projectArticleSearchReveal, type ArticleSearchRevealPresentation } from './articleSearchRevealPresentation';

import type { ArticleDocumentContextAdapter, ArticleDocumentTaskLease } from './articleDocumentContext';
import type { ArticleEditorRuntimeBinding } from './articleEditorRuntimeBinding';

/** Borrow the actual document and editor owners; this does not admit server search packages or record visits. */
export class ArticleEditorSearchRuntime
{
    private lease: ArticleDocumentTaskLease | null = null;
    private command: unknown = null;
    private disposed = false;
    private readonly listeners = new Set<(presentation: ArticleSearchRevealPresentation | null) => void>();
    private readonly unsubscribeContext: () => void;
    private removeAbortListener: (() => void) | null = null;
    private readonly owner: ArticleDocumentContextAdapter;
    private readonly binding: ArticleEditorRuntimeBinding;

    public constructor(
        owner: ArticleDocumentContextAdapter,
        binding: ArticleEditorRuntimeBinding
    )
    {
        this.owner = owner;
        this.binding = binding;
        if (!owner.isCurrentContext(binding.context))
        {
            throw new Error('article-editor-search-binding-invalid');
        }
        this.unsubscribeContext = owner.subscribeContext(() => this.invalidate('article-editor-search-context-changed'));
    }

    public get currentTask(): ArticleDocumentTaskLease | null
    {
        return this.lease;
    }

    /** Reproject on every read; an immutable ready projection is never a navigation acknowledgement. */
    public get presentation(): ArticleSearchRevealPresentation | null
    {
        return this.disposed || this.lease === null || this.command === null
            ? null : projectArticleSearchReveal(this.command, this.binding, this.lease);
    }

    public beginTask(producerRef: string, producerVersion?: string): ArticleDocumentTaskLease
    {
        this.assertActive();
        this.invalidate('article-editor-search-superseded');
        const lease = this.owner.beginTask('search', producerRef, producerVersion);
        this.lease = lease;
        this.binding.continuity.setSearchTaskOwner(lease);
        const abort = (): void =>
        {
            if (this.lease === lease)
            {
                this.clear();
                this.refresh();
            }
        };
        lease.signal.addEventListener('abort', abort, { once: true });
        this.removeAbortListener = () => lease.signal.removeEventListener('abort', abort);
        this.refresh();
        return lease;
    }

    /** Only a canonical search-origin anchor command projects as available; raw index/range inputs remain rejected. */
    public projectCommand(command: unknown, lease: ArticleDocumentTaskLease): ArticleSearchRevealPresentation | null
    {
        this.assertActive();
        if (lease !== this.lease || lease.signal.aborted || !lease.isCurrent()
            || lease.envelope.kind !== 'search' || !this.owner.isCurrentContext(lease.envelope.context)
            || lease.envelope.context.contextDigest !== this.binding.context.contextDigest)
        {
            throw new Error('article-editor-search-task-stale');
        }
        this.command = command;
        return this.refresh();
    }

    /** Hosts refresh after a native binding/command or lease transition; reads also validate the current binding. */
    public refresh(): ArticleSearchRevealPresentation | null
    {
        const presentation = this.presentation;
        for (const listener of this.listeners)
        {
            listener(presentation);
        }
        return presentation;
    }

    public subscribe(listener: (presentation: ArticleSearchRevealPresentation | null) => void): () => void
    {
        if (!this.disposed)
        {
            this.listeners.add(listener);
        }
        listener(this.presentation);
        return () => this.listeners.delete(listener);
    }

    public cancel(): void
    {
        this.invalidate('article-editor-search-closed');
    }

    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.disposed = true;
        this.unsubscribeContext();
        this.invalidate('article-editor-search-release');
        this.listeners.clear();
    }

    private clear(): void
    {
        this.removeAbortListener?.();
        this.removeAbortListener = null;
        this.lease = null;
        this.command = null;
        this.binding.continuity.setSearchTaskOwner(null);
    }

    private invalidate(reason: string): void
    {
        const lease = this.lease;
        this.clear();
        lease?.cancel(reason);
        this.refresh();
    }

    private assertActive(): void
    {
        if (this.disposed || !this.owner.isCurrentContext(this.binding.context))
        {
            throw new Error('article-editor-search-runtime-unavailable');
        }
        try
        {
            if (!this.owner.isCurrentContext(this.binding.positionBinding().document))
            {
                throw new Error('article-editor-search-binding-invalid');
            }
        }
        catch
        {
            throw new Error('article-editor-search-runtime-unavailable');
        }
    }
}
