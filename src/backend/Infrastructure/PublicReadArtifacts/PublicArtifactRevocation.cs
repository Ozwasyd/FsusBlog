using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FsusBlog.Server.Infrastructure.Cache;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed class PublicArtifactRevocationOptions
{
    public bool CdnPurgeEnabled { get; set; }
    public string CdnProvider { get; set; } = "Generic";
    public string CdnPurgeEndpoint { get; set; } = string.Empty;
    public string CdnPurgeBearerToken { get; set; } = string.Empty;
    public string CloudflareZoneId { get; set; } = string.Empty;
    public bool PurgeAllOnArticleRevocation { get; set; } = true;

    public bool IsValid()
    {
        if (!CdnPurgeEnabled)
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(CdnPurgeBearerToken))
        {
            return false;
        }

        if (string.Equals(CdnProvider, "Cloudflare", StringComparison.OrdinalIgnoreCase))
        {
            return CloudflareZoneId.Length is > 0 and <= 64
                && CloudflareZoneId.All(static character => char.IsAsciiLetterOrDigit(character));
        }

        return string.Equals(CdnProvider, "Generic", StringComparison.OrdinalIgnoreCase)
            && Uri.TryCreate(CdnPurgeEndpoint, UriKind.Absolute, out Uri? endpoint)
            && endpoint.Scheme == Uri.UriSchemeHttps;
    }
}

public readonly record struct PublicArtifactTombstone(
    int ArticleId,
    long Generation,
    long RevokedAtUnixMilliseconds,
    bool PurgeConfirmed = false)
{
    public string Marker => $"g{Generation.ToString(CultureInfo.InvariantCulture)}";
}

public sealed record PublicArtifactRevocationMessage(
    string Action,
    int ArticleId,
    long Generation,
    long RevokedAtUnixMilliseconds,
    bool PurgeConfirmed = false)
{
    internal const string Channel = "fsus:public-artifact-revocation:v1";

    internal PublicArtifactTombstone Tombstone
        => new(ArticleId, Generation, RevokedAtUnixMilliseconds, PurgeConfirmed);
}

public sealed class PublicArtifactRevocationRegistry
{
    private readonly ConcurrentDictionary<int, PublicArtifactTombstone> _active = new();
    private readonly ConcurrentDictionary<int, long> _observedGenerations = new();
    private readonly ConcurrentDictionary<int, long> _clearedGenerations = new();
    private long _generation;

    public long CurrentGeneration => Volatile.Read(ref _generation);

    public void Apply(PublicArtifactTombstone tombstone)
    {
        if (tombstone.Generation <= 0)
        {
            return;
        }

        if (_clearedGenerations.TryGetValue(tombstone.ArticleId, out long cleared)
            && cleared >= tombstone.Generation)
        {
            return;
        }

        long observed = _observedGenerations.AddOrUpdate(
            tombstone.ArticleId,
            tombstone.Generation,
            (_, current) => Math.Max(current, tombstone.Generation));
        if (observed != tombstone.Generation)
        {
            return;
        }

        _active.AddOrUpdate(
            tombstone.ArticleId,
            tombstone,
            (_, current) => current.Generation > tombstone.Generation
                || (current.Generation == tombstone.Generation && current.PurgeConfirmed)
                    ? current
                    : tombstone);
        AdvanceGeneration(tombstone.Generation);
    }

    public void Clear(PublicArtifactTombstone tombstone)
    {
        _clearedGenerations.AddOrUpdate(
            tombstone.ArticleId,
            tombstone.Generation,
            (_, current) => Math.Max(current, tombstone.Generation));
        _observedGenerations.AddOrUpdate(
            tombstone.ArticleId,
            tombstone.Generation,
            (_, current) => Math.Max(current, tombstone.Generation));
        ((ICollection<KeyValuePair<int, PublicArtifactTombstone>>)_active)
            .Remove(new KeyValuePair<int, PublicArtifactTombstone>(tombstone.ArticleId, tombstone));
        AdvanceGeneration(tombstone.Generation);
    }

