import { createArticleDraftResponsibilitySnapshot, type ArticleDraftResponsibilitySnapshot,
    type ArticleDraftResponsibilitySource } from '@/view-contracts/articleDraftResponsibility';

import { validateArticleAttachmentLifecycle, type ArticleAttachmentLifecycleSnapshot } from './articleAttachmentContext';
import {
    articleDocumentContextAuthority,
    createArticleDocumentContext,
    validateArticleDocumentContext,
    type ArticleDocumentContext,
    type ArticleDocumentContextAuthority,
    type ArticleDocumentContextBinding,
    type ArticleDocumentTaskLease
} from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';


/** Reads current values from the existing editor host, including its attachment runtime receipts. */
export interface ArticlePreviewSourceInput {
    readonly context: ArticleDocumentContext;
    readonly source: string;
    readonly responsibility: ArticleDraftResponsibilitySource | null;
    readonly siteAuthor: string;
    readonly attachmentLifecycleHistory: readonly ArticleAttachmentLifecycleSnapshot[];
}

export interface ArticlePreviewSourceRequest {
    readonly schema: 'fsusblog.article-preview-source-request.v1';
    readonly context: ArticleDocumentContext;
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly responsibility: ArticleDraftResponsibilitySnapshot;
    readonly attachmentLifecycleHistoryDigest: string;
    readonly inputDigest: string;
}

interface CapturedInput {
    readonly context: ArticleDocumentContext;
    readonly responsibility: ArticleDraftResponsibilitySnapshot;
    readonly attachmentLifecycleHistoryDigest: string;
    readonly inputDigest: string;
}

/**
 * Admission for the source/responsibility/lifecycle slice of draft preview.
 * History is an invalidation input, never a current asset inventory or activation proof.
 * Rendering, rights, verified assets and complete preview identity remain separate gates.
 */
export class ArticlePreviewSourceAdmission
{
    private readonly requests = new WeakMap<ArticlePreviewSourceRequest, ArticleDocumentTaskLease>();
    private active: ArticleDocumentTaskLease | null = null;
    private disposed = false;

    private constructor(
        private readonly binding: ArticleDocumentContextBinding,
        private readonly read: () => ArticlePreviewSourceInput
    )
    {}

    /** Acquires another binding only after confirming that this host's canonical owner already exists. */
    public static attach(
        read: () => ArticlePreviewSourceInput,
        authority: ArticleDocumentContextAuthority = articleDocumentContextAuthority
    ): ArticlePreviewSourceAdmission
    {
        const input = read();
        if (!validateArticleDocumentContext(input.context)
            || authority.context?.contextDigest !== input.context.contextDigest)
        {
            throw new Error('article-preview-owner-mismatch');
        }
        // createArticleDocumentContext also rejects contentDigest/source byte mismatches.
        createArticleDocumentContext({ ...input.context, content: input.source });
        const binding = authority.acquire({ articleId: input.context.articleId,
            siteScope: input.context.siteScope, userScope: input.context.userScope, content: input.source });
        const admission = new ArticlePreviewSourceAdmission(binding, read);
        try
        {
            admission.capture();
            return admission;
        }
        catch (error)
        {
            binding.release();
            throw error;
        }
    }

    public begin(): ArticlePreviewSourceRequest
    {
        this.cancel();
        const input = this.capture();
        const lease = this.binding.adapter.beginTask('preview', 'article-preview-source', 'version:1');
        const request = Object.freeze({ schema: 'fsusblog.article-preview-source-request.v1' as const,
            ...input, requestId: lease.envelope.requestId, signal: lease.signal });
        this.requests.set(request, lease);
        this.active = lease;
        return request;
    }

    public accept<T>(request: ArticlePreviewSourceRequest, value: T): Readonly<{
        accepted: boolean; value: T | null; reason: string | null;
    }>
    {
        const lease = this.requests.get(request);
        if (!lease || lease !== this.active)
        {
            return Object.freeze({ accepted: false, value: null, reason: 'preview-request-invalid' });
        }
        try
        {
            if (!lease.isCurrent() || this.capture().inputDigest !== request.inputDigest)
            {
                lease.cancel('preview-input-changed');
                return Object.freeze({ accepted: false, value: null, reason: 'preview-input-changed' });
            }
            const accepted = lease.accept(value, request.context.sourceRevision);
            return Object.freeze({ accepted: accepted.accepted, value: accepted.value, reason: accepted.reason });
        }
        catch
        {
            lease.cancel('preview-input-invalid');
            return Object.freeze({ accepted: false, value: null, reason: 'preview-input-invalid' });
        }
        finally
        {
            this.active = null;
            this.requests.delete(request);
        }
    }

    public cancel(): void
    {
        this.active?.cancel('preview-canceled');
        this.active = null;
    }

    public dispose(): void
    {
        if (this.disposed)
        {
            return;
        }
        this.cancel();
        this.disposed = true;
        this.binding.release();
    }

    private capture(): CapturedInput
    {
        if (this.disposed)
        {
            throw new Error('article-preview-source-disposed');
        }
        const input = this.read();
        if (!validateArticleDocumentContext(input.context)
            || !this.binding.adapter.isCurrentContext(input.context))
        {
            throw new Error('article-preview-source-context-invalid');
        }
        createArticleDocumentContext({ ...input.context, content: input.source });
        if (!Array.isArray(input.attachmentLifecycleHistory) || input.attachmentLifecycleHistory.length > 64
            || !input.attachmentLifecycleHistory.every(validateArticleAttachmentLifecycle))
        {
            throw new Error('article-preview-attachment-history-invalid');
        }
        const responsibility = createArticleDraftResponsibilitySnapshot(input.context, input.responsibility, input.siteAuthor);
        const attachmentLifecycleHistoryDigest = digest(input.attachmentLifecycleHistory);
        return Object.freeze({ context: input.context, responsibility, attachmentLifecycleHistoryDigest,
            inputDigest: digest({ contextDigest: input.context.contextDigest,
                responsibilityDigest: responsibility.responsibilityDigest, attachmentLifecycleHistoryDigest }) });
    }
}
