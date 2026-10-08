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
    | 'reveal-map-invalid'
    | 'anchor-transactions-unavailable'
    | 'anchor-create-position-required'
    | 'anchor-surface-target-unbound';

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

function resolveBinding(binding: ArticleEditorRuntimeBinding, context: CommandContext)
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
    return { reason: null, document, map: position.map };
}

/** Keep native anchor mutation surfaces closed until target binding and current impact are safe. */
export function guardArticleBlockAnchorCoreCommands(
    coreCommands: readonly FsusUiAuthoringCommand[],
    binding: ArticleEditorRuntimeBinding,
    copy: Pick<ArticleBlockAnchorCommandCopy, 'reason'>
): readonly FsusUiAuthoringCommand[]
{
    return Object.freeze(coreCommands.map(command =>
    {
        if (command.key !== 'anchor-insert' && command.key !== 'anchor-properties')
        {
            return command;
        }
        const key = command.key;
        const reason = (context: CommandContext): ArticleBlockAnchorCommandReason =>
        {
            const current = resolveBinding(binding, context);
            if (current.reason !== null)
            {
                return current.reason;
            }
            const admission = resolveArticleBlockAnchorAdmission(current.document, context,
                key === 'anchor-insert' ? 'create' : 'request-remove');
            // Opening the canonical insert form precedes its user-supplied ID. No source write is admitted here.
            if (admission.reason !== null
                && !(key === 'anchor-insert' && admission.reason === 'anchor-id-invalid' && admission.candidateId === null))
            {
                return admission.reason;
            }
            if (key === 'anchor-properties')
            {
                return 'current-impact-required';
            }
            const resolved = context.projection?.resolve(admission.nodeId!);
            const paragraph = resolved?.status === 'current' ? resolved.node : undefined;
            if (paragraph?.kind !== 'paragraph'
                || context.selection.start !== context.selection.end
                || (context.selection.start !== paragraph.rawRange.end
                    && context.selection.start !== paragraph.rawContentRanges.at(-1)?.end))
            {
                return 'anchor-create-position-required';
            }
            // The native form currently follows selection changes into existing-anchor edits.
            // Only FsusUI can bind its mutation intent/target; Blog must not duplicate that handler.
            return command.enabled?.(context) === false ? 'anchor-transactions-unavailable' : 'anchor-surface-target-unbound';
        };
        return Object.freeze<FsusUiAuthoringCommand>({
            ...command,
            enabled: () => false,
            disabledReason: context => copy.reason(reason(context)),
            run: context =>
            {
                const refusal = reason(context);
                throw new ArticleBlockAnchorCommandError(refusal, copy.reason(refusal));
            }
        });
    }));
}

/** One navigation consumer of the original owner's binding and public command session. */
export function createArticleBlockAnchorRevealCommand(
    binding: ArticleEditorRuntimeBinding,
    copy: ArticleBlockAnchorCommandCopy
): FsusUiAuthoringCommand
{
    const resolve = (context: CommandContext) =>
    {
        const current = resolveBinding(binding, context);
        if (current.reason !== null)
        {
            return current;
        }
        const document = current.document;
        const admission = resolveArticleBlockAnchorAdmission(document, context, 'reveal-source');
        if (admission.reason !== null || admission.range === null)
        {
            return { reason: admission.reason ?? 'anchor-required' as const };
        }
        try
        {
            const reveal = current.map.sourceRangeToReveal(admission.range);
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
