import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationPath = 'config/governance/release-document-migrations.json';
const migration = JSON.parse(fs.readFileSync(path.join(root, migrationPath), 'utf8'));
const lifecycle = JSON.parse(fs.readFileSync(path.join(root, 'config/development/document-lifecycle.json'), 'utf8'));

const expectedSources = [
    'docs/issue-1024-release-identity-handoff.md',
    'docs/issue-1025-blue-green-slots-handoff.md',
    'docs/issue-1026-gateway-switch-handoff.md',
    'docs/issue-1027-deployment-lifecycle-handoff.md',
    'docs/issue-1028-online-migration-handoff.md',
    'docs/issue-1029-storage-lifecycle-handoff.md',
    'docs/issue-1029-1031-service-worker-browser-handoff.md',
    'docs/issue-1030-active-release-fencing-handoff.md',
    'docs/issue-1031-asset-compatibility-handoff.md',
    'docs/issue-1031-documentation-handoff.json',
    'docs/issue-1031-migration-qualification-handoff.md',
    'docs/issue-1031-notification-evidence-handoff.md',
    'docs/issue-1031-release-evidence-handoff.md',
    'docs/issue-1031-traffic-probe-handoff.md',
    'docs/issue-1031-worker-normal-observer-handoff.md',
    'docs/issue-1031-worker-reconciliation-handoff.md',
    'docs/issue-1031-zero-downtime-rehearsal-handoff.md',
    'docs/issue-1041-executable-data-test-governance.md'
];

function Read(relativePath)
{
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function Walk(directory)
{
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const absolute = path.join(directory, entry.name);
        return entry.isDirectory() ? Walk(absolute) : [absolute];
    });
}

test('release document migration registry maps every retired handoff exactly once', () =>
{
    assert.equal(migration.schema, 'fsusblog.release-document-migrations.v1');
    assert.deepEqual(migration.entries.map(({ source }) => source).sort(), expectedSources.toSorted());
    assert.equal(new Set(migration.entries.map(({ source }) => source)).size, expectedSources.length);

    for (const entry of migration.entries)
    {
        assert.equal(fs.existsSync(path.join(root, entry.source)), false, entry.source);
        assert.match(entry.disposition, /^(absorbed-current-contract|split-current-contract|delete-implementation-snapshot)$/u);

        if (entry.disposition === 'delete-implementation-snapshot')
        {
            assert.equal(entry.canonicalTarget, null);
            continue;
        }

        assert.equal(typeof entry.canonicalTarget, 'string');
        assert.equal(fs.existsSync(path.join(root, entry.canonicalTarget)), true, entry.canonicalTarget);
        assert.doesNotMatch(entry.canonicalTarget, /(?:issue-\d+|handoff|release-final|production-fresh)/u);
        for (const supporting of entry.supportingTargets ?? [])
        {
            assert.equal(fs.existsSync(path.join(root, supporting)), true, supporting);
            assert.doesNotMatch(supporting, /(?:issue-\d+|handoff|release-final|production-fresh)/u);
        }
    }
});

test('current release authorities are unique and carry explicit issue metadata', () =>
{
    const requiredAuthorities = new Map([
        ['release-identity', 'docs/releases/release-identity.md'],
        ['blue-green-deployment', 'docs/releases/blue-green-deployment-runbook.md'],
        ['release-storage-lifecycle', 'docs/architecture/release-storage-lifecycle.md'],
        ['online-database-migration', 'docs/online-database-migration.md'],
        ['active-release-fencing', 'docs/active-release-fencing.md'],
        ['release-evidence-model', 'docs/release-evidence-model.md'],
        ['release-browser-contract', 'docs/testing/browser-contract.md'],
        ['zero-downtime-release-qualification', 'docs/releases/zero-downtime-release-runbook.md']
    ]);
    const claims = new Map(lifecycle.authorityClaims.map(({ id, path: authorityPath }) => [id, authorityPath]));
    assert.equal(claims.size, lifecycle.authorityClaims.length);

    for (const [id, authorityPath] of requiredAuthorities)
    {
        assert.equal(claims.get(id), authorityPath);
        const document = lifecycle.documents.find(({ path: documentPath }) => documentPath === authorityPath);
        assert.equal(document?.status, 'current');
        assert.ok(document.relatedIssues.includes(1431), authorityPath);
    }
});

test('current documentation does not depend on retired release handoff paths', () =>
{
    const retiredTokens = expectedSources.map((source) => path.basename(source));
    for (const absolute of Walk(path.join(root, 'docs')))
    {
        if (!/\.(?:md|json)$/u.test(absolute))
        {
            continue;
        }
        const relative = path.relative(root, absolute);
        const content = fs.readFileSync(absolute, 'utf8');
        for (const token of retiredTokens)
        {
            assert.equal(content.includes(token), false, `${relative} references ${token}`);
        }
    }
});

test('release evidence contract separates schemas, receipts and implementation handoff', () =>
{
    const model = Read('docs/release-evidence-model.md');
    assert.match(model, /Evidence schema[\s\S]+security\/evidence-contracts\/[\s\S]+tests\/fixtures\//u);
    assert.match(model, /Execution receipt[\s\S]+\.tmp\/release-evidence\/<release-identity>\//u);
    assert.match(model, /Implementation handoff[\s\S]+issue\/PR history/u);
    assert.match(model, /cannot substitute for a schema or receipt/u);

    const runbook = Read('docs/releases/zero-downtime-release-runbook.md');
    for (const responsibility of ['HTTP session and AEDS traffic', 'Browser and retained assets', 'Notification restart and replay', 'Normal worker completion', 'Forced-source reconciliation', 'Schema migration qualification'])
    {
        assert.match(runbook, new RegExp(responsibility, 'u'));
    }
    assert.match(runbook, /do not assert that an external rollout or rehearsal ran/u);

    for (const { source } of migration.retiredSupportAssets)
    {
        assert.equal(fs.existsSync(path.join(root, source)), false, source);
    }
    const attestation = JSON.parse(Read('security/evidence-contracts/active-release-fencing-implementation.json'));
    assert.equal(attestation.evidenceClass, 'implementation-attestation');
    assert.equal(attestation.freshExecution, false);
    assert.equal(attestation.releaseBound, false);
    assert.equal(attestation.productionFreshRun, false);
    assert.equal('validation' in attestation, false);
});
