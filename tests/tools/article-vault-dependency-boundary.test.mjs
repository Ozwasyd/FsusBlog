import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDependencyBoundary, inspectDependencySource } from '../../tools/governance/check-article-vault-dependency-boundary.mjs';

test('actual dependency adapters retain their source boundary', () =>
{
    assert.deepEqual(checkDependencyBoundary(), []);
});

for (const [name, source] of [
    ['remote-fetch', 'using System.Net.Http; HttpClient client;'],
    ['direct-storage', 'File.ReadAllBytes(path);'],
    ['direct-ledger', 'ISqlSugarClient db;'],
    ['rendered-scan', 'HtmlParser parser;'],
    ['second-index', 'ConcurrentDictionary<string, AssetRecord> ledger;'],
    ['string-target', 'public record Target(string AssetIdentity);']
])
{
    test(`rejects ${name} in the adapter boundary`, () =>
    {
        assert.match(inspectDependencySource(source, 'candidate.cs').join('\n'), new RegExp(name));
    });
}

test('canonical typed identities, local projections and digest comparisons remain allowed', () =>
{
    assert.deepEqual(inspectDependencySource('AssetId expected; AssetRecord record; ArticleEmbedTargetIdentity Target; var projection = record.StorageKey; SHA256.HashData(bytes);', 'candidate.cs'), []);
});
