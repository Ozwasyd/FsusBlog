import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
    parseFsusuiReleaseEvent,
    requireVerifiedFsusuiEvent,
    reverifyFsusuiEventReceipt,
    verifyFsusuiReleaseEvent
} from '../../tools/dependencies/verify-fsusui-release-event.mjs';

const packageName = '@ozwasyd/element-plus';
const registry = 'https://registry.npmjs.org/';
const now = () => new Date('2026-09-05T00:00:00.000Z');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

function archive(manifest, duplicate = false) {
    const bytes = Buffer.isBuffer(manifest) ? manifest : Buffer.from(JSON.stringify(manifest));
    const header = Buffer.alloc(512);
    header.write('package/package.json');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    const entry = Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
    return gzipSync(Buffer.concat([entry, ...(duplicate ? [entry] : []), Buffer.alloc(1024)]));
}

function fixture({ manifest = { name: packageName, version: '1.5.2' }, tarball = archive(manifest) } = {}) {
    const payload = {
        schemaVersion: 1,
        package: packageName,
        version: '1.5.2',
        distTag: 'latest',
        registry,
        sourceRepository: 'Ozwasyd/FsusUI',
        sourceCommit: 'a'.repeat(40),
        releaseTag: 'v1.5.2',
        candidateSha256: sha256(tarball),
        candidateManifestSha256: 'b'.repeat(64),
        crossGateReceiptSha256: 'c'.repeat(64),
        npmIntegrity: integrity(tarball),
        npmTarballSha256: sha256(tarball),
        publishRunId: '123'
    };
    const version = { name: packageName, version: '1.5.2', dist: { integrity: payload.npmIntegrity, tarball: `${registry}@ozwasyd/element-plus/-/element-plus-1.5.2.tgz` } };
    return { payload, version, latest: structuredClone(version), tarball, requests: [] };
}

async function registryFixture(t, data) {
    const server = createServer((request, response) => {
        data.requests.push(request.url);
        const value = request.url === '/%40ozwasyd%2Felement-plus/1.5.2' ? data.version
            : request.url === '/%40ozwasyd%2Felement-plus/latest' ? data.latest
                : request.url === '/@ozwasyd/element-plus/-/element-plus-1.5.2.tgz' ? data.tarball : undefined;
        response.statusCode = data.status ?? (value === undefined ? 404 : 200);
        response.end(Buffer.isBuffer(value) ? value : JSON.stringify(value ?? {}));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    return async (url, options) => {
        assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
        assert.equal(options.redirect, 'error');
        const local = `http://127.0.0.1:${server.address().port}${new URL(url).pathname}`;
        const response = await fetch(local, options);
        // Only transport is simulated; production digest/schema/archive checks run unchanged.
        return new Response(response.body, { status: response.status, headers: response.headers });
    };
}

test('simulation: same candidate bytes traverse HTTP metadata, latest, archive and sealed receipt', async (t) => {
    const data = fixture();
    const transport = await registryFixture(t, data);
    const raw = JSON.stringify(data.payload, null, 2);
    const receipt = await verifyFsusuiReleaseEvent(raw, { transport, now });
    assert.deepEqual(requireVerifiedFsusuiEvent(receipt), data.payload);
    assert.equal(receipt.rawPayloadSha256, sha256(raw));
    assert.equal(receipt.npmTarballSha256, sha256(data.tarball));
    assert.equal(receipt.npmVersionMetadataSha256, sha256(JSON.stringify(data.version)));
    assert.equal(receipt.npmLatestMetadataSha256, sha256(JSON.stringify(data.latest)));
    assert.equal(receipt.verifiedAt, now().toISOString());
    assert.equal(data.requests.length, 3);
    assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.payload));
    assert.throws(() => { receipt.payload.version = '9.9.9'; }, TypeError);
    assert.throws(() => requireVerifiedFsusuiEvent(data.payload), /sealed verified/);
    assert.throws(() => requireVerifiedFsusuiEvent(JSON.parse(JSON.stringify(receipt))), /sealed verified/);
    assert.throws(() => requireVerifiedFsusuiEvent({ ...receipt }), /sealed verified/);
    const reverified = await reverifyFsusuiEventReceipt(JSON.stringify(receipt), { transport, now });
    assert.equal(reverified.receiptSha256, receipt.receiptSha256);
    assert.deepEqual(requireVerifiedFsusuiEvent(reverified), data.payload);
    assert.equal(data.requests.length, 6);
});

