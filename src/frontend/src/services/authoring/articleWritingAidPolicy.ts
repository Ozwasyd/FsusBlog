import {
    validateArticleDocumentContext,
    type ArticleDocumentContext,
    type ArticleDocumentContextAdapter
} from './articleDocumentContext';

import type {
    MarkdownEditorFocusExemptions,
    MarkdownEditorProps,
    MarkdownEditorResolvedWritingAids
} from '@ozwasyd/element-plus';

export type ArticleWritingAidBlockedReason =
    | 'not-requested'
    | 'preference-unavailable'
    | 'document-unavailable'
    | 'stale-document'
    | 'inactive-pane'
    | 'read-only'
    | 'capability-unavailable'
    | 'overlay'
    | 'composition'
    | 'selection-drag'
    | 'assistive-navigation'
    | 'manual-scroll'
    | 'explicit-navigation'
    | 'viewport-unavailable';

export interface ArticleWritingAidDecision {
    readonly requested: boolean;
    readonly effective: boolean;
    readonly blockedReason: ArticleWritingAidBlockedReason | null;
}

/** Host facts are read from their existing owners; this policy retains no state. */
export interface ArticleWritingAidPolicyInput {
    readonly requested: Readonly<Pick<MarkdownEditorResolvedWritingAids, 'focus' | 'typewriter'>> | null;
    readonly document: ArticleDocumentContext | null;
    readonly documentOwner: Pick<ArticleDocumentContextAdapter, 'isCurrentContext'>;
    readonly editablePane: boolean;
    readonly readonly: boolean;
    readonly focusAvailable: boolean;
    readonly typewriterAvailable: boolean;
    readonly overlayActive: boolean;
    readonly composing: boolean;
    readonly selectionDragging: boolean;
    readonly assistiveNavigation: boolean;
    readonly manualScrollActive: boolean;
    readonly explicitNavigationActive: boolean;
    readonly viewportAvailable: boolean;
    readonly focusExemptions?: MarkdownEditorFocusExemptions;
}

export interface ArticleWritingAidPolicyResult {
    readonly focus: ArticleWritingAidDecision;
    readonly typewriter: ArticleWritingAidDecision;
    readonly editorProps: Readonly<Pick<MarkdownEditorProps, 'writingAids' | 'focusExemptions'>>;
}

function commonBlock(input: ArticleWritingAidPolicyInput): ArticleWritingAidBlockedReason | null
{
    if (input.requested === null)
    {
        return 'preference-unavailable';
    }
    if (!validateArticleDocumentContext(input.document))
    {
        return 'document-unavailable';
    }
    if (!input.documentOwner.isCurrentContext(input.document))
    {
        return 'stale-document';
    }
    if (!input.editablePane)
    {
        return 'inactive-pane';
    }
    if (input.readonly)
    {
        return 'read-only';
    }
    if (input.overlayActive)
    {
        return 'overlay';
    }
    if (input.composing)
    {
        return 'composition';
    }
    if (input.selectionDragging)
    {
        return 'selection-drag';
    }
    if (input.assistiveNavigation)
    {
        return 'assistive-navigation';
    }
    return null;
}

function decide(
    requested: boolean,
    commonReason: ArticleWritingAidBlockedReason | null,
    specificReason: ArticleWritingAidBlockedReason | null
): ArticleWritingAidDecision
{
    const blockedReason = commonReason === 'preference-unavailable'
        ? commonReason
        : !requested ? 'not-requested' : commonReason ?? specificReason;
    return Object.freeze({ requested, effective: blockedReason === null, blockedReason });
}

/**
 * Projects preference-owner requests into the sole mounted editor's public props.
 * The host recomputes on owner changes. FsusUI owns current blocks, input and scroll;
 * this function never creates its runtime controller or writes user preferences.
 */
export function resolveArticleWritingAidPolicy(
    input: ArticleWritingAidPolicyInput
): ArticleWritingAidPolicyResult
{
    const requested = input.requested ?? { focus: false, typewriter: false };
    const commonReason = requested.focus || requested.typewriter
        ? commonBlock(input)
        : input.requested === null ? 'preference-unavailable' : null;
    const focus = decide(requested.focus, commonReason,
        input.focusAvailable ? null : 'capability-unavailable');
    const typewriter = decide(requested.typewriter, commonReason,
        !input.typewriterAvailable ? 'capability-unavailable'
            : !input.viewportAvailable ? 'viewport-unavailable'
                : input.manualScrollActive ? 'manual-scroll'
                    : input.explicitNavigationActive ? 'explicit-navigation' : null);

    return Object.freeze({
        focus,
        typewriter,
        editorProps: Object.freeze({
            // Explicit false values revoke previously enabled options on the same editor.
            writingAids: Object.freeze({
                focus: focus.effective,
                typewriter: typewriter.effective
            }),
            focusExemptions: input.focusExemptions
        })
    });
}
