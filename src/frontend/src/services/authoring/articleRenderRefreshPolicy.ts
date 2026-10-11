import { MARKDOWN_RENDERER_VERSION, createMarkdownEditorProjection } from '@/fsusui/markdown';

import {
    articleDocumentContextSchema, validateArticleDocumentContext,
    type ArticleDocumentContext
} from './articleDocumentContext';
import { calculateOpenArticleDocumentDigest as digest } from './openArticleDocumentRegistry';

export const articleRenderRefreshDecisionSchema = 'fsusblog.article-render-refresh-decision.v1' as const;
export const articleRenderSourceByteLimit = 80 * 1024;
export const articleRenderEstimatedNodeLimit = 3000;

export interface ArticleRenderRefreshDecision {
    readonly schema: typeof articleRenderRefreshDecisionSchema;
    readonly contextDigest: string;
    readonly sourceDigest: string;
    readonly sourceRevision: number;
    readonly projectionVersion: string;
    readonly sourceUtf8Bytes: number;
    readonly byteMeasurement: 'exact' | 'lower-bound';
    readonly lineCount: number | null;
    readonly estimatedNodeUnits: number | null;
    readonly nodeMeasurement: 'not-run' | 'exact' | 'lower-bound';
    readonly allowed: boolean;
    readonly reason: 'render-source-byte-limit' | 'render-estimated-node-limit' | 'render-policy-projection-failed' | null;
    readonly decisionDigest: string;
}

// Content-free, weak provenance: serialized/re-digested caller decisions cannot authorize rendering.
const producedDecisions = new WeakSet<ArticleRenderRefreshDecision>();
const decisionKeys = ['schema', 'contextDigest', 'sourceDigest', 'sourceRevision', 'projectionVersion',
    'sourceUtf8Bytes', 'byteMeasurement', 'lineCount', 'estimatedNodeUnits', 'nodeMeasurement',
    'allowed', 'reason', 'decisionDigest'];
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function validateArticleRenderRefreshDecision(value: unknown): value is ArticleRenderRefreshDecision
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== decisionKeys.length || !decisionKeys.every(key => Object.hasOwn(value, key)))
    {
        return false;
    }
    const decision = value as ArticleRenderRefreshDecision;
    if (decision.schema !== articleRenderRefreshDecisionSchema || !isDigest(decision.contextDigest)
        || !isDigest(decision.sourceDigest) || !isDigest(decision.decisionDigest)
        || !isCount(decision.sourceRevision) || decision.projectionVersion !== MARKDOWN_RENDERER_VERSION
        || !isCount(decision.sourceUtf8Bytes) || !['exact', 'lower-bound'].includes(decision.byteMeasurement)
        || typeof decision.allowed !== 'boolean')
    {
        return false;
    }
    const { decisionDigest, ...unsigned } = decision;
    if (decisionDigest !== digest(unsigned))
    {
        return false;
    }
    if (decision.sourceUtf8Bytes > articleRenderSourceByteLimit)
    {
        return !decision.allowed && decision.reason === 'render-source-byte-limit'
            && decision.lineCount === null && decision.estimatedNodeUnits === null && decision.nodeMeasurement === 'not-run';
    }
    if (decision.byteMeasurement !== 'exact' || !isCount(decision.lineCount))
    {
        return false;
    }
    if (decision.reason === 'render-policy-projection-failed')
    {
        return !decision.allowed && decision.estimatedNodeUnits === null && decision.nodeMeasurement === 'not-run';
    }
    if (!isCount(decision.estimatedNodeUnits) || decision.estimatedNodeUnits < decision.lineCount)
    {
        return false;
    }
    return decision.estimatedNodeUnits > articleRenderEstimatedNodeLimit
        ? !decision.allowed && decision.reason === 'render-estimated-node-limit'
            && ['exact', 'lower-bound'].includes(decision.nodeMeasurement)
        : decision.allowed && decision.reason === null && decision.nodeMeasurement === 'exact';
}

export function admitArticleRenderRefreshDecision(
    decision: ArticleRenderRefreshDecision,
    context: ArticleDocumentContext,
    projectionVersion: string
): boolean
{
    return producedDecisions.has(decision) && validateArticleRenderRefreshDecision(decision)
        && decision.contextDigest === context.contextDigest && decision.sourceDigest === context.contentDigest
        && decision.sourceRevision === context.sourceRevision && decision.projectionVersion === projectionVersion;
}

