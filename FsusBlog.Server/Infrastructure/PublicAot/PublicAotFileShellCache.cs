using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotFileShellCache(
    IWebHostEnvironment env,
    IConnectionMultiplexer redis,
    ILogger<PublicAotFileShellCache> logger) : IPublicAotShellCache
{
    private const string RegistryKey = "public:aot:v2:registry";
    private const string InvalidationChannel = "public:aot:v2:invalidate";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly IDatabase _db = redis.GetDatabase();
    private readonly string _cacheRoot = ResolveCacheRoot(env);

    public Task<(bool Hit, string Value)> TryGetAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!TryReadValidEntry(cacheKey, out var cachedValue))
        {
            return Task.FromResult((false, string.Empty));
        }

        return Task.FromResult((true, cachedValue));
    }

    public async Task<string> GetOrCreateAsync(
        string cacheKey,
        Func<CancellationToken, Task<string>> factory,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        if (TryReadValidEntry(cacheKey, out var cachedValue))
        {
            return cachedValue;
        }

        string value = await factory(cancellationToken);
        await SetAsync(cacheKey, value, ttl, cancellationToken);
        return value;
    }

    public async Task SetAsync(string cacheKey, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var entry = new PublicAotFileEntry
        {
            CacheKey = cacheKey,
            ExpiresAtUtc = DateTimeOffset.UtcNow.Add(ttl),
            Value = value
        };

        string targetPath = GetEntryPath(cacheKey);
        string directory = Path.GetDirectoryName(targetPath)!;
        Directory.CreateDirectory(directory);

        string payload = JsonSerializer.Serialize(entry, JsonOptions);
        string tempPath = Path.Combine(directory, $"{Path.GetFileName(targetPath)}.{Guid.NewGuid():N}.tmp");
        await File.WriteAllTextAsync(tempPath, payload, Encoding.UTF8, cancellationToken);
        File.Move(tempPath, targetPath, overwrite: true);

        await RegisterKeyAsync(cacheKey).ConfigureAwait(false);
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

        RedisValue[] keys = await SafeSetMembersAsync().ConfigureAwait(false);
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

        foreach (RedisValue key in keys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            string cacheKey = key.ToString();
            if (!cacheKey.StartsWith(prefix, StringComparison.Ordinal))
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

        try
        {
            _ = await _db.KeyDeleteAsync(RegistryKey).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to clear Redis AOT registry key.");
        }

        await PublishInvalidationAsync("all").ConfigureAwait(false);
    }

    private bool TryReadValidEntry(string cacheKey, out string value)
    {
        value = string.Empty;
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
            try
            {
                File.Delete(path);
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "Failed to remove expired public AOT cache file: {Path}", path);
            }

            return false;
        }

        value = entry.Value ?? string.Empty;
        return true;
    }

    private static bool TryReadEntry(string path, out PublicAotFileEntry? entry)
    {
        entry = null;
        if (!File.Exists(path))
        {
            return false;
        }

        try
        {
            string raw = File.ReadAllText(path, Encoding.UTF8);
            entry = JsonSerializer.Deserialize<PublicAotFileEntry>(raw, JsonOptions);
            return entry is not null;
        }
        catch
        {
            return false;
        }
    }

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
        byte[] bytes = SHA256.HashData(Encoding.UTF8.GetBytes(input));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private async Task<RedisValue[]> SafeSetMembersAsync()
    {
        try
        {
            return await _db.SetMembersAsync(RegistryKey).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to read Redis AOT registry members.");
            return [];
        }
    }

    private async Task RegisterKeyAsync(string cacheKey)
    {
        try
        {
            _ = await _db.SetAddAsync(RegistryKey, cacheKey).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to register public AOT key in Redis index: {CacheKey}", cacheKey);
        }
    }

    private async Task UnregisterKeyAsync(string cacheKey)
    {
        try
        {
            _ = await _db.SetRemoveAsync(RegistryKey, cacheKey).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to unregister public AOT key in Redis index: {CacheKey}", cacheKey);
        }
    }

    private async Task PublishInvalidationAsync(string cacheKey)
    {
        try
        {
            var channel = await redis.GetSubscriber()
                .PublishAsync(RedisChannel.Literal(InvalidationChannel), cacheKey)
                .ConfigureAwait(false);
            _ = channel;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed to publish public AOT invalidation event: {CacheKey}", cacheKey);
        }
    }

    private sealed class PublicAotFileEntry
    {
        public string CacheKey { get; init; } = string.Empty;
        public DateTimeOffset ExpiresAtUtc { get; init; }
        public string Value { get; init; } = string.Empty;
    }
}
