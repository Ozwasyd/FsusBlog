/** Normalize an upstream release record without inventing a publication timestamp. */
export function registryRelease(latestStable, published, source)
{
    if (typeof latestStable !== 'string' || latestStable.length === 0)
    {
        throw new Error(`registry_latest_missing:${source}`);
    }
    const timestamp = typeof published === 'string' ? Date.parse(published) : Number.NaN;
    const format = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/;
    const day = typeof published === 'string' ? published.slice(0, 10) : '';
    const calendarDate = Date.parse(day);
    if (!format.test(published ?? '') || !Number.isFinite(timestamp) || !Number.isFinite(calendarDate)
        || new Date(calendarDate).toISOString().slice(0, 10) !== day)
    {
        throw new Error(`registry_publication_missing_or_invalid:${source}`);
    }
    return { latestStable, releasedAt: new Date(timestamp).toISOString() };
}
