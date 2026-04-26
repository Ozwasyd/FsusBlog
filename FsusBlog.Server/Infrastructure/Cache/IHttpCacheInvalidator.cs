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
        foreach (CacheTag tag in tags.Distinct())
        {
            if (tag == CacheTag.None)
            {
                continue;
            }

            await outputCacheStore.EvictByTagAsync(tag.ToOutputCacheTag(), default);
        }
    }
}
