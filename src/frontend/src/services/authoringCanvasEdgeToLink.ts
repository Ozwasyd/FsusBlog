/**
 * Authoring Canvas Edge-To-Link Conversion Planner (#2487, #2489)
 *
 * Implements transaction planning and preview validation for converting
 * explicit canvas reference edges into article Markdown links.
 */
import type { AuthoringCanvasEdge, AuthoringCanvasNode } from '@/contracts/authoringCanvas';
import { buildPublicArticleHref } from '@/public-renderers/publicRouteIdentity';
export interface EdgeToLinkPlan
{
    edgeId: string;
    edgeType: string;
    valid: boolean;
    reason?: string;
    sourceNodeId: string;
    targetNodeId: string;
    sourceArticleId?: number | string;
    targetArticleId?: number | string;
    targetTitle?: string;
    generatedMarkdownLink?: string;
    insertPosition: 'end_of_document' | 'below_heading' | 'custom';
}
export interface EdgeToLinkCommitRequest
{
    requestId: string;
    canvasId: string;
    canvasRevision: number;
    canvasContentDigest: string;
    sourceArticleId: number | string;
    expectedArticleRevision: number | string;
    targetArticleId: number | string;
    expectedTargetRevision: number | string;
    plan: EdgeToLinkPlan;
}
export interface EdgeToLinkReceipt
{
    requestId: string;
    sourceArticleId: number | string;
    previousArticleRevision: number | string;
    articleRevision: number | string;
}
export interface EdgeToLinkHistoryRequest
{
    requestId: string;
    sourceArticleId: number | string;
    expectedArticleRevision: number | string;
    targetJournalId: string;
}
export interface EdgeToLinkHistory
{
    sourceArticleId: number | string;
    articleRevision: number | string;
    historyArticleRevision: number | string;
    lastJournalId: string | null;
    undoEntries: readonly {
        journalId: string;
    }[];
    redoEntries: readonly {
        journalId: string;
    }[];
}
export type EdgeToLinkPendingWrite = {
    kind: 'commit';
    request: EdgeToLinkCommitRequest;
} | {
    kind: 'undo' | 'redo';
    request: EdgeToLinkHistoryRequest;
};
/** The existing article editor owns this explicit CAS transaction capability and its separate history. */
export interface EdgeToLinkTransaction
{
    pendingWrite?(): EdgeToLinkPendingWrite | null;
    retryPending?(): Promise<EdgeToLinkReceipt>;
    commit(request: EdgeToLinkCommitRequest): Promise<EdgeToLinkReceipt>;
    history(sourceArticleId: number | string): Promise<EdgeToLinkHistory>;
    undo(request: EdgeToLinkHistoryRequest): Promise<EdgeToLinkReceipt>;
    redo(request: EdgeToLinkHistoryRequest): Promise<EdgeToLinkReceipt>;
}
function linkTextOrTitle(value: string | undefined, title: string): string
{
    if (value)
    {
        return value;
    }
    return title;
}
export function planEdgeToLinkConversion(edge: AuthoringCanvasEdge, nodes: Record<string, AuthoringCanvasNode>, targetArticleTitle = 'Referenced Article'): EdgeToLinkPlan
{
    if (edge.type !== 'explicit-reference-note')
    {
        return {
            edgeId: edge.id,
            edgeType: edge.type,
            valid: false,
            reason: 'Only "explicit-reference-note" edges can be converted to Markdown links. Visual-only edges cannot be converted.',
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            insertPosition: 'end_of_document'
        };
    }
    const sourceNode = nodes[edge.sourceNodeId];
    const targetNode = nodes[edge.targetNodeId];
    if ((targetNode?.type === 'heading-reference' && !/^[a-z][a-z0-9-]{0,63}$/u.test(targetNode.targetHeadingId))
        || (targetNode?.type === 'block-reference' && !/^[a-z][a-z0-9-]{0,63}$/u.test(targetNode.targetBlockId)))
    {
        return { edgeId: edge.id, edgeType: edge.type, valid: false, reason: 'Target anchor identity is not canonical.',
            sourceNodeId: edge.sourceNodeId, targetNodeId: edge.targetNodeId, insertPosition: 'end_of_document' };
    }
    if (!sourceNode || !targetNode)
    {
        return {
            edgeId: edge.id,
            edgeType: edge.type,
            valid: false,
            reason: 'One or both edge endpoints are missing from the canvas document.',
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            insertPosition: 'end_of_document'
        };
    }
    // Determine target link URL and label
    let targetUrl: string;
    let targetArticleId: number | string | undefined;
    if (targetNode.type === 'article-reference')
    {
        targetArticleId = targetNode.targetArticleId;
        targetUrl = buildPublicArticleHref(targetNode.targetArticleId);
    }
    else if (targetNode.type === 'heading-reference')
    {
        targetArticleId = targetNode.targetArticleId;
        targetUrl = `${buildPublicArticleHref(targetNode.targetArticleId)}#${targetNode.targetHeadingId}`;
    }
    else if (targetNode.type === 'block-reference')
    {
        targetArticleId = targetNode.targetArticleId;
        targetUrl = `${buildPublicArticleHref(targetNode.targetArticleId)}#${targetNode.targetBlockId}`;
    }
    else
    {
        return {
            edgeId: edge.id,
            edgeType: edge.type,
            valid: false,
            reason: 'Target endpoint must be an article, heading, or block reference.',
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            insertPosition: 'end_of_document'
        };
    }
    let sourceArticleId: number | string | undefined;
    if (sourceNode.type === 'article-reference' || sourceNode.type === 'heading-reference' || sourceNode.type === 'block-reference')
    {
        sourceArticleId = sourceNode.targetArticleId;
    }
    const linkText = linkTextOrTitle(edge.label?.trim(), targetArticleTitle);
    const escapedLinkText = linkText.replace(/[\\[\]]/gu, '\\$&').replace(/[\r\n]/gu, ' ');
    const generatedMarkdownLink = `[${escapedLinkText}](${targetUrl})`;
    return {
        edgeId: edge.id,
        edgeType: edge.type,
        valid: true,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        sourceArticleId,
        targetArticleId,
        targetTitle: targetArticleTitle,
        generatedMarkdownLink,
        insertPosition: 'end_of_document'
    };
}
