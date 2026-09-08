using System.Text;
using System.Text.Json;
using System.Threading.Channels;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;

using Microsoft.Extensions.Options;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Configures the bounded, process-local projection used by public hot reads.
/// The projection is deliberately independent from <see cref="IMemoryCache"/> so
/// its entry and byte budgets are explicit and enforceable.
/// </summary>
public sealed class PublicHotReadRiskProjectionOptions
{
    public const string SectionName = "Security:PublicHotReadRiskProjection";

    /// <summary>Maximum number of identities retained by one node.</summary>
    public int MaxEntries { get; set; } = 100_000;

    /// <summary>Maximum estimated resident bytes retained by one node.</summary>
    public long MaxBytes { get; set; } = 16 * 1024 * 1024;

    /// <summary>Maximum time an update may keep an identity known.</summary>
    public int MaxEntryTtlSeconds { get; set; } = 3_600;

    /// <summary>Interval at which durable risk events are replayed after Pub/Sub loss.</summary>
    public int ReplayIntervalSeconds { get; set; } = 5;

    /// <summary>Redis subscriber channel ingress capacity.</summary>
    public int SubscriberCapacity { get; set; } = 10_000;
}

/// <summary>Identifies the source used to answer a public hot-read risk lookup.</summary>
public static class PublicHotReadRiskProjectionSources
{
    public const string LocalPositive = "local-positive";
    public const string LocalZero = "local-zero";
    public const string UnknownPolicyAction = "unknown-policy-action";
    public const string PolicyDisabled = "policy-disabled";
    public const string VerifiedCrawler = "verified-crawler";
    public const string SocialPreview = "social-preview";
}

/// <summary>Result of a synchronous public hot-read projection lookup.</summary>
public readonly record struct PublicHotReadRiskProjectionLookup(
    bool Known,
    int Score,
    string Source,
    DateTimeOffset? UpdatedAtUtc,
    DateTimeOffset? ExpiresAtUtc,
    string? Version)
{
    public static readonly PublicHotReadRiskProjectionLookup Unknown = new(
        false,
        0,
        PublicHotReadRiskProjectionSources.UnknownPolicyAction,
        null,
        null,
        null);
}

/// <summary>One durable, replayable projection update.</summary>
public readonly record struct PublicHotReadRiskProjectionUpdate(
    string IdentityHash,
    int PseudonymEpoch,
    int Score,
    DateTimeOffset UpdatedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    string EventId,
    bool IsAuthoritativeZero = false)
{
    public bool IsExpired(DateTimeOffset now) => ExpiresAtUtc <= now;

    public string ToPayload()
        => JsonSerializer.Serialize(this, s_jsonOptions);

    public static bool TryParse(RedisValue payload, out PublicHotReadRiskProjectionUpdate update)
    {
        try
        {
            PublicHotReadRiskProjectionUpdate? parsed = JsonSerializer.Deserialize<PublicHotReadRiskProjectionUpdate>(
                (string)payload!,
                s_jsonOptions);
            if (parsed is { } value
                && IsValidIdentity(value.IdentityHash)
                && value.PseudonymEpoch > 0
                && IsValidEventId(value.EventId)
                && value.UpdatedAtUtc != default
                && value.ExpiresAtUtc > value.UpdatedAtUtc)
            {
                update = value;
                return true;
            }
        }
        catch (JsonException or ArgumentException or NotSupportedException)
        {
            // Invalid Pub/Sub data is ignored. Durable PostgreSQL replay remains
            // the recovery source and no request is allowed to consult Redis.
        }

        update = default;
        return false;
    }

    internal static bool IsValidIdentity(string? value)
        => value is { Length: 64 }
            && value.All(static character => char.IsAsciiHexDigit(character));

    internal static bool IsValidEventId(string? value)
        => value is { Length: > 0 and <= 128 };

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false
    };
}

/// <summary>Read-only projection counters and resident-budget state.</summary>
public readonly record struct PublicHotReadRiskProjectionSnapshot(
    int EntryCount,
    long ResidentBytes,
    int MaxEntries,
    long MaxBytes,
    long HitCount,
    long UnknownCount,
    long EvictionCount,
    long RejectedUpdateCount,
    long VersionRejectedCount,
    long DurableReplayCount,
    long DistributedUpdateCount);

