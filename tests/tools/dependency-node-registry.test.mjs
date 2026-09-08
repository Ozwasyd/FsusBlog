import assert from 'node:assert/strict';
import test from 'node:test';
import { readLatestNode } from '../../tools/governance/dependency-node-registry.mjs';

test('stable-only includes Current releases rather than restricting the target to LTS', async () => {
    const result = await readLatestNode(async url => {
        assert.equal(url, 'https://nodejs.org/dist/index.json');
        return [
            { version: 'v24.9.0', date: '2026-01-01', lts: 'Example' },
            { version: 'v25.9.0', date: '2026-01-02', lts: false },
            { version: 'v26.0.0-rc.1', date: '2026-01-03', lts: false },
            { version: 'v25.10.0', date: '2026-01-04', lts: false }
        ];
    });
    assert.deepEqual(result, { latestStable: '25.10.0', releasedAt: '2026-01-04T00:00:00.000Z' });
});

test('invalid, empty and ambiguous upstream release indexes fail closed', async () => {
    await assert.rejects(readLatestNode(async () => ({})), /index_invalid/);
    await assert.rejects(readLatestNode(async () => [{ version: 'v26.0.0-rc.1' }]), /stable_release_missing/);
    await assert.rejects(readLatestNode(async () => [
        { version: 'v25.0.0', date: '2026-01-01' },
        { version: 'v25.0.0', date: '2026-01-02' }
    ]), /latest_release_ambiguous/);
});

test('missing latest publication and upstream failure cannot fall back to an older release', async () => {
    await assert.rejects(readLatestNode(async () => [
        { version: 'v25.0.0' },
        { version: 'v24.0.0', date: '2026-01-01', lts: 'Example' }
    ]), /registry_publication_missing_or_invalid/);
    await assert.rejects(readLatestNode(async () => { throw new Error('network unavailable'); }), /network unavailable/);
});
