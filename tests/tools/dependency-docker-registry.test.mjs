import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createDockerRegistryReader, dockerRepository, readDockerManifest, readDockerTags } from '../../tools/governance/dependency-docker-registry.mjs';

function page(tags, link, name = 'library/node')
{
    return new Response(JSON.stringify({ name, tags }), { headers: link ? { link } : {} });
}

test('catalog Docker names bind to their registry and official-image namespace', () => {
    assert.deepEqual(dockerRepository('node'), { origin: 'https://registry-1.docker.io', name: 'library/node' });
    assert.deepEqual(dockerRepository('docker.io/openresty/openresty'), { origin: 'https://registry-1.docker.io', name: 'openresty/openresty' });
    assert.deepEqual(dockerRepository('mcr.microsoft.com/dotnet/sdk'), { origin: 'https://mcr.microsoft.com', name: 'dotnet/sdk' });
    assert.deepEqual(dockerRepository('ghcr.io/macbre/curl-http3'), { origin: 'https://ghcr.io', name: 'macbre/curl-http3' });
});

test('Docker tags consume all advertised pages without filtering variant names', async () => {
    const calls = [];
    const tags = await readDockerTags('node', async (url) => {
        calls.push(url);
        return calls.length === 1
            ? page(['24-alpine'], '</v2/library/node/tags/list?n=1000&last=24-alpine>; rel="next"')
            : page(['25-bookworm-slim']);
    });
    assert.deepEqual(tags, ['24-alpine', '25-bookworm-slim']);
    assert.equal(calls.length, 2);
});

test('foreign or malformed pagination links and duplicate tags fail closed', async () => {
    for (const link of ['<https://other.example/v2/library/node/tags/list>; rel="next"',
        '</v2/library/other/tags/list>; rel="next"', 'invalid'])
    {
        await assert.rejects(readDockerTags('node', async () => page(['24'], link)), /next_link_invalid/);
    }
    await assert.rejects(readDockerTags('node', async () => page(['24', '24'])), /tags_duplicate/);
});

test('late registry failure cannot return a partial tag list', async () => {
    let calls = 0;
    await assert.rejects(readDockerTags('node', async () => ++calls === 1
        ? page(['24'], '</v2/library/node/tags/list?last=24>; rel="next"')
        : new Response('', { status: 429 })), /http_error:node:429/);
});

test('anonymous Docker Hub token is scoped to one repository and reused only there', async () => {
    const calls = [];
    const read = createDockerRegistryReader('node', async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1) return new Response('', { status: 401 });
        if (url.startsWith('https://auth.docker.io/token'))
        {
            assert.equal(new URL(url).searchParams.get('scope'), 'repository:library/node:pull');
            assert.equal(options.headers.Authorization, undefined);
            return Response.json({ token: 'local-simulation-token' });
        }
        assert.equal(options.headers.Authorization, 'Bearer local-simulation-token');
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        return page(['24']);
    });
    assert.equal((await read('https://registry-1.docker.io/v2/library/node/tags/list')).status, 200);
    assert.equal((await read('https://registry-1.docker.io/v2/library/node/tags/list')).status, 200);
    assert.equal(calls.length, 4);
    await assert.rejects(read('https://other.example/v2/library/node/tags/list'), /read_scope_invalid/);
    await assert.rejects(read('https://registry-1.docker.io/v2/library/other/tags/list'), /read_scope_invalid/);
    assert.equal(calls.length, 4);
});

test('token permission errors propagate without credential or response-body diagnostics', async () => {
    let calls = 0;
    const read = createDockerRegistryReader('ghcr.io/macbre/curl-http3', async (url) => {
        if (++calls === 1) return new Response('', { status: 401 });
        assert.equal(new URL(url).origin, 'https://ghcr.io');
        return new Response('private token response', { status: 403 });
    });
    await assert.rejects(read('https://ghcr.io/v2/macbre/curl-http3/tags/list'), (error) => {
        assert.match(error.message, /token_http_error:ghcr.io\/macbre\/curl-http3:403/);
        assert.doesNotMatch(error.message, /private token response/);
        return true;
    });
});

function manifestFixture()
{
    const manifest = {
        schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'a'.repeat(64)}`, size: 100 }, layers: []
    };
    const bytes = JSON.stringify(manifest);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    return { manifest, bytes, digest, headers: { 'content-type': manifest.mediaType, 'docker-content-digest': digest } };
}

test('manifest digest is computed from exact bytes with no image layer requests', async () => {
    const data = manifestFixture();
    const calls = [];
    const result = await readDockerManifest('node', data.digest, async (url, accept) => {
        calls.push(url);
        assert.ok(accept.includes(data.manifest.mediaType));
        return new Response(data.bytes, { headers: data.headers });
    });
    assert.equal(result.digest, data.digest);
    assert.deepEqual(result.manifest, data.manifest);
    assert.equal(calls.length, 1);
});

test('manifest byte tampering and requested digest mismatch fail closed', async () => {
    const data = manifestFixture();
    await assert.rejects(readDockerManifest('node', 'latest', async () => new Response(`${data.bytes} `, { headers: data.headers })), /digest_mismatch/);
    await assert.rejects(readDockerManifest('node', `sha256:${'b'.repeat(64)}`, async () => new Response(data.bytes, { headers: data.headers })), /digest_mismatch/);
});

test('legacy media types and excessive manifest bodies are not accepted', async () => {
    const data = manifestFixture();
    await assert.rejects(readDockerManifest('node', 'latest', async () => new Response(data.bytes)), /media_type_invalid/);
    await assert.rejects(readDockerManifest('node', 'latest', async () => new Response(' '.repeat(4 * 1024 * 1024 + 1), { headers: data.headers })), /size_exceeded/);
});
