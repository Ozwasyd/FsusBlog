using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MfaChallengeServiceTests
{
    [Fact]
    public async Task RecordFailureAsync_SameAccountSubjectHashSharesCounterAcrossAccountIds()
    {
        var cache = new RecordingCounterCache();
        var service = new MfaChallengeService(cache, NullLogger<MfaChallengeService>.Instance);
        const string subjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        bool locked = false;
        for (int i = 0; i < 10; i++)
        {
            locked = await service.RecordFailureAsync(
                new MfaChallengeTicket
                {
                    TicketId = string.Concat("ticket-", i.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                    AccountId = i % 2 == 0 ? 42 : 314,
                    AccountSubjectHash = subjectHash,
                    Type = "action",
                    Action = "passkey.delete"
                },
                "203.0.113.10",
                "unit-test");
        }

        Assert.True(locked);
        Assert.Equal(10, cache.Counters["fail:subject:" + subjectHash]);
        Assert.DoesNotContain(cache.Counters.Keys, static key => key.StartsWith("fail:user:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RecordFailureAsync_NormalizesSubjectHashBeforeBuildingCounterKey()
    {
        var cache = new RecordingCounterCache();
        var service = new MfaChallengeService(cache, NullLogger<MfaChallengeService>.Instance);

        await service.RecordFailureAsync(
            new MfaChallengeTicket
            {
                TicketId = "ticket-normalized",
                AccountId = 42,
                AccountSubjectHash = " ABCDEF ",
                Type = "action",
                Action = "passkey.delete"
            },
            "203.0.113.10",
            "unit-test");

        Assert.Contains("fail:subject:abcdef", cache.Counters.Keys);
        Assert.DoesNotContain(cache.Counters.Keys, static key => key.StartsWith("fail:user:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RecordFailureAsync_UsesSingleAtomicCounterSnapshot()
    {
        var cache = new RecordingCounterCache();
        var service = new MfaChallengeService(cache, NullLogger<MfaChallengeService>.Instance);

        await service.RecordFailureAsync(
            new MfaChallengeTicket
            {
                TicketId = "ticket-atomic",
                AccountId = 42,
                AccountSubjectHash = "subject-atomic",
                Type = "action",
                Action = "passkey.delete"
            },
            "203.0.113.10",
            "unit-test");

        string[] batch = Assert.Single(cache.AtomicIncrementBatches);
        Assert.Equal(
            ["fail:ticket:ticket-atomic", "fail:subject:subject-atomic"],
            batch.Take(2).ToArray());
        Assert.StartsWith("fail:ip:", batch[2], StringComparison.Ordinal);
        Assert.Equal(0, cache.SingleIncrementCalls);
    }

    [Fact]
    public async Task RecordFailureAsync_LockDecisionUsesAtomicSubjectCount()
    {
        var cache = new RecordingCounterCache();
        cache.Counters["fail:subject:subject-lock"] = 9;
        var service = new MfaChallengeService(cache, NullLogger<MfaChallengeService>.Instance);

        bool locked = await service.RecordFailureAsync(
            new MfaChallengeTicket
            {
                TicketId = "ticket-lock",
                AccountId = 42,
                AccountSubjectHash = "subject-lock",
                Type = "action",
                Action = "passkey.delete"
            },
            "203.0.113.10",
            "unit-test");

        Assert.True(locked);
        Assert.Equal(10, cache.Counters["fail:subject:subject-lock"]);
        Assert.Contains("ticket-lock", cache.Removed);
    }

    [Fact]
    public void MfaFailureLimiter_UsesStableAccountSubjectHashAndAccountAuditField()
    {
        string source = ReadSource("src/backend/Services/Security/MfaChallengeService.cs");
        string ticket = ExtractBetween(source, "public sealed record class MfaChallengeTicket", "public interface IMfaChallengeService");
        string recordFailure = ExtractBetween(source, "public async Task<bool> RecordFailureAsync", "public async Task<string> CreateProofTokenAsync");

        Assert.Contains("AccountId", ticket, StringComparison.Ordinal);
        Assert.Contains("AccountSubjectHash", ticket, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", ticket, StringComparison.Ordinal);

        Assert.Contains("fail:subject:", recordFailure, StringComparison.Ordinal);
        Assert.DoesNotContain("fail:user:", recordFailure, StringComparison.Ordinal);
        Assert.Contains("\"AccountId\"", recordFailure, StringComparison.Ordinal);
        Assert.DoesNotContain("\"UserId\"", recordFailure, StringComparison.Ordinal);
    }

    [Fact]
    public void MfaFailureLimiter_StaticLegacyUserIdResidueDoesNotReturn()
    {
        string source = ReadSource("src/backend/Services/Security/MfaChallengeService.cs");

        Assert.DoesNotContain("fail:user:", source, StringComparison.Ordinal);
        Assert.DoesNotContain("required int UserId", source, StringComparison.Ordinal);
    }

    private static string ReadSource(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractBetween(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        int end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
    }

    private sealed class RecordingCounterCache : IUnifiedCache
    {
        public Dictionary<string, long> Counters { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Removed { get; } = new(StringComparer.Ordinal);
        public List<string[]> AtomicIncrementBatches { get; } = [];
        public int SingleIncrementCalls { get; private set; }

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<T>(false, default));

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<byte[]>(false, default));

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<ReadOnlyMemory<byte>>(false, default));

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<string?>(null);

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
        {
            SingleIncrementCalls++;
            Counters.TryGetValue(identity, out long current);
            current += value;
            Counters[identity] = current;
            return Task.FromResult(current);
        }

        public Task<long[]> IncrementManyAsync(CachePolicyId policyId, IReadOnlyList<string> identities, long value = 1, CancellationToken cancellationToken = default)
        {
            AtomicIncrementBatches.Add([.. identities]);
            long[] values = new long[identities.Count];
            for (int i = 0; i < identities.Count; i++)
            {
                string identity = identities[i];
                Counters.TryGetValue(identity, out long current);
                current += value;
                Counters[identity] = current;
                values[i] = current;
            }

            return Task.FromResult(values);
        }

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(new CacheReadResult<T>(false, default));

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            Removed.Add(identity);
            return Task.CompletedTask;
        }

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<IAsyncDisposable>(new NoopAsyncDisposable());

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => identity;
    }

    private sealed class NoopAsyncDisposable : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
