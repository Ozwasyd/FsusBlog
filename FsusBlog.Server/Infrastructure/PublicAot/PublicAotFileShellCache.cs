using System.Buffers;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly IDatabase _db = redis.GetDatabase();
    private readonly string _cacheRoot = ResolveCacheRoot(env);

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

        await RegisterKeyAsync(entry.CacheKey).ConfigureAwait(false);
    }

    public async Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string path = GetEntryPath(cacheKey);
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
        RedisValue[] keys = await SafeSetMembersAsync(registryKey).ConfigureAwait(false);
        if (keys.Length == 0)
        {
            if (!string.Equals(registryKey, PublicAotCacheRegistry.GlobalRegistryKey, StringComparison.Ordinal))
            {
                keys = await SafeSetMembersAsync(PublicAotCacheRegistry.GlobalRegistryKey).ConfigureAwait(false);
            }

            if (keys.Length == 0)
            {
                foreach (string file in EnumerateEntryFiles())
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!TryReadEntry(file, out var entry) || entry is null)
                    {
                        continue;
                    }

                    if (!entry.CacheKey.StartsWith(prefix, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    File.Delete(file);
                }
                return;
            }
        }

        foreach (RedisValue key in keys)
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
        }
    }

    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
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
                byte[] raw = File.ReadAllBytes(path);
                return Task.FromResult(DeserializeEntryBytes(raw));
            },
            _ => null,
            NullLogger<PublicAotFileShellCache>.Instance,
            $"public-aot-read-entry:{path}",
            LogLevel.Debug).GetAwaiter().GetResult();
        return entry is not null;
    }

    internal static byte[] SerializeEntryBytes(PublicAotCacheEntry entry)
        => JsonSerializer.SerializeToUtf8Bytes(entry, JsonOptions);

    internal static PublicAotCacheEntry? DeserializeEntryBytes(ReadOnlySpan<byte> payload)
        => JsonSerializer.Deserialize<PublicAotCacheEntry>(payload, JsonOptions);

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

        return Directory.EnumerateFiles(_cacheRoot, "*.json", SearchOption.AllDirectories);
    }

    private string GetEntryPath(string cacheKey)
    {
        string hash = ToHash(cacheKey);
        string bucket = hash[..2];
        return Path.Combine(_cacheRoot, bucket, $"{hash}.json");
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

    private async Task<RedisValue[]> SafeSetMembersAsync(string registryKey)
    {
        return await BoundaryExecutor.ExecuteValueAsync(
            () => _db.SetMembersAsync(registryKey),
            _ => [],
            logger,
            $"public-aot-read-registry:{registryKey}");
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
}