    public bool TryGet(int articleId, out PublicArtifactTombstone tombstone)
        => _active.TryGetValue(articleId, out tombstone);

    internal bool TryResolve(in PublicHotReadRoute route, out PublicArtifactTombstone tombstone)
    {
        if (route.ArticleId > 0 && _active.TryGetValue(route.ArticleId, out tombstone))
        {
            return true;
        }

        if (_active.TryGetValue(0, out tombstone))
        {
            return true;
        }

        tombstone = default;
        foreach (PublicArtifactTombstone candidate in _active.Values)
        {
            if (candidate.Generation > tombstone.Generation)
            {
                tombstone = candidate;
            }
        }

        return tombstone.Generation > 0;
    }

    public IReadOnlyList<PublicArtifactTombstone> Snapshot()
        => _active.Values.OrderBy(static item => item.Generation).ToArray();

    private void AdvanceGeneration(long generation)
    {
        long current = Volatile.Read(ref _generation);
        while (generation > current)
        {
            long observed = Interlocked.CompareExchange(ref _generation, generation, current);
            if (observed == current)
            {
                return;
            }
            current = observed;
        }
    }
}

public interface IPublicArtifactRevocationStateStore
{
    Task<PublicArtifactTombstone> RevokeArticleAsync(int articleId, CancellationToken cancellationToken);
    Task<PublicArtifactTombstone> ConfirmPurgeAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken);
    Task<IReadOnlyList<PublicArtifactTombstone>> LoadActiveAsync(CancellationToken cancellationToken);
    Task<bool> ClearAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken);
    Task PublishAsync(PublicArtifactRevocationMessage message, CancellationToken cancellationToken);
}

public sealed class RedisPublicArtifactRevocationStateStore(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope runtimeKeyScope) : IPublicArtifactRevocationStateStore
{
    private const string GenerationKey = "public-hot-read:revocation:generation";
    private const string TombstoneHashKey = "public-hot-read:revocation:tombstones";
    private static readonly LuaScript CompareAndDelete = LuaScript.Prepare(
        "local value = redis.call('HGET', @hash, @field); " +
        "if not value then return 1; end; " +
        "if value == @expected then redis.call('HDEL', @hash, @field); return 1; end; return 0;");
    private readonly IDatabase _database = redis.GetDatabase();
    private readonly ISubscriber _subscriber = redis.GetSubscriber();

    public async Task<PublicArtifactTombstone> RevokeArticleAsync(int articleId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisKey hashKey = runtimeKeyScope.PrefixKey(TombstoneHashKey);
        RedisValue field = articleId.ToString(CultureInfo.InvariantCulture);
        RedisValue existing = await _database.HashGetAsync(hashKey, field).ConfigureAwait(false);
        if (TryParse(existing, out PublicArtifactTombstone tombstone))
        {
            return tombstone;
        }

        long generation = await _database.StringIncrementAsync(runtimeKeyScope.PrefixKey(GenerationKey)).ConfigureAwait(false);
        tombstone = new PublicArtifactTombstone(articleId, generation, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        string payload = JsonSerializer.Serialize(tombstone);
        bool stored = await _database.HashSetAsync(hashKey, field, payload, When.NotExists).ConfigureAwait(false);
        if (stored)
        {
            return tombstone;
        }

        existing = await _database.HashGetAsync(hashKey, field).ConfigureAwait(false);
        return TryParse(existing, out tombstone)
            ? tombstone
            : throw new InvalidOperationException("public artifact tombstone could not be persisted");
    }

    public async Task<IReadOnlyList<PublicArtifactTombstone>> LoadActiveAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HashEntry[] entries = await _database.HashGetAllAsync(runtimeKeyScope.PrefixKey(TombstoneHashKey)).ConfigureAwait(false);
        return entries
            .Select(static entry => TryParse(entry.Value, out PublicArtifactTombstone value) ? value : default)
            .Where(static value => value.Generation > 0)
            .ToArray();
    }

