import type { FsusUiAuthoringCommand } from '@/fsusui/authoringCommands';

import {
    resolveArticleBlockAnchorAdmission,
    type ArticleBlockAnchorAdmissionReason
} from './articleBlockAnchorAdmission';

import type { ArticleEditorRuntimeBinding } from './articleEditorRuntimeBinding';

type CommandContext = Parameters<FsusUiAuthoringCommand['run']>[0];

export type ArticleBlockAnchorCommandReason = ArticleBlockAnchorAdmissionReason
    | 'source-mode-required'
    | 'editor-binding-unavailable'
    | 'editor-binding-stale'
    | 'reveal-map-invalid';

export interface ArticleBlockAnchorCommandCopy {
    readonly label: string;
    reason(reason: ArticleBlockAnchorCommandReason): string;
}

export class ArticleBlockAnchorCommandError extends Error
{
    public constructor(public readonly reason: ArticleBlockAnchorCommandReason, message: string)
    {
        super(message);
        this.name = 'ArticleBlockAnchorCommandError';
    }
}

/** One navigation consumer of the original owner's binding and public command session. */
export function createArticleBlockAnchorRevealCommand(
    binding: ArticleEditorRuntimeBinding,
    copy: ArticleBlockAnchorCommandCopy
): FsusUiAuthoringCommand
{
    const resolve = (context: CommandContext) =>
    {
        if (context.mode !== 'source')
        {
            return { reason: 'source-mode-required' as const };
        }
        if (context.readonly)
        {
            return { reason: 'editor-readonly' as const };
        }
        let position: ReturnType<ArticleEditorRuntimeBinding['positionBinding']>;
        try
        {
            position = binding.positionBinding();
        }
        catch
        {
            return { reason: 'editor-binding-unavailable' as const };
        }
        const document = binding.context;
        if (position.document.contextDigest !== document.contextDigest
            || position.map.documentIdentity.id !== document.documentId
            || position.map.documentIdentity.epoch !== document.documentEpoch
            || position.map.source !== context.value)
        {
            return { reason: 'editor-binding-stale' as const };
        }
        const admission = resolveArticleBlockAnchorAdmission(document, context, 'reveal-source');
        if (admission.reason !== null || admission.range === null)
        {
            return { reason: admission.reason ?? 'anchor-required' as const };
        }
        try
        {
            const reveal = position.map.sourceRangeToReveal(admission.range);
            if (reveal.documentIdentity.id !== document.documentId
                || reveal.documentIdentity.epoch !== document.documentEpoch
                || reveal.reveal.documentIdentity.id !== document.documentId
                || reveal.reveal.documentIdentity.epoch !== document.documentEpoch
                || reveal.reveal.range.start !== admission.range.start
                || reveal.reveal.range.end !== admission.range.end)
            {
                return { reason: 'reveal-map-invalid' as const };
            }
        }
        catch
        {
            return { reason: 'reveal-map-invalid' as const };
        }
        return { reason: null, document, range: admission.range };
    };

    return Object.freeze<FsusUiAuthoringCommand>({
        key: 'reveal-anchor-source',
        label: copy.label,
        group: 'navigate',
        presentation: Object.freeze(['palette', 'selection'] as const),
        when: context => context.syntax?.type === 'anchor',
        enabled: context => resolve(context).reason === null,
        disabledReason: context =>
        {
            const result = resolve(context);
            return result.reason === null ? undefined : copy.reason(result.reason);
        },
        run: context =>
        {
            const result = resolve(context);
            if (result.reason !== null)
            {
                throw new ArticleBlockAnchorCommandError(result.reason, copy.reason(result.reason));
            }
            // The editor's existing command session dispatches this selection-only plan.
            return {
                focus: 'editor',
                transaction: {
                    changes: [],
                    history: 'skip',
                    origin: 'command',
                    documentIdentity: { id: result.document.documentId, epoch: result.document.documentEpoch },
                    expectedRevision: result.document.sourceRevision,
                    selection: { ...result.range, direction: context.selection.direction ?? 'none' }
                }
            };
        }
    });
}
