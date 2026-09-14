import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    DATA_SCALE_SEMANTIC_PROOF_SCHEMA,
    REQUIRED_KINDS,
    buildSemanticProofReceipt,
    verifyDatabaseProof,
    verifySemanticProofReceipt
} from '../../tools/data-scale/semantic-proof.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

function validReceiptSetup()
{
    const canaries = {
        article: { id: 1, title: 'data-scale:local:scale-m:article:1' },
        category: { id: 10, name: 'data-scale:local:scale-m:category:1' },
        tag: { id: 20, name: 'data-scale:local:scale-m:tag:1' },
        comment: { id: 100, contentPrefix: 'data-scale:local:scale-m:comment:' }
    };

    const results = {
        database: { status: 'ok', semanticDigest: 'sha256:db-digest-123', assertionIds: ['data-scale.database.counts'] },
        httpPayload: { status: 'ok', semanticDigest: 'sha256:http-digest-123', assertionIds: ['data-scale.http-payload.article-list'] },
        search: { status: 'ok', semanticDigest: 'sha256:search-digest-123', assertionIds: ['data-scale.search.canary-doc'] },
        aot: { status: 'ok', semanticDigest: 'sha256:aot-digest-123', assertionIds: ['data-scale.aot.canary-routes'] },
        hotRead: { status: 'ok', semanticDigest: 'sha256:hotread-digest-123', assertionIds: ['data-scale.hotread.digest-equality'] }
    };

    return {
        dataScaleRunId: 'run-valid-semantic-proof-1',
        runtimeLeaseDigest: 'sha256:lease-abc',
        seedReceiptDigest: 'sha256:seed-def',
        canaries,
        results
    };
}

test('builds valid receipt with fsusblog.data-scale-semantic-proof.v2 and passes verification', () =>
{
    const setup = validReceiptSetup();
    const receipt = buildSemanticProofReceipt(setup);

    assert.equal(receipt.schema, DATA_SCALE_SEMANTIC_PROOF_SCHEMA);
    assert.equal(receipt.status, 'ok');
    assert.equal(receipt.failureReasons.length, 0);
    assert.deepEqual(receipt.requiredKinds, REQUIRED_KINDS);
    assert.ok(receipt.contentDigest.startsWith('sha256:'));

    const verification = verifySemanticProofReceipt(receipt);
    assert.equal(verification.ok, true);
    assert.equal(verification.status, 'ok');
    assert.equal(verification.failureReasons.length, 0);
});

test('kills loophole: search=unsupported + aot=unsupported + hotRead=ok MUST fail closed', () =>
{
    const setup = validReceiptSetup();
    setup.results.search = { status: 'unsupported', reason: 'search not configured' };
    setup.results.aot = { status: 'unsupported', reason: 'aot not configured' };
    setup.results.hotRead = { status: 'ok', semanticDigest: 'sha256:hotread-123' };

    const receipt = buildSemanticProofReceipt(setup);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((r) => r.includes('unsupported_required_kind:search')));
    assert.ok(receipt.failureReasons.some((r) => r.includes('unsupported_required_kind:aot')));

    const verification = verifySemanticProofReceipt(receipt);
    assert.equal(verification.ok, false);
    assert.equal(verification.status, 'failed');
    assert.ok(verification.failureReasons.some((r) => r.includes('result_not_ok:search:unsupported')));
    assert.ok(verification.failureReasons.some((r) => r.includes('result_not_ok:aot:unsupported')));
});

test('fails when requiredKinds is missing any of the 5 required kinds', () =>
{
    const setup = validReceiptSetup();
    delete setup.results.aot; // Missing AOT

    const receipt = buildSemanticProofReceipt(setup);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((r) => r.includes('missing_required_kind:aot')));

    const verification = verifySemanticProofReceipt(receipt);
    assert.equal(verification.ok, false);
});

test('fails when requiredKinds contains duplicates or wrong ordering in receipt', () =>
{
    const setup = validReceiptSetup();
    const receipt = buildSemanticProofReceipt(setup);
    receipt.requiredKinds = ['database', 'httpPayload', 'search', 'aot', 'aot']; // Duplicate

    const verification = verifySemanticProofReceipt(receipt);
    assert.equal(verification.ok, false);
    assert.ok(verification.failureReasons.some((r) => r.includes('requiredKinds_must_be_exact_five')));
});

test('fails when DB counts are correct but HTTP payload lacks seeded data', () =>
    {
    const setup = validReceiptSetup();
    // DB is ok with counts
    setup.results.database = { status: 'ok', semanticDigest: 'sha256:db-digest' };
    // HTTP payload failed
    setup.results.httpPayload = {
        status: 'failed',
        errors: ['http_article_list_missing_canary']
    };

    const receipt = buildSemanticProofReceipt(setup);
    assert.equal(receipt.status, 'failed');
    assert.ok(receipt.failureReasons.some((r) => r.includes('kind_failed:httpPayload')));

    const verification = verifySemanticProofReceipt(receipt);
    assert.equal(verification.ok, false);
    assert.equal(verification.status, 'failed');
});

