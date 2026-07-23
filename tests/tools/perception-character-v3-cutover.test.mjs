import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const invoker = path.join(root, 'tools/deployment/invoke-perception-character-v3-cutover.mjs');
const releaseTargetFile = path.join(
    root,
    'src/shared/Contracts/Validation/Security/perception-character-v3-release-target.json');
const releaseTarget = JSON.parse(fs.readFileSync(releaseTargetFile, 'utf8'));

function run(args, environment = {})
{
    return new Promise(resolve =>
    {
        const child = spawn(process.execPath, [invoker, ...args], {
            cwd: root,
            env: { ...process.env, ...environment },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', chunk =>
        {
            stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', chunk =>
        {
            stderr += chunk;
        });
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
}

function fixture(directory, contractDigest = releaseTarget.contractDigest)
{
    const pool = path.join(directory, 'manifest.json');
    fs.writeFileSync(pool, `${JSON.stringify({
        schema: 'fsusblog.security.perception-character-v3.pool-manifest.v1',
        generationId: 'pool-a',
        contractDigest
    }, null, 2)}\n`);
    const auth = path.join(directory, 'admin-header');
    fs.writeFileSync(auth, 'Authorization: Bearer fixture-token\n', { mode: 0o600 });
    return { pool, auth };
}

function args(port, directory, files)
{
    return [
        '--port', String(port),
        '--release-id', 'release-a',
        '--slot', 'green',
        '--generation', '42',
        '--operation-id', 'rollout-a:perception-character-v3-cutover',
        '--release-target', releaseTargetFile,
        '--pool-manifest', files.pool,
        '--policy-version', 'policy-a',
        '--admin-header-file', files.auth,
        '--origin', 'http://localhost',
        '--receipt', path.join(directory, 'receipt.json')
    ];
}

test('one-shot invoker binds release pool policy and all three schema fingerprints', async t =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-v3-cutover-'));
    const files = fixture(directory);
    let observed;
    const server = http.createServer((request, response) =>
    {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk =>
        {
            body += chunk;
        });
        request.on('end', () =>
        {
            observed = JSON.parse(body);
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({
                schemaVersion: 'fsus.security.perception-character-v3-cutover-receipt.v1',
                accepted: true,
                status: 'activated',
                dryRun: false,
                targetFingerprint: observed.target.targetFingerprint
            }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const port = server.address().port;

    const result = await run(args(port, directory, files), {
        FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE: '1'
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(observed.releaseId, 'release-a');
    assert.equal(observed.slot, 'green');
    assert.equal(observed.generation, 42);
    assert.equal(observed.target.contractDigest, releaseTarget.contractDigest);
    assert.equal(observed.target.poolGeneration, 'pool-a');
    assert.equal(observed.target.poolManifestDigest,
        createHash('sha256').update(fs.readFileSync(files.pool)).digest('hex'));
    assert.equal(observed.target.policySnapshotVersion, 'policy-a');
    assert.equal(observed.target.backendAedsSchemaFingerprint, releaseTarget.aedsSchemaFingerprint);
    assert.equal(observed.target.sharedAedsSchemaFingerprint, releaseTarget.aedsSchemaFingerprint);
    assert.equal(observed.target.frontendAedsSchemaFingerprint, releaseTarget.aedsSchemaFingerprint);
    assert.match(observed.target.targetFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8')).status, 'activated');
});

test('invoker rejects a mixed pool contract before making a request', async () =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-v3-cutover-'));
    const files = fixture(directory, 'f'.repeat(64));

    const result = await run(args(1, directory, files), {
        FSUSBLOG_GATEWAY_ALLOW_HTTP_PROBE: '1'
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pool manifest does not bind/u);
    assert.equal(fs.existsSync(path.join(directory, 'receipt.json')), false);
});