    public async Task<PublicArtifactTombstone> ConfirmPurgeAsync(
        PublicArtifactTombstone tombstone,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (tombstone.PurgeConfirmed)
        {
            return tombstone;
        }

        PublicArtifactTombstone confirmed = tombstone with { PurgeConfirmed = true };
        RedisKey hashKey = runtimeKeyScope.PrefixKey(TombstoneHashKey);
        RedisValue field = tombstone.ArticleId.ToString(CultureInfo.InvariantCulture);
        RedisValue current = await _database.HashGetAsync(hashKey, field).ConfigureAwait(false);
        if (!TryParse(current, out PublicArtifactTombstone persisted)
            || persisted.Generation != tombstone.Generation)
        {
            throw new InvalidOperationException("public artifact tombstone changed before CDN purge confirmation");
        }

        if (persisted.PurgeConfirmed)
        {
            return persisted;
        }

        await _database.HashSetAsync(hashKey, field, JsonSerializer.Serialize(confirmed)).ConfigureAwait(false);
        return confirmed;
    }

    public async Task<bool> ClearAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string expected = JsonSerializer.Serialize(tombstone);
        RedisResult result = await _database.ScriptEvaluateAsync(
                CompareAndDelete,
                new
                {
                    hash = (RedisKey)runtimeKeyScope.PrefixKey(TombstoneHashKey),
                    field = (RedisValue)tombstone.ArticleId.ToString(CultureInfo.InvariantCulture),
                    expected = (RedisValue)expected
                })
            .ConfigureAwait(false);
        return (long)result == 1;
    }

    public async Task PublishAsync(PublicArtifactRevocationMessage message, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await _subscriber.PublishAsync(
                RedisChannel.Literal(runtimeKeyScope.PrefixKey(PublicArtifactRevocationMessage.Channel)),
                JsonSerializer.Serialize(message))
            .ConfigureAwait(false);
    }

    private static bool TryParse(RedisValue payload, out PublicArtifactTombstone tombstone)
    {
        try
        {
            tombstone = payload.HasValue
                ? JsonSerializer.Deserialize<PublicArtifactTombstone>((string)payload!)
                : default;
            return tombstone.Generation > 0;
        }
        catch (JsonException)
        {
            tombstone = default;
            return false;
        }
    }
}

public sealed record PublicArtifactCdnPurgeRequest(
    long Generation,
    string Marker,
    bool PurgeAll,
    IReadOnlyList<string> Paths,
    IReadOnlyList<string> Tags);

public interface IPublicArtifactCdnPurger
{
    Task PurgeAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken);
}

public sealed class HttpPublicArtifactCdnPurger(
    IHttpClientFactory httpClientFactory,
    IOptions<PublicArtifactRevocationOptions> options) : IPublicArtifactCdnPurger
{
    public async Task PurgeAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken)
    {
        PublicArtifactRevocationOptions value = options.Value;
        if (!value.CdnPurgeEnabled)
        {
            return;
        }

        if (!value.IsValid())
        {
            throw new InvalidOperationException("PublicArtifactRevocation CDN provider configuration is invalid");
        }

        bool cloudflare = string.Equals(value.CdnProvider, "Cloudflare", StringComparison.OrdinalIgnoreCase);
        Uri endpoint = cloudflare
            ? new Uri($"https://api.cloudflare.com/client/v4/zones/{value.CloudflareZoneId}/purge_cache", UriKind.Absolute)
            : new Uri(value.CdnPurgeEndpoint, UriKind.Absolute);

        string articlePath = tombstone.ArticleId > 0 ? $"/article/{tombstone.ArticleId}" : "/*";
        string binaryPath = tombstone.ArticleId > 0 ? $"/api/binary/article/{tombstone.ArticleId}.aeds" : "/api/binary/article/*";
        var payload = new PublicArtifactCdnPurgeRequest(
            tombstone.Generation,
            tombstone.Marker,
            value.PurgeAllOnArticleRevocation,
            [articlePath, binaryPath, "/api/binary/article/list/*", "/api/binary/article/hot/*", "/api/binary/article/featured/*"],
            ["fsus-public-artifact", tombstone.ArticleId > 0 ? $"article-{tombstone.ArticleId}" : "all-articles"]);

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = cloudflare
                ? JsonContent.Create(new { purge_everything = true })
                : JsonContent.Create(payload)
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.TryAddWithoutValidation("Idempotency-Key", $"fsus-public-artifact-{tombstone.Marker}");
        if (!string.IsNullOrWhiteSpace(value.CdnPurgeBearerToken))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", value.CdnPurgeBearerToken);
        }

        using HttpResponseMessage response = await httpClientFactory
            .CreateClient(nameof(HttpPublicArtifactCdnPurger))
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
    }
}

