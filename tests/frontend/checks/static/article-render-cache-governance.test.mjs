import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cachePath, producerPath, verifyRenderCacheSources } from './check-article-render-cache-governance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const cache = fs.readFileSync(path.join(root, cachePath), 'utf8');
const producer = fs.readFileSync(path.join(root, producerPath), 'utf8');

test('canonical current sources satisfy static governance', () =>
{
    assert.deepEqual(verifyRenderCacheSources(cache, producer), []);
});
for (const mutation of [
    'localStorage.setItem("html", "body");', 'draftHtml = body;', 'element.innerHTML = html;',
    'const sourceHashCache = new Map();', 'const crossArticleCache = new Map();', 'marked(source);',
    'const threshold = 81920;'
])
{
    test(`rejects forbidden authority: ${mutation}`, () =>
    {
        assert.ok(verifyRenderCacheSources(`${cache}\n${mutation}`, producer).length > 0);
    });
}
for (const token of ['left.articleId === right.articleId', 'left.documentEpoch === right.documentEpoch',
    'left.userScope === right.userScope', 'task.accept(result)', 'content: this.entry', 'task.signal',
    'producer.verify', 'maxEntryBytes', 'featureConfigurationDigest'])
{
    test(`rejects omitted binding/control: ${token}`, () =>
    {
        assert.ok(cache.includes(token));
        assert.ok(verifyRenderCacheSources(cache.replaceAll(token, 'removedControl'), producer).length > 0);
    });
}
