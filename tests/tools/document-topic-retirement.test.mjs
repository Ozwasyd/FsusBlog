import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mapping = JSON.parse(fs.readFileSync(path.join(root, 'tests/governance/document-topic-retirement.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/development/document-lifecycle.json'), 'utf8'));
const { BuildDocumentInventory } = await import(pathToFileURL(path.join(root, 'tools/docs/document-lifecycle.mjs')).href);

function Read(relative)
{
    return fs.readFileSync(path.join(root, relative), 'utf8');
}

function HeadingAnchorExists(markdown, anchor)
{
    return markdown.split(/\r?\n/u)
        .filter((line) => /^#{1,6}\s+/u.test(line))
        .map((line) => line.replace(/^#{1,6}\s+/u, '').trim().toLowerCase()
            .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
            .replace(/\s+/gu, '-'))
        .includes(anchor);
}

test('retired issue documents map every durable section to a live semantic target', () =>
{
    assert.equal(mapping.schema, 'fsusblog.document-topic-retirement.v1');
    assert.deepEqual(mapping.relatedIssues, [399, 1013, 1014, 1430]);
    assert.equal(mapping.migrations.length, 3);

    const current = new Set(BuildDocumentInventory(root, policy).documents
        .filter((entry) => entry.status === 'current' && entry.sourceOfTruth)
        .map((entry) => entry.path));
    for (const migration of mapping.migrations)
    {
        assert.equal(fs.existsSync(path.join(root, migration.source)), false, `${migration.source} must be removed`);
        assert.ok(migration.sections.length > 0, `${migration.source} requires paragraph mappings`);
        for (const section of migration.sections)
        {
            if (section.target === null)
            {
                assert.match(section.reason, /transient|session|neither runtime contracts/iu);
                continue;
            }
            assert.ok(current.has(section.target), `${section.id} target must be a current source of truth`);
            assert.equal(HeadingAnchorExists(Read(section.target), section.anchor), true, `${section.id} anchor is missing`);
            if (section.history)
            {
                const history = policy.documents.find((entry) => entry.path === section.history);
                assert.equal(history?.status, 'historical', `${section.id} audit record must stay historical`);
            }
        }
    }
});

test('distributed invalidation has one current authority and issue numbers remain metadata', () =>
{
    const claims = policy.authorityClaims.filter((entry) => entry.id === 'distributed-cache-invalidation');
    assert.deepEqual(claims, [{
        id: 'distributed-cache-invalidation',
        path: 'docs/architecture/distributed-cache-invalidation.md'
    }]);
    const metadata = policy.documents.find((entry) => entry.path === claims[0].path);
    assert.equal(metadata?.status, 'current');
    assert.deepEqual(metadata?.relatedIssues, [399, 1430]);
    assert.equal(policy.legacyNamingCompatibility.some((entry) => mapping.migrations.some((migration) => migration.source === entry.path)), false);
});

test('per-pass release notes without executed audit evidence are not retained as history', () =>
{
    assert.equal(mapping.discardedSessionDocuments.length, 6);
    for (const discarded of mapping.discardedSessionDocuments)
    {
        assert.equal(fs.existsSync(path.join(root, discarded)), false, `${discarded} must be removed`);
        assert.equal(policy.documents.some((entry) => entry.path === discarded), false);
        assert.equal(policy.legacyNamingCompatibility.some((entry) => entry.path === discarded), false);
    }
    const evidence = JSON.parse(Read('tests/backend/runtime-fallback-evidence.json'));
    assert.equal(evidence.schema, 'fsusblog.runtime-fallback-evidence.v2');
    assert.equal(evidence.productionAudit, undefined);
    assert.equal(evidence.deliveryConstraint, undefined);
    assert.equal(evidence.releaseNotes, undefined);
    assert.equal(evidence.centralGovernanceReadback, undefined);
    assert.equal(evidence.verification, undefined);

    const identityEvidence = JSON.parse(Read('tests/backend/legacy-identity-retirement-evidence.json'));
    assert.equal(identityEvidence.schema, 'fsusblog.identity-retirement-evidence.v2');
    assert.equal(identityEvidence.retiredSurfaceInspection, undefined);
    assert.equal(identityEvidence.centralGovernanceFilesModified, undefined);
    assert.equal(identityEvidence.verification, undefined);
    assert.ok(identityEvidence.externalAcceptanceRequirements.every((entry) => entry.status === undefined));
});

test('current documentation and governance fixtures do not depend on retired paths', () =>
{
    const retired = mapping.migrations.map((entry) => entry.source);
    const repositoryFiles = [
        ...policy.documents.filter((entry) => entry.status === 'current').map((entry) => entry.path),
        'docs/planning/dead-code-audit-index.json',
        'tests/backend/legacy-identity-retirement-evidence.json',
        'tests/backend/runtime-fallback-evidence.json',
        'tests/coverage-registry.json',
        'tests/matrix.yml',
        'tests/test-asset-semantic-renames.json'
    ];
    for (const file of new Set(repositoryFiles))
    {
        const text = Read(file);
        for (const retiredPath of retired)
        {
            assert.equal(text.includes(retiredPath), false, `${file} still references ${retiredPath}`);
        }
    }
});

test('retirement mapping contains no runtime or product source target', () =>
{
    const targets = mapping.migrations.flatMap((entry) => entry.sections)
        .flatMap((entry) => [entry.target, entry.history])
        .filter(Boolean);
    assert.ok(targets.every((target) => target.startsWith('docs/')));
});
