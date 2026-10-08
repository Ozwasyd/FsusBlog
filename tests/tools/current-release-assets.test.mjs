/* eslint-disable import-x/no-relative-parent-imports -- Focused controls consume the transferred release and asset owners. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { createReleaseBrowserProjection } from '../../tools/storage/release-browser-projection.mjs';


import { currentReleaseAssetsFixture as fixture } from './support/current-release-assets-fixture.mjs';

const api = globalThis.FsusCurrentReleaseAssets;
const origin = 'https://assets.example.test';
const releaseId = '20260711010101-0123456789ab';
const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const encode = value => Buffer.from(api.canonicalize(value));

class MemoryCache
{
    entries = new Map();
    async put(url, response)
    {
        this.entries.set(String(url), response.clone());
    }
    async match(url)
    {
        return this.entries.get(typeof url === 'string' ? url : url.url)?.clone();
    }
    async keys()
    {
        return [...this.entries.keys()].map(url => new Request(url));
    }
}
function memoryCaches()
{
    const values = new Map([['unowned-old-cache', new MemoryCache()], ['active-verified-cache', new MemoryCache()]]);
    return { values, keys: async () => [...values.keys()], delete: async name => values.delete(name),
        open: async name =>
        {
            if (!values.has(name))
            {
                values.set(name, new MemoryCache());
            }
            return values.get(name);
        } };
}
async function consumer(fixture, overrides = {})
{
    const projection = await api.verifyProjection(encode(fixture.projection), fixture.trust);
    const files = await api.loadInventory(encode(fixture.inventory), projection);
    const requested = [];
    const cacheStorage = memoryCaches();
    const fetchBytes = async (url, options) =>
    {
        requested.push({ url, options });
        const file = files.find(asset => new URL(asset.releaseUrl, origin).href === url);
        if (!file)
        {
            throw new Error('unexpected network request');
        }
        return new Response(fs.readFileSync(path.join(fixture.source, file.path)), {
            headers: { 'Content-Type': file.mediaType, 'Cache-Control': file.cacheControl } });
    };
    const value = api.createConsumer({ projection, files, origin, cacheStorage, fetchBytes,
        operationId: 'control-run-1', ...overrides });
    return { value, projection, files, requested, cacheStorage, fetchBytes };
}

test('public projection is derived from verified signed source and contains no operational paths or database identity', async context =>
{
    const data = fixture(context);
    const publicBytes = encode(data.projection);
    const verified = await api.verifyProjection(publicBytes, data.trust);
    assert.equal(verified.candidateId, data.options.manifest.candidateId);
    assert.equal(verified.manifestContentDigest, data.options.manifest.contentDigest);
    for (const secret of [data.root, data.options.manifest.currentSchema.database.databaseId,
        data.options.manifest.currentSchema.database.instanceId, 'reference', 'minimumCoordinate', 'maximumCoordinate'])
    {
        assert.equal(publicBytes.toString().includes(secret), false);
    }
    assert.throws(() =>
    {
        verified.inventory.url = '/old';
    }, TypeError);
    assert.throws(() => createReleaseBrowserProjection(data.options, crypto.generateKeyPairSync('ed25519').privateKey), /signing key/u);
    fs.writeFileSync(path.join(data.source, 'assets/current.js'), 'corrupt');
    assert.throws(() => createReleaseBrowserProjection(data.options, data.privateKey), /byte digest/u);
});

test('public signature refuses tamper, independently wrong trust, duplicate fields and compatibility extensions', async context =>
{
    const data = fixture(context);
    for (const mutate of [value =>
    {
        value.candidateId = hash('different');
    },
    value =>
    {
        value.minDecoderVersion = 1;
    }, value =>
    {
        value.contracts.aeds.minimum = 1;
    },
    value =>
    {
        value.inventory.url = '/release-assets/old/asset-manifest.json';
    },
    value =>
    {
        value.serviceWorker.namespace = 'previous';
    },
    value =>
    {
        value.signature = Buffer.alloc(64).toString('base64');
    }])
    {
        const changed = structuredClone(data.projection);
        mutate(changed);
        await assert.rejects(api.verifyProjection(encode(changed), data.trust), /current_release_assets/u);
    }
    await assert.rejects(api.verifyProjection(encode(data.projection), { ...data.trust, keyId: 'other' }), /trust_mismatch/u);
    const text = encode(data.projection).toString().replace('{', '{"releaseId":"ignored",');
    await assert.rejects(api.verifyProjection(Buffer.from(text), data.trust), /noncanonical_projection/u);
});

test('only opaque verified projection/inventory capabilities can create a current cache consumer', async context =>
{
    const data = fixture(context);
    const current = await consumer(data);
    assert.throws(() => api.createConsumer({ projection: data.projection, files: current.files, origin }), /verified_inventory/u);
    assert.throws(() => api.createConsumer({ projection: current.projection, files: [...current.files], origin }), /verified_inventory/u);
    await assert.rejects(api.loadInventory(encode(data.inventory), data.projection), /verified_projection/u);
    await assert.rejects(api.loadInventory(encode({ ...data.inventory, previousRelease: 'old' }), current.projection), /inventory_digest/u);
});

test('cold install verifies all current bytes, warm fetch only reads current cache and cache miss fetches the exact current URL', async context =>
{
    const current = await consumer(fixture(context));
    await current.value.prepare();
    assert.equal(current.cacheStorage.values.has(current.value.cacheName), false);
    await current.value.commit();
    assert.equal(current.cacheStorage.values.has(current.value.stagingName), false);
    assert.equal(current.cacheStorage.values.has('active-verified-cache'), true);
    const url = `${origin}/release-assets/${releaseId}/assets/current.js`;
    const networkBefore = current.requested.length;
    assert.match(await (await current.value.fetchAsset(new Request(url))).text(), /current/u);
    assert.equal(current.requested.length, networkBefore);
    current.cacheStorage.values.get(current.value.cacheName).entries.delete(url);
    await current.value.fetchAsset(new Request(url));
    assert.equal(current.requested.length, networkBefore + 1);
    assert.equal(current.requested.at(-1).url, url);
    assert.deepEqual(current.requested.at(-1).options, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    const evidence = await current.value.evidence();
    const { contentDigest, ...payload } = evidence;
    assert.equal(contentDigest, hash(encode(payload)));
    assert.ok(evidence.observations.every(item => item.candidateId === current.projection.candidateId));
    assert.ok(evidence.observations.some(item => item.source === 'current-cache'));
});

test('unknown, old canonical release, query alias and authenticated requests fail before cache or network lookup', async context =>
{
    const current = await consumer(fixture(context));
    await current.value.prepare();
    await current.value.commit();
    const before = current.requested.length;
    for (const url of [`${origin}/release-assets/20260710010101-aaaaaaaaaaaa/assets/current.js`,
        `${origin}/assets/current.js`, `${origin}/release-assets/${releaseId}/assets/unknown.js`,
        `${origin}/release-assets/${releaseId}/assets/current.js?old=1`, 'https://other.test/current.js'])
    {
        await assert.rejects(current.value.fetchAsset(new Request(url)), /undeclared_asset/u);
    }
    await assert.rejects(current.value.fetchAsset(new Request(`${origin}/release-assets/${releaseId}/assets/current.js`,
        { headers: { Authorization: 'source-test' } })), /private_asset/u);
    assert.equal(current.requested.length, before);
});

for (const asset of ['assets/current.js', 'assets/current.woff2', 'wasm/decoder.wasm'])
{
    test(`tampered ${asset} prevents install and cleans only the owned operation cache`, async context =>
    {
        const data = fixture(context);
        const current = await consumer(data);
        fs.writeFileSync(path.join(data.source, asset), 'tampered');
        await assert.rejects(current.value.prepare(), /hash_or_size|size_limit/u);
        assert.equal(current.cacheStorage.values.has(current.value.stagingName), false);
        assert.deepEqual(await current.cacheStorage.keys(), ['unowned-old-cache', 'active-verified-cache']);
    });
}

test('partial install and media/privacy response drift refuse preparation while old caches remain untouched', async context =>
{
    const data = fixture(context);
    for (const headers of [{ 'Content-Type': 'text/plain', 'Cache-Control': 'public,immutable' },
        { 'Content-Type': 'text/javascript', 'Cache-Control': 'private' },
        { 'Content-Type': 'text/javascript', 'Cache-Control': 'public,immutable', Vary: 'Cookie' },
        { 'Content-Type': 'text/javascript', 'Cache-Control': 'public,immutable', 'Set-Cookie': 'source-test' }])
    {
        const current = await consumer(data, { fetchBytes: async () => new Response('bad', { headers }) });
        await assert.rejects(current.value.prepare(), /media_type|private_response|nonpublic/u);
        assert.equal(current.cacheStorage.values.size, 2);
    }
    const current = await consumer(data);
    fs.rmSync(path.join(data.source, 'assets/current.css'));
    await assert.rejects(current.value.prepare(), /ENOENT/u);
    assert.equal(current.cacheStorage.values.size, 2);
});

for (const reference of ['"/release-assets/20260710010101-aaaaaaaaaaaa/assets/current.js"', '/assets/unknown.js'])
{
    test(`current index reference ${reference} is rejected even when its own signed hash matches`, async context =>
    {
        const data = fixture(context, source => fs.writeFileSync(path.join(source, 'index.html'),
            `<script src=${reference}></script>`));
        const current = await consumer(data);
        await assert.rejects(current.value.prepare(), /index_undeclared/u);
        assert.equal(current.cacheStorage.values.size, 2);
    });
}

test('independent observation check rejects coherent bad-asset reseals without granting runtime qualification', async context =>
{
    const current = await consumer(fixture(context));
    await current.value.prepare();
    await current.value.commit();
    const evidence = await current.value.evidence();
    const verified = await api.verifyObservations(encode(evidence), current.projection, current.files);
    assert.equal(verified.runtimeQualificationEligible, false);
    for (const mutate of [value =>
    {
        value.observations[0].sha256 = hash('other');
    },
    value =>
    {
        value.observations[0].url = `${origin}/release-assets/old/assets/current.js`;
    },
    value =>
    {
        value.observations[0].source = 'old-cache';
    }, value =>
    {
        value.cacheName = 'old-cache';
    }])
    {
        const changed = structuredClone(evidence);
        mutate(changed);
        delete changed.contentDigest;
        changed.contentDigest = hash(encode(changed));
        await assert.rejects(api.verifyObservations(encode(changed), current.projection, current.files), /observation/u);
    }
});

test('actual worker source prepares verified assets but disconnected native admission refuses takeover and cleans only staging', async context =>
{
    const data = fixture(context);
    const current = await consumer(data);
    const events = new Map();
    let claimed = 0;
    let skipped = 0;
    const sandbox = { TextEncoder, TextDecoder, Uint8Array, URL, Response, Request, Headers, atob, btoa,
        structuredClone, crypto: crypto.webcrypto, caches: current.cacheStorage,
        location: { origin, href: `${origin}/sw.js?build=${releaseId}` },
        addEventListener: (name, listener) => events.set(name, listener),
        clients: { claim: async () =>
        {
            claimed++;
        } }, skipWaiting: async () =>
        {
            skipped++;
        },
        FsusCurrentReleaseBrowserConfiguration: {
            projectionUrl: `/release-assets/${releaseId}/release-browser-projection.json`, projectionSha256: hash(encode(data.projection)),
            candidateId: data.projection.candidateId, manifestContentDigest: data.projection.manifestContentDigest,
            trust: { keyId: data.trust.keyId, publicKeySha256: data.trust.publicKeySha256, publicKeySpkiBase64: data.trust.publicKeySpkiBase64 }
        },
        fetch: async (url, options) =>
        {
            if (url.endsWith('/release-browser-projection.json'))
            {
                return new Response(encode(data.projection));
            }
            if (url.endsWith('/asset-manifest.json'))
            {
                return new Response(encode(data.inventory));
            }
            return current.fetchBytes(url, options);
        } };
    sandbox.self = sandbox;
    const realm = vm.createContext(sandbox);
    sandbox.importScripts = url => vm.runInContext(fs.readFileSync(path.resolve(import.meta.dirname,
        '../../src/frontend/public', url.slice(1)), 'utf8'), realm);
    vm.runInContext(fs.readFileSync(path.resolve(import.meta.dirname, '../../src/frontend/public/sw.js'), 'utf8'), realm);
    let completion;
    events.get('install')({ waitUntil: promise =>
    {
        completion = promise;
    } });
    await assert.rejects(completion, /native_current_schema_admission_bridge_unconfigured/u);
    assert.equal(skipped, 0);
    assert.equal(claimed, 0);
    assert.deepEqual(await current.cacheStorage.keys(), ['unowned-old-cache', 'active-verified-cache']);
    let response;
    events.get('fetch')({ request: new Request(`${origin}/release-assets/20260710010101-aaaaaaaaaaaa/assets/current.js`),
        respondWith: promise =>
        {
            response = promise;
        } });
    assert.equal((await response).status, 503);
});

test('warm cache wrong hash and staged unknown asset cannot be used as evidence or fallback', async context =>
{
    const data = fixture(context);
    const current = await consumer(data);
    await current.value.prepare();
    await current.value.commit();
    const url = `${origin}/release-assets/${releaseId}/assets/current.js`;
    await current.cacheStorage.values.get(current.value.cacheName).put(url,
        new Response('corrupt', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public,immutable' } }));
    const before = current.requested.length;
    await assert.rejects(current.value.fetchAsset(new Request(url)), /hash_or_size/u);
    assert.equal(current.requested.length, before);
    const another = await consumer(data, { operationId: 'control-run-2', cacheStorage: current.cacheStorage });
    await another.value.prepare();
    await current.cacheStorage.values.get(another.value.stagingName).put(`${origin}/unknown.js`, new Response('extra'));
    await assert.rejects(another.value.commit(), /staging_inventory/u);
    await another.value.discard();
    assert.equal(current.cacheStorage.values.has(current.value.cacheName), true);
});

test('operation cache collision cannot acquire or delete another operation cache', async context =>
{
    const data = fixture(context);
    const first = await consumer(data);
    await first.value.prepare();
    const second = await consumer(data, { cacheStorage: first.cacheStorage });
    await assert.rejects(second.value.prepare(), /already_exists/u);
    assert.equal(await second.value.discard(), false);
    assert.equal(first.cacheStorage.values.has(first.value.stagingName), true);
});
