using FsusBlog.Core.Common;

namespace FsusBlog.Core.Cache;

public interface ILevel1CacheStore
{
    bool TryGet(string key, out byte[] value);
    void Set(string key, byte[] value, TimeSpan ttl);
    void Remove(string key);
}

public interface ILevel2CacheStore
{
    Task<byte[]?> GetAsync(string key, CancellationToken cancellationToken = default);
    Task SetAsync(string key, byte[] value, TimeSpan ttl, CancellationToken cancellationToken = default);
    Task RemoveAsync(string key, CancellationToken cancellationToken = default);
}

public delegate bool CacheDecoder<T>(ReadOnlyMemory<byte> bytes, out T value);

public interface ICacheManager
{
    Task<Result<T>> TryGetAsync<T>(string key, CacheDecoder<T> decoder, CancellationToken cancellationToken = default);
    Task<Result> SetAsync<T>(string key, T value, Func<T, byte[]> encoder, TimeSpan ttl, CancellationToken cancellationToken = default);
    Task<Result> RemoveAsync(string key, CancellationToken cancellationToken = default);
    Task<Result<T>> GetOrLoadAsync<T>(
        string key,
        CacheDecoder<T> decoder,
        Func<T, byte[]> encoder,
        Func<CancellationToken, Task<T>> loader,
        TimeSpan ttl,
        CancellationToken cancellationToken = default);
}
