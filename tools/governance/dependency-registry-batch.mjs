/** Bound network pressure while retaining every dependency's exact failure identity. */
export async function collectRegistryResults(items, lookup, concurrency = 8)
{
    if (!Array.isArray(items) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
    {
        throw new Error('registry_batch_invalid');
    }
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () =>
    {
        while (next < items.length)
        {
            const index = next++;
            const item = items[index];
            try
            {
                results[index] = { status: 'fulfilled', value: await lookup(item) };
            }
            catch (error)
            {
                results[index] = {
                    status: 'rejected',
                    reason: new Error(`${item.id}:${item.datasource}:${item.packageName}: ${error instanceof Error ? error.message : String(error)}`)
                };
            }
        }
    }));
    return results;
}
