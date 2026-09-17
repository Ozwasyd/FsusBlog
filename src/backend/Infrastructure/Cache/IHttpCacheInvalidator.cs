using Microsoft.AspNetCore.OutputCaching;

namespace FsusBlog.Server.Infrastructure.Cache;

public interface IHttpCacheInvalidator
{
    Task InvalidateAsync(params CacheTag[] tags);
}

public sealed class HttpCacheInvalidator(IOutputCacheStore outputCacheStore) : IHttpCacheInvalidator
{
    public async Task InvalidateAsync(params CacheTag[] tags)
    {
        Task[] evictions = tags
            .Distinct()
            .Where(static tag => tag != CacheTag.None)
            .Select(tag => outputCacheStore.EvictByTagAsync(tag.ToOutputCacheTag(), default).AsTask())
            .ToArray();

        if (evictions.Length > 0)
        {
            await Task.WhenAll(evictions);
        }
    }
}
