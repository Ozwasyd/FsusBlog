import {
    validateArticleDocumentContext,
    type ArticleDocumentContextAdapter
} from './articleDocumentContext';
import {
    resolveArticleWritingAidPolicy,
    type ArticleWritingAidPolicyInput,
    type ArticleWritingAidPolicyResult
} from './articleWritingAidPolicy';

import type { ArticleEditorRuntimeBinding } from './articleEditorRuntimeBinding';

export type ArticleWritingAidRuntimeFacts = Omit<
    ArticleWritingAidPolicyInput, 'document' | 'documentOwner' | 'manualScrollActive'
>;

export interface ArticleWritingAidRuntimeView {
    readonly status: 'bound' | 'disabled' | 'unavailable' | 'rejected';
    readonly reason: 'preference-unavailable' | 'editor-binding-unavailable' | 'editor-binding-stale' | null;
    readonly policy: ArticleWritingAidPolicyResult;
}

/**
 * Consume the sole writer binding. Context/currentness, manual intent and resume
 * remain with the original owners; no editor, task, observer or scroll loop is created.
 */
export function createArticleWritingAidRuntimeConsumer(
    binding: ArticleEditorRuntimeBinding,
    documentOwner: ArticleDocumentContextAdapter
)
{
    const unavailable = (
        input: ArticleWritingAidRuntimeFacts,
        status: ArticleWritingAidRuntimeView['status'],
        reason: ArticleWritingAidRuntimeView['reason']
    ): ArticleWritingAidRuntimeView => Object.freeze({
        status,
        reason,
        policy: resolveArticleWritingAidPolicy({ ...input, document: null, documentOwner, manualScrollActive: false })
    });

    const read = (input: ArticleWritingAidRuntimeFacts): ArticleWritingAidRuntimeView =>
    {
        if (input.requested === null)
        {
            return unavailable(input, 'unavailable', 'preference-unavailable');
        }
        if (!input.requested.focus && !input.requested.typewriter)
        {
            return unavailable(input, 'disabled', null);
        }
        try
        {
            // positionBinding also checks the real binding lifetime before admitting this read.
            const position = binding.positionBinding();
            const document = binding.context;
            if (!validateArticleDocumentContext(position.document)
                || !validateArticleDocumentContext(document)
                || !documentOwner.isCurrentContext(position.document)
                || !documentOwner.isCurrentContext(document)
                || position.document.contextDigest !== document.contextDigest)
            {
                return unavailable(input, 'rejected', 'editor-binding-stale');
            }
            return Object.freeze({
                status: 'bound',
                reason: null,
                policy: resolveArticleWritingAidPolicy({
                    ...input,
                    document,
                    documentOwner,
                    manualScrollActive: binding.anchors.userIntent.state === 'manual'
                })
            });
        }
        catch
        {
            return unavailable(input, 'unavailable', 'editor-binding-unavailable');
        }
    };

    return Object.freeze({
        read,
        resumeTypewriter: (
            input: ArticleWritingAidRuntimeFacts,
            reason: Parameters<ArticleEditorRuntimeBinding['anchors']['resume']>[0],
            now: number
        ): boolean =>
        {
            if (input.requested?.typewriter !== true)
            {
                return false;
            }
            if (input.explicitNavigationActive && reason !== 'navigation')
            {
                return false;
            }
            const view = read(input);
            const block = view.policy.typewriter.blockedReason;
            if (view.status !== 'bound' || block !== null && block !== 'manual-scroll' && block !== 'explicit-navigation')
            {
                return false;
            }
            // Only the existing intent owner decides generations, deadlines and resume admission.
            return binding.anchors.resume(reason, now);
        }
    });
}

export type ArticleWritingAidRuntimeConsumer = ReturnType<typeof createArticleWritingAidRuntimeConsumer>;
