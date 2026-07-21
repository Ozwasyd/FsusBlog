#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const schemaVersion = 'fsus.security-challenge-kind-cutover-receipt.v1';
const evidenceVersion = 'fsus.security-challenge-kind-cutover-acceptance.v1';
const expectedTargetFingerprint = '48e9440c0b09fcd494d11f3773d7190f703bcb1295c171c3242ea9d3ea484c19';

function parseArgs(argv)
{
    const options = new Map();
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error(`invalid argument near ${name ?? '<end>'}`);
        }
        options.set(name.slice(2), value);
    }
    return options;
}

function required(options, name)
{
    const value = options.get(name)?.trim();
    if (!value)
    {
        throw new Error(`--${name} is required`);
    }
    return value;
}

function positiveInteger(value, name)
{
    if (!/^\d+$/.test(value) || Number(value) <= 0)
    {
        throw new Error(`${name} must be a positive integer`);
    }
    return Number(value);
}

function normalizeTargets(value)
{
    assert(Array.isArray(value), 'expected targets must be an array');
    const result = value.map((target) => ({
        numericKind: positiveInteger(String(target?.numericKind ?? ''), 'target numericKind'),
        wireName: String(target?.wireName ?? '').trim()
    })).sort((left, right) => left.numericKind - right.numericKind || left.wireName.localeCompare(right.wireName, 'en'));
    assert(result.every((target) => target.wireName.length > 0), 'target wireName is required');
    assert(new Set(result.map((target) => target.numericKind)).size === result.length, 'target numeric kinds must be unique');
    assert(new Set(result.map((target) => target.wireName)).size === result.length, 'target wire names must be unique');
    assert(JSON.stringify(result.map((target) => target.numericKind)) === JSON.stringify([3, 10, 13]), 'targets must match the complete retired numeric set');
    assert(targetFingerprint(result) === expectedTargetFingerprint, 'target mapping is not the authoritative retired mapping');
    return result;
}

function targetFingerprint(targets)
{
    const canonical = targets.map((target) => `${target.numericKind}\0${target.wireName}\n`).join('');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function hexDigest(value, label)
{
    if (!/^[a-f0-9]{64}$/.test(value))
    {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

const options = parseArgs(process.argv.slice(2));
const receiptPath = required(options, 'receipt');
const expectedTargets = normalizeTargets(JSON.parse(await readFile(required(options, 'targets'), 'utf8')));
const expected = {
    releaseId: required(options, 'release-id'),
    slot: required(options, 'slot'),
    generation: positiveInteger(required(options, 'generation'), 'generation'),
    numericKinds: expectedTargets.map((target) => target.numericKind),
    targetFingerprint: targetFingerprint(expectedTargets)
};

const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
assert(receipt.schemaVersion === schemaVersion, 'receipt schema is not supported');
assert(receipt.releaseId === expected.releaseId, 'receipt release id does not match');
assert(receipt.slot === expected.slot, 'receipt slot does not match');
assert(receipt.generation === expected.generation, 'receipt generation does not match');
assert(JSON.stringify(receipt.numericKinds) === JSON.stringify(expected.numericKinds), 'receipt numeric kinds do not match');
assert(receipt.targetFingerprint === expected.targetFingerprint, 'receipt target mapping does not match operator expectation');
assert(receipt.accepted === true, 'cutover was not accepted');
assert(receipt.fenceVerifiedBefore === true, 'active release fence was not verified before cutover');
assert(receipt.fenceVerifiedImmediatelyBeforeMutation === true, 'active release fence was not verified immediately before mutation');
assert(receipt.fenceVerifiedAfter === true, 'active release fence was not verified after cutover');
assert(receipt.dryRun === false, 'receipt only represents a dry run');
assert(receipt.status === 'applied', 'cutover does not have applied status');
hexDigest(receipt.requestFingerprint, 'request fingerprint');
assert(typeof receipt.operationId === 'string' && receipt.operationId.length > 0, 'operation id is missing');
assert(!Number.isNaN(Date.parse(receipt.completedAtUtc)), 'completion timestamp is invalid');

for (const field of ['v2AttemptKeys', 'v2UsedKeys', 'envelopesExamined', 'envelopesRevoked'])
{
    assert(Number.isSafeInteger(receipt[field]) && receipt[field] >= 0, `${field} is invalid`);
}
hexDigest(receipt.revokedEnvelopeIdsDigest, 'revoked envelope ids digest');

process.stdout.write(`${JSON.stringify({
    schemaVersion: evidenceVersion,
    accepted: true,
    operationId: receipt.operationId,
    requestFingerprint: receipt.requestFingerprint,
    releaseId: receipt.releaseId,
    slot: receipt.slot,
    generation: receipt.generation,
    numericKinds: receipt.numericKinds,
    targetFingerprint: receipt.targetFingerprint,
    clearedV2Keys: receipt.v2AttemptKeys + receipt.v2UsedKeys,
    envelopesExamined: receipt.envelopesExamined,
    envelopesRevoked: receipt.envelopesRevoked,
    completedAtUtc: receipt.completedAtUtc
}, null, 2)}\n`);