test('fails when canary ID or title differs from seed receipt in DB proof', () =>
{
    const seedReceipt = {
        schema: 'fsusblog.data-scale-seed-receipt.v1',
        counts: { articles: 100, comments: 1000 },
        canaries: {
            article: { id: 1, title: 'data-scale:local:scale-m:article:1' },
            category: { id: 10, name: 'data-scale:local:scale-m:category:1' },
            tag: { id: 20, name: 'data-scale:local:scale-m:tag:1' }
        },
        dbSemanticDigest: 'sha256:db-123'
    };

    // Consumer tries to guess with different canary
    const guessedCanaries = {
        article: { id: 999, title: 'wrong-guessed-title' },
        category: { id: 10, name: 'data-scale:local:scale-m:category:1' },
        tag: { id: 20, name: 'data-scale:local:scale-m:tag:1' }
    };

    const proof = verifyDatabaseProof({
        seedReceipt,
        counts: { articles: 100, comments: 1000 },
        canaries: guessedCanaries,
        dbSemanticDigest: 'sha256:db-123'
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('database_canary_article_id_mismatch')));
});

test('fails when receipt content digest is tampered', () =>
{
    const setup = validReceiptSetup();
    const receipt = buildSemanticProofReceipt(setup);
    assert.equal(verifySemanticProofReceipt(receipt).ok, true);

    // Tamper with dataScaleRunId
    receipt.dataScaleRunId = 'tampered-run-id';
    const tamperedVerification = verifySemanticProofReceipt(receipt);
    assert.equal(tamperedVerification.ok, false);
    assert.ok(tamperedVerification.failureReasons.some((r) => r.includes('contentDigest_mismatch')));
});

test('fails when seed receipt semantic digest mismatches DB observed semantic digest', () =>
{
    const seedReceipt = {
        schema: 'fsusblog.data-scale-seed-receipt.v1',
        counts: { articles: 1, comments: 0 },
        canaries: {
            article: { id: 1, title: 'data-scale:local:scale-xs:article:1' },
            category: { id: 10, name: 'data-scale:local:scale-xs:category:1' },
            tag: { id: 20, name: 'data-scale:local:scale-xs:tag:1' }
        },
        dbSemanticDigest: 'sha256:expected-digest-123'
    };

    const proof = verifyDatabaseProof({
        seedReceipt,
        counts: { articles: 1, comments: 0 },
        canaries: seedReceipt.canaries,
        dbSemanticDigest: 'sha256:mismatched-digest-999'
    });

    assert.equal(proof.status, 'failed');
    assert.ok(proof.errors.some((e) => e.includes('database_semantic_digest_mismatch')));
});

test('driver rejects summary.json with legacy or missing schema instead of fsusblog.data-scale-semantic-proof.v2', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-driver-schema-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const scaleXsDir = path.join(temp, 'scale-xs');
    fs.mkdirSync(scaleXsDir, { recursive: true });

    const mockProbe = path.join(temp, 'mock-probe.sh');
    fs.writeFileSync(mockProbe, `#!/bin/bash
cat << 'EOF' > "${temp}/scale-xs/summary.json"
{
  "status": "ok",
  "schema": "fsusblog.legacy-summary.v1"
}
EOF
exit 0
`, { mode: 0o755 });

    const dataScaleLane = path.join(root, 'tools/test/lanes/data-scale.sh');
    const res = spawnSync('bash', [dataScaleLane, 'scale-xs'], {
        cwd: root,
        env: {
            ...process.env,
            FSUSBLOG_DATA_SCALE_ROOT: temp,
            FSUSBLOG_DATA_SCALE_PROBE_SCRIPT: mockProbe,
            FSUSBLOG_POSTGRES_CONTAINER_NAME: 'dedicated-postgres-container'
        },
        encoding: 'utf8'
    });

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /summary\.json schema must be fsusblog\.data-scale-semantic-proof\.v2/);
});

test('verifies receipt retains extra observational fields and handles releaseReliability binding', () =>
{
    const setup = validReceiptSetup();
    const receipt = buildSemanticProofReceipt({
        ...setup,
        tier: 'scale-m',
        sampling: { requests: 12, concurrency: 2 }
    });

    assert.equal(receipt.tier, 'scale-m');
    assert.deepEqual(receipt.sampling, { requests: 12, concurrency: 2 });

    // Attach releaseReliability as writeReleaseReliabilityAuthority would
    const withBinding = {
        ...receipt,
        releaseReliability: {
            invocationId: 'inv-1',
            runId: 'run-1'
        }
    };

    const verification = verifySemanticProofReceipt(withBinding);
    assert.equal(verification.ok, true);
    assert.equal(verification.status, 'ok');
});