test('every missing field, unknown field and field type fails before any network request', async () => {
    const { payload } = fixture();
    const transport = () => assert.fail('invalid payload reached network');
    for (const key of Object.keys(payload)) {
        const missing = { ...payload };
        delete missing[key];
        await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(missing), { transport }), /missing/);
        for (const value of [null, {}, [], false]) {
            assert.throws(() => parseFsusuiReleaseEvent(JSON.stringify({ ...payload, [key]: value })), new RegExp(key));
        }
    }
    for (const key of ['url', 'tarball', 'authToken', 'unknown']) {
        await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify({ ...payload, [key]: 'https://example.invalid/' }), { transport }), /unknown/);
    }
});

for (const [key, value] of [
    ['schemaVersion', 2], ['version', '1.5.2-rc.1'], ['version', '01.5.2'], ['version', '1.5.2+preview'],
    ['distTag', 'next'], ['package', 'other'], ['registry', 'https://example.invalid/'],
    ['sourceRepository', 'other/FsusUI'], ['sourceCommit', 'abcd'], ['releaseTag', 'v1.5.3'],
    ['releaseTag', '1.5.2'], ['candidateSha256', '0'.repeat(64)], ['crossGateReceiptSha256', ''],
    ['candidateManifestSha256', 'unknown'], ['publishRunId', '0'], ['npmIntegrity', 'sha512-aA==']
]) {
    test(`rejects payload ${key}=${value}`, () => {
        assert.throws(() => parseFsusuiReleaseEvent(JSON.stringify({ ...fixture().payload, [key]: value })), new RegExp(key));
    });
}

test('rejects duplicate and escaped duplicate JSON keys', () => {
    const raw = JSON.stringify(fixture().payload);
    assert.throws(() => parseFsusuiReleaseEvent(raw.replace('{', '{"version":"1.5.2",')), /duplicate/);
    assert.throws(() => parseFsusuiReleaseEvent(raw.replace('{', '{"vers\\u0069on":"1.5.2",')), /duplicate/);
    for (const value of ['null', '[]', '{', 'false']) {
        assert.throws(() => parseFsusuiReleaseEvent(value), /payload/);
    }
});

for (const [label, mutate, error] of [
    ['latest version', (d) => { d.latest.version = '1.5.3'; }, /latest/],
    ['metadata name', (d) => { d.version.name = 'other'; }, /name\/version/],
    ['metadata version', (d) => { d.version.version = '1.5.3'; }, /name\/version/],
    ['metadata integrity', (d) => { d.version.dist.integrity = integrity('other'); }, /integrity/],
    ['latest integrity', (d) => { d.latest.dist.integrity = integrity('other'); }, /latest identity/],
    ['tarball integrity', (d) => { d.tarball = Buffer.from('other'); }, /tarball integrity/],
    ['tarball SHA', (d) => { d.payload.candidateSha256 = d.payload.npmTarballSha256 = '0'.repeat(64); }, /tarball SHA/],
    ['registry unavailable', (d) => { d.status = 503; }, /network\/registry/],
    ['foreign tarball URL', (d) => { d.latest.dist.tarball = d.version.dist.tarball = 'https://example.invalid/package.tgz'; }, /URL origin/],
    ['credential tarball URL', (d) => { d.latest.dist.tarball = d.version.dist.tarball = 'https://token@registry.npmjs.org/package.tgz'; }, /URL origin/]
]) {
    test(`simulation: rejects ${label}`, async (t) => {
        const data = fixture();
        mutate(data);
        const transport = await registryFixture(t, data);
        await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(data.payload), { transport, now }), error);
    });
}

