import {
    MARKDOWN_ANCHOR_ID,
    collectMarkdownAnchorNodes,
    normalizeMarkdownSource,
    type MarkdownEditorCommandContext
} from '@/fsusui/articleBlockAnchors';

import {
    createArticleDocumentContext,
    validateArticleDocumentContext,
    type ArticleDocumentContext
} from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest } from './openArticleDocumentRegistry';

export type ArticleBlockAnchorAction = 'create' | 'rename' | 'request-remove' | 'reveal-source';
export type ArticleBlockAnchorAdmissionReason =
    | 'command-aborted'
    | 'document-stale'
    | 'editor-readonly'
    | 'projection-unavailable'
    | 'projection-stale'
    | 'source-node-unavailable'
    | 'source-node-stale'
    | 'anchor-diagnostic'
    | 'anchor-required'
    | 'anchor-already-present'
    | 'anchor-id-invalid'
    | 'anchor-id-duplicate'
    | 'current-impact-required';

type AnchorNode = ReturnType<typeof collectMarkdownAnchorNodes>[number];
type AnchorDiagnostic = Extract<AnchorNode, { readonly ok: false; }>;

export interface ArticleBlockAnchorAdmission {
    readonly schema: 'fsusblog.article-block-anchor-admission.v1';
    readonly document: ArticleDocumentContext;
    readonly action: ArticleBlockAnchorAction;
    readonly status: 'admitted' | 'blocked' | 'impact-required';
    readonly reason: ArticleBlockAnchorAdmissionReason | null;
    readonly nodeId: string | null;
    readonly range: Readonly<{ start: number; end: number; }> | null;
    readonly anchorId: string | null;
    readonly candidateId: string | null;
    readonly diagnostic: Readonly<Pick<AnchorDiagnostic, 'code' | 'range'>> | null;
    readonly contentDigest: string;
}

/** Local preflight only. It grants neither source mutation nor refactor permission. */
export function resolveArticleBlockAnchorAdmission(
    document: ArticleDocumentContext,
    command: MarkdownEditorCommandContext,
    action: ArticleBlockAnchorAction,
    candidateId?: string
): ArticleBlockAnchorAdmission
{
    const syntax = command.syntax;
    let reason: ArticleBlockAnchorAdmissionReason | null = null;
    let anchorId: string | null = null;
    let diagnostic: ArticleBlockAnchorAdmission['diagnostic'] = null;

    if (command.signal.aborted)
    {
        reason = 'command-aborted';
    }
    else if (!validateArticleDocumentContext(document)
        || command.documentIdentity.id !== document.documentId
        || command.documentIdentity.epoch !== document.documentEpoch
        || command.revision !== document.sourceRevision
        || createArticleDocumentContext({
            ...document, content: command.value, contentDigest: undefined
        }).contextDigest !== document.contextDigest)
    {
        reason = 'document-stale';
    }
    else if (command.readonly && action !== 'reveal-source')
    {
        reason = 'editor-readonly';
    }
    else if (!command.projection)
    {
        reason = 'projection-unavailable';
    }
    else if (command.projection.documentIdentity.id !== document.documentId
        || command.projection.documentIdentity.epoch !== document.documentEpoch
        || command.projection.normalizedSource !== normalizeMarkdownSource(command.value))
    {
        reason = 'projection-stale';
    }
    else if (!syntax)
    {
        reason = 'source-node-unavailable';
    }
    else
    {
        const resolved = command.projection.resolve(syntax.nodeId);
        if (resolved.status !== 'current' || resolved.node?.kind !== syntax.type || resolved.node.status !== syntax.status
            || resolved.node.blockIdentity !== syntax.blockIdentity
            || resolved.node.rawRange.start !== syntax.range.start
            || resolved.node.rawRange.end !== syntax.range.end)
        {
            reason = 'source-node-stale';
        }
        else
        {
            const inventory = collectMarkdownAnchorNodes(command.value);
            const invalid = inventory.find((node): node is AnchorDiagnostic => !node.ok);
            if (invalid)
            {
                diagnostic = Object.freeze({
                    code: invalid.code,
                    range: Object.freeze({ ...invalid.range })
                });
                reason = 'anchor-diagnostic';
            }
            else if (syntax.status !== 'valid')
            {
                reason = 'source-node-stale';
            }
            else
            {
                const anchor = inventory.find(node => node.ok && syntax.type === 'anchor'
                    && node.ranges.full.start === syntax.range.start
                    && node.ranges.full.end === syntax.range.end);
                anchorId = anchor?.ok ? anchor.id : null;
                if (action === 'create' && anchorId !== null)
                {
                    reason = 'anchor-already-present';
                }
                else if (action !== 'create' && anchorId === null)
                {
                    reason = 'anchor-required';
                }
                else if (action === 'create' || action === 'rename')
                {
                    // Require the public validator's match to cover every supplied byte.
                    if (typeof candidateId !== 'string'
                        || MARKDOWN_ANCHOR_ID.exec(candidateId)?.[0] !== candidateId)
                    {
                        reason = 'anchor-id-invalid';
                    }
                    else if (inventory.some(node => node.ok && node.id === candidateId))
                    {
                        reason = 'anchor-id-duplicate';
                    }
                }
                if (reason === null && (action === 'rename' || action === 'request-remove'))
                {
                    reason = 'current-impact-required';
                }
            }
        }
    }

    const body = Object.freeze({
        schema: 'fsusblog.article-block-anchor-admission.v1' as const,
        document,
        action,
        status: reason === null ? 'admitted' as const
            : reason === 'current-impact-required' ? 'impact-required' as const : 'blocked' as const,
        reason,
        nodeId: reason === 'document-stale' || reason === 'command-aborted' ? null : syntax?.nodeId ?? null,
        range: reason === 'document-stale' || reason === 'command-aborted' || !syntax
            ? null : Object.freeze({ ...syntax.range }),
        anchorId,
        candidateId: typeof candidateId === 'string' && candidateId.length <= 64 ? candidateId : null,
        diagnostic
    });
    return Object.freeze({ ...body, contentDigest: calculateOpenArticleDocumentDigest(body) });
}

/** Recompute from current public facts; a self-consistent reseal is insufficient. */
export function verifyArticleBlockAnchorAdmission(
    admission: ArticleBlockAnchorAdmission,
    document: ArticleDocumentContext,
    command: MarkdownEditorCommandContext,
    candidateId?: string
): boolean
{
    const current = resolveArticleBlockAnchorAdmission(document, command, admission.action, candidateId);
    return document.contextDigest === admission.document.contextDigest
        && JSON.stringify(current) === JSON.stringify(admission);
}
