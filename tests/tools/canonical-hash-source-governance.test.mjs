import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath)
{
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const canonicalSources = [
    'src/core/Integrity/ArticleCanonicalHashV1.cs',
    'src/core/Integrity/ArticleRightsCanonicalHashV1.cs'
];

test('canonical hash source boundary keeps core free of runtime and external dependencies', () =>
{
    const forbiddenNamespaces = [
        'FsusBlog.Server',
        'Microsoft.AspNetCore',
        'SqlSugar',
        'StackExchange.Redis',
        'System.Net.Http',
        'System.Reflection'
    ];
    for (const relativePath of canonicalSources)
    {
        const source = read(relativePath);
        for (const namespace of forbiddenNamespaces)
        {
            assert.doesNotMatch(source, new RegExp(`^using ${namespace.replaceAll('.', '\\.')}`, 'mu'), relativePath);
        }
        assert.doesNotMatch(source, /\bdynamic\b/u, relativePath);
    }

    const project = read('src/core/FsusBlog.Core.csproj');
    for (const dependency of ['src/backend', 'FsusBlog.Server', 'SqlSugar', 'Nethereum', 'IPFS', 'Arweave'])
    {
        assert.equal(project.toLowerCase().includes(dependency.toLowerCase()), false, dependency);
    }
});

test('rights canonical writer keeps the governed buffer writer boundary', () =>
{
    const source = read('src/core/Integrity/ArticleRightsCanonicalHashV1.cs');
    assert.match(source, /new ArrayBufferWriter<byte>\(/u);
    assert.match(source, /WritePayload\(IBufferWriter<byte> writer/u);
    assert.doesNotMatch(source, /\bJsonSerializer\b/u);
});

test('ownership catalog maps every canonical contract to current behavior manifest and golden owners', () =>
{
    const ownership = JSON.parse(read('tests/backend/Fixtures/canonical-hash-test-ownership.json'));
    const golden = JSON.parse(read('tests/backend/Fixtures/canonical-hash-golden-vectors.json'));
    const currentOwners = [
        'tests/backend/Unit/ArticleCanonicalHashTests.cs',
        'tests/backend/Unit/ArticleRightsCanonicalHashTests.cs',
        'tests/backend/Unit/IntegrityVerificationManifestServiceTests.cs'
    ].map(read).join('\n');

    assert.equal(ownership.schema, 'fsusblog.canonical-hash-test-ownership.v1');
    assert.equal(golden.schema, 'fsusblog.canonical-hash-golden-vectors.v1');
    assert.deepEqual(ownership.contracts.map(({ id }) => id), ['article-content-v1', 'article-rights-v1']);
    assert.equal(ownership.contracts.length, golden.vectors.length);
    assert.equal(ownership.governanceOwner, 'tests/tools/canonical-hash-source-governance.test.mjs');

    for (const contract of ownership.contracts)
    {
        assert.ok(golden.vectors.some((vector) =>
            vector.contract === contract.id.replace('-v1', '')), contract.id);
        const owners = [contract.goldenOwner, ...contract.behaviorOwners, ...contract.manifestOwners];
        for (const owner of owners)
        {
            assert.match(currentOwners, new RegExp(`\\b${owner.split('.').at(-1)}\\b`, 'u'), owner);
        }
    }
});

test('product behavior tests do not own runtime shape or payload fragment assertions', () =>
{
    for (const relativePath of [
        'tests/backend/Unit/ArticleCanonicalHashTests.cs',
        'tests/backend/Unit/ArticleRightsCanonicalHashTests.cs'
    ])
    {
        const source = read(relativePath);
        for (const forbidden of [
            'RuntimeMetadataInspection',
            'GetReferencedAssemblies',
            'Assert.Contains("\\n',
            'Assert.StartsWith("fsusblog.'
        ])
        {
            assert.equal(source.includes(forbidden), false, `${relativePath}: ${forbidden}`);
        }
    }
});
