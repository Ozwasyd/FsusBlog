import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const {
    atlasVariantBytes,
    buildVectors,
    computeAnswerTag,
    contract,
    encodeLP,
    fixedTimeTagEquals,
    normalizeAnswer,
    openStateBytes,
    rasterize,
    sampleAnswer,
    sealState,
    switchRepresentation,
    transition,
    validateKeyRings
} = await import(new URL('../../tools/contracts/perception-character-v3-reference.mjs', import.meta.url));

const fixturePath = new URL('../fixtures/security/perception-character-v3-vectors.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

test('V3 identity is exact and forbidden predecessor names are not aliases', () =>
{
    assert.equal(contract.enum, 'PerceptionCharacterV3');
    assert.equal(contract.wireName, 'perceptionCharacterV3');
    assert.equal(contract.algorithm, 'fsu.challenge/perception-character-raster@v3');
    assert.deepEqual(contract.forbiddenAliases, [
        'captchaV1',
        'perceptionCharacterV2',
        'perceptionTextTaskV2',
        'text-task'
    ]);
    for (const alias of contract.forbiddenAliases)
    {
        assert.notEqual(alias, contract.wireName);
    }
    assert.deepEqual(contract.wire.verifyFields, [
        'algorithm',
        'challengeId',
        'envelopeId',
        'representation',
        'answer',
        'stateToken'
    ]);
    assert.ok(contract.wire.forbiddenTruthFields.includes('solveDurationMs'));
    assert.ok(contract.wire.forbiddenTruthFields.includes('rasterSeed'));
    assert.equal(contract.wire.issuePublicFields.some((field) => contract.wire.forbiddenTruthFields.includes(field)), false);
});

test('answer normalization removes only ASCII whitespace and applies only ASCII uppercase', () =>
{
    assert.equal(normalizeAnswer(' a\tc\nd\re 7'), 'ACDE7');
    assert.equal(normalizeAnswer('a C\vD\fE7'), 'ACDE7');
    assert.equal(normalizeAnswer('A\u00a0CDE7'), null);
    assert.equal(normalizeAnswer('ＡCDE7'), null);
    assert.equal(normalizeAnswer('İCDE7'), null);
    assert.equal(normalizeAnswer('ABCDE'), null);
    assert.equal(normalizeAnswer('ACDE'), null);
    assert.equal(normalizeAnswer('ACDE77'), null);
});

test('byte rejection sampling gives every alphabet symbol exactly the same count', () =>
{
    let cursor = 0;
    const counts = new Map([...contract.answer.alphabet].map((symbol) => [symbol, 0]));
    for (let sample = 0; sample < 468; sample += 1)
    {
        const answer = sampleAnswer(() => Buffer.from([cursor++ % 256]));
        for (const symbol of answer)
        {
            counts.set(symbol, counts.get(symbol) + 1);
        }
    }
    assert.deepEqual([...counts.values()], Array(26).fill(90));
});

test('seeded statistical property remains within the declared uniform distribution bound', () =>
{
    let counter = 0;
    let available = Buffer.alloc(0);
    const readByte = () =>
    {
        if (available.length === 0)
        {
            const block = Buffer.alloc(4);
            block.writeUInt32BE(counter++);
            available = createHash('sha256').update('pcv3-statistical-property').update(block).digest();
        }
        const value = available.subarray(0, 1);
        available = available.subarray(1);
        return value;
    };
    const counts = new Map([...contract.answer.alphabet].map((symbol) => [symbol, 0]));
    const accepted = 52_000;
    for (let sample = 0; sample < accepted / 5; sample += 1)
    {
        for (const symbol of sampleAnswer(readByte))
        {
            counts.set(symbol, counts.get(symbol) + 1);
        }
    }
    const expected = accepted / 26;
    const chiSquared = [...counts.values()].reduce(
        (sum, observed) => sum + ((observed - expected) ** 2 / expected),
        0
    );
    assert.ok(chiSquared < 52.62, `chi-squared ${chiSquared} exceeds p=0.001 for 25 degrees of freedom`);
});

test('EncodeLP vectors cover empty, uint8-boundary lengths, and field-order stability', () =>
{
    assert.equal(encodeLP([]).toString('hex'), fixture.lp.emptyHex);
    assert.equal(encodeLP([Buffer.alloc(0)]).toString('hex'), fixture.lp.emptyFieldHex);
    const boundary255 = Buffer.alloc(255, 0x61);
    const boundary256 = Buffer.alloc(256, 0x62);
    assert.equal(sha256(encodeLP([boundary255, boundary256])), fixture.lp.boundary255And256Sha256);
    assert.equal(sha256(encodeLP([boundary256, boundary255])), fixture.lp.reversedBoundaryFieldsSha256);
    assert.notEqual(fixture.lp.boundary255And256Sha256, fixture.lp.reversedBoundaryFieldsSha256);
});

test('answer HMAC, state plaintext, AAD, and AES-256-GCM token match the cross-language vector', () =>
{
    assert.deepEqual(buildVectors(), fixture);
    const answerKey = Buffer.from(fixture.answer.keyHex, 'hex');
    const tag = computeAnswerTag(answerKey, fixture.state.context, ' a7\tC\n9q ');
    assert.equal(tag.toString('hex'), fixture.answer.tagHex);
    assert.equal(fixedTimeTagEquals(tag, Buffer.from(fixture.answer.tagHex, 'hex')), true);
    assert.equal(fixedTimeTagEquals(tag, Buffer.alloc(31)), false);
    assert.notEqual(
        computeAnswerTag(answerKey, { ...fixture.state.context, routeKey: '/api/binary/other' }, 'A7C9Q').toString('hex'),
        fixture.answer.tagHex
    );
    assert.notEqual(computeAnswerTag(answerKey, fixture.state.context, 'A7C97').toString('hex'), fixture.answer.tagHex);

    const tokenKey = Buffer.from(fixture.state.tokenKeyHex, 'hex');
    const plaintext = openStateBytes(tokenKey, fixture.state.token, fixture.state.context);
    assert.equal(plaintext.toString('hex'), fixture.state.plaintextHex);
});

test('AES-GCM rejects every AAD binding substitution and token tampering', () =>
{
    const key = Buffer.from(fixture.state.tokenKeyHex, 'hex');
    for (const field of [
        'challengeId',
        'envelopeId',
        'action',
        'routeKey',
        'mediaHash',
        'issuedAtUnixMs',
        'expiresAtUnixMs',
        'tokenKeyVersion'
    ])
    {
        const changed = {
            ...fixture.state.context,
            [field]: typeof fixture.state.context[field] === 'number'
                ? fixture.state.context[field] + 1
                : field === 'mediaHash' ? 'ff'.repeat(32) : `${fixture.state.context[field]}-changed`
        };
        assert.throws(() => openStateBytes(key, fixture.state.token, changed), { name: /Error/u });
    }
    const tokenBytes = Buffer.from(fixture.state.token, 'base64url');
    tokenBytes[tokenBytes.length - 17] ^= 0x01;
    assert.throws(() => openStateBytes(key, tokenBytes.toString('base64url'), fixture.state.context));
});

test('key-ring validation rejects missing, short, equal, unknown-current, and checked-in keys', () =>
{
    const token = Buffer.alloc(32, 0x41);
    const answer = Buffer.alloc(32, 0x42);
    const valid = {
        tokenCurrent: 'tk1',
        tokenKeys: { tk1: token },
        answerCurrent: 'ak1',
        answerKeys: { ak1: answer }
    };
    assert.equal(validateKeyRings(valid), true);
    assert.throws(() => validateKeyRings({ ...valid, tokenCurrent: '' }));
    assert.throws(() => validateKeyRings({ ...valid, tokenCurrent: 'unknown' }));
    assert.throws(() => validateKeyRings({ ...valid, tokenKeys: null }));
    assert.throws(() => validateKeyRings({ ...valid, answerKeys: { ak1: Buffer.alloc(31) } }));
    assert.throws(() => validateKeyRings({ ...valid, answerKeys: { ak1: token } }));
    assert.throws(() => validateKeyRings({
        ...valid,
        tokenKeys: { tk1: Buffer.from(fixture.state.tokenKeyHex, 'hex') }
    }));
    assert.equal(validateKeyRings({
        tokenCurrent: 'fixture-token',
        tokenKeys: { 'fixture-token': Buffer.from(fixture.state.tokenKeyHex, 'hex') },
        answerCurrent: 'fixture-answer',
        answerKeys: { 'fixture-answer': Buffer.from(fixture.answer.keyHex, 'hex') },
        environment: 'Test',
        allowTestVectors: true
    }), true);
});

test('approved atlas has six distinct raster variants for every alphabet symbol', () =>
{
    const allVariants = [];
    for (const character of contract.answer.alphabet)
    {
        const variants = Array.from({ length: 6 }, (_, variant) => atlasVariantBytes(character, variant));
        assert.equal(new Set(variants.map((value) => value.toString('hex'))).size, 6, character);
        allVariants.push(...variants);
    }
    assert.equal(allVariants.length, 156);
    assert.equal(sha256(Buffer.concat(allVariants)), fixture.atlas.sha256);
});

test('normative Gray8 raster is fixed-size, deterministic, and hash-bound', () =>
{
    const first = rasterize(fixture.raster.answer, Buffer.from(fixture.raster.seedHex, 'hex'));
    const second = rasterize(fixture.raster.answer, Buffer.from(fixture.raster.seedHex, 'hex'));
    const changed = rasterize(fixture.raster.answer, Buffer.from('ff'.repeat(32), 'hex'));
    assert.equal(first.length, 512 * 192);
    assert.deepEqual(first, second);
    assert.equal(sha256(first), fixture.raster.mediaHashHex);
    assert.notEqual(sha256(changed), fixture.raster.mediaHashHex);
    assert.ok(new Set(first).size > 100);
});

test('atomic model permits one concurrent success and rejects replay without a third attempt', () =>
{
    const initial = activeState();
    const winner = transition(initial, verify(true));
    const replay = transition(winner, verify(true));
    assert.deepEqual({ status: winner.status, attempts: winner.attempts }, { status: 'consumed', attempts: 1 });
    assert.deepEqual({ status: replay.status, attempts: replay.attempts, publicError: replay.publicError }, {
        status: 'consumed', attempts: 1, publicError: 'rejected'
    });
});

test('atomic model linearizes mixed correct and incorrect requests in either order', () =>
{
    const correctFirst = transition(activeState(), verify(true));
    const incorrectAfter = transition(correctFirst, verify(false));
    assert.deepEqual({ status: incorrectAfter.status, attempts: incorrectAfter.attempts }, {
        status: 'consumed', attempts: 1
    });

    const incorrectFirst = transition(activeState(), verify(false));
    const correctAfter = transition(incorrectFirst, verify(true));
    assert.deepEqual({ status: correctAfter.status, attempts: correctAfter.attempts }, {
        status: 'consumed', attempts: 2
    });
});

test('atomic model accounts for concurrent failures, exhaustion, expiry, revocation, and store failure', () =>
{
    const firstFailure = transition(activeState(), verify(false));
    const exhausted = transition(firstFailure, verify(false));
    const afterExhaustion = transition(exhausted, verify(false));
    assert.deepEqual({ status: firstFailure.status, attempts: firstFailure.attempts, publicError: firstFailure.publicError }, {
        status: 'active', attempts: 1, publicError: 'retryable'
    });
    assert.deepEqual({ status: exhausted.status, attempts: exhausted.attempts }, { status: 'exhausted', attempts: 2 });
    assert.equal(afterExhaustion.attempts, 2);
    assert.equal(transition(activeState(), { ...verify(true), nowUnixMs: 2000 }).status, 'expired');
    assert.equal(transition(activeState(), { type: 'revoke', storeAvailable: true }).status, 'revoked');
    assert.deepEqual(transition(activeState(), { ...verify(true), storeAvailable: false }), {
        ...activeState(), publicError: 'unavailable'
    });
});

test('representation switch revokes the old identity and starts a disjoint attempt counter', () =>
{
    const old = { ...activeState(), representation: 'visual', challengeId: 'old-c', envelopeId: 'old-e', stateToken: 'old-t' };
    const switched = switchRepresentation(old, {
        representation: 'audio',
        challengeId: 'new-c',
        envelopeId: 'new-e',
        stateToken: 'new-t',
        expiresAtUnixMs: 3000
    });
    assert.equal(switched.revoked.status, 'revoked');
    assert.deepEqual({ status: switched.issued.status, attempts: switched.issued.attempts }, { status: 'active', attempts: 0 });
    assert.throws(() => switchRepresentation(old, { ...old, representation: 'audio' }));
});

test('a fresh nonce changes the state token while preserving the authenticated plaintext', () =>
{
    const vectors = buildVectors();
    const key = Buffer.from(vectors.state.tokenKeyHex, 'hex');
    const answerTag = Buffer.from(vectors.answer.tagHex, 'hex');
    const state = {
        ...vectors.state.context,
        answerTag,
        attemptBudget: 2,
        representation: 'visual',
        answerKeyVersion: vectors.state.answerKeyVersion
    };
    const second = sealState(key, Buffer.from('101112131415161718191a1b', 'hex'), vectors.state.context, state);
    assert.notEqual(second, vectors.state.token);
    assert.equal(openStateBytes(key, second, vectors.state.context).toString('hex'), vectors.state.plaintextHex);
});

test('normative documents bind formulas, threat model, coarse errors, and test-only reference ownership', () =>
{
    const protocol = readFileSync(new URL('../../docs/security/perception-character-v3-protocol.md', import.meta.url), 'utf8');
    const api = readFileSync(new URL('../../docs/api/contracts.md', import.meta.url), 'utf8');
    const security = readFileSync(new URL('../../docs/security.md', import.meta.url), 'utf8');
    for (const required of [
        '26^5 = 11,881,376',
        'ASCIIUpper(RemoveASCIIWhitespace(x))',
        'HMAC-SHA-256',
        'AES-256-GCM',
        '512 x 192',
        'A_i = T_i * R_i * H_i * S_i',
        'Catmull–Rom',
        'active -> consumed | exhausted | expired | revoked',
        'retryable',
        'reissueRequired',
        'Distributed low-rate guessing',
        'not a proof of humanity'
    ])
    {
        assert.ok(protocol.includes(required), required);
    }
    assert.ok(api.includes('fsu.challenge/perception-character-raster@v3'));
    assert.ok(security.includes('PerceptionCharacterV3 规范边界'));
    assert.ok(protocol.includes('reference-test path'));
    assert.ok(protocol.includes('not a UI or production provider'));
});

function activeState()
{
    return { status: 'active', attempts: 0, expiresAtUnixMs: 1000 };
}

function verify(answerMatches)
{
    return { type: 'verify', answerMatches, nowUnixMs: 500, storeAvailable: true };
}

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}