/// <summary>
/// Provides a synchronous, bounded local risk projection for the public hot-read gate.
/// It performs no Redis, database, filesystem, or network access.
/// </summary>
public interface IPublicHotReadRiskProjection
{
    PublicHotReadRiskProjectionLookup Lookup(HttpContext context);

    PublicHotReadRiskProjectionLookup Lookup(string clientIp);

    bool Apply(SecurityRiskEventWrite write);

    bool Apply(PublicHotReadRiskProjectionUpdate update, bool durableReplay = false, bool distributedUpdate = false);

    bool ApplyIdentity(
        string clientIp,
        int score,
        DateTimeOffset updatedAtUtc,
        DateTimeOffset expiresAtUtc,
        string eventId);

    PublicHotReadRiskProjectionSnapshot Snapshot();
}

/// <summary>Publishes projection updates without placing any work on the L0 request path.</summary>
public interface IPublicHotReadRiskProjectionPublisher
{
    ValueTask PublishAsync(PublicHotReadRiskProjectionUpdate update, CancellationToken cancellationToken = default);
}

/// <summary>
/// A strict entry/byte-bounded projection. Positive entries are never evicted to admit
/// a zero entry; if no safe victim exists, the new update is rejected and the lookup is
/// therefore unknown (fail-closed in enforcing modes).
/// </summary>
public sealed class PublicHotReadRiskProjection : IPublicHotReadRiskProjection
{
    private const int FixedEntryBytes = 96;
    private readonly object _gate = new();
    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly ISecurityRiskPseudonymizer _pseudonymizer;
    private readonly TimeProvider _timeProvider;
    private readonly int _maxEntries;
    private readonly long _maxBytes;
    private readonly int _maxEntryTtlSeconds;
    private long _residentBytes;
    private long _hitCount;
    private long _unknownCount;
    private long _evictionCount;
    private long _rejectedUpdateCount;
    private long _versionRejectedCount;
    private long _durableReplayCount;
    private long _distributedUpdateCount;

    public PublicHotReadRiskProjection(
        IOptions<PublicHotReadRiskProjectionOptions> options,
        ISecurityRiskPseudonymizer pseudonymizer,
        TimeProvider timeProvider)
    {
        PublicHotReadRiskProjectionOptions value = options.Value;
        _maxEntries = Math.Clamp(value.MaxEntries, 1, 100_000);
        _maxBytes = Math.Clamp(value.MaxBytes, 1_024, 512L * 1024 * 1024);
        _maxEntryTtlSeconds = Math.Clamp(value.MaxEntryTtlSeconds, 1, 86_400);
        _pseudonymizer = pseudonymizer;
        _timeProvider = timeProvider;
    }

    public PublicHotReadRiskProjectionLookup Lookup(HttpContext context)
        => Lookup(context.GetClientIp());

    public PublicHotReadRiskProjectionLookup Lookup(string clientIp)
    {
        if (string.IsNullOrWhiteSpace(clientIp))
        {
            Interlocked.Increment(ref _unknownCount);
            return PublicHotReadRiskProjectionLookup.Unknown;
        }

        DateTimeOffset now = _timeProvider.GetUtcNow();
        IReadOnlyList<SecurityRiskPseudonym> pseudonyms = _pseudonymizer.PseudonymizeForRead(
            SecurityRiskIdentityDomain.ClientIp,
            clientIp);
        lock (_gate)
        {
            foreach (SecurityRiskPseudonym pseudonym in pseudonyms)
            {
                if (!_entries.TryGetValue(pseudonym.Hash, out Entry? entry) || entry is null)
                {
                    continue;
                }

                if (entry.ExpiresAtUtc <= now)
                {
                    RemoveLocked(pseudonym.Hash, entry);
                    Interlocked.Increment(ref _evictionCount);
                    continue;
                }

                Interlocked.Increment(ref _hitCount);
                return new PublicHotReadRiskProjectionLookup(
                    true,
                    entry.Score,
                    entry.Score > 0
                        ? PublicHotReadRiskProjectionSources.LocalPositive
                        : PublicHotReadRiskProjectionSources.LocalZero,
                    entry.UpdatedAtUtc,
                    entry.ExpiresAtUtc,
                    entry.EventId);
            }
        }

        Interlocked.Increment(ref _unknownCount);
        return PublicHotReadRiskProjectionLookup.Unknown;
    }

