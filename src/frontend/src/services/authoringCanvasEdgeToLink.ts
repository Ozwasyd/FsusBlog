/**
 * Authoring Canvas Edge-To-Link Conversion Planner (#2487, #2489)
 *
 * Implements transaction planning and preview validation for converting
 * explicit canvas reference edges into article Markdown links.
 */

import type {
    AuthoringCanvasEdge,
    AuthoringCanvasNode
} from '@/contracts/authoringCanvas';

export interface EdgeToLinkPlan {
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

export function planEdgeToLinkConversion(
    edge: AuthoringCanvasEdge,
    nodes: Record<string, AuthoringCanvasNode>,
    targetArticleTitle: string = 'Referenced Article'
): EdgeToLinkPlan {
    if (edge.type !== 'explicit-reference-note') {
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

    if (!sourceNode || !targetNode) {
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
    let targetUrl = '';
    let targetArticleId: number | string | undefined;

    if (targetNode.type === 'article-reference') {
        targetArticleId = targetNode.targetArticleId;
        targetUrl = `/article/${targetNode.targetArticleId}`;
    } else if (targetNode.type === 'heading-reference') {
        targetArticleId = targetNode.targetArticleId;
        targetUrl = `/article/${targetNode.targetArticleId}#${targetNode.targetHeadingId}`;
    } else if (targetNode.type === 'block-reference') {
        targetArticleId = targetNode.targetArticleId;
        targetUrl = `/article/${targetNode.targetArticleId}?block=${targetNode.targetBlockId}`;
    } else {
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
    if (sourceNode.type === 'article-reference' || sourceNode.type === 'heading-reference' || sourceNode.type === 'block-reference') {
        sourceArticleId = sourceNode.targetArticleId;
    }

    const linkText = edge.label ? edge.label.trim() : targetArticleTitle;
    const generatedMarkdownLink = `[${linkText}](${targetUrl})`;

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