public interface IPublicArtifactRevocationCoordinator
{
    long CurrentGeneration { get; }
    Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default);
    Task RevokeAllAsync(CancellationToken cancellationToken = default);
    Task CompleteRebuildAsync(
        IReadOnlyCollection<int>? articleIds,
        long maximumGeneration,
        CancellationToken cancellationToken = default);
}

public sealed class PublicArtifactRevocationCoordinator(
    IPublicArtifactRevocationStateStore stateStore,
    PublicArtifactRevocationRegistry registry,
    IPublicArtifactCdnPurger cdnPurger) : IPublicArtifactRevocationCoordinator
{
    public long CurrentGeneration => registry.CurrentGeneration;

    public Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default)
        => RevokeAsync(articleId, cancellationToken);

    public Task RevokeAllAsync(CancellationToken cancellationToken = default)
        => RevokeAsync(0, cancellationToken);

    public async Task CompleteRebuildAsync(
        IReadOnlyCollection<int>? articleIds,
        long maximumGeneration,
        CancellationToken cancellationToken = default)
    {
        HashSet<int>? selected = articleIds is null ? null : articleIds.ToHashSet();
        foreach (PublicArtifactTombstone tombstone in registry.Snapshot())
        {
            if (!tombstone.PurgeConfirmed || tombstone.Generation > maximumGeneration)
            {
                continue;
            }

            if (tombstone.ArticleId == 0 && selected is not null)
            {
                continue;
            }

            if (selected is not null && tombstone.ArticleId != 0 && !selected.Contains(tombstone.ArticleId))
            {
                continue;
            }

            if (!await stateStore.ClearAsync(tombstone, cancellationToken).ConfigureAwait(false))
            {
                continue;
            }

            registry.Clear(tombstone);
        }
    }

    private async Task RevokeAsync(int articleId, CancellationToken cancellationToken)
    {
        PublicArtifactTombstone tombstone = await stateStore
            .RevokeArticleAsync(articleId, cancellationToken)
            .ConfigureAwait(false);
        registry.Apply(tombstone);
        if (!tombstone.PurgeConfirmed)
        {
            try
            {
                await PublishAsync(tombstone, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                // The confirmed notification below is authoritative. Continue
                // to the purge so a transient Pub/Sub failure cannot skip CDN invalidation.
            }

            await cdnPurger.PurgeAsync(tombstone, cancellationToken).ConfigureAwait(false);
            tombstone = await stateStore.ConfirmPurgeAsync(tombstone, cancellationToken).ConfigureAwait(false);
            registry.Apply(tombstone);
        }

        await PublishAsync(tombstone, cancellationToken).ConfigureAwait(false);
    }

    private Task PublishAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken)
        => stateStore.PublishAsync(
            new PublicArtifactRevocationMessage(
                "revoke",
                tombstone.ArticleId,
                tombstone.Generation,
                tombstone.RevokedAtUnixMilliseconds,
                tombstone.PurgeConfirmed),
            cancellationToken);
}