    public bool Apply(SecurityRiskEventWrite write)
    {
        if (string.IsNullOrWhiteSpace(write.ClientIpHash))
        {
            return false;
        }

        return Apply(
            new PublicHotReadRiskProjectionUpdate(
                write.ClientIpHash,
                write.PseudonymEpoch,
                write.TotalScore,
                write.OccurredAtUtc,
                write.ExpiresAtUtc,
                write.Id,
                IsAuthoritativeZero: write.ScoreDelta < 0
                    || string.Equals(write.Reason, SecurityRiskEventReasons.RiskReset, StringComparison.Ordinal)));
    }

    public bool Apply(
        PublicHotReadRiskProjectionUpdate update,
        bool durableReplay = false,
        bool distributedUpdate = false)
    {
        if (!PublicHotReadRiskProjectionUpdate.IsValidIdentity(update.IdentityHash)
            || update.PseudonymEpoch <= 0
            || !PublicHotReadRiskProjectionUpdate.IsValidEventId(update.EventId)
            || update.UpdatedAtUtc == default
            || update.ExpiresAtUtc <= update.UpdatedAtUtc)
        {
            Interlocked.Increment(ref _rejectedUpdateCount);
            return false;
        }

        DateTimeOffset now = _timeProvider.GetUtcNow();
        if (update.IsExpired(now))
        {
            return false;
        }

        DateTimeOffset maxExpiry = now.AddSeconds(_maxEntryTtlSeconds);
        DateTimeOffset expiresAt = update.ExpiresAtUtc > maxExpiry
            ? maxExpiry
            : update.ExpiresAtUtc;
        Entry candidate = new(
            update.PseudonymEpoch,
            Math.Max(0, update.Score),
            update.UpdatedAtUtc,
            expiresAt,
            update.EventId,
            EstimateBytes(update.IdentityHash, update.EventId));

        lock (_gate)
        {
            if (_entries.TryGetValue(update.IdentityHash, out Entry? current))
            {
                if (candidate.Score == 0 && current.Score > 0 && !update.IsAuthoritativeZero)
                {
                    // A zero score from a best-effort signal or a Redis miss is
                    // not proof that an existing positive risk was cleared.
                    // Only an atomic negative update or a durable reset tombstone
                    // may replace a positive entry with zero.
                    Interlocked.Increment(ref _versionRejectedCount);
                    return false;
                }

                int version = CompareVersion(candidate, current);
                if (version <= 0)
                {
                    Interlocked.Increment(ref _versionRejectedCount);
                    return false;
                }

                if (_residentBytes - current.Bytes + candidate.Bytes > _maxBytes
                    && !TryMakeRoomForReplacementLocked(update.IdentityHash, current.Bytes, candidate.Bytes))
                {
                    Interlocked.Increment(ref _rejectedUpdateCount);
                    return false;
                }

                _entries[update.IdentityHash] = candidate;
                _residentBytes += candidate.Bytes - current.Bytes;
                RecordApplyKind(durableReplay, distributedUpdate);
                return true;
            }

            if (!TryMakeRoomLocked(candidate.Bytes))
            {
                Interlocked.Increment(ref _rejectedUpdateCount);
                return false;
            }

            _entries.Add(update.IdentityHash, candidate);
            _residentBytes += candidate.Bytes;
            RecordApplyKind(durableReplay, distributedUpdate);
            return true;
        }
    }

    public bool ApplyIdentity(
        string clientIp,
        int score,
        DateTimeOffset updatedAtUtc,
        DateTimeOffset expiresAtUtc,
        string eventId)
    {
        if (string.IsNullOrWhiteSpace(clientIp))
        {
            return false;
        }

        SecurityRiskPseudonym pseudonym = _pseudonymizer.PseudonymizeCurrent(
            SecurityRiskIdentityDomain.ClientIp,
            clientIp);
        return Apply(new PublicHotReadRiskProjectionUpdate(
            pseudonym.Hash,
            pseudonym.Epoch,
            score,
            updatedAtUtc,
            expiresAtUtc,
            eventId));
    }

    public PublicHotReadRiskProjectionSnapshot Snapshot()
    {
        int entryCount;
        long residentBytes;
        lock (_gate)
        {
            entryCount = _entries.Count;
            residentBytes = _residentBytes;
        }

        return new(
            entryCount,
            residentBytes,
            _maxEntries,
            _maxBytes,
            Interlocked.Read(ref _hitCount),
            Interlocked.Read(ref _unknownCount),
            Interlocked.Read(ref _evictionCount),
            Interlocked.Read(ref _rejectedUpdateCount),
            Interlocked.Read(ref _versionRejectedCount),
            Interlocked.Read(ref _durableReplayCount),
            Interlocked.Read(ref _distributedUpdateCount));
    }

