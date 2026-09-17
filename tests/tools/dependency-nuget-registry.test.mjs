import assert from 'node:assert/strict';
import test from 'node:test';

const { readLatestNuget } = await import(new URL('../../tools/governance/dependency-nuget-registry.mjs', import.meta.url));
function fixture(external = false)
{
    const entry = { id: 'Example.Package', version: '2.0.0', listed: true, published: '2026-01-01T12:00:00+00:00' };
    const page = { '@id': 'https://api.nuget.org/registration/page', count: 1, items: [{ catalogEntry: entry }] };
    const index = { count: 1, items: [external ? { '@id': page['@id'], count: 1 } : page] };
    const requests = [];
    const read = async (url) =>
    {
        requests.push(url);
        switch (url)
        {
            case 'https://api.nuget.org/v3-flatcontainer/example.package/index.json':
                return { versions: ['1.0.0', '2.0.0', '3.0.0-preview.1'] };
            case 'https://api.nuget.org/v3/index.json':
                return { resources: [{ '@type': 'RegistrationsBaseUrl/3.6.0', '@id': 'https://api.nuget.org/registration/' }] };
            case 'https://api.nuget.org/registration/example.package/index.json': return index;
            case page['@id']: return page;
            default: throw new Error(`unexpected route ${url}`);
        }
    };
    return { entry, page, index, read, requests };
}

test('NuGet preserves the existing stable target and reads actual publication time', async () =>
{
    for (const external of [false, true])
    {
        const data = fixture(external);
        assert.deepEqual(await readLatestNuget('Example.Package', data.read), {
            latestStable: '2.0.0', releasedAt: '2026-01-01T12:00:00.000Z'
        });
        assert.equal(data.requests.length, external ? 4 : 3);
    }
});

test('missing, unlisted, sentinel and invalid publication metadata never become query time', async () =>
{
    for (const change of [{ published: undefined }, { published: 'invalid' }, { published: '1900-01-01T00:00:00Z' }, { listed: false }])
    {
        const data = fixture();
        Object.assign(data.entry, change);
        await assert.rejects(readLatestNuget('Example.Package', data.read), /publication_missing/);
    }
});

test('partial or duplicated registration evidence fails closed', async () =>
{
    const partial = fixture();
    partial.page.count = 2;
    await assert.rejects(readLatestNuget('Example.Package', partial.read), /page_incomplete/);
    const duplicate = fixture();
    duplicate.index.items.push(duplicate.page);
    duplicate.index.count = 2;
    await assert.rejects(readLatestNuget('Example.Package', duplicate.read), /page_duplicate/);
});

test('inline page fragment identities are preserved but never used for external page fetches', async () =>
{
    const inline = fixture();
    inline.page['@id'] += '#page/1.0.0/2.0.0';
    assert.equal((await readLatestNuget('Example.Package', inline.read)).latestStable, '2.0.0');
    assert.equal(inline.requests.length, 3);
    const external = fixture(true);
    external.index.items[0]['@id'] += '#page/1.0.0/2.0.0';
    await assert.rejects(readLatestNuget('Example.Package', external.read), /registry_url_invalid/);
});

test('foreign package metadata and late network errors cannot supply a freshness result', async () =>
{
    const data = fixture(true);
    data.entry.id = 'Other.Package';
    await assert.rejects(readLatestNuget('Example.Package', data.read), /entry_invalid/);
    await assert.rejects(readLatestNuget('Example.Package', async (url) =>
    {
        if (url === data.page['@id'])
        {
            throw new Error('registry unavailable');
        }
        return data.read(url);
    }), /registry unavailable/);
});

test('explicitly unlisted newest version does not displace the latest listed stable target', async () =>
{
    const data = fixture();
    data.entry.listed = false;
    data.entry.published = '1900-01-01T00:00:00Z';
    data.page.items.push({ catalogEntry: { id: 'Example.Package', version: '1.0.0', listed: true, published: '2025-12-01T00:00:00Z' } });
    data.page.count = 2;
    assert.deepEqual(await readLatestNuget('Example.Package', data.read), {
        latestStable: '1.0.0', releasedAt: '2025-12-01T00:00:00.000Z'
    });
    // Missing metadata is not equivalent to an explicit unlisted state.
    delete data.entry.listed;
    await assert.rejects(readLatestNuget('Example.Package', data.read), /publication_missing/);
});
