function delay(ms)
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findEventuallyNamedTaxonomyId({
    label,
    name,
    read,
    timeoutMs,
    intervalMs = 600
})
{
    const deadline = Date.now() + timeoutMs;
    let lastNames = '[]';

    do
    {
        const items = await read();
        if (Array.isArray(items))
        {
            const found = items.find((item) => item?.name === name);
            const id = Number(found?.id);
            if (Number.isFinite(id) && id > 0)
            {
                return id;
            }

            lastNames = `[${items.map((item) => JSON.stringify(item?.name ?? '')).join(', ')}]`;
        }
        else
        {
            lastNames = '<non-array>';
        }

        await delay(intervalMs);
    } while (Date.now() < deadline);

    throw new Error(`${label}: ${name} missing from taxonomy list; last names=${lastNames}`);
}
