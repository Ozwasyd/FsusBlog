import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifier = fileURLToPath(new URL('../../tools/security/verify-security-challenge-kind-cutover.mjs', import.meta.url));
const targets = [
    { numericKind: 3, wireName: ['cap', 'tchaV1'].join('') },
    { numericKind: 10, wireName: ['perception', 'CharacterV2'].join('') },
    { numericKind: 13, wireName: ['perception', 'TextTaskV2'].join('') }
];

function fingerprint(value)
{
    const canonical = value
        .toSorted((left, right) => left.numericKind - right.numericKind || left.wireName.localeCompare(right.wireName, 'en'))
        .map((target) => `${target.numericKind}\0${target.wireName}\n`)
        .join('');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function receipt()
{
    return {
        schemaVersion: 'fsus.security-challenge-kind-cutover-receipt.v1',
        operationId: 'operation-a',
        requestFingerprint: 'a'.repeat(64),
        releaseId: 'release-a',
        slot: 'green',
        generation: 42,
        numericKinds: [3, 10, 13],
        targetFingerprint: fingerprint(targets),
        dryRun: false,
        accepted: true,
        idempotent: false,
        status: 'applied',
        errorCode: null,
        fenceVerifiedBefore: true,
        fenceVerifiedImmediatelyBeforeMutation: true,
        fenceVerifiedAfter: true,
        v2AttemptKeys: 2,
        v2UsedKeys: 1,
        envelopesExamined: 4,
        envelopesRevoked: 1,
        revokedEnvelopeIdsDigest: 'b'.repeat(64),
        completedAtUtc: '2026-07-21T00:00:00Z'
    };
}

function fixture(expectedTargets = targets, candidateReceipt = receipt())
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-kind-cutover-verifier-'));
    const targetPath = path.join(root, 'targets.json');
    const receiptPath = path.join(root, 'receipt.json');
    fs.writeFileSync(targetPath, JSON.stringify(expectedTargets));
    fs.writeFileSync(receiptPath, JSON.stringify(candidateReceipt));
    return { targetPath, receiptPath };
}

function run(paths)
{
    return spawnSync(process.execPath, [
        verifier,
        '--receipt', paths.receiptPath,
        '--targets', paths.targetPath,
        '--release-id', 'release-a',
        '--slot', 'green',
        '--generation', '42'
    ], { encoding: 'utf8' });
}

test('verifier accepts a receipt bound to the independently supplied target map', () =>
{
    const result = run(fixture());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).targetFingerprint, fingerprint(targets));
});

test('verifier rejects a fresh wrong operator map before it can validate a receipt', () =>
{
    const remapped = targets.map((target) => target.numericKind === 10
        ? { ...target, wireName: 'localization/v2' }
        : target);
    const mismatch = run(fixture(remapped));
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /target mapping is not the authoritative retired mapping/u);
});

test('verifier rejects a tampered receipt fingerprint', () =>
{
    const tampered = { ...receipt(), targetFingerprint: 'c'.repeat(64) };
    const tamperResult = run(fixture(targets, tampered));
    assert.notEqual(tamperResult.status, 0);
    assert.match(tamperResult.stderr, /target mapping does not match operator expectation/u);
});

test('verifier rejects a different numeric target set', () =>
{
    const wrongNumericSet = targets.map((target) => target.numericKind === 13
        ? { ...target, numericKind: 14 }
        : target);
    const result = run(fixture(wrongNumericSet));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /complete retired numeric set/u);
});
