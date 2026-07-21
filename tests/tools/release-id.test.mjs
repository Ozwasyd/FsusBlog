import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    LOCAL_RELEASE_ID,
    RELEASE_ID_CONTRACT,
    assertReleaseIdentity,
    compareReleaseIds,
    createReleaseId,
    createReleaseIdentitySnapshot,
    parseReleaseId,
    renderGeneratedContracts,
    validateReleaseId
} = await import(pathToFileURL(path.join(root, 'tools/release/release-id.mjs')).href);

const fixtures = JSON.parse(fs.readFileSync(
    path.join(root, 'tests/fixtures/release/release-id-cases.json'),
    'utf8'
));

test('contract fixes the UTC14 plus sha12 release ID authority', () =>
{
    assert.deepEqual(RELEASE_ID_CONTRACT, {
        schema: 'fsusblog.release-id-contract.v1',
        regex: '^[0-9]{14}-[0-9a-f]{12}$',
        localSentinel: 'local-unversioned',
        timestampFormat: 'yyyyMMddHHmmss',
        timestampDigits: 14,
        shaDigits: 12
    });
    assert.equal(LOCAL_RELEASE_ID, 'local-unversioned');
});

test('createReleaseId uses UTC seconds and the lowercase commit prefix', () =>
{
    assert.equal(
        createReleaseId({
            createdAtUtc: '2026-02-28T01:02:03.987Z',
            commitSha: fixtures.identity.commitSha
        }),
        fixtures.identity.releaseId
    );
    assert.equal(
        createReleaseId(new Date('2026-02-28T01:02:03Z'), fixtures.identity.commitSha),
        fixtures.identity.releaseId
    );
    assert.throws(() => createReleaseId('2026-02-28T01:02:03Z', fixtures.identity.commitSha.toUpperCase()), /lowercase/u);
    assert.throws(() => createReleaseId('2026-02-30T01:02:03Z', fixtures.identity.commitSha), /real UTC/u);
    assert.throws(() => createReleaseId('2026-02-28T09:02:03+08:00', fixtures.identity.commitSha), /real UTC/u);
});

test('identity snapshot captures release ID UTC second and commit exactly once', () =>
{
    assert.deepEqual(createReleaseIdentitySnapshot({
        createdAtUtc: fixtures.identity.createdAtUtc,
        commitSha: fixtures.identity.commitSha
    }), {
        releaseId: fixtures.identity.releaseId,
        createdAtUtc: '2026-02-28T01:02:03.987Z',
        commitSha: fixtures.identity.commitSha
    });
});

test('parse and validate reject fake calendar dates aliases semver and malformed IDs', () =>
{
    for (const releaseId of fixtures.valid)
    {
        assert.deepEqual(validateReleaseId(releaseId), [], releaseId);
        assert.equal(parseReleaseId(releaseId)?.releaseId, releaseId);
    }
    for (const releaseId of fixtures.invalid)
    {
        assert.notDeepEqual(validateReleaseId(releaseId), [], releaseId);
        assert.equal(parseReleaseId(releaseId), null, releaseId);
    }
    assert.deepEqual(validateReleaseId(LOCAL_RELEASE_ID, { allowLocalSentinel: true }), []);
    assert.notDeepEqual(validateReleaseId(LOCAL_RELEASE_ID, { allowLocalSentinel: true, forPublication: true }), []);
});

test('assertReleaseIdentity cross-checks commit and UTC creation time', () =>
{
    const parsed = assertReleaseIdentity(fixtures.identity);
    assert.equal(parsed.commitShaPrefix, '0123456789ab');
    assert.equal(parsed.createdAtUtc, '2026-02-28T01:02:03.000Z');
    assert.throws(
        () => assertReleaseIdentity({ ...fixtures.identity, commitSha: `f${fixtures.identity.commitSha.slice(1)}` }),
        /commit prefix/u
    );
    assert.throws(
        () => assertReleaseIdentity({ ...fixtures.identity, createdAtUtc: '2026-02-28T01:02:04Z' }),
        /timestamp/u
    );
    assert.throws(
        () => assertReleaseIdentity({ ...fixtures.identity, createdAtUtc: '2026-02-28T09:02:03+08:00' }),
        /ISO UTC/u
    );
    assert.throws(
        () => assertReleaseIdentity({ ...fixtures.identity, releaseId: LOCAL_RELEASE_ID }),
        /cannot identify a published release/u
    );
});

test('compareReleaseIds provides stable chronological then commit ordering', () =>
{
    assert.equal(compareReleaseIds(fixtures.valid[0], fixtures.valid[0]), 0);
    assert.equal(compareReleaseIds(fixtures.valid[0], fixtures.valid[1]), 1);
    assert.equal(compareReleaseIds('20260228010203-0123456789ab', '20260228010203-abcdef012345'), -1);
    assert.throws(() => compareReleaseIds('v1.2.3', fixtures.valid[0]), /left releaseId/u);
});

test('generator is deterministic and check mode detects no drift', () =>
{
    const generated = renderGeneratedContracts();
    assert.deepEqual(generated.map(item => item.path), [
        'src/backend/Infrastructure/Operations/ReleaseIdContract.Generated.cs',
        'src/frontend/src/generated/releaseIdContract.ts',
        'src/frontend/public/generated/release-id-contract.js'
    ]);
    assert.equal(generated[0].content, fs.readFileSync(path.join(root, generated[0].path), 'utf8'));

    const allGeneratedFilesExist = generated.every(item => fs.existsSync(path.join(root, item.path)));
    const result = spawnSync(process.execPath, [
        path.join(root, 'tools/release/release-id.mjs'),
        '--check'
    ], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    if (allGeneratedFilesExist)
    {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /generated contracts are in sync/u);
    }
    else
    {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /is stale/u);
    }
});

test('stable shell CLI exposes create parse validate assert and compare operations', () =>
{
    const tool = path.join(root, 'tools/release/release-id.mjs');
    const run = (...args) => spawnSync(process.execPath, [tool, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000
    });
    const created = run(
        'create',
        '--created-at-utc', fixtures.identity.createdAtUtc,
        '--commit-sha', fixtures.identity.commitSha
    );
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.stdout.trim(), fixtures.identity.releaseId);

    for (const command of ['parse', 'validate'])
    {
        const result = run(command, fixtures.identity.releaseId);
        assert.equal(result.status, 0, result.stderr);
    }
    const asserted = run(
        'assert',
        '--release-id', fixtures.identity.releaseId,
        '--created-at-utc', fixtures.identity.createdAtUtc,
        '--commit-sha', fixtures.identity.commitSha
    );
    assert.equal(asserted.status, 0, asserted.stderr);
    assert.equal(JSON.parse(asserted.stdout).releaseId, fixtures.identity.releaseId);
    assert.equal(run('compare', fixtures.valid[0], fixtures.valid[1]).stdout.trim(), '1');
    assert.notEqual(run('validate', 'v1.2.0').status, 0);
    assert.notEqual(run('validate', LOCAL_RELEASE_ID).status, 0);

    const snapshot = run(
        'snapshot',
        '--created-at-utc', fixtures.identity.createdAtUtc,
        '--commit-sha', fixtures.identity.commitSha,
        '--format', 'lines'
    );
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.deepEqual(snapshot.stdout.trim().split('\n'), [
        fixtures.identity.releaseId,
        fixtures.identity.createdAtUtc,
        fixtures.identity.commitSha
    ]);
});
