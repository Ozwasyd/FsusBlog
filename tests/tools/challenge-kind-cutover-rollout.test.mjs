import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
    const identity = { releaseId: 'release-1368', slot: 'green', generation: 42 };
    return {
        identity,
        state: write(directory, 'state.json', { schema: 'fsusblog.release-rollout-state.v1', rolloutId: 'deploy-release-1368', currentStage: 'source-drain', destructiveCutoverStarted: true, activationCommitted: false, target: { releaseId: identity.releaseId, slot: identity.slot, runtimeGeneration: identity.generation } }),
        fence: write(directory, 'fence.json', { operation: 'status', result: { accepted: true }, request: { endpoint: `http://127.0.0.1:8082/api/ops/deployment/fence/status?releaseId=${identity.releaseId}&slot=${identity.slot}&generation=${identity.generation}` } }),
        acceptance: write(directory, 'acceptance.json', { schemaVersion: 'fsus.security-challenge-kind-cutover-acceptance.v1', accepted: true, operationId: 'op', targetFingerprint: 'a'.repeat(64), ...identity }),
        protocol: write(directory, 'protocol.json', { schemaVersion: 'fsus.security-challenge-protocol-activation.v1', accepted: true, status: 'open', operationId: 'op', targetFingerprint: 'a'.repeat(64), ...identity }),
        assets: write(directory, 'assets.json', { status: 'ok', releaseId: identity.releaseId, slot: identity.slot }),
        aot: write(directory, 'aot.json', { routes: [{ settled: { releaseId: identity.releaseId, releaseSlot: identity.slot } }] })
    };
}

function verify(values, out)
{
    return spawnSync(process.execPath, [verifier,
        '--rollout-state', values.state, '--active-fence', values.fence,
        '--cutover-acceptance', values.acceptance, '--asset-materialization', values.assets,
        '--protocol-activation', values.protocol,
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
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).bindings, { backendFence: true, frontend: true, staticAssets: true, cutover: true, protocolActivation: true });
});

test('binding gate fails closed on generation or asset release mismatch', () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cutover-rollout-'));
    const values = fixtures(directory);
    values.acceptance = write(directory, 'acceptance-bad.json', { schemaVersion: 'fsus.security-challenge-kind-cutover-acceptance.v1', accepted: true, operationId: 'op', targetFingerprint: 'a'.repeat(64), ...values.identity, generation: 43 });
    values.assets = write(directory, 'assets-bad.json', { status: 'ok', releaseId: 'release-other', slot: values.identity.slot });
    const out = path.join(directory, 'gate.json');
    const result = verify(values, out);
    assert.notEqual(result.status, 0);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(report.status, 'fail');
    assert.match(report.errors.join('\n'), /generation|static asset/u);
});
