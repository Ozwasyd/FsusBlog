import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createDockerRegistryReader, dockerRepository, readDockerHubPublication, readDockerManifest, readDockerTags, readLatestDocker, readMcrPublication, selectLatestDockerTag } from '../../tools/governance/dependency-docker-registry.mjs';

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

test('Docker latest tag preserves compatibility suffix and version precision', () => {
    assert.equal(selectLatestDockerTag(['17-alpine', '18-alpine', '19-bookworm', '18.1-alpine', '19'], '17-alpine'), '18-alpine');
    assert.equal(selectLatestDockerTag(['10.0', '10.1', '10.2.0', '11.0-preview.1'], '10.0'), '10.1');
    assert.equal(selectLatestDockerTag(['24.9.0', '24.10.0', '24.11.0-alpine', '25.0.0-rc1'], '24.9.0'), '24.10.0');
});

test('Docker numeric ordering is exact and independent of tag response ordering', () => {
    const tags = ['1.9.0', '2.0.0', '1.10.0'];
    assert.equal(selectLatestDockerTag(tags, '1.0.0'), '2.0.0');
    assert.equal(selectLatestDockerTag([...tags].reverse(), '1.0.0'), '2.0.0');
    assert.equal(selectLatestDockerTag(['1.9007199254740992', '1.9007199254740993'], '1.0'), '1.9007199254740993');
});

test('missing compatible tags, implicit aliases and downgrades cannot become latest targets', () => {
    assert.throws(() => selectLatestDockerTag(['18-bookworm'], '17-alpine'), /compatible_tag_missing/);
    assert.throws(() => selectLatestDockerTag(['16-alpine'], '17-alpine'), /would_downgrade/);
    for (const current of ['latest', `sha256:${'a'.repeat(64)}`, 'not-a-version'])
    {
        assert.throws(() => selectLatestDockerTag(['1.0'], current), /numeric_tag_required/);
    }
});

test('Docker Hub publication requires exact tag and manifest identity, not HTTP observation time', async () => {
    const data = manifestFixture();
    const body = { name: '24', digest: data.digest, tag_last_pushed: '2026-01-01T00:00:00Z' };
    const read = async (url) => {
        assert.equal(url, 'https://hub.docker.com/v2/namespaces/library/repositories/node/tags/24');
        return body;
    };
    assert.equal(await readDockerHubPublication('node', '24', data.digest, read), '2026-01-01T00:00:00.000Z');
    body.digest = `sha256:${'b'.repeat(64)}`;
    await assert.rejects(readDockerHubPublication('node', '24', data.digest, read), /digest_changed/);
    body.digest = data.digest;
    delete body.tag_last_pushed;
    await assert.rejects(readDockerHubPublication('node', '24', data.digest, read), /publication_missing/);
});

test('Docker snapshot joins tag or digest targets with the exact publication provider', async () => {
    const data = manifestFixture();
    for (const current of ['23', `sha256:${'b'.repeat(64)}`])
    {
        const digestOnly = current.startsWith('sha256:');
        const read = async (url) => url.includes('/tags/list') ? page(['23', '24']) : new Response(data.bytes, { headers: data.headers });
        const result = await readLatestDocker('node', current, read, async (name, tag, digest) => {
            assert.equal(name, 'node');
            assert.equal(tag, digestOnly ? 'latest' : '24');
            assert.equal(digest, data.digest);
            return '2026-01-01T00:00:00Z';
        });
        assert.equal(result.latestStable, digestOnly ? data.digest : '24');
        assert.equal(result.targetDigest, data.digest);
        assert.equal(result.releasedAt, '2026-01-01T00:00:00.000Z');
    }
});

test('same-tag digest changes remain distinct freshness targets', async () => {
    const data = manifestFixture();
    const current = `24@sha256:${'b'.repeat(64)}`;
    const result = await readLatestDocker('node', current, async url => url.includes('/tags/list')
        ? page(['24']) : new Response(data.bytes, { headers: data.headers }), async () => '2026-01-01T00:00:00Z');
    assert.equal(result.latestStable, `24@${data.digest}`);
    assert.notEqual(result.latestStable, current);
    await assert.rejects(readLatestDocker('node', '24@sha256:short', async () => { throw new Error('must not fetch'); }), /current_reference_invalid/);
});

test('every image flavor is verified and unchanged flavors cannot backdate a new update', async () => {
    const data = manifestFixture();
    const current = JSON.stringify([`24-alpine@${data.digest}`, `24-slim@sha256:${'b'.repeat(64)}`]);
    const publications = [];
    const read = async url => url.includes('/tags/list')
        ? page(['24-alpine', '24-slim']) : new Response(data.bytes, { headers: data.headers });
    const result = await readLatestDocker('node', current, read, async (name, tag) => {
        publications.push(tag);
        return tag === '24-alpine' ? '2025-01-01T00:00:00Z' : '2026-01-02T00:00:00Z';
    });
    assert.deepEqual(publications, ['24-alpine', '24-slim']);
    assert.equal(result.latestStable, JSON.stringify([`24-alpine@${data.digest}`, `24-slim@${data.digest}`]));
    assert.equal(result.releasedAt, '2026-01-02T00:00:00.000Z');
    await assert.rejects(readLatestDocker('node', current, read, async (name, tag) => {
        if (tag === '24-slim') throw new Error('second flavor unavailable');
        return '2025-01-01T00:00:00Z';
    }), /second flavor unavailable/);
    await assert.rejects(readLatestDocker('node', '["24","24"]', read), /variant_identity_invalid/);
});

test('MCR catalog publication binds registry, repository, tag and manifest digest', async () => {
    const data = manifestFixture();
    const row = { name: '10.0', digest: data.digest, repository: 'dotnet/sdk', regHash: 'mar',
        manifestType: data.manifest.mediaType, lastModifiedDate: '2026-01-01T12:00:00.0000000+00:00' };
    const read = async (url) => {
        assert.equal(url, 'https://mcr.microsoft.com/api/v1/catalog/dotnet/sdk/tags?reg=mar');
        return [row];
    };
    assert.equal(await readMcrPublication('mcr.microsoft.com/dotnet/sdk', '10.0', data.digest, read), '2026-01-01T12:00:00.000Z');
    for (const changes of [{ digest: `sha256:${'b'.repeat(64)}` }, { repository: 'dotnet/aspnet' }, { regHash: 'other' }])
    {
        await assert.rejects(readMcrPublication('mcr.microsoft.com/dotnet/sdk', '10.0', data.digest, async () => [{ ...row, ...changes }]), /identity_mismatch/);
    }
    await assert.rejects(readMcrPublication('mcr.microsoft.com/dotnet/sdk', '10.0', data.digest, async () => [row, row]), /identity_mismatch/);
    delete row.lastModifiedDate;
    await assert.rejects(readMcrPublication('mcr.microsoft.com/dotnet/sdk', '10.0', data.digest, read), /publication_missing/);
});
