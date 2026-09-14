import assert from 'node:assert/strict';
import test from 'node:test';

import {
    verifyHotReadProof
} from '../../tools/data-scale/semantic-proof.mjs';

function validHotReadSetup({ runId = 'run-data-scale-123' } = {})
{
    const payload = {
        items: [{ id: 1, title: 'data-scale:local:scale-m:article:1' }]
    };
    return {
        coldResponse: {
            ok: true,
            status: 200,
            generation: runId,
            payload,
            semanticDigest: 'sha256:identical-digest-abc'
        },
        warmResponse: {
            ok: true,
            status: 200,
            generation: runId,
            payload,
            semanticDigest: 'sha256:identical-digest-abc'
        },
        runtimeLease: {
            dataScaleRunId: runId
        }
    };
}

test('verifies cold read generates canary content and warm read returns identical semantic digest', () =>
{
    const { coldResponse, warmResponse, runtimeLease } = validHotReadSetup();
    const proof = verifyHotReadProof({
        coldResponse,
        warmResponse,
        runtimeLease
    });

    assert.equal(proof.status, 'ok');
    assert.equal(proof.errors.length, 0);
    assert.ok(proof.assertionIds.includes('data-scale.hotread.digest-equality'));
    assert.ok(proof.assertionIds.includes('data-scale.hotread.cache-generation'));
});

test('fails when warm read response semantic digest differs from cold read', () =>
{
    const { coldResponse, warmResponse, runtimeLease } = validHotReadSetup();
    warmResponse.semanticDigest = 'sha256:different-warm-digest-xyz';

    const proof = verifyHotReadProof({
        coldResponse,
        warmResponse,
        runtimeLease
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('hotread_semantic_digest_differ')));
});

test('fails when cold read fails', () =>
{
    const { coldResponse, warmResponse, runtimeLease } = validHotReadSetup();
    coldResponse.ok = false;
    coldResponse.status = 500;

    const proof = verifyHotReadProof({
        coldResponse,
        warmResponse,
        runtimeLease
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('hotread_cold_read_failed')));
});

test('fails when warm read fails', () =>
{
    const { coldResponse, warmResponse, runtimeLease } = validHotReadSetup();
    warmResponse.ok = false;
    warmResponse.status = 503;

    const proof = verifyHotReadProof({
        coldResponse,
        warmResponse,
        runtimeLease
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('hotread_warm_read_failed')));
});

test('fails when cache generation does not belong to current runtime lease', () =>
{
    const { coldResponse, warmResponse } = validHotReadSetup();
    warmResponse.generation = 'run-old-stale-generation';

    const proof = verifyHotReadProof({
        coldResponse,
        warmResponse,
        runtimeLease: {
            dataScaleRunId: 'run-current-fresh-123'
        }
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('hotread_cache_generation_stale')));
});

test('fails when cold or warm response is missing', () =>
{
    const proofNullCold = verifyHotReadProof({
        coldResponse: null,
        warmResponse: { ok: true, status: 200 }
    });
    assert.equal(proofNullCold.status, 'failed');
    assert.ok(proofNullCold.errors.some((e) => e.includes('missing')));

    const proofNullWarm = verifyHotReadProof({
        coldResponse: { ok: true, status: 200 },
        warmResponse: null
    });
    assert.equal(proofNullWarm.status, 'failed');
    assert.ok(proofNullWarm.errors.some((e) => e.includes('missing')));
});