    private void RecordApplyKind(bool durableReplay, bool distributedUpdate)
    {
        if (durableReplay)
        {
            Interlocked.Increment(ref _durableReplayCount);
        }

        if (distributedUpdate)
        {
            Interlocked.Increment(ref _distributedUpdateCount);
        }
    }

    private bool TryMakeRoomLocked(int candidateBytes)
    {
        while (_entries.Count >= _maxEntries || _residentBytes + candidateBytes > _maxBytes)
        {
            string? victimKey = null;
            Entry? victim = null;
            DateTimeOffset now = _timeProvider.GetUtcNow();

            foreach ((string key, Entry value) in _entries)
            {
                if (value.ExpiresAtUtc <= now)
                {
                    victimKey = key;
                    victim = value;
                    break;
                }

                // Zero-risk entries are the only safe capacity victims. A positive
                // risk entry may not be silently evicted and become an unknown allow.
                if (value.Score == 0 && (victim is null || value.UpdatedAtUtc < victim.UpdatedAtUtc))
                {
                    victimKey = key;
                    victim = value;
                }
            }

            if (victimKey is null || victim is null)
            {
                return false;
            }

            RemoveLocked(victimKey, victim);
            Interlocked.Increment(ref _evictionCount);
        }

        return true;
    }

    private bool TryMakeRoomForReplacementLocked(string keyBeingReplaced, int currentBytes, int candidateBytes)
    {
        while (_residentBytes - currentBytes + candidateBytes > _maxBytes)
        {
            string? victimKey = null;
            Entry? victim = null;
            DateTimeOffset now = _timeProvider.GetUtcNow();

            foreach ((string key, Entry value) in _entries)
            {
                if (string.Equals(key, keyBeingReplaced, StringComparison.Ordinal))
                {
                    continue;
                }

                if (value.ExpiresAtUtc <= now
                    || (value.Score == 0 && (victim is null || value.UpdatedAtUtc < victim.UpdatedAtUtc)))
                {
                    victimKey = key;
                    victim = value;
                    if (value.ExpiresAtUtc <= now)
                    {
                        break;
                    }
                }
            }

            if (victimKey is null || victim is null)
            {
                return false;
            }

            RemoveLocked(victimKey, victim);
            Interlocked.Increment(ref _evictionCount);
        }

        return true;
    }

    private void RemoveLocked(string key, Entry entry)
    {
        if (_entries.Remove(key))
        {
            _residentBytes = Math.Max(0, _residentBytes - entry.Bytes);
        }
    }

    private static int CompareVersion(Entry left, Entry right)
    {
        int epoch = left.PseudonymEpoch.CompareTo(right.PseudonymEpoch);
        if (epoch != 0)
        {
            return epoch;
        }

        int timestamp = left.UpdatedAtUtc.CompareTo(right.UpdatedAtUtc);
        return timestamp != 0
            ? timestamp
            : string.CompareOrdinal(left.EventId, right.EventId);
    }

    private static int EstimateBytes(string identityHash, string eventId)
        => FixedEntryBytes
            + Encoding.UTF8.GetByteCount(identityHash)
            + Encoding.UTF8.GetByteCount(eventId);

    private sealed record Entry(
        int PseudonymEpoch,
        int Score,
        DateTimeOffset UpdatedAtUtc,
        DateTimeOffset ExpiresAtUtc,
        string EventId,
        int Bytes);
}

/// <summary>Redis Pub/Sub transport for best-effort cross-node projection delivery.</summary>
public sealed class RedisPublicHotReadRiskProjectionPublisher(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope runtimeKeyScope,
    ILogger<RedisPublicHotReadRiskProjectionPublisher> logger) : IPublicHotReadRiskProjectionPublisher
{
    internal const string Channel = "fsus:security:public-hot-risk-projection:v1";

    public async ValueTask PublishAsync(
        PublicHotReadRiskProjectionUpdate update,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            await redis.GetSubscriber()
                .PublishAsync(
                    RedisChannel.Literal(runtimeKeyScope.PrefixKey(Channel)),
                    update.ToPayload())
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // The event row is the durable replay source. Pub/Sub failure is
            // observable but must not turn a risk signal into a request failure.
            logger.LogWarning(ex, "public-hot-risk-projection-publish-failed");
        }
    }
}

