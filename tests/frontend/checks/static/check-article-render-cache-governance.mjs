import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const cachePath = 'src/frontend/src/services/authoring/articleRenderCache.ts';
export const producerPath = 'src/frontend/src/services/authoring/articleFsusUiRenderProducer.ts';
export const policyPath = 'src/frontend/src/services/authoring/articleRenderRefreshPolicy.ts';

export function verifyRenderCacheSources(cache, producer, policy)
{
    const failures = [];
    for (const [name, source] of [['cache', cache], ['producer', producer]])
    {
        for (const [pattern, reason] of [
            [/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/u, 'persistent-body-copy'],
            [/\b(?:innerHTML|outerHTML|querySelector|DOMParser|draftHtml)\b/u, 'html-or-dom-authority'],
            [/\b(?:marked|markdownIt|parseMarkdown|renderMarkdownFallbackWithRuntime)\b/u, 'second-renderer'],
            [/\b(?:sourceHashCache|crossArticleCache|globalRenderCache)\b/u, 'source-hash-or-shared-cache'],
            [/\b(?:81920|3000)\b|80\s*\*\s*1024/u, 'second-threshold-owner']
        ])
        {
            if (pattern.test(source))
            {
                failures.push(`${name}:${reason}`);
            }
        }
    }
    for (const token of [
        "articleRenderCacheSchema = 'fsusblog.article-render-cache.v1'", 'validateArticleRenderCacheEntry',
        'validateArticleRenderReceipt', 'validateArticleRenderResult', 'adapter.subscribeContext',
        "beginTask('refresh'", 'task.signal', 'task.isCurrent()', 'task.accept(result)',
        'Promise.race', 'task.signal.removeEventListener', 'producer.verify', 'producer.release',
        'maxEntryBytes', 'maxAgeMs', 'maxReceipts', 'content: this.entry', 'cachedRevision:',
        'currentRevision:', 'lastValidTime:', 'actionIds:', 'entryRequest',
        'left.articleId === right.articleId', 'left.draftId === right.draftId',
        'left.documentId === right.documentId', 'left.documentEpoch === right.documentEpoch',
        'left.editorSessionId === right.editorSessionId', 'left.userScope === right.userScope',
        'left.siteScope === right.siteScope', 'left.draftRevision === right.draftRevision',
        'rendererVersion', 'projectionVersion', 'featureConfigurationDigest', 'themeDigest', 'locale',
        'admitArticleRenderRefreshDecision(decision, this.adapter.context, this.identity.projectionVersion)'
    ])
    {
        if (!cache.includes(token))
        {
            failures.push(`cache:missing:${token}`);
        }
    }
    for (const token of [
        "from '@/fsusui/markdown'", 'renderMarkdownWithFsusRuntime', 'createMarkdownEditorProjection',
        'resolveMarkdownSourceIdentity', 'request.signal.aborted', 'request.context.contentDigest',
        'maxResultBytes', 'this.results.size >= 2', 'projection.diagnostics', 'freezeProjection',
        'digest(retained.result) === digest(result)', 'this.results.delete(resultRef)'
    ])
    {
        if (!producer.includes(token))
        {
            failures.push(`producer:missing:${token}`);
        }
    }
    for (const [pattern, reason] of [
        [/\b(?:localStorage|sessionStorage|indexedDB|innerHTML|DOMParser|marked|markdownIt|parseMarkdown)\b/u, 'second-authority'],
        [/\bsource\.(?:match|split|replace)\s*\(/u, 'consumer-syntax-parser'],
        [/getFsusRenderPipelineAdapter|estimateMarkdownRender/u, 'private-or-invented-estimator']
    ])
    {
        if (pattern.test(policy))
        {
            failures.push(`policy:${reason}`);
        }
    }
    for (const token of [
        "articleRenderRefreshDecisionSchema = 'fsusblog.article-render-refresh-decision.v1'",
        'articleRenderSourceByteLimit = 80 * 1024;', 'articleRenderEstimatedNodeLimit = 3000;',
        'new TextEncoder().encodeInto(source, new Uint8Array(articleRenderSourceByteLimit + 4))',
        'sourceUtf8Bytes > articleRenderSourceByteLimit', 'estimatedNodeUnits > articleRenderEstimatedNodeLimit',
        'createMarkdownEditorProjection(source)', 'producedDecisions.has(decision)',
        'decision.contextDigest === context.contextDigest', 'decision.sourceDigest === context.contentDigest',
        'decision.sourceRevision === context.sourceRevision', 'decision.projectionVersion === projectionVersion',
        'decisionDigest !== digest(unsigned)', 'node.rawMarkerRanges', 'node.table?.rows.length',
        'estimatedNodeUnits += 2;', 'estimatedNodeUnits += 30;', "byteMeasurement:", "nodeMeasurement = 'lower-bound'"
    ])
    {
        if (!policy?.includes(token))
        {
            failures.push(`policy:missing:${token}`);
        }
    }
    return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const failures = verifyRenderCacheSources(fs.readFileSync(path.join(root, cachePath), 'utf8'),
        fs.readFileSync(path.join(root, producerPath), 'utf8'), fs.readFileSync(path.join(root, policyPath), 'utf8'));
    if (failures.length)
    {
        console.error(failures.join('\n'));
        process.exitCode = 1;
    }
    else
    {
        console.log('article render cache governance passed');
    }
}
