import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRolloutState } from '../../tools/deployment/release-rollout-lib.mjs';
import { createCurrentRolloutFixtureBinding } from './support/release-rollout-evidence-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const verifier = path.join(root, 'tools/deployment/verify-release-challenge-kind-cutover.mjs');

function write(directory, name, value)
{
    const file = path.join(directory, name);
    fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
    return file;
}

function fixtures(directory)
{
    const identity = { releaseId: '20261003010101-bbbbbbbbbbbb', slot: 'green', generation: 42 };
    const state = createRolloutState({ ...createCurrentRolloutFixtureBinding(),
        rolloutId: 'deploy-release-1368', manifestPath: path.join(directory, 'manifest.json'),
        source: { slot: 'blue', releaseId: '20261002010101-aaaaaaaaaaaa', imageDigest: `sha256:${'a'.repeat(64)}`, runtimeGeneration: 41 },
        target: { slot: identity.slot, releaseId: identity.releaseId, imageDigest: `sha256:${'b'.repeat(64)}`, runtimeGeneration: identity.generation } });
    // Component-only state at the existing destructive boundary, not a production rollout receipt.
    Object.assign(state, { status: 'running', currentStage: 'source-drain', switchCommitted: true,
        gatewayGeneration: 1, destructiveCutoverStarted: true, activationCommitted: false });
    const releaseTarget = {
        schema: 'fsusblog.security.perception-character-v3-release-target.v1',
        contractDigest: 'b'.repeat(64),
        aedsSchemaFingerprint: 'c'.repeat(64),
        targetFingerprint: 'd'.repeat(64)
    };
    const poolManifest = {
        schema: 'fsusblog.security.perception-character-v3.pool-manifest.v1',
        generationId: 'pool-generation-a',
        contractDigest: releaseTarget.contractDigest
    };
    const pool = write(directory, 'pool.json', poolManifest);
    const poolDigest = createHash('sha256').update(fs.readFileSync(pool)).digest('hex');
    return {
        identity,
        policyVersion: 'policy-a',
        state: write(directory, 'state.json', state),
        fence: write(directory, 'fence.json', { operation: 'status', result: { accepted: true }, request: { endpoint: `http://127.0.0.1:8082/api/ops/deployment/fence/status?releaseId=${identity.releaseId}&slot=${identity.slot}&generation=${identity.generation}` } }),
        acceptance: write(directory, 'acceptance.json', { schemaVersion: 'fsus.security-challenge-kind-cutover-acceptance.v1', accepted: true, operationId: 'op', targetFingerprint: 'a'.repeat(64), ...identity }),
        releaseTarget: write(directory, 'release-target.json', releaseTarget),
        pool,
        perceptionV3: write(directory, 'perception-v3.json', {
            schemaVersion: 'fsus.security.perception-character-v3-cutover-receipt.v1',
            accepted: true,
            status: 'activated',
            dryRun: false,
            contractDigest: releaseTarget.contractDigest,
            backendAedsSchemaFingerprint: releaseTarget.aedsSchemaFingerprint,
            sharedAedsSchemaFingerprint: releaseTarget.aedsSchemaFingerprint,
            frontendAedsSchemaFingerprint: releaseTarget.aedsSchemaFingerprint,
            poolGeneration: poolManifest.generationId,
            poolManifestDigest: poolDigest,
            policySnapshotVersion: 'policy-a',
            ...identity
        }),
        assets: write(directory, 'assets.json', { status: 'ok', releaseId: identity.releaseId, slot: identity.slot }),
        aot: write(directory, 'aot.json', { routes: [{ settled: { releaseId: identity.releaseId, releaseSlot: identity.slot } }] })
    };
}

function verify(values, out)
{
    return spawnSync(process.execPath, [verifier,
        '--rollout-state', values.state, '--active-fence', values.fence,
        '--cutover-acceptance', values.acceptance, '--asset-materialization', values.assets,
        '--perception-v3-cutover', values.perceptionV3,
        '--release-target', values.releaseTarget,
        '--pool-manifest', values.pool,
        '--policy-version', values.policyVersion,
        '--public-aot-warm', values.aot, '--out', out
    ], { cwd: root, encoding: 'utf8' });
}

test('rollout contract has one fail-closed cutover caller', () =>
{
    const result = spawnSync(process.execPath, [path.join(root, 'tools/deployment/check-challenge-kind-cutover-rollout-contract.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
});

test('binding gate accepts one release slot generation across backend frontend assets and cutover', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cutover-rollout-'));
    const values = fixtures(directory);
    const out = path.join(directory, 'gate.json');
    const result = verify(values, out);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).bindings, { backendFence: true, frontend: true, staticAssets: true, cutover: true, perceptionCharacterV3: true });
});

test('binding gate fails closed on generation or asset release mismatch', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cutover-rollout-'));
    const values = fixtures(directory);
    values.acceptance = write(directory, 'acceptance-bad.json', { schemaVersion: 'fsus.security-challenge-kind-cutover-acceptance.v1', accepted: true, operationId: 'op', targetFingerprint: 'a'.repeat(64), ...values.identity, generation: 43 });
    values.perceptionV3 = write(directory, 'perception-v3-bad.json', {
        ...JSON.parse(fs.readFileSync(values.perceptionV3, 'utf8')),
        frontendAedsSchemaFingerprint: 'e'.repeat(64)
    });
    values.assets = write(directory, 'assets-bad.json', { status: 'ok', releaseId: 'release-other', slot: values.identity.slot });
    const out = path.join(directory, 'gate.json');
    const result = verify(values, out);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.status, 'fail');
    assert.match(report.errors.join('\n'), /generation|static asset|PerceptionCharacterV3/u);
});
