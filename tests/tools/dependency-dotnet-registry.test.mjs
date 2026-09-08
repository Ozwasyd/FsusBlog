import assert from 'node:assert/strict';
import test from 'node:test';

import { readLatestDotnetSdk } from '../../tools/governance/dependency-dotnet-registry.mjs';

function fixture()
{
    const index = { 'releases-index': [
        { 'channel-version': '11.0', 'latest-sdk': '11.0.100-preview.1' },
        { 'channel-version': '9.0', 'latest-sdk': '9.0.999' },
        { 'channel-version': '10.0', 'latest-sdk': '10.0.101' }
    ] };
    const channel = { 'channel-version': '10.0', releases: [
        { 'release-date': '2025-12-09', sdks: [{ version: '10.0.101' }] }
    ] };
    const urls = [];
    const read = async (url) => {
        urls.push(url);
        if (url.endsWith('/releases-index.json')) return index;
        assert.equal(url, 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json');
        return channel;
    };
    return { index, channel, urls, read };
}

test('dotnet registry selects numeric latest stable SDK and its real release date', async () => {
    const data = fixture();
    assert.deepEqual(await readLatestDotnetSdk(data.read), {
        latestStable: '10.0.101', releasedAt: '2025-12-09T00:00:00.000Z'
    });
    assert.equal(data.urls.length, 2);
});

test('SDK metadata supports singular sdk and never substitutes the query date', async () => {
    const data = fixture();
    data.channel.releases = [{ 'release-date': '2025-12-09', sdk: { version: '10.0.101' } }];
    assert.equal((await readLatestDotnetSdk(data.read)).releasedAt, '2025-12-09T00:00:00.000Z');
    delete data.channel.releases[0]['release-date'];
    await assert.rejects(readLatestDotnetSdk(data.read), /release_date_missing/);
});

test('missing, conflicting and malformed SDK release dates fail closed', async () => {
    for (const releases of [[],
        [{ 'release-date': '2025-02-30', sdk: { version: '10.0.101' } }],
        ['2025-12-09', '2025-12-10'].map((date) => ({ 'release-date': date, sdk: { version: '10.0.101' } }))])
    {
        const data = fixture();
        data.channel.releases = releases;
        await assert.rejects(readLatestDotnetSdk(data.read), /release_date_missing/);
    }
});

test('registry errors and mismatched channels cannot become freshness success', async () => {
    await assert.rejects(readLatestDotnetSdk(async () => { throw new Error('registry unavailable'); }), /registry unavailable/);
    const data = fixture();
    data.channel['channel-version'] = '9.0';
    await assert.rejects(readLatestDotnetSdk(data.read), /channel_invalid/);
    data.index['releases-index'] = [];
    await assert.rejects(readLatestDotnetSdk(data.read), /latest_sdk_missing/);
});
