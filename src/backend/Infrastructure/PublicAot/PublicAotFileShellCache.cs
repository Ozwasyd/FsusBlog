using System.Collections.Concurrent;
using System.Buffers;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Execution;
using Microsoft.Extensions.Logging.Abstractions;
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

    public Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!TryReadValidEntry(cacheKey, out var cachedValue))
        {
            return Task.FromResult<PublicAotCacheEntry?>(null);
        }

        return Task.FromResult<PublicAotCacheEntry?>(cachedValue);
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
        _memoryCache[entry.CacheKey] = new MemoryCacheEntry(entry, File.GetLastWriteTimeUtc(targetPath));

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

    private bool TryReadValidEntry(string cacheKey, out PublicAotCacheEntry? value)
    {
        value = null;
        string path = GetEntryPath(cacheKey);
        if (TryGetMemoryEntry(cacheKey, path, out value))
        {
            return true;
        }

        if (!TryReadEntry(path, out var entry) || entry is null)
        {
            return false;
        }

        if (!string.Equals(entry.CacheKey, cacheKey, StringComparison.Ordinal))
        {
            return false;
        }

        if (entry.ExpiresAtUtc <= DateTimeOffset.UtcNow)
        {
            BoundaryExecutor.ExecuteAsync(
                () =>
                {
                    File.Delete(path);
                    return Task.CompletedTask;
                },
                logger,
                $"public-aot-delete-expired:{path}",
                LogLevel.Debug).GetAwaiter().GetResult();

            return false;
        }

        value = entry;
        _memoryCache[cacheKey] = new MemoryCacheEntry(entry, File.GetLastWriteTimeUtc(path));
        return true;
    }

    private bool TryGetMemoryEntry(string cacheKey, string path, out PublicAotCacheEntry? value)
    {
        value = null;
        if (!_memoryCache.TryGetValue(cacheKey, out MemoryCacheEntry? cached))
        {
            return false;
        }

        if (!File.Exists(path))
        {
            _memoryCache.TryRemove(cacheKey, out _);
            return false;
        }

        if (File.GetLastWriteTimeUtc(path) != cached.LastWriteTimeUtc)
        {
            _memoryCache.TryRemove(cacheKey, out _);
            return false;
        }

        if (cached.Entry.ExpiresAtUtc <= DateTimeOffset.UtcNow)
        {
            _memoryCache.TryRemove(cacheKey, out _);
            BoundaryExecutor.ExecuteAsync(
                () =>
                {
                    File.Delete(path);
                    return Task.CompletedTask;
                },
                logger,
                $"public-aot-delete-expired:{path}",
                LogLevel.Debug).GetAwaiter().GetResult();
            return false;
        }

        value = cached.Entry;
        return true;
    }

    private static bool TryReadEntry(string path, out PublicAotCacheEntry? entry)
    {
        entry = null;
        if (!File.Exists(path))
        {
            return false;
        }

        entry = BoundaryExecutor.ExecuteValueAsync(
            () =>
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, FileOptions.SequentialScan);
                if (stream.Length <= 0 || stream.Length > int.MaxValue)
                {
                    return Task.FromResult<PublicAotCacheEntry?>(null);
                }

                int length = checked((int)stream.Length);
                byte[] raw = ArrayPool<byte>.Shared.Rent(length);
                try
                {
                    int totalRead = 0;
                    while (totalRead < length)
                    {
                        int read = stream.Read(raw, totalRead, length - totalRead);
                        if (read == 0)
                        {
                            break;
                        }

                        totalRead += read;
                    }

                    return Task.FromResult(totalRead == length
                        ? PublicAotCacheEntryBinaryCodec.Decode(raw.AsMemory(0, totalRead))
                        : null);
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(raw, clearArray: false);
                }
            },
            _ => null,
            NullLogger<PublicAotFileShellCache>.Instance,
            $"public-aot-read-entry:{path}",
            LogLevel.Debug).GetAwaiter().GetResult();
        return entry is not null;
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

    private sealed record MemoryCacheEntry(PublicAotCacheEntry Entry, DateTime LastWriteTimeUtc);
}
