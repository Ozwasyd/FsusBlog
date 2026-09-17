import assert from 'node:assert/strict';
import test from 'node:test';

const { registryRelease } = await import(new URL('../../tools/governance/dependency-registry-release.mjs', import.meta.url));
const { behindSlaMs } = await import(new URL('../../tools/governance/dependency-freshness.mjs', import.meta.url));
test('registry publication time is preserved independently of repeated observation time', () =>
{
    const published = '2026-01-01T12:34:56.789Z';
    const first = registryRelease('1.2.3', published, 'npm:example');
    const second = registryRelease('1.2.3', published, 'npm:example');
    assert.deepEqual(first, { latestStable: '1.2.3', releasedAt: published });
    assert.deepEqual(second, first);
    assert.ok(Date.parse('2026-01-03T00:00:00Z') - Date.parse(second.releasedAt) > behindSlaMs);
});

test('date-only and offset upstream values normalize to UTC without changing the instant', () =>
{
    assert.equal(registryRelease('24.1.0', '2026-01-01', 'node-version:node').releasedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(registryRelease('v1', '2026-01-01T01:00:00+01:00', 'github-tags:example/test').releasedAt, '2026-01-01T00:00:00.000Z');
});

test('missing, permissively parseable and impossible publication dates fail with source diagnostics', () =>
{
    for (const value of [undefined, null, 0, '', 'January 1, 2026', '2026-02-30', '2026-01-01T25:00:00Z'])
    {
        assert.throws(() => registryRelease('1.0.0', value, 'npm:example'), /registry_publication_missing_or_invalid:npm:example/);
    }
});

test('missing release identity fails rather than returning timestamp-only evidence', () =>
{
    for (const version of [undefined, null, '', 1])
    {
        assert.throws(() => registryRelease(version, '2026-01-01', 'npm:example'), /registry_latest_missing:npm:example/);
    }
});
