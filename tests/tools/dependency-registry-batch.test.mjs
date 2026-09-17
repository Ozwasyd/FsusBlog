import assert from 'node:assert/strict';
import test from 'node:test';

const { collectRegistryResults } = await import(new URL('../../tools/governance/dependency-registry-batch.mjs', import.meta.url));
test('registry batch bounds concurrent lookups and preserves catalog order', async () =>
{
    let active = 0;
    let maximum = 0;
    const items = Array.from({ length: 9 }, (_, id) => ({ id }));
    const results = await collectRegistryResults(items, async (item) =>
    {
        active++;
        maximum = Math.max(active, maximum);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return item.id;
    }, 2);
    assert.equal(maximum, 2);
    assert.deepEqual(results.map((result) => result.value), items.map((item) => item.id));
});

test('one failed lookup retains its dependency identity without dropping other results', async () =>
{
    const items = ['a', 'b', 'c'].map((id) => ({ id, datasource: 'nuget', packageName: `package-${id}` }));
    const results = await collectRegistryResults(items, async (item) =>
    {
        if (item.id === 'b')
        {
            throw new Error('publication missing');
        }
        return item.id;
    });
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.equal(results[1].reason.message, 'b:nuget:package-b: publication missing');
});
