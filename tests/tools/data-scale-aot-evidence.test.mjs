import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    DATA_SCALE_AOT_RECEIPT_SCHEMA,
    DATA_SCALE_AOT_REBUILD_COMMAND,
    assertAotRebuildSupported,
    buildAotRebuildManifest,
    materializeAotRebuildArtifacts,
    rebuildDataScalePublicAot
} from '../../tools/data-scale/aot-evidence.mjs';
import { verifyAotProof } from '../../tools/data-scale/semantic-proof.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

const CANARIES = Object.freeze({
    article: {
        id: 1,
        title: 'data-scale:local:scale-m:article:1'
    },
    category: {
        id: 10,
        name: 'data-scale:local:scale-m:category:1'
    },
    tag: {
        id: 20,
        name: 'data-scale:local:scale-m:tag:1'
    }
});

const RUNTIME_LEASE = Object.freeze({
    dataScaleRunId: 'run-data-scale-aot-1',
    runtimeLeaseDigest: 'sha256:current-lease',
    seedReceiptDigest: 'sha256:current-seed'
});

test('seed.sh no longer emits rebuilds.aot.status unsupported', () =>
{
    const seedSource = fs.readFileSync(path.join(root, 'tools/data-scale/seed.sh'), 'utf8');
    assert.doesNotMatch(
        seedSource,
        /aot:\s*\{[^}]*status:\s*"unsupported"/su,
        'seed.sh must not leave AOT unsupported as the success path'
    );
    assert.match(seedSource, /aot-evidence\.mjs rebuild/u);
    assert.match(seedSource, /status:\s*"probe-required"/u);
});

test('assertAotRebuildSupported fails closed for unsupported/not-configured', () =>
{
    for (const status of ['unsupported', 'not-configured'])
    {
        const result = assertAotRebuildSupported({ status, reason: 'legacy' });
        assert.equal(result.ok, false);
        assert.equal(result.status, 'failed');
        assert.ok(result.errors.some((e) => e.includes(status)));
    }
    assert.equal(assertAotRebuildSupported({ status: 'probe-required' }).ok, true);
});

test('rebuild owner materializes ok current-run AOT proof artifacts', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-aot-rebuild-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const result = rebuildDataScalePublicAot({
        aotRoot: temp,
        canaries: CANARIES,
        runtimeLease: RUNTIME_LEASE,
        dataScaleRunId: RUNTIME_LEASE.dataScaleRunId,
        seedEntry: { status: 'probe-required', command: DATA_SCALE_AOT_REBUILD_COMMAND }
    });

    assert.equal(result.status, 'ok', result.errors?.join('; '));
    assert.ok(result.artifactCount > 0);
    assert.ok(result.sizeBytes > 0);
    assert.equal(result.receipt.schema, DATA_SCALE_AOT_RECEIPT_SCHEMA);
    assert.ok(fs.existsSync(path.join(temp, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(temp, 'article-1.json')));

    const manifest = JSON.parse(fs.readFileSync(path.join(temp, 'manifest.json'), 'utf8'));
    const artifacts = {
        '/article/1': JSON.parse(fs.readFileSync(path.join(temp, 'article-1.json'), 'utf8'))
    };
    const proof = verifyAotProof({
        aotManifest: manifest,
        aotArtifacts: artifacts,
        canaries: CANARIES,
        runtimeLease: RUNTIME_LEASE
    });
    assert.equal(proof.status, 'ok', proof.errors.join('; '));
});

test('rebuild fails closed when seed entry is unsupported', () =>
{
    const result = rebuildDataScalePublicAot({
        aotRoot: '/tmp/unused-aot-root',
        canaries: CANARIES,
        runtimeLease: RUNTIME_LEASE,
        seedEntry: { status: 'unsupported', reason: 'legacy gap' }
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('unsupported')));
});

test('rebuild fails closed when canary article is missing', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-aot-missing-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const result = materializeAotRebuildArtifacts({
        aotRoot: temp,
        canaries: { category: CANARIES.category },
        runtimeLease: RUNTIME_LEASE
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('canary') || e.includes('article')));
});

test('rebuild fails when authoritative artifact title mismatches canary', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-aot-mismatch-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const result = rebuildDataScalePublicAot({
        aotRoot: temp,
        canaries: CANARIES,
        runtimeLease: RUNTIME_LEASE,
        routeArtifacts: {
            '/article/1': {
                id: 1,
                title: 'stale-pre-seed-title',
                html: '<html>stale-pre-seed-title</html>'
            }
        }
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('aot_artifact_title_mismatch')));
});

test('manifest builder rejects unsupported status', () =>
{
    const manifest = buildAotRebuildManifest({
        canaries: CANARIES,
        runtimeLease: RUNTIME_LEASE,
        status: 'unsupported'
    });
    assert.equal(manifest.status, 'failed');
    assert.ok(manifest.errors.some((e) => e.includes('unsupported')));
});

test('requireAuthoritativePayload fails closed without warmed payloads', () =>
{
    const result = rebuildDataScalePublicAot({
        aotRoot: '/tmp/unused',
        canaries: CANARIES,
        runtimeLease: RUNTIME_LEASE,
        requireAuthoritativePayload: true,
        routeArtifacts: {}
    });
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some((e) => e.includes('authoritative_payload_missing')));
});
