using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Security")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class RecoveryKeyAttemptLimiterContractTests(PostgresSchemaMigrationFixture fixture)
{
    private const string Pepper = "unit-test-recovery-key-pepper-with-enough-entropy";
    private static readonly DateTimeOffset s_baselineNow = new(2026, 7, 11, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task VerifyAsync_FailedAttemptsEscalateAtThresholdAndRecoverAfterWindowExpiry()
    {
        var clock = new MutableTimeProvider(s_baselineNow);
        var cache = new ExpiringAttemptCache(clock);
        RecoveryKeyService service = CreateService(Substitute.For<ISqlSugarClient>(), cache);

        for (int attempt = 1; attempt < 8; attempt++)
        {
            Result<RecoveryKeyVerifyResponseCoreModel> rejected = await VerifyAsync(service, "frk_invalid-shape");
            Assert.False(rejected.IsSuccess);
            Assert.Equal(ErrorCode.Unauthorized, rejected.Error.Code);
            Assert.Equal("RECOVERY_KEY_INVALID", rejected.Error.Message);
        }

        Result<RecoveryKeyVerifyResponseCoreModel> threshold = await VerifyAsync(service, "frk_invalid-shape");
        Assert.False(threshold.IsSuccess);
        Assert.Equal(ErrorCode.Forbidden, threshold.Error.Code);
        Assert.Equal("RECOVERY_KEY_RATE_LIMITED", threshold.Error.Message);
        Assert.Equal(8L, cache.CurrentCount);

        clock.UtcNow = s_baselineNow.AddMinutes(10).AddTicks(1);
        Result<RecoveryKeyVerifyResponseCoreModel> afterExpiry = await VerifyAsync(service, "frk_invalid-shape");

        Assert.False(afterExpiry.IsSuccess);
        Assert.Equal(ErrorCode.Unauthorized, afterExpiry.Error.Code);
        Assert.Equal("RECOVERY_KEY_INVALID", afterExpiry.Error.Message);
        Assert.Equal(1L, cache.CurrentCount);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task VerifyAsync_ConcurrentFailuresUseOneAtomicWindowWithoutLostIncrements()
    {
        const int ConcurrentFailures = 32;
        var clock = new MutableTimeProvider(s_baselineNow);
        var cache = new ExpiringAttemptCache(clock, ConcurrentFailures);
        RecoveryKeyService service = CreateService(Substitute.For<ISqlSugarClient>(), cache);

        Result<RecoveryKeyVerifyResponseCoreModel>[] results = await Task.WhenAll(
            Enumerable.Range(0, ConcurrentFailures)
                .Select(_ => VerifyAsync(service, "frk_same-invalid-shape")));

        Assert.Equal(7, results.Count(static result => result.Error.Message == "RECOVERY_KEY_INVALID"));
        Assert.Equal(25, results.Count(static result => result.Error.Message == "RECOVERY_KEY_RATE_LIMITED"));
        Assert.Equal((long)ConcurrentFailures, cache.CurrentCount);
        Assert.Equal(ConcurrentFailures, cache.IncrementCalls);

        Result<RecoveryKeyVerifyResponseCoreModel> locked = await VerifyAsync(service, "frk_same-invalid-shape");
        Assert.Equal("RECOVERY_KEY_RATE_LIMITED", locked.Error.Message);
        Assert.Equal(ConcurrentFailures, cache.IncrementCalls);
    }

    [Fact]
    public async Task VerifyAsync_LockedIdentityReturnsBeforeCredentialLookup()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(RecoveryKeyCredential));
        var cache = new ExpiringAttemptCache(new MutableTimeProvider(s_baselineNow));
        RecoveryKeyService service = CreateService(db, cache);
        const string RecoveryKey = "frk_00112233445566778899aabbccddeeff_missingCredential";

        for (int attempt = 0; attempt < 8; attempt++)
        {
            _ = await VerifyAsync(service, RecoveryKey);
        }

        await db.Ado.ExecuteCommandAsync("DROP TABLE account_recovery_key;");

        Result<RecoveryKeyVerifyResponseCoreModel> locked = await VerifyAsync(service, RecoveryKey);
        Assert.False(locked.IsSuccess);
        Assert.Equal(ErrorCode.Forbidden, locked.Error.Code);
        Assert.Equal("RECOVERY_KEY_RATE_LIMITED", locked.Error.Message);
        Assert.Equal(8, cache.IncrementCalls);
    }

    [Fact]
    public async Task VerifyAsync_ExistingAndMissingCredentialFailuresHaveTheSameObservableResponse()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(RecoveryKeyCredential));
        var cache = new ExpiringAttemptCache(new MutableTimeProvider(s_baselineNow));
        RecoveryKeyService service = CreateService(db, cache);
        const string ExistingLookup = "00112233445566778899aabbccddeeff";
        const string MissingLookup = "ffeeddccbbaa99887766554433221100";
        const string ExistingKey = "frk_00112233445566778899aabbccddeeff_wrongSecret";
        const string MissingKey = "frk_ffeeddccbbaa99887766554433221100_wrongSecret";

        await db.Insertable(new RecoveryKeyCredential
        {
            AccountId = 17,
            LookupIdHash = HashLookup(ExistingLookup),
            KeyHash = "invalid-stored-hash",
            KeyVersion = 1,
            CreatedAt = DateTime.UtcNow
        }).ExecuteCommandAsync();

        Result<RecoveryKeyVerifyResponseCoreModel> existing = await VerifyAsync(service, ExistingKey);
        Result<RecoveryKeyVerifyResponseCoreModel> missing = await VerifyAsync(service, MissingKey);

        Assert.False(existing.IsSuccess);
        Assert.False(missing.IsSuccess);
        Assert.Equal(existing.Error.Code, missing.Error.Code);
        Assert.Equal(ErrorCode.Unauthorized, existing.Error.Code);
        Assert.Equal(existing.Error.Message, missing.Error.Message);
        Assert.Equal("RECOVERY_KEY_INVALID", existing.Error.Message);
        Assert.All(cache.ObservedIdentities, identity =>
        {
            Assert.DoesNotContain(ExistingLookup, identity, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(MissingLookup, identity, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("wrongSecret", identity, StringComparison.Ordinal);
        });
    }

    private static Task<Result<RecoveryKeyVerifyResponseCoreModel>> VerifyAsync(
        RecoveryKeyService service,
        string recoveryKey)
        => service.VerifyAsync(
            new RecoveryKeyVerifyRequestCoreModel(recoveryKey, RevokeSessions: false, RevokePasskeys: false),
            "203.0.113.41",
            "recovery-limiter-behavior-test",
            CancellationToken.None);

    private static RecoveryKeyService CreateService(ISqlSugarClient db, IUnifiedCache cache)
        => new(
            db,
            cache,
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Security:RecoveryKeyPepper"] = Pepper
                })
                .Build(),
            Substitute.For<IPasskeyService>(),
            NullLogger<RecoveryKeyService>.Instance,
            Substitute.For<IUserSessionValidationCache>());

    private static string HashLookup(string lookup)
        => Convert.ToHexString(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(Pepper),
            Encoding.UTF8.GetBytes("recovery-key-lookup:" + lookup)));

    private sealed class ExpiringAttemptCache(TimeProvider timeProvider, int concurrentReadGate = 0) : IUnifiedCache
    {
        private readonly object _sync = new();
        private readonly Dictionary<string, CounterWindow> _counters = new(StringComparer.Ordinal);
        private readonly TaskCompletionSource<bool> _readGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _readersAtGate;
        private int _gateReleased;
        private int _incrementCalls;

        public ConcurrentBag<string> ObservedIdentities { get; } = [];

        public int IncrementCalls => Volatile.Read(ref _incrementCalls);

        public long CurrentCount
        {
            get
            {
                lock (_sync)
                {
                    RemoveExpiredCounters();
                    return _counters.Values.SingleOrDefault()?.Value ?? 0;
                }
            }
        }

        public async Task<string?> GetStringAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            Assert.Equal(CachePolicyId.SecurityRecoveryKeyAttempt, policyId);
            ObservedIdentities.Add(identity);
            string? snapshot;
            lock (_sync)
            {
                RemoveExpiredCounters();
                snapshot = _counters.TryGetValue(BuildKey(policyId, identity), out CounterWindow? counter)
                    ? counter.Value.ToString(CultureInfo.InvariantCulture)
                    : null;
            }

            if (concurrentReadGate > 0 && Volatile.Read(ref _gateReleased) == 0)
            {
                if (Interlocked.Increment(ref _readersAtGate) == concurrentReadGate)
                {
                    Interlocked.Exchange(ref _gateReleased, 1);
                    _readGate.TrySetResult(true);
                }

                await _readGate.Task.WaitAsync(cancellationToken);
            }

            return snapshot;
        }

        public Task<long> IncrementWithExpiryAsync(
            CachePolicyId policyId,
            string identity,
            TimeSpan ttl,
            long value = 1,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Assert.Equal(CachePolicyId.SecurityRecoveryKeyAttempt, policyId);
            Assert.Equal(TimeSpan.FromMinutes(10), ttl);
            Interlocked.Increment(ref _incrementCalls);
            ObservedIdentities.Add(identity);
            lock (_sync)
            {
                RemoveExpiredCounters();
                string key = BuildKey(policyId, identity);
                if (!_counters.TryGetValue(key, out CounterWindow? counter))
                {
                    counter = new CounterWindow(0, timeProvider.GetUtcNow().Add(ttl));
                }

                counter = counter with
                {
                    Value = counter.Value + value
                };
                _counters[key] = counter;
                return Task.FromResult(counter.Value);
            }
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}";

        private void RemoveExpiredCounters()
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            foreach (string key in _counters
                         .Where(pair => pair.Value.ExpiresAt <= now)
                         .Select(static pair => pair.Key)
                         .ToArray())
            {
                _counters.Remove(key);
            }
        }

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();

        private sealed record CounterWindow(long Value, DateTimeOffset ExpiresAt);
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }
}