public sealed class PublicArtifactRevocationSubscriber(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope runtimeKeyScope,
    IPublicArtifactRevocationStateStore stateStore,
    PublicArtifactRevocationRegistry registry,
    PublicHotArtifactUpdateQueue updateQueue,
    ILogger<PublicArtifactRevocationSubscriber> logger) : IHostedService
{
    private ChannelMessageQueue? _subscription;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        ISubscriber subscriber = redis.GetSubscriber();
        _subscription = await subscriber
            .SubscribeAsync(RedisChannel.Literal(runtimeKeyScope.PrefixKey(PublicArtifactRevocationMessage.Channel)))
            .ConfigureAwait(false);
        _subscription.OnMessage(message => Apply(message.Message));
        foreach (PublicArtifactTombstone tombstone in await stateStore.LoadActiveAsync(cancellationToken).ConfigureAwait(false))
        {
            registry.Apply(tombstone);
            QueueRebuildWhenConfirmed(tombstone);
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (_subscription is not null)
        {
            await _subscription.UnsubscribeAsync().ConfigureAwait(false);
        }
    }

    private void Apply(RedisValue payload)
    {
        try
        {
            PublicArtifactRevocationMessage? message = JsonSerializer.Deserialize<PublicArtifactRevocationMessage>((string)payload!);
            if (message is null)
            {
                return;
            }

            if (string.Equals(message.Action, "revoke", StringComparison.Ordinal))
            {
                registry.Apply(message.Tombstone);
                QueueRebuildWhenConfirmed(message.Tombstone);
            }
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "public-artifact-revocation-message-invalid");
        }
    }

    private void QueueRebuildWhenConfirmed(PublicArtifactTombstone tombstone)
    {
        if (!tombstone.PurgeConfirmed)
        {
            return;
        }

        PublicHotArtifactEnqueueResult result = updateQueue.Enqueue(
            tombstone.ArticleId > 0 ? tombstone.ArticleId : null,
            "public-artifact-revocation-edge");
        if (!result.Accepted)
        {
            logger.LogWarning(
                "public-artifact-revocation-edge-rebuild-enqueue-failed {ArticleId} {Generation} {Status}",
                tombstone.ArticleId,
                tombstone.Generation,
                result.Status);
        }
    }
}

public static class PublicArtifactRevocationExtensions
{
    public static IApplicationBuilder UseFsusPublicArtifactRevocation(this IApplicationBuilder app)
    {
        var registry = app.ApplicationServices.GetRequiredService<PublicArtifactRevocationRegistry>();
        return app.Use((context, next) => PublicArtifactRevocationMiddleware.TryHandleAsync(context, next, registry));
    }
}

public static class PublicArtifactRevocationMiddleware
{
    internal static Task TryHandleAsync(
        HttpContext context,
        RequestDelegate next,
        PublicArtifactRevocationRegistry registry)
    {
        if (!HttpMethods.IsGet(context.Request.Method)
            && !HttpMethods.IsHead(context.Request.Method))
        {
            return next(context);
        }

        if (!PublicHotReadFastPath.TryCreateRequestFeature(context, out PublicHotReadRequestFeature? feature)
            || feature is null)
        {
            return next(context);
        }

        context.Response.Headers["X-Fsus-Generation"] = registry.CurrentGeneration.ToString(CultureInfo.InvariantCulture);
        if (!registry.TryResolve(feature.Route, out PublicArtifactTombstone tombstone))
        {
            return next(context);
        }

        HttpResponse response = context.Response;
        response.StatusCode = StatusCodes.Status410Gone;
        response.ContentLength = 0;
        response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
        response.Headers["Pragma"] = "no-cache";
        response.Headers["Expires"] = "0";
        response.Headers["Accept-Ranges"] = "none";
        response.Headers["X-Fsus-Generation"] = tombstone.Generation.ToString(CultureInfo.InvariantCulture);
        response.Headers["X-Fsus-Revoked"] = tombstone.Marker;
        response.Headers.Remove("ETag");
        response.Headers.Remove("Content-Encoding");
        return Task.CompletedTask;
    }
}
