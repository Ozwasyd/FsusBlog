using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Testing;

using Microsoft.Extensions.Options;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public sealed class PublicArtifactRevocationOptions
{
    public bool CdnPurgeEnabled
    {
        get; set;
    }
    public string CdnProvider { get; set; } = "Generic";
    public string CdnPurgeEndpoint { get; set; } = string.Empty;
    public string CdnPurgeBearerToken { get; set; } = string.Empty;
    public string CloudflareZoneId { get; set; } = string.Empty;
    public bool PurgeAllOnArticleRevocation { get; set; } = true;
    public int MutationFenceRecoveryIntervalSeconds { get; set; } = 5;

    public bool IsValid()
    {
        if (MutationFenceRecoveryIntervalSeconds is < 1 or > 300)
        {
            return false;
        }

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

public enum PublicArtifactRevocationTargetKind : byte
{
    ExactArticle = 0,
    Global = 1,
    Scope = 2
}

public enum PublicArtifactRevocationScope : byte
{
    None = 0,
    Category = 1,
    Tag = 2,
    ArticleDetail = 3,
    ArticleList = 4,
    ArticleHot = 5,
    ArticleFeatured = 6,
    ArticleHtml = 7,
    PublicHtml = 8
}

public readonly record struct PublicArtifactRevocationTarget(
    PublicArtifactRevocationTargetKind Kind,
    int ArticleId = 0,
    PublicArtifactRevocationScope Scope = PublicArtifactRevocationScope.None)
{
    public static PublicArtifactRevocationTarget ForArticle(int articleId)
        => new(PublicArtifactRevocationTargetKind.ExactArticle, articleId);

    public static PublicArtifactRevocationTarget Global
        => new(PublicArtifactRevocationTargetKind.Global);

    public static PublicArtifactRevocationTarget ForScope(PublicArtifactRevocationScope scope)
        => new(PublicArtifactRevocationTargetKind.Scope, Scope: scope);

    internal bool IsValid
        => Kind switch
        {
            PublicArtifactRevocationTargetKind.ExactArticle => ArticleId > 0
                && Scope == PublicArtifactRevocationScope.None,
            PublicArtifactRevocationTargetKind.Global => ArticleId == 0
                && Scope == PublicArtifactRevocationScope.None,
            PublicArtifactRevocationTargetKind.Scope => ArticleId == 0
                && Scope is > PublicArtifactRevocationScope.None and <= PublicArtifactRevocationScope.PublicHtml,
            _ => false
        };

    internal string StorageField
        => Kind switch
        {
            PublicArtifactRevocationTargetKind.ExactArticle when IsValid
                => ArticleId.ToString(CultureInfo.InvariantCulture),
            PublicArtifactRevocationTargetKind.Global when IsValid => "0",
            PublicArtifactRevocationTargetKind.Scope when IsValid
                => $"scope:{((byte)Scope).ToString(CultureInfo.InvariantCulture)}",
            _ => throw new ArgumentOutOfRangeException(nameof(Kind), "public artifact revocation target is invalid")
        };
}

public readonly record struct PublicArtifactTombstone(
    int ArticleId,
    long Generation,
    long RevokedAtUnixMilliseconds,
    bool PurgeConfirmed = false,
    bool TransitionPending = false,
    PublicArtifactRevocationTargetKind TargetKind = PublicArtifactRevocationTargetKind.ExactArticle,
    PublicArtifactRevocationScope Scope = PublicArtifactRevocationScope.None)
{
    public string Marker => $"g{Generation.ToString(CultureInfo.InvariantCulture)}";

    public PublicArtifactRevocationTarget Target => new(TargetKind, ArticleId, Scope);

    public static PublicArtifactTombstone ForGlobal(
        long generation,
        long revokedAtUnixMilliseconds,
        bool purgeConfirmed = false,
        bool transitionPending = false)
        => new(
            0,
            generation,
            revokedAtUnixMilliseconds,
            purgeConfirmed,
            transitionPending,
            PublicArtifactRevocationTargetKind.Global);

    public static PublicArtifactTombstone ForScope(
        PublicArtifactRevocationScope scope,
        long generation,
        long revokedAtUnixMilliseconds,
        bool purgeConfirmed = false,
        bool transitionPending = false)
        => new(
            0,
            generation,
            revokedAtUnixMilliseconds,
            purgeConfirmed,
            transitionPending,
            PublicArtifactRevocationTargetKind.Scope,
            scope);
}

public sealed record PublicArtifactRevocationMessage(
    string Action,
    int ArticleId,
    long Generation,
    long RevokedAtUnixMilliseconds,
    bool PurgeConfirmed = false,
    bool TransitionPending = false,
    PublicArtifactRevocationTargetKind TargetKind = PublicArtifactRevocationTargetKind.ExactArticle,
    PublicArtifactRevocationScope Scope = PublicArtifactRevocationScope.None)
{
    internal const string Channel = "fsus:public-artifact-revocation:v1";

    internal PublicArtifactTombstone Tombstone
        => new(
            ArticleId,
            Generation,
            RevokedAtUnixMilliseconds,
            PurgeConfirmed,
            TransitionPending,
            TargetKind,
            Scope);
}

public sealed class PublicArtifactRevocationRegistry
{
    internal const string MeterName = "FsusBlog.PublicArtifactRevocation";
    private static readonly Meter s_meter = new(MeterName, "1.0.0");
    private static readonly Counter<long> s_lookupHits = s_meter.CreateCounter<long>(
        "fsus.public_artifact_revocation.lookup.hit");
    private static readonly Counter<long> s_lookupMisses = s_meter.CreateCounter<long>(
        "fsus.public_artifact_revocation.lookup.miss");
    private static readonly Counter<long> s_applyCount = s_meter.CreateCounter<long>(
        "fsus.public_artifact_revocation.apply");
    private static readonly Counter<long> s_clearCount = s_meter.CreateCounter<long>(
        "fsus.public_artifact_revocation.clear");
    private static readonly UpDownCounter<long> s_activeCount = s_meter.CreateUpDownCounter<long>(
        "fsus.public_artifact_revocation.active.count");
    private static readonly Histogram<double> s_lookupDuration = s_meter.CreateHistogram<double>(
        "fsus.public_artifact_revocation.lookup.duration",
        "ms");
    private readonly ConcurrentDictionary<int, PublicArtifactTombstone> _exact = new();
    private readonly ConcurrentDictionary<PublicArtifactRevocationScope, PublicArtifactTombstone> _scopes = new();
    private readonly Dictionary<PublicArtifactRevocationTarget, long> _observedGenerations = [];
    private readonly Dictionary<PublicArtifactRevocationTarget, long> _clearedGenerations = [];
    private readonly object _mutationLock = new();
    private TombstoneBox? _global;
    private int _activeCount;
    private long _generation;
    private long _lookupCount;
    private long _exactHits;
    private long _globalHits;
    private long _scopeHits;
    private long _misses;
    private long _applies;
    private long _clears;

    public long CurrentGeneration => Volatile.Read(ref _generation);

    public void Apply(PublicArtifactTombstone tombstone)
    {
        PublicArtifactRevocationTarget target = tombstone.Target;
        if (tombstone.Generation <= 0 || !target.IsValid)
        {
            return;
        }

        lock (_mutationLock)
        {
            if (_clearedGenerations.TryGetValue(target, out long cleared)
                && cleared >= tombstone.Generation)
            {
                return;
            }

            if (_observedGenerations.TryGetValue(target, out long observed)
                && observed > tombstone.Generation)
            {
                return;
            }

            _observedGenerations[target] = tombstone.Generation;
            bool hadActive = TryGetActive(target, out PublicArtifactTombstone current);
            PublicArtifactTombstone applied = hadActive ? Merge(current, tombstone) : tombstone;
            SetActive(target, applied);
            if (!hadActive)
            {
                Interlocked.Increment(ref _activeCount);
                s_activeCount.Add(1);
            }

            AdvanceGeneration(tombstone.Generation);
            Interlocked.Increment(ref _applies);
            s_applyCount.Add(1);
        }
    }

    public void Clear(PublicArtifactTombstone tombstone)
    {
        PublicArtifactRevocationTarget target = tombstone.Target;
        if (tombstone.Generation <= 0 || !target.IsValid)
        {
            return;
        }

        lock (_mutationLock)
        {
            _clearedGenerations[target] = _clearedGenerations.TryGetValue(target, out long cleared)
                ? Math.Max(cleared, tombstone.Generation)
                : tombstone.Generation;
            _observedGenerations[target] = _observedGenerations.TryGetValue(target, out long observed)
                ? Math.Max(observed, tombstone.Generation)
                : tombstone.Generation;
            if (TryGetActive(target, out PublicArtifactTombstone active)
                && active.Generation <= tombstone.Generation)
            {
                RemoveActive(target, active);
                Interlocked.Decrement(ref _activeCount);
                s_activeCount.Add(-1);
            }

            AdvanceGeneration(tombstone.Generation);
            Interlocked.Increment(ref _clears);
            s_clearCount.Add(1);
        }
    }

    internal bool ForgetRuntimeEvidenceGuard(PublicArtifactTombstone tombstone)
    {
        PublicArtifactRevocationTarget target = tombstone.Target;
        lock (_mutationLock)
        {
            if (TryGetActive(target, out _))
            {
                return false;
            }

            if (_observedGenerations.TryGetValue(target, out long observed)
                && observed == tombstone.Generation)
            {
                _observedGenerations.Remove(target);
            }
            if (_clearedGenerations.TryGetValue(target, out long cleared)
                && cleared == tombstone.Generation)
            {
                _clearedGenerations.Remove(target);
            }
            return !_observedGenerations.ContainsKey(target)
                && !_clearedGenerations.ContainsKey(target);
        }
    }

    public bool TryGet(int articleId, out PublicArtifactTombstone tombstone)
    {
        if (articleId > 0)
        {
            return _exact.TryGetValue(articleId, out tombstone);
        }

        tombstone = default;
        return false;
    }

    internal bool TryResolve(in PublicHotReadRoute route, out PublicArtifactTombstone tombstone)
    {
        long lookup = Interlocked.Increment(ref _lookupCount);
        bool sampled = (lookup & 63) == 0;
        long started = sampled ? Stopwatch.GetTimestamp() : 0;
        if (route.ArticleId > 0 && _exact.TryGetValue(route.ArticleId, out tombstone))
        {
            Interlocked.Increment(ref _exactHits);
            s_lookupHits.Add(1, new KeyValuePair<string, object?>("target", "exact"));
            RecordLookupDuration(sampled, started);
            return true;
        }

        TombstoneBox? global = Volatile.Read(ref _global);
        if (global is not null)
        {
            tombstone = global.Value;
            Interlocked.Increment(ref _globalHits);
            s_lookupHits.Add(1, new KeyValuePair<string, object?>("target", "global"));
            RecordLookupDuration(sampled, started);
            return true;
        }

        PublicArtifactRevocationScope scope = ResolveScope(route.Kind);
        if (scope != PublicArtifactRevocationScope.None
            && _scopes.TryGetValue(scope, out tombstone))
        {
            Interlocked.Increment(ref _scopeHits);
            s_lookupHits.Add(1, new KeyValuePair<string, object?>("target", "scope"));
            RecordLookupDuration(sampled, started);
            return true;
        }

        tombstone = default;
        Interlocked.Increment(ref _misses);
        s_lookupMisses.Add(1);
        RecordLookupDuration(sampled, started);
        return false;
    }

    internal PublicArtifactRevocationRegistrySnapshot MetricsSnapshot()
        => new(
            Volatile.Read(ref _activeCount),
            Volatile.Read(ref _exactHits),
            Volatile.Read(ref _globalHits),
            Volatile.Read(ref _scopeHits),
            Volatile.Read(ref _misses),
            Volatile.Read(ref _applies),
            Volatile.Read(ref _clears));

    public IReadOnlyList<PublicArtifactTombstone> Snapshot()
    {
        lock (_mutationLock)
        {
            var snapshot = new List<PublicArtifactTombstone>(_activeCount);
            snapshot.AddRange(_exact.Values);
            snapshot.AddRange(_scopes.Values);
            TombstoneBox? global = Volatile.Read(ref _global);
            if (global is not null)
            {
                snapshot.Add(global.Value);
            }

            return snapshot.OrderBy(static item => item.Generation).ToArray();
        }
    }

    private bool TryGetActive(
        PublicArtifactRevocationTarget target,
        out PublicArtifactTombstone tombstone)
    {
        switch (target.Kind)
        {
            case PublicArtifactRevocationTargetKind.ExactArticle:
                return _exact.TryGetValue(target.ArticleId, out tombstone);
            case PublicArtifactRevocationTargetKind.Global:
                TombstoneBox? global = Volatile.Read(ref _global);
                if (global is not null)
                {
                    tombstone = global.Value;
                    return true;
                }
                break;
            case PublicArtifactRevocationTargetKind.Scope:
                return _scopes.TryGetValue(target.Scope, out tombstone);
        }

        tombstone = default;
        return false;
    }

    private void SetActive(PublicArtifactRevocationTarget target, PublicArtifactTombstone tombstone)
    {
        switch (target.Kind)
        {
            case PublicArtifactRevocationTargetKind.ExactArticle:
                _exact[target.ArticleId] = tombstone;
                break;
            case PublicArtifactRevocationTargetKind.Global:
                Volatile.Write(ref _global, new TombstoneBox(tombstone));
                break;
            case PublicArtifactRevocationTargetKind.Scope:
                _scopes[target.Scope] = tombstone;
                break;
        }
    }

    private void RemoveActive(PublicArtifactRevocationTarget target, PublicArtifactTombstone tombstone)
    {
        switch (target.Kind)
        {
            case PublicArtifactRevocationTargetKind.ExactArticle:
                _exact.TryRemove(new KeyValuePair<int, PublicArtifactTombstone>(target.ArticleId, tombstone));
                break;
            case PublicArtifactRevocationTargetKind.Global:
                Volatile.Write(ref _global, null);
                break;
            case PublicArtifactRevocationTargetKind.Scope:
                _scopes.TryRemove(new KeyValuePair<PublicArtifactRevocationScope, PublicArtifactTombstone>(
                    target.Scope,
                    tombstone));
                break;
        }
    }

    private static PublicArtifactRevocationScope ResolveScope(PublicHotReadRouteKind routeKind)
        => routeKind is > PublicHotReadRouteKind.None and <= PublicHotReadRouteKind.PublicHtml
            ? (PublicArtifactRevocationScope)(byte)routeKind
            : PublicArtifactRevocationScope.None;

    private static PublicArtifactTombstone Merge(
        PublicArtifactTombstone current,
        PublicArtifactTombstone incoming)
    {
        if (current.Generation != incoming.Generation)
        {
            return current.Generation > incoming.Generation ? current : incoming;
        }

        return current with
        {
            PurgeConfirmed = current.PurgeConfirmed || incoming.PurgeConfirmed,
            TransitionPending = current.TransitionPending && incoming.TransitionPending
        };
    }

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

    private static void RecordLookupDuration(bool sampled, long started)
    {
        if (sampled)
        {
            s_lookupDuration.Record(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
        }
    }

    private sealed record TombstoneBox(PublicArtifactTombstone Value);
}

public readonly record struct PublicArtifactRevocationRegistrySnapshot(
    int ActiveCount,
    long ExactHits,
    long GlobalHits,
    long ScopeHits,
    long Misses,
    long Applies,
    long Clears);

public interface IPublicArtifactRevocationStateStore
{
    Task<PublicArtifactTombstone> BeginMutationFenceAsync(
        PublicArtifactRevocationTarget target,
        CancellationToken cancellationToken);
    Task<PublicArtifactTombstone> RevokeAsync(
        PublicArtifactRevocationTarget target,
        CancellationToken cancellationToken);
    Task<PublicArtifactTombstone?> MarkTransitionCommittedAsync(
        PublicArtifactTombstone tombstone,
        CancellationToken cancellationToken);
    Task<PublicArtifactTombstone> ConfirmPurgeAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken);
    Task<IReadOnlyList<PublicArtifactTombstone>> LoadActiveAsync(CancellationToken cancellationToken);
    Task<bool> ClearAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken);
    Task PublishAsync(PublicArtifactRevocationMessage message, CancellationToken cancellationToken);
}

public sealed class RedisPublicArtifactRevocationStateStore(
    IRedisOperationExecutor redis,
    IRuntimeKeyScope runtimeKeyScope) : IPublicArtifactRevocationStateStore
{
    private const string GenerationKey = "public-hot-read:revocation:generation";
    private const string TombstoneHashKey = "public-hot-read:revocation:tombstones";
    private static readonly LuaScript s_beginTransition = LuaScript.Prepare(
        "local existing = redis.call('HGET', @hash, @field); " +
        "if existing then " +
        "local decoded = cjson.decode(existing); " +
        "if decoded.TransitionPending == true or decoded.PurgeConfirmed ~= true then return ''; end; " +
        "end; " +
        "local generation = redis.call('INCR', @generationKey); " +
        "local payload = cjson.encode({" +
        "ArticleId=tonumber(@articleId)," +
        "TargetKind=tonumber(@targetKind)," +
        "Scope=tonumber(@scope)," +
        "Generation=generation," +
        "RevokedAtUnixMilliseconds=tonumber(@revokedAt)," +
        "PurgeConfirmed=false," +
        "TransitionPending=true}); " +
        "redis.call('HSET', @hash, @field, payload); return payload;");
    private static readonly LuaScript s_compareAndSet = LuaScript.Prepare(
        "local value = redis.call('HGET', @hash, @field); " +
        "if not value then return 0; end; " +
        "local decoded = cjson.decode(value); " +
        "if tonumber(decoded.Generation) ~= tonumber(@generation) then return 0; end; " +
        "redis.call('HSET', @hash, @field, @replacement); return 1;");
    private static readonly LuaScript s_compareAndDelete = LuaScript.Prepare(
        "local value = redis.call('HGET', @hash, @field); " +
        "if not value then return 1; end; " +
        "local decoded = cjson.decode(value); " +
        "if tonumber(decoded.Generation) ~= tonumber(@generation) then return 0; end; " +
        "redis.call('HDEL', @hash, @field); return 1;");
    public async Task<PublicArtifactTombstone> BeginMutationFenceAsync(
        PublicArtifactRevocationTarget target,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!target.IsValid)
        {
            throw new ArgumentOutOfRangeException(nameof(target));
        }

        RedisResult result = await ExecuteDatabaseAsync(
                database => database.ScriptEvaluateAsync(
                    s_beginTransition,
                    new
                    {
                        generationKey = (RedisKey)runtimeKeyScope.PrefixKey(GenerationKey),
                        hash = (RedisKey)runtimeKeyScope.PrefixKey(TombstoneHashKey),
                        field = (RedisValue)target.StorageField,
                        articleId = target.ArticleId,
                        targetKind = (byte)target.Kind,
                        scope = (byte)target.Scope,
                        revokedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    }),
                cancellationToken)
            .ConfigureAwait(false);
        string payload = result.ToString();
        return TryParse(payload, out PublicArtifactTombstone tombstone)
            ? tombstone
            : throw new InvalidOperationException("public artifact mutation fence is already active");
    }

    public async Task<PublicArtifactTombstone> RevokeAsync(
        PublicArtifactRevocationTarget target,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!target.IsValid)
        {
            throw new ArgumentOutOfRangeException(nameof(target));
        }

        RedisKey hashKey = runtimeKeyScope.PrefixKey(TombstoneHashKey);
        RedisValue field = target.StorageField;
        RedisValue existing = await ExecuteDatabaseAsync(
            database => database.HashGetAsync(hashKey, field),
            cancellationToken).ConfigureAwait(false);
        if (TryParse(existing, out PublicArtifactTombstone tombstone))
        {
            return tombstone;
        }

        long generation = await ExecuteDatabaseAsync(
            database => database.StringIncrementAsync(runtimeKeyScope.PrefixKey(GenerationKey)),
            cancellationToken).ConfigureAwait(false);
        tombstone = new PublicArtifactTombstone(
            target.ArticleId,
            generation,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            TargetKind: target.Kind,
            Scope: target.Scope);
        string payload = JsonSerializer.Serialize(tombstone);
        bool stored = await ExecuteDatabaseAsync(
            database => database.HashSetAsync(hashKey, field, payload, When.NotExists),
            cancellationToken).ConfigureAwait(false);
        if (stored)
        {
            return tombstone;
        }

        existing = await ExecuteDatabaseAsync(
            database => database.HashGetAsync(hashKey, field),
            cancellationToken).ConfigureAwait(false);
        return TryParse(existing, out tombstone)
            ? tombstone
            : throw new InvalidOperationException("public artifact tombstone could not be persisted");
    }

    public async Task<IReadOnlyList<PublicArtifactTombstone>> LoadActiveAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HashEntry[] entries = await ExecuteDatabaseAsync(
            database => database.HashGetAllAsync(runtimeKeyScope.PrefixKey(TombstoneHashKey)),
            cancellationToken).ConfigureAwait(false);
        return entries
            .Select(static entry => TryParse(entry.Value, out PublicArtifactTombstone value) ? value : default)
            .Where(static value => value.Generation > 0)
            .ToArray();
    }

    public async Task<PublicArtifactTombstone?> MarkTransitionCommittedAsync(
        PublicArtifactTombstone tombstone,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!tombstone.TransitionPending)
        {
            return tombstone;
        }

        PublicArtifactTombstone committed = tombstone with
        {
            TransitionPending = false
        };
        RedisResult result = await ExecuteDatabaseAsync(
                database => database.ScriptEvaluateAsync(
                    s_compareAndSet,
                    new
                    {
                        hash = (RedisKey)runtimeKeyScope.PrefixKey(TombstoneHashKey),
                        field = (RedisValue)tombstone.Target.StorageField,
                        generation = tombstone.Generation,
                        replacement = (RedisValue)JsonSerializer.Serialize(committed)
                    }),
                cancellationToken)
            .ConfigureAwait(false);
        return (long)result == 1 ? committed : null;
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

        RedisKey hashKey = runtimeKeyScope.PrefixKey(TombstoneHashKey);
        RedisValue field = tombstone.Target.StorageField;
        RedisValue current = await ExecuteDatabaseAsync(
            database => database.HashGetAsync(hashKey, field),
            cancellationToken).ConfigureAwait(false);
        if (!TryParse(current, out PublicArtifactTombstone persisted)
            || persisted.Generation != tombstone.Generation)
        {
            throw new InvalidOperationException("public artifact tombstone changed before CDN purge confirmation");
        }

        if (persisted.PurgeConfirmed)
        {
            return persisted;
        }

        PublicArtifactTombstone confirmed = persisted with
        {
            PurgeConfirmed = true
        };
        RedisResult updated = await ExecuteDatabaseAsync(
                database => database.ScriptEvaluateAsync(
                    s_compareAndSet,
                    new
                    {
                        hash = hashKey,
                        field,
                        generation = tombstone.Generation,
                        replacement = (RedisValue)JsonSerializer.Serialize(confirmed)
                    }),
                cancellationToken)
            .ConfigureAwait(false);
        if ((long)updated != 1)
        {
            throw new InvalidOperationException("public artifact tombstone changed before CDN purge confirmation");
        }
        return confirmed;
    }

    public async Task<bool> ClearAsync(PublicArtifactTombstone tombstone, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisResult result = await ExecuteDatabaseAsync(
                database => database.ScriptEvaluateAsync(
                    s_compareAndDelete,
                    new
                    {
                        hash = (RedisKey)runtimeKeyScope.PrefixKey(TombstoneHashKey),
                        field = (RedisValue)tombstone.Target.StorageField,
                        generation = tombstone.Generation
                    }),
                cancellationToken)
            .ConfigureAwait(false);
        return (long)result == 1;
    }

    public async Task PublishAsync(PublicArtifactRevocationMessage message, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await redis.ExecuteAsync(
                RedisOperationPort.PublicArtifactRevocation,
                (multiplexer, _) => multiplexer.GetSubscriber().PublishAsync(
                    RedisChannel.Literal(runtimeKeyScope.PrefixKey(PublicArtifactRevocationMessage.Channel)),
                    JsonSerializer.Serialize(message)),
                cancellationToken)
            .ConfigureAwait(false);
    }

    private Task<T> ExecuteDatabaseAsync<T>(
        Func<IDatabase, Task<T>> operation,
        CancellationToken cancellationToken)
        => redis.ExecuteAsync(
            RedisOperationPort.PublicArtifactRevocation,
            (multiplexer, _) => operation(multiplexer.GetDatabase()),
            cancellationToken);

    private static bool TryParse(RedisValue payload, out PublicArtifactTombstone tombstone)
    {
        try
        {
            tombstone = payload.HasValue
                ? JsonSerializer.Deserialize<PublicArtifactTombstone>((string)payload!)
                : default;
            return tombstone.Generation > 0 && tombstone.Target.IsValid;
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

        bool exactArticle = tombstone.TargetKind == PublicArtifactRevocationTargetKind.ExactArticle;
        string articlePath = exactArticle ? $"/article/{tombstone.ArticleId}" : "/*";
        string binaryPath = exactArticle ? $"/api/binary/article/{tombstone.ArticleId}.aeds" : "/api/binary/article/*";
        var payload = new PublicArtifactCdnPurgeRequest(
            tombstone.Generation,
            tombstone.Marker,
            value.PurgeAllOnArticleRevocation,
            [articlePath, binaryPath, "/api/binary/article/list/*", "/api/binary/article/hot/*", "/api/binary/article/featured/*"],
            ["fsus-public-artifact", exactArticle ? $"article-{tombstone.ArticleId}" : "all-articles"]);

        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = cloudflare
                ? JsonContent.Create(new
                {
                    purge_everything = true
                })
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
    long CurrentGeneration
    {
        get;
    }
    Task BeginArticleMutationFenceAsync(int articleId, CancellationToken cancellationToken = default);
    Task BeginGlobalMutationFenceAsync(CancellationToken cancellationToken = default);
    Task<bool> RecoverPendingMutationFenceAsync(
        PublicArtifactTombstone tombstone,
        CancellationToken cancellationToken = default);
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

    public Task BeginArticleMutationFenceAsync(int articleId, CancellationToken cancellationToken = default)
        => RevokeAsync(
            PublicArtifactRevocationTarget.ForArticle(articleId),
            transitionPending: true,
            cancellationToken: cancellationToken);

    public Task BeginGlobalMutationFenceAsync(CancellationToken cancellationToken = default)
        => RevokeAsync(
            PublicArtifactRevocationTarget.Global,
            transitionPending: true,
            cancellationToken: cancellationToken);

    public async Task<bool> RecoverPendingMutationFenceAsync(
        PublicArtifactTombstone tombstone,
        CancellationToken cancellationToken = default)
    {
        if (!tombstone.TransitionPending)
        {
            return false;
        }

        registry.Apply(tombstone);
        if (!tombstone.PurgeConfirmed)
        {
            try
            {
                await PublishAsync(tombstone, cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                // The confirmed notification below remains authoritative.
            }

            await cdnPurger.PurgeAsync(tombstone, cancellationToken).ConfigureAwait(false);
            tombstone = await stateStore.ConfirmPurgeAsync(tombstone, cancellationToken).ConfigureAwait(false);
            registry.Apply(tombstone);
        }

        PublicArtifactTombstone? committed = await stateStore
            .MarkTransitionCommittedAsync(tombstone, cancellationToken)
            .ConfigureAwait(false);
        if (committed is null)
        {
            return false;
        }

        registry.Apply(committed.Value);
        await PublishAsync(committed.Value, cancellationToken).ConfigureAwait(false);
        return true;
    }

    public Task RevokeArticleAsync(int articleId, CancellationToken cancellationToken = default)
        => RevokeAsync(
            PublicArtifactRevocationTarget.ForArticle(articleId),
            transitionPending: false,
            cancellationToken: cancellationToken);

    public Task RevokeAllAsync(CancellationToken cancellationToken = default)
        => RevokeAsync(
            PublicArtifactRevocationTarget.Global,
            transitionPending: false,
            cancellationToken: cancellationToken);

    public async Task CompleteRebuildAsync(
        IReadOnlyCollection<int>? articleIds,
        long maximumGeneration,
        CancellationToken cancellationToken = default)
    {
        HashSet<int>? selected = articleIds is null ? null : articleIds.ToHashSet();
        foreach (PublicArtifactTombstone tombstone in registry.Snapshot())
        {
            if (!tombstone.PurgeConfirmed
                || tombstone.TransitionPending
                || tombstone.Generation > maximumGeneration)
            {
                continue;
            }

            if (tombstone.TargetKind != PublicArtifactRevocationTargetKind.ExactArticle
                && selected is not null)
            {
                continue;
            }

            if (selected is not null
                && tombstone.TargetKind == PublicArtifactRevocationTargetKind.ExactArticle
                && !selected.Contains(tombstone.ArticleId))
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

    private async Task RevokeAsync(
        PublicArtifactRevocationTarget target,
        bool transitionPending,
        CancellationToken cancellationToken)
    {
        PublicArtifactTombstone tombstone = transitionPending
            ? await stateStore.BeginMutationFenceAsync(target, cancellationToken).ConfigureAwait(false)
            : await stateStore.RevokeAsync(target, cancellationToken).ConfigureAwait(false);
        if (!transitionPending && tombstone.TransitionPending)
        {
            tombstone = await stateStore
                    .MarkTransitionCommittedAsync(tombstone, cancellationToken)
                    .ConfigureAwait(false)
                ?? throw new InvalidOperationException("public artifact mutation fence changed before commit");
        }
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
                tombstone.PurgeConfirmed,
                tombstone.TransitionPending,
                tombstone.TargetKind,
                tombstone.Scope),
            cancellationToken);
}

public sealed class PublicArtifactRevocationSubscriber(
    IRedisOperationExecutor redis,
    IRuntimeKeyScope runtimeKeyScope,
    IPublicArtifactRevocationStateStore stateStore,
    PublicArtifactRevocationRegistry registry,
    PublicHotArtifactUpdateQueue updateQueue,
    ILogger<PublicArtifactRevocationSubscriber> logger) : IHostedService
{
    private ChannelMessageQueue? _subscription;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        _subscription = await redis.ExecuteAsync(
                RedisOperationPort.PublicArtifactRevocation,
                (multiplexer, _) => multiplexer.GetSubscriber().SubscribeAsync(
                    RedisChannel.Literal(runtimeKeyScope.PrefixKey(PublicArtifactRevocationMessage.Channel))),
                cancellationToken)
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
            await redis.ExecuteAsync(
                    RedisOperationPort.PublicArtifactRevocation,
                    (_, _) => _subscription.UnsubscribeAsync(),
                    cancellationToken)
                .ConfigureAwait(false);
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
        if (!tombstone.PurgeConfirmed || tombstone.TransitionPending)
        {
            return;
        }

        PublicHotArtifactEnqueueResult result = updateQueue.EnqueueAsync(
                PublicHotArtifactDeliveryClass.RequiredContent,
                tombstone.TargetKind == PublicArtifactRevocationTargetKind.ExactArticle
                    ? tombstone.ArticleId
                    : null,
                "public-artifact-revocation-edge",
                cancellationToken: CancellationToken.None)
            .GetAwaiter()
            .GetResult();
        PublicHotArtifactDeliveryReceipt.RequireDurable(result, "public-artifact-revocation-edge");
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

        PublicHotReadRequestFeature? feature = context.Features.Get<PublicHotReadRequestFeature>();
        if (feature is null)
        {
            return next(context);
        }

        context.Response.Headers["X-Fsus-Generation"] = registry.CurrentGeneration.ToString(CultureInfo.InvariantCulture);
        bool revoked = registry.TryResolve(feature.Route, out PublicArtifactTombstone tombstone);
        RuntimeCacheEvidenceObservation.Current?.RecordCacheEvent(
            "public-artifact-revocation-lookup",
            $"{context.Request.Method}:{context.Request.Path.Value}",
            revoked ? "hit" : "negative");
        if (!revoked)
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
