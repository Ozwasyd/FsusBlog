import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const fixture = path.join(root, 'tools/test/backend-trx-contract-fixture.sh');
const suiteSupport = path.join(root, 'tools/test/lanes/_suite-support.sh');

test('controlled filtered-lane dry-run writes stable lane TRX files and passing result content', (t) =>
{
    const trxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-backend-trx-'));
    t.after(() => fs.rmSync(trxRoot, { recursive: true, force: true }));
    const result = spawnSync('bash', [
        fixture,
        'backend-unit',
        'backend-property',
        'coverage-backend'
    ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, FSUSBLOG_BACKEND_TRX_DIR: trxRoot }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(trxRoot).sort(), [
        'backend-property.trx',
        'backend-unit.trx',
        'coverage-backend.trx'
    ]);
    const manifest = JSON.parse(result.stdout.trim());
    assert.equal(manifest.schema, 'fsusblog.backend-trx-dry-run.v1');
    assert.equal(manifest.status, 'dry-run');
    assert.deepEqual(manifest.lanes, ['backend-unit', 'backend-property', 'coverage-backend']);

    for (const lane of manifest.lanes)
    {
        const trx = fs.readFileSync(path.join(trxRoot, `${lane}.trx`), 'utf8');
        assert.match(trx, /<TestRun\b/u);
        assert.match(trx, /<UnitTestResult testName="BackendTrxContractDryRun" outcome="Passed"/u);
        assert.match(trx, /<Counters total="1" executed="1" passed="1" failed="0"/u);
    }
});

test('backend test runtime cleanup removes only regenerated data and storage roots', (t) =>
{
    const buildRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fsusblog-backend-output-'));
    t.after(() => fs.rmSync(buildRoot, { recursive: true, force: true }));
    const output = path.join(
        buildRoot,
        'dotnet/FsusBlog.Server.Tests/bin/Debug/net10.0'
    );
    const data = path.join(output, 'data');
    const storage = path.join(output, 'storage');
    const assembly = path.join(output, 'FsusBlog.Server.Tests.dll');
    const sibling = path.join(output, 'runtime-evidence');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(storage, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(data, 'key.xml'), 'runtime');
    fs.writeFileSync(path.join(storage, 'state.json'), '{}');
    fs.writeFileSync(path.join(sibling, 'receipt.json'), '{}');
    fs.writeFileSync(assembly, 'assembly');

    const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$1"
export FSUSBLOG_PRODUCTION_BUILD_ROOT="$2"
export FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug
CleanupBackendTestRuntimeOutput
`, 'bash', suiteSupport, buildRoot], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(data), false);
    assert.equal(fs.existsSync(storage), false);
    assert.equal(fs.readFileSync(assembly, 'utf8'), 'assembly');
    assert.equal(fs.readFileSync(path.join(sibling, 'receipt.json'), 'utf8'), '{}');
});