// Sole threshold producer. Syntax facts belong to FsusUI; this computes a resource budget, not an AST/DOM.
export function evaluateArticleRenderRefreshPolicy(context: ArticleDocumentContext, source: string): ArticleRenderRefreshDecision
{
    if (!validateArticleDocumentContext(context) || typeof source !== 'string'
        || digest({ schema: articleDocumentContextSchema, content: source }) !== context.contentDigest)
    {
        throw new Error('article-render-policy-source-invalid');
    }
    // Four extra bytes fit any next UTF-8 scalar. Above-limit results honestly report a lower bound.
    const encoded = new TextEncoder().encodeInto(source, new Uint8Array(articleRenderSourceByteLimit + 4));
    const sourceUtf8Bytes = encoded.written;
    let lineCount: number | null = null;
    let estimatedNodeUnits: number | null = null;
    let nodeMeasurement: ArticleRenderRefreshDecision['nodeMeasurement'] = 'not-run';
    let reason: ArticleRenderRefreshDecision['reason'] = 'render-source-byte-limit';
    if (sourceUtf8Bytes <= articleRenderSourceByteLimit)
    {
        lineCount = source.length === 0 ? 0 : 1;
        for (let index = 0; index < source.length; index += 1)
        {
            if (source.charCodeAt(index) === 10)
            {
                lineCount += 1;
            }
        }
        estimatedNodeUnits = lineCount;
        nodeMeasurement = 'lower-bound';
        reason = 'render-estimated-node-limit';
        if (estimatedNodeUnits <= articleRenderEstimatedNodeLimit)
        {
            try
            {
                const projection = createMarkdownEditorProjection(source);
                if (projection.identity.rawSource !== source || projection.identity.version !== MARKDOWN_RENDERER_VERSION)
                {
                    throw new Error('article-render-policy-projection-invalid');
                }
                const listMarkers = new Set<string>();
                for (const node of projection.nodes)
                {
                    if (node.kind === 'heading')
                    {
                        estimatedNodeUnits += 2;
                    }
                    else if (node.kind === 'list' || node.kind === 'task')
                    {
                        for (const marker of node.rawMarkerRanges)
                        {
                            const key = `${marker.start}:${marker.end}`;
                            if (!listMarkers.has(key))
                            {
                                listMarkers.add(key);
                                estimatedNodeUnits += 2;
                            }
                        }
                    }
                    else if (node.kind === 'table')
                    {
                        estimatedNodeUnits += (node.table?.rows.length ?? 0) * 3;
                    }
                    else if (node.diagnosticCode === 'unclosed-code-fence' || node.diagnosticCode === 'unclosed-mermaid')
                    {
                        estimatedNodeUnits += 30;
                    }
                    else if (node.kind === 'code' || node.kind === 'mermaid')
                    {
                        estimatedNodeUnits += node.rawMarkerRanges.filter(marker => marker.end - marker.start >= 3).length * 30;
                    }
                    if (estimatedNodeUnits > articleRenderEstimatedNodeLimit)
                    {
                        break;
                    }
                }
                if (estimatedNodeUnits <= articleRenderEstimatedNodeLimit)
                {
                    nodeMeasurement = 'exact';
                    reason = null;
                }
            }
            catch
            {
                estimatedNodeUnits = null;
                nodeMeasurement = 'not-run';
                reason = 'render-policy-projection-failed';
            }
        }
    }
    const unsigned = { schema: articleRenderRefreshDecisionSchema, contextDigest: context.contextDigest,
        sourceDigest: context.contentDigest, sourceRevision: context.sourceRevision, projectionVersion: MARKDOWN_RENDERER_VERSION,
        sourceUtf8Bytes, byteMeasurement: encoded.read === source.length ? 'exact' as const : 'lower-bound' as const,
        lineCount, estimatedNodeUnits, nodeMeasurement, allowed: reason === null, reason };
    const decision = Object.freeze({ ...unsigned, decisionDigest: digest(unsigned) });
    producedDecisions.add(decision);
    return decision;
}