/// <summary>
/// Subscribes to projection updates and periodically replays durable risk events.
/// The first replay runs at startup, so a restarted node does not depend on a missed
/// Pub/Sub message.
/// </summary>
public sealed class PublicHotReadRiskProjectionWorker(
    PublicHotReadRiskProjection projection,
    IConnectionMultiplexer redis,
    IRuntimeKeyScope runtimeKeyScope,
    IServiceScopeFactory scopeFactory,
    IOptions<PublicHotReadRiskProjectionOptions> options,
    ILogger<PublicHotReadRiskProjectionWorker> logger,
    TimeProvider timeProvider) : BackgroundService
{
    private readonly Channel<RedisValue> _remoteMessages = Channel.CreateBounded<RedisValue>(
        new BoundedChannelOptions(Math.Clamp(options.Value.SubscriberCapacity, 1, 100_000))
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = false
        });
    private readonly TimeSpan _replayInterval = TimeSpan.FromSeconds(
        Math.Clamp(options.Value.ReplayIntervalSeconds, 1, 300));

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        ChannelMessageQueue? subscription = null;
        Task remoteDrain = DrainRemoteAsync(stoppingToken);
        try
        {
            subscription = await redis.GetSubscriber()
                .SubscribeAsync(RedisChannel.Literal(runtimeKeyScope.PrefixKey(RedisPublicHotReadRiskProjectionPublisher.Channel)))
                .ConfigureAwait(false);
            subscription.OnMessage(message =>
            {
                if (!_remoteMessages.Writer.TryWrite(message.Message))
                {
                    logger.LogWarning("public-hot-risk-projection-subscriber-buffer-full");
                }
            });
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "public-hot-risk-projection-subscribe-failed");
        }

        try
        {
            await ReplayDurableAsync(stoppingToken).ConfigureAwait(false);
            using PeriodicTimer timer = new(_replayInterval);
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                await ReplayDurableAsync(stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            _remoteMessages.Writer.TryComplete();
            if (subscription is not null)
            {
                try
                {
                    await subscription.UnsubscribeAsync().ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    logger.LogDebug(ex, "public-hot-risk-projection-unsubscribe-failed");
                }
            }

            try
            {
                await remoteDrain.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
            }
        }
    }

    private async Task DrainRemoteAsync(CancellationToken cancellationToken)
    {
        await foreach (RedisValue payload in _remoteMessages.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
        {
            ApplyRemote(payload);
        }
    }

    internal async Task<int> ReplayDurableAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            ISecurityRiskEventStore store = scope.ServiceProvider.GetRequiredService<ISecurityRiskEventStore>();
            IReadOnlyList<SecurityRiskEventRecord> events = await store.ListActiveForScoreAsync(
                new SecurityRiskScoreQuery(null, null, null, null, null),
                timeProvider.GetUtcNow(),
                projection.Snapshot().MaxEntries,
                cancellationToken).ConfigureAwait(false);
            int applied = 0;
            foreach (SecurityRiskEventRecord item in events)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (item.ClientIpHash is null)
                {
                    continue;
                }

                if (projection.Apply(
                        new PublicHotReadRiskProjectionUpdate(
                            item.ClientIpHash,
                            item.PseudonymEpoch,
                            item.TotalScore,
                            item.OccurredAtUtc,
                            item.ExpiresAtUtc,
                            item.Id,
                            IsAuthoritativeZero: item.ScoreDelta < 0
                                || string.Equals(item.Reason, SecurityRiskEventReasons.RiskReset, StringComparison.Ordinal)),
                        durableReplay: true))
                {
                    applied++;
                }
            }

            return applied;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "public-hot-risk-projection-durable-replay-failed");
            return 0;
        }
    }

    private void ApplyRemote(RedisValue payload)
    {
        if (!PublicHotReadRiskProjectionUpdate.TryParse(payload, out PublicHotReadRiskProjectionUpdate update))
        {
            logger.LogDebug("public-hot-risk-projection-message-ignored");
            return;
        }

        _ = projection.Apply(update, distributedUpdate: true);
    }
}
