using FsusBlog.Core.Common;

namespace FsusBlog.Core.Cache;

public sealed class CacheManager(ILevel1CacheStore level1, ILevel2CacheStore level2) : ICacheManager
{
    public async Task<Result<T>> TryGetAsync<T>(string key, CacheDecoder<T> decoder, CancellationToken cancellationToken = default)
    {
        if (level1.TryGet(key, out byte[] l1Bytes))
        {
            if (decoder(l1Bytes, out T l1Value))
            {
                return Result<T>.Success(l1Value);
            }

            level1.Remove(key);
            _ = level2.RemoveAsync(key, cancellationToken);
        }

        byte[]? l2Bytes = await level2.GetAsync(key, cancellationToken);
        if (l2Bytes is null || l2Bytes.Length == 0)
        {
            return Result<T>.Failure(ErrorCode.NotFound, "cache miss");
        }

        if (!decoder(l2Bytes, out T l2Value))
        {
            level1.Remove(key);
            await level2.RemoveAsync(key, cancellationToken);
            return Result<T>.Failure(ErrorCode.InfraFailure, "cache decode failed");
        }

        level1.Set(key, l2Bytes, TimeSpan.FromMinutes(5));
        return Result<T>.Success(l2Value);
    }

    public async Task<Result> SetAsync<T>(string key, T value, Func<T, byte[]> encoder, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        byte[] bytes = encoder(value);
        level1.Set(key, bytes, ttl);
        await level2.SetAsync(key, bytes, ttl, cancellationToken);
        return Result.Success();
    }

    public async Task<Result> RemoveAsync(string key, CancellationToken cancellationToken = default)
    {
        level1.Remove(key);
        await level2.RemoveAsync(key, cancellationToken);
        return Result.Success();
    }

    public async Task<Result<T>> GetOrLoadAsync<T>(
        string key,
        CacheDecoder<T> decoder,
        Func<T, byte[]> encoder,
        Func<CancellationToken, Task<T>> loader,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        Result<T> cached = await TryGetAsync(key, decoder, cancellationToken);
        if (cached.IsSuccess)
        {
            return cached;
        }

        T loaded = await loader(cancellationToken);
        await SetAsync(key, loaded, encoder, ttl, cancellationToken);
        return Result<T>.Success(loaded);
    }
}
