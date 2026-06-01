using System.Collections.Concurrent;
using System.Buffers;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotFileShellCache(
    IWebHostEnvironment env,
    IConnectionMultiplexer redis,
    ILogger<PublicAotFileShellCache> logger) : IPublicAotShellCache
{
    private const string InvalidationChannel = "public:aot:v2:invalidate";
    private readonly IDatabase _db = redis.GetDatabase();
    private readonly string _cacheRoot = ResolveCacheRoot(env);
    private readonly ConcurrentDictionary<string, MemoryCacheEntry> _memoryCache = new(StringComparer.Ordinal);
    private long _memoryGeneration;

    public async Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (TryGetMemoryEntry(cacheKey, out var cachedValue))
        {
            return cachedValue;
        }

        return await TryReadValidEntryAsync(cacheKey, cancellationToken).ConfigureAwait(false);
    }

    public async Task SetAsync(PublicAotCacheEntry entry, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string targetPath = GetEntryPath(entry.CacheKey);
        string directory = Path.GetDirectoryName(targetPath)!;
        Directory.CreateDirectory(directory);

        string tempPath = Path.Combine(directory, $"{Path.GetFileName(targetPath)}.{Guid.NewGuid():N}.tmp");
        byte[] payload = SerializeEntryBytes(entry);
        await File.WriteAllBytesAsync(tempPath, payload, cancellationToken);
        File.Move(tempPath, targetPath, overwrite: true);
        _memoryCache[entry.CacheKey] = CreateMemoryCacheEntry(entry);

        await RegisterKeyAsync(entry.CacheKey).ConfigureAwait(false);
    }

    public async Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string path = GetEntryPath(cacheKey);
        _memoryCache.TryRemove(cacheKey, out _);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        await UnregisterKeyAsync(cacheKey).ConfigureAwait(false);
        await PublishInvalidationAsync(cacheKey).ConfigureAwait(false);
    }

    public async Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(prefix))
        {
            return;
        }

        string registryKey = ResolveRegistryKey(prefix, out bool requiresPrefixFilter);
        int removed = await RemoveRegisteredKeysAsync(registryKey, prefix, requiresPrefixFilter, cancellationToken).ConfigureAwait(false);
        if (removed == 0)
        {
            if (!string.Equals(registryKey, PublicAotCacheRegistry.GlobalRegistryKey, StringComparison.Ordinal))
            {
                removed = await RemoveRegisteredKeysAsync(PublicAotCacheRegistry.GlobalRegistryKey, prefix, requiresPrefixFilter: true, cancellationToken).ConfigureAwait(false);
            }

            if (removed == 0)
            {
                logger.LogWarning(
                    "public-aot-prefix-invalidation-registry-missing {Prefix}; skipped disk scan",
                    prefix);
                await PublishInvalidationAsync(prefix).ConfigureAwait(false);
                return;
            }
        }
    }

    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Interlocked.Increment(ref _memoryGeneration);
        _memoryCache.Clear();
        if (Directory.Exists(_cacheRoot))
        {
            foreach (string file in EnumerateEntryFiles())
            {
                cancellationToken.ThrowIfCancellationRequested();
                File.Delete(file);
            }
        }

        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                RedisKey[] registryKeys = [.. PublicAotCacheRegistry.GetAllKnownRegistryKeys().Select(static key => (RedisKey)key)];
                if (registryKeys.Length > 0)
                {
                    _ = await _db.KeyDeleteAsync(registryKeys).ConfigureAwait(false);
                }
            },
            logger,
            "public-aot-clear-registry");

        await PublishInvalidationAsync("all").ConfigureAwait(false);
    }

    private async Task<PublicAotCacheEntry?> TryReadValidEntryAsync(string cacheKey, CancellationToken cancellationToken)
    {
        string path = GetEntryPath(cacheKey);
        PublicAotCacheEntry? entry = await TryReadEntryAsync(path, cancellationToken).ConfigureAwait(false);
        if (entry is null)
        {
            RecordCacheRead("miss", "file", "public_aot_cache_miss", cacheKey, TimeSpan.Zero);
            return null;
        }

        if (!string.Equals(entry.CacheKey, cacheKey, StringComparison.Ordinal))
        {
            RecordCacheRead("miss", "file", "public_aot_cache_miss", cacheKey, TimeSpan.Zero);
            return null;
        }

        if (entry.ExpiresAtUtc <= DateTimeOffset.UtcNow)
        {
            _memoryCache.TryRemove(cacheKey, out _);
            QueueExpiredFileDelete(path);
            RecordCacheRead("stale", "file", "public_aot_cache_stale_removed", cacheKey, TimeSpan.Zero);
            return null;
        }

        _memoryCache[cacheKey] = CreateMemoryCacheEntry(entry);
        RecordCacheRead("hit", "file", "public_aot_cache_file_hit", cacheKey, TimeSpan.Zero);
        return entry;
    }

    private bool TryGetMemoryEntry(string cacheKey, out PublicAotCacheEntry? value)
    {
        value = null;
        if (!_memoryCache.TryGetValue(cacheKey, out MemoryCacheEntry? cached))
        {
            return false;
        }

        long generation = Volatile.Read(ref _memoryGeneration);
        if (cached.GenerationToken != generation || cached.ExpiresAtUtc <= DateTimeOffset.UtcNow)
        {
            _memoryCache.TryRemove(cacheKey, out _);
            if (cached.ExpiresAtUtc <= DateTimeOffset.UtcNow)
            {
                QueueExpiredFileDelete(GetEntryPath(cacheKey));
                RecordCacheRead("stale", "memory", "public_aot_cache_stale_removed", cacheKey, TimeSpan.Zero);
            }
            return false;
        }

        value = cached.Entry;
        RecordCacheRead("hit", "memory", "public_aot_cache_memory_hit", cacheKey, TimeSpan.Zero);
        return true;
    }

    private async Task<PublicAotCacheEntry?> TryReadEntryAsync(string path, CancellationToken cancellationToken)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        long started = Stopwatch.GetTimestamp();
        try
        {
            await using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 64 * 1024,
                options: FileOptions.Asynchronous | FileOptions.SequentialScan);
            if (stream.Length <= 0 || stream.Length > int.MaxValue)
            {
                return null;
            }

            int length = checked((int)stream.Length);
            byte[] raw = ArrayPool<byte>.Shared.Rent(length);
            try
            {
                int totalRead = 0;
                while (totalRead < length)
                {
                    int read = await stream.ReadAsync(raw.AsMemory(totalRead, length - totalRead), cancellationToken).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    totalRead += read;
                }

                return totalRead == length
                    ? PublicAotCacheEntryBinaryCodec.Decode(raw.AsMemory(0, totalRead))
                    : null;
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(raw, clearArray: false);
                TimeSpan elapsed = Stopwatch.GetElapsedTime(started);
                FsusObservability.RecordCacheOperation(
                    "read",
                    nameof(CachePolicyId.PublicAotDocument),
                    "file",
                    "completed",
                    elapsed);
                logger.LogDebug("public_aot_cache_file_read_ms {Path} {ElapsedMs}", path, elapsed.TotalMilliseconds);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            TimeSpan elapsed = Stopwatch.GetElapsedTime(started);
            FsusObservability.RecordCacheOperation(
                "read",
                nameof(CachePolicyId.PublicAotDocument),
                "file",
                "error",
                elapsed);
            logger.LogWarning(ex, "public_aot_cache_read_error {Path}", path);
            return null;
        }
    }

    private MemoryCacheEntry CreateMemoryCacheEntry(PublicAotCacheEntry entry)
        => new(entry, entry.ExpiresAtUtc, entry.RendererVersion, entry.FrontendAssetVersion, Volatile.Read(ref _memoryGeneration));

    private void RecordCacheRead(string result, string layer, string logToken, string cacheKey, TimeSpan duration)
    {
        FsusObservability.RecordCacheOperation(
            "lookup",
            nameof(CachePolicyId.PublicAotDocument),
            layer,
            result,
            duration);
        switch (logToken)
        {
            case "public_aot_cache_memory_hit":
                logger.LogDebug("public_aot_cache_memory_hit {CacheKey}", cacheKey);
                break;
            case "public_aot_cache_file_hit":
                logger.LogDebug("public_aot_cache_file_hit {CacheKey}", cacheKey);
                break;
            case "public_aot_cache_miss":
                logger.LogDebug("public_aot_cache_miss {CacheKey}", cacheKey);
                break;
            case "public_aot_cache_stale_removed":
                logger.LogDebug("public_aot_cache_stale_removed {CacheKey}", cacheKey);
                break;
            default:
                logger.LogDebug("public_aot_cache_lookup {Result} {Layer} {CacheKey}", result, layer, cacheKey);
                break;
        }
    }

    private void QueueExpiredFileDelete(string path)
    {
        _ = Task.Run(() =>
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "public_aot_cache_expired_delete_failed {Path}", path);
            }
        });
    }

    internal static byte[] SerializeEntryBytes(PublicAotCacheEntry entry)
        => PublicAotCacheEntryBinaryCodec.Encode(entry);

    internal static PublicAotCacheEntry? DeserializeEntryBytes(ReadOnlySpan<byte> payload)
        => PublicAotCacheEntryBinaryCodec.Decode(payload);

    internal static PublicAotCacheEntry? DeserializeEntryBytes(ReadOnlyMemory<byte> payload)
        => PublicAotCacheEntryBinaryCodec.Decode(payload);

    private static string ResolveCacheRoot(IWebHostEnvironment env)
    {
        string webRoot = string.IsNullOrWhiteSpace(env.WebRootPath)
            ? Path.Combine(env.ContentRootPath, "wwwroot")
            : env.WebRootPath;
        return Path.Combine(webRoot, "aot-cache");
    }

    private IEnumerable<string> EnumerateEntryFiles()
    {
        if (!Directory.Exists(_cacheRoot))
        {
            return [];
        }

        return Directory.EnumerateFiles(_cacheRoot, "*.aeds", SearchOption.AllDirectories);
    }

    private string GetEntryPath(string cacheKey)
    {
        string hash = ToHash(cacheKey);
        string bucket = hash[..2];
        return Path.Combine(_cacheRoot, bucket, $"{hash}.aeds");
    }

    private static string ToHash(string input)
    {
        int byteCount = Encoding.UTF8.GetByteCount(input);
        Span<byte> hash = stackalloc byte[32];

        if (byteCount <= 256)
        {
            Span<byte> utf8 = stackalloc byte[byteCount];
            Encoding.UTF8.GetBytes(input.AsSpan(), utf8);
            SHA256.HashData(utf8, hash);
            return Convert.ToHexStringLower(hash);
        }

        byte[] rented = ArrayPool<byte>.Shared.Rent(byteCount);
        try
        {
            int written = Encoding.UTF8.GetBytes(input.AsSpan(), rented);
            SHA256.HashData(rented.AsSpan(0, written), hash);
            return Convert.ToHexStringLower(hash);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented, clearArray: true);
        }
    }

    internal static string ToHashForTests(string input) => ToHash(input);

    private async Task<int> RemoveRegisteredKeysAsync(
        string registryKey,
        string prefix,
        bool requiresPrefixFilter,
        CancellationToken cancellationToken)
    {
        int removed = 0;
        try
        {
            foreach (RedisValue key in _db.SetScan(registryKey, pageSize: 256))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (key.IsNullOrEmpty)
                {
                    continue;
                }

                string cacheKey = key.ToString();
                if (requiresPrefixFilter && !cacheKey.StartsWith(prefix, StringComparison.Ordinal))
                {
                    continue;
                }

                await RemoveAsync(cacheKey, cancellationToken).ConfigureAwait(false);
                removed++;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "public-aot-read-registry-failed {RegistryKey}", registryKey);
        }

        return removed;
    }

    private async Task RegisterKeyAsync(string cacheKey)
    {
        if (PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out PublicPageId pageId, out string routeKey))
        {
            foreach (string registryKey in PublicAotCacheRegistry.GetRegistryKeys(pageId, routeKey))
            {
                await BoundaryExecutor.ExecuteAsync(
                    async () => _ = await _db.SetAddAsync(registryKey, cacheKey).ConfigureAwait(false),
                    logger,
                    $"public-aot-register:{registryKey}:{cacheKey}");
            }

            return;
        }

        await BoundaryExecutor.ExecuteAsync(
            async () => _ = await _db.SetAddAsync(PublicAotCacheRegistry.GlobalRegistryKey, cacheKey).ConfigureAwait(false),
            logger,
            $"public-aot-register:{cacheKey}");
    }

    private async Task UnregisterKeyAsync(string cacheKey)
    {
        if (PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out PublicPageId pageId, out string routeKey))
        {
            foreach (string registryKey in PublicAotCacheRegistry.GetRegistryKeys(pageId, routeKey))
            {
                await BoundaryExecutor.ExecuteAsync(
                    async () => _ = await _db.SetRemoveAsync(registryKey, cacheKey).ConfigureAwait(false),
                    logger,
                    $"public-aot-unregister:{registryKey}:{cacheKey}");
            }

            return;
        }

        await BoundaryExecutor.ExecuteAsync(
            async () => _ = await _db.SetRemoveAsync(PublicAotCacheRegistry.GlobalRegistryKey, cacheKey).ConfigureAwait(false),
            logger,
            $"public-aot-unregister:{cacheKey}");
    }

    private static string ResolveRegistryKey(string prefix, out bool requiresPrefixFilter)
    {
        if (PublicAotCacheRegistry.TryResolveRegistryScope(prefix, out string registryKey, out requiresPrefixFilter))
        {
            return registryKey;
        }

        requiresPrefixFilter = true;
        return PublicAotCacheRegistry.GlobalRegistryKey;
    }

    private async Task PublishInvalidationAsync(string cacheKey)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                _ = await redis.GetSubscriber()
                    .PublishAsync(RedisChannel.Literal(InvalidationChannel), cacheKey)
                    .ConfigureAwait(false);
            },
            logger,
            $"public-aot-publish:{cacheKey}",
            LogLevel.Debug);
    }

    private sealed record MemoryCacheEntry(
        PublicAotCacheEntry Entry,
        DateTimeOffset ExpiresAtUtc,
        string RendererVersion,
        string FrontendAssetVersion,
        long GenerationToken);
}
