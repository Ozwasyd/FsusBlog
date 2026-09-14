import assert from 'node:assert/strict';
import test from 'node:test';

import {
    verifyAotProof
} from '../../tools/data-scale/semantic-proof.mjs';

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

function validAotSetup()
{
    return {
        aotManifest: {
            scope: 'all',
            routes: [
                { path: '/article/1', id: 1 },
                { path: '/category/10', id: 10 },
                { path: '/tag/20', id: 20 }
            ],
            runtimeLeaseDigest: 'sha256:current-lease',
            seedReceiptDigest: 'sha256:current-seed'
        },
        aotArtifacts: {
            '/article/1': {
                id: 1,
                title: 'data-scale:local:scale-m:article:1',
                html: '<html>Canary Article 1</html>'
            }
        }
    };
}

test('verifies valid AOT manifest and artifacts containing canary article', () =>
{
    const { aotManifest, aotArtifacts } = validAotSetup();
    const proof = verifyAotProof({
        aotManifest,
        aotArtifacts,
        canaries: CANARIES,
        runtimeLease: {
            runtimeLeaseDigest: 'sha256:current-lease',
            seedReceiptDigest: 'sha256:current-seed'
        }
    });

    assert.equal(proof.status, 'ok');
    assert.equal(proof.errors.length, 0);
    assert.ok(proof.assertionIds.includes('data-scale.aot.canary-payload'));
});

test('fails when AOT status is unsupported', () =>
{
    const aotManifest = { status: 'unsupported' };
    const proof = verifyAotProof({
        aotManifest,
        canaries: CANARIES
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('unsupported')));
});

test('fails when AOT status is not-configured', () =>
{
    const aotManifest = { status: 'not-configured' };
    const proof = verifyAotProof({
        aotManifest,
        canaries: CANARIES
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('unsupported_or_not_configured')));
});

test('fails when AOT manifest is missing or invalid', () =>
{
    const proof = verifyAotProof({
        aotManifest: null,
        canaries: CANARIES
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('aot_manifest_missing')));
});

test('fails when AOT manifest exists but missing canary article route', () =>
{
    const { aotArtifacts } = validAotSetup();
    const aotManifest = {
        scope: 'all',
        routes: [
            { path: '/article/999', id: 999 } // Canary article 1 is missing
        ]
    };

    const proof = verifyAotProof({
        aotManifest,
        aotArtifacts,
        canaries: CANARIES
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('aot_manifest_missing_canary_article_route')));
});

test('fails when AOT artifact has wrong title or id', () =>
{
    const { aotManifest } = validAotSetup();
    const aotArtifacts = {
        '/article/1': {
            id: 1,
            title: 'wrong-title'
        }
    };

    const proof = verifyAotProof({
        aotManifest,
        aotArtifacts,
        canaries: CANARIES
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('aot_artifact_title_mismatch')));
});

test('fails when AOT artifact is from previous run / stale seed digest', () =>
{
    const { aotManifest, aotArtifacts } = validAotSetup();
    aotManifest.seedReceiptDigest = 'sha256:old-seed-digest';

    const proof = verifyAotProof({
        aotManifest,
        aotArtifacts,
        canaries: CANARIES,
        runtimeLease: {
            seedReceiptDigest: 'sha256:current-seed-digest'
        }
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('aot_manifest_stale_seed_digest')));
});

test('fails when AOT manifest has stale runtime lease digest', () =>
{
    const { aotManifest, aotArtifacts } = validAotSetup();
    aotManifest.runtimeLeaseDigest = 'sha256:old-lease-digest';

    const proof = verifyAotProof({
        aotManifest,
        aotArtifacts,
        canaries: CANARIES,
        runtimeLease: {
            runtimeLeaseDigest: 'sha256:current-lease-digest'
        }
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('aot_manifest_stale_runtime_lease')));
});
