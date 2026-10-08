import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cachePath, producerPath, policyPath, verifyRenderCacheSources } from './check-article-render-cache-governance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const cache = fs.readFileSync(path.join(root, cachePath), 'utf8');
const producer = fs.readFileSync(path.join(root, producerPath), 'utf8');
const policy = fs.readFileSync(path.join(root, policyPath), 'utf8');

test('canonical current sources satisfy static governance', () =>
{
    assert.deepEqual(verifyRenderCacheSources(cache, producer, policy), []);
});
for (const mutation of [
    'localStorage.setItem("html", "body");', 'draftHtml = body;', 'element.innerHTML = html;',
    'const sourceHashCache = new Map();', 'const crossArticleCache = new Map();', 'marked(source);',
    'const threshold = 81920;'
])
{
    test(`rejects forbidden authority: ${mutation}`, () =>
    {
        assert.ok(verifyRenderCacheSources(`${cache}\n${mutation}`, producer, policy).length > 0);
    });
}
for (const token of ['left.articleId === right.articleId', 'left.documentEpoch === right.documentEpoch',
    'left.userScope === right.userScope', 'task.accept(result)', 'content: this.entry', 'task.signal',
    'producer.verify', 'maxEntryBytes', 'featureConfigurationDigest'])
{
    test(`rejects omitted binding/control: ${token}`, () =>
    {
        assert.ok(cache.includes(token));
        assert.ok(verifyRenderCacheSources(cache.replaceAll(token, 'removedControl'), producer, policy).length > 0);
    });
}
for (const token of ['articleRenderSourceByteLimit = 80 * 1024;', 'articleRenderEstimatedNodeLimit = 3000;',
    'producedDecisions.has(decision)', 'decision.contextDigest === context.contextDigest',
    'decision.sourceRevision === context.sourceRevision', 'decisionDigest !== digest(unsigned)',
    'new TextEncoder().encodeInto(source, new Uint8Array(articleRenderSourceByteLimit + 4))'])
{
    test(`rejects threshold authority/control mutation: ${token}`, () =>
    {
        assert.ok(policy.includes(token));
        assert.ok(verifyRenderCacheSources(cache, producer, policy.replaceAll(token, 'removedControl')).length > 0);
    });
}
for (const mutation of ['source.match(/^#{1,6}/g);', 'getFsusRenderPipelineAdapter("markdown-renderer");',
    'localStorage.setItem("policy", "allowed");'])
{
    test(`rejects forbidden policy authority: ${mutation}`, () =>
    {
        assert.ok(verifyRenderCacheSources(cache, producer, `${policy}\n${mutation}`).length > 0);
    });
}
test('rejects cache admission bypass', () =>
{
    assert.ok(verifyRenderCacheSources(cache.replaceAll(
        'admitArticleRenderRefreshDecision(decision, this.adapter.context, this.identity.projectionVersion)', 'true'), producer, policy).length > 0);
});