for (const [label, tarball, error] of [
    ['wrong package name', archive({ name: 'other', version: '1.5.2' }), /tarball name\/version/],
    ['wrong package version', archive({ name: packageName, version: '1.5.3' }), /tarball name\/version/],
    ['invalid archive', Buffer.from('not a gzip tar archive'), /tarball package/],
    ['duplicate manifest', archive({ name: packageName, version: '1.5.2' }, true), /tarball package/]
]) {
    test(`simulation: rejects ${label} even when all cryptographic digests agree`, async (t) => {
        const data = fixture({ tarball });
        const transport = await registryFixture(t, data);
        await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(data.payload), { transport, now }), error);
    });
}

test('network errors and redirects fail closed without exposing transport secrets', async () => {
    for (const transport of [
        () => { throw new Error('credential-secret'); },
        () => ({ ok: true, redirected: true, body: [] }),
        () => ({ ok: true, redirected: false, url: 'https://example.invalid/', body: [] })
    ]) {
        await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(fixture().payload), { transport }), (error) => {
            assert.match(error.message, /network\/registry/);
            assert.ok(!error.message.includes('credential-secret'));
            return true;
        });
    }
});

test('simulation: tampered receipts, even rehashed, cannot authorize writes', async (t) => {
    const data = fixture();
    const transport = await registryFixture(t, data);
    const receipt = await verifyFsusuiReleaseEvent(JSON.stringify(data.payload), { transport, now });
    const changed = { ...receipt, npmTarballSha256: '0'.repeat(64) };
    await assert.rejects(reverifyFsusuiEventReceipt(JSON.stringify(changed), { transport, now }), /receipt digest/);
    const { receiptSha256, ...body } = changed;
    const rehashed = { ...body, receiptSha256: sha256(JSON.stringify(body)) };
    await assert.rejects(reverifyFsusuiEventReceipt(JSON.stringify(rehashed), { transport, now }), /receipt binding/);
    data.latest.version = '1.5.3';
    await assert.rejects(reverifyFsusuiEventReceipt(JSON.stringify(receipt), { transport, now }), /latest dist-tag/);
});

test('payload and streamed metadata size bounds fail before archive processing', async () => {
    assert.throws(() => parseFsusuiReleaseEvent(' '.repeat(4 * 1024 * 1024 + 1)), /size\/type/);
    const transport = async () => new Response(Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(fixture().payload), { transport }), /network\/registry\/response/);
});

test('tarball streaming enforces 128 MiB without buffering an oversized response', async () => {
    const data = fixture();
    let request = 0;
    const transport = async () => {
        request += 1;
        if (request < 3) {
            return new Response(JSON.stringify(request === 1 ? data.version : data.latest));
        }
        const chunk = Buffer.alloc(1024 * 1024);
        return { ok: true, redirected: false, body: Array.from({ length: 129 }, () => chunk) };
    };
    await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(data.payload), { transport }), /network\/registry\/response/);
    assert.equal(request, 3);
});

test('simulation: decompressed package manifest size is bounded independently of gzip size', async (t) => {
    const data = fixture({ tarball: archive({ name: packageName, version: '1.5.2', padding: ' '.repeat(4 * 1024 * 1024) }) });
    assert.ok(data.tarball.length < 10000);
    const transport = await registryFixture(t, data);
    await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(data.payload), { transport, now }), /tarball package/);
});

test('simulation: duplicate package identity inside a valid tarball is rejected', async (t) => {
    const data = fixture({ tarball: archive(Buffer.from('{"name":"other","name":"@ozwasyd/element-plus","version":"1.5.2"}')) });
    const transport = await registryFixture(t, data);
    await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(data.payload), { transport, now }), /duplicate/);
});

test('simulation: stalled HTTP registry is aborted by the production 30-second deadline', { timeout: 35000 }, async (t) => {
    const server = createServer(() => {});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    let requestSignal;
    const transport = async (_url, options) => {
        requestSignal = options.signal;
        return fetch(`http://127.0.0.1:${server.address().port}/`, options);
    };
    await assert.rejects(verifyFsusuiReleaseEvent(JSON.stringify(fixture().payload), { transport, now }), /network\/registry\/response/);
    assert.equal(requestSignal.aborted, true);
    assert.equal(requestSignal.reason.name, 'TimeoutError');
});
