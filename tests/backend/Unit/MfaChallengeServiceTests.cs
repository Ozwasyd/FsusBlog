using System.Reflection;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class MfaChallengeServiceTests
{
    private static readonly string s_uppercaseSubjectHash = new string('A', AccountSubjectHashRequirement.Sha256HexLength);
    private static readonly string s_atomicSubjectHash = new string('b', AccountSubjectHashRequirement.Sha256HexLength);
    private static readonly string s_lockedSubjectHash = new string('c', AccountSubjectHashRequirement.Sha256HexLength);

    [Fact]
    public async Task RecordFailureAsync_SameAccountSubjectHashSharesCounterAcrossAccountIds()
    {
        var cache = new RecordingCounterCache();
        var service = new MfaChallengeService(cache, cache, cache, cache, cache, NullLogger<MfaChallengeService>.Instance);
        const string SubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        bool locked = false;
        for (int i = 0; i < 10; i++)
        {
            locked = await service.RecordFailureAsync(
                new MfaChallengeTicket
                {
                    TicketId = string.Concat("ticket-", i.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                    AccountId = i % 2 == 0 ? 42 : 314,
                    AccountSubjectHash = SubjectHash,
                    Type = "action",
                    Action = "passkey.delete"
                },
                "203.0.113.10",
                "unit-test");
        }

        Assert.True(locked);
        Assert.Equal(10, cache.Counters["fail:subject:" + SubjectHash]);
        Assert.DoesNotContain(cache.Counters.Keys, static key => key.StartsWith("fail:user:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RecordFailureAsync_NormalizesSubjectHashBeforeBuildingCounterKey()
    {
        var cache = new RecordingCounterCache();
        var service = new MfaChallengeService(cache, cache, cache, cache, cache, NullLogger<MfaChallengeService>.Instance);

        await service.RecordFailureAsync(
            new MfaChallengeTicket
            {
                TicketId = "ticket-normalized",
                AccountId = 42,
                AccountSubjectHash = $" {s_uppercaseSubjectHash} ",
                Type = "action",
                Action = "passkey.delete"
            },
            "203.0.113.10",
            "unit-test");

        Assert.Contains("fail:subject:" + s_uppercaseSubjectHash.ToLowerInvariant(), cache.Counters.Keys);
        Assert.DoesNotContain(cache.Counters.Keys, static key => key.StartsWith("fail:user:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task RecordFailureAsync_UsesSingleAtomicCounterSnapshot()
    {
        var cache = new RecordingCounterCache();
        var service = new MfaChallengeService(cache, cache, cache, cache, cache, NullLogger<MfaChallengeService>.Instance);

        await service.RecordFailureAsync(
            new MfaChallengeTicket
            {
                TicketId = "ticket-atomic",
                AccountId = 42,
                AccountSubjectHash = s_atomicSubjectHash,
                Type = "action",
                Action = "passkey.delete"
            },
            "203.0.113.10",
            "unit-test");

        string[] batch = Assert.Single(cache.AtomicIncrementBatches);
        TimeSpan ttl = Assert.Single(cache.AtomicIncrementBatchTtls);
        Assert.Equal(
            ["fail:ticket:ticket-atomic", "fail:subject:" + s_atomicSubjectHash],
            batch.Take(2).ToArray());
        Assert.StartsWith("fail:ip:", batch[2], StringComparison.Ordinal);
        Assert.Equal(TimeSpan.FromMinutes(10), ttl);
        Assert.Equal(0, cache.SingleIncrementCalls);
    }

    [Fact]
    public async Task RecordFailureAsync_LockDecisionUsesAtomicSubjectCount()
    {
        var cache = new RecordingCounterCache();
        cache.Counters["fail:subject:" + s_lockedSubjectHash] = 9;
        var service = new MfaChallengeService(cache, cache, cache, cache, cache, NullLogger<MfaChallengeService>.Instance);

        bool locked = await service.RecordFailureAsync(
            new MfaChallengeTicket
            {
                TicketId = "ticket-lock",
                AccountId = 42,
                AccountSubjectHash = s_lockedSubjectHash,
                Type = "action",
                Action = "passkey.delete"
            },
            "203.0.113.10",
            "unit-test");

        Assert.True(locked);
        Assert.Equal(10, cache.Counters["fail:subject:" + s_lockedSubjectHash]);
        Assert.Contains("ticket-lock", cache.Removed);
    }

    [Fact]
    public void MfaFailureLimiter_UsesStableAccountSubjectHashAndAccountAuditField()
    {
        string[] ticket = typeof(MfaChallengeTicket).GetProperties().Select(static property => property.Name).ToArray();
        string recordFailure = RuntimeMetadataInspection.DescribeMethods(
            typeof(MfaChallengeService),
            nameof(MfaChallengeService.RecordFailureAsync));

        Assert.Contains(nameof(MfaChallengeTicket.AccountId), ticket);
        Assert.Contains(nameof(MfaChallengeTicket.AccountSubjectHash), ticket);
        Assert.DoesNotContain("UserId", ticket);

        Assert.Contains("fail:subject:", recordFailure, StringComparison.Ordinal);
        Assert.Contains("IncrementManyWithExpiryAsync", recordFailure, StringComparison.Ordinal);
        Assert.DoesNotContain("IncrementManyAsync", recordFailure, StringComparison.Ordinal);
        Assert.DoesNotContain("fail:user:", recordFailure, StringComparison.Ordinal);
        Assert.Contains("AccountId", recordFailure, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", recordFailure, StringComparison.Ordinal);
        Assert.Equal(
            TimeSpan.FromMinutes(10),
            typeof(MfaChallengeService).GetField("s_failureWindowTtl", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null));
    }

    [Fact]
    public void MfaFailureLimiter_StaticLegacyUserIdResidueDoesNotReturn()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(MfaChallengeService));

        Assert.DoesNotContain("fail:user:", runtimeShape, StringComparison.Ordinal);
        Assert.Null(typeof(MfaChallengeTicket).GetProperty("UserId"));
    }

    [Fact]
    public void MfaTickets_AreSignedAndLegacyTicketsRejected()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["MfaChallenge:TicketSigningKey"] = "unit-test-ticket-signing-key-with-at-least-32-characters"
            })
            .Build();
        var cache = new RecordingCounterCache();
        var service = new MfaChallengeService(
            cache,
            cache,
            cache,
            cache,
            cache,
            NullLogger<MfaChallengeService>.Instance,
            configuration);
        var ticket = new MfaChallengeTicket
        {
            TicketId = "signed-ticket",
            AccountId = 42,
            AccountSubjectHash = s_atomicSubjectHash,
            Type = "action",
            Action = "passkey.delete"
        };
        MethodInfo encode = typeof(MfaChallengeService).GetMethod("EncodeTicket", BindingFlags.Instance | BindingFlags.NonPublic)!;
        MethodInfo decode = typeof(MfaChallengeService).GetMethod("DecodeTicket", BindingFlags.Instance | BindingFlags.NonPublic)!;
        string encoded = (string)encode.Invoke(service, [ticket])!;
        MfaChallengeTicket decoded = Assert.IsType<MfaChallengeTicket>(decode.Invoke(service, [encoded]));
        int tamperIndex = encoded.Length / 2;
        string tampered = encoded[..tamperIndex] + (encoded[tamperIndex] == 'A' ? 'B' : 'A') + encoded[(tamperIndex + 1)..];

        Assert.Equal(ticket.TicketId, decoded.TicketId);
        Assert.Null(decode.Invoke(service, [tampered]));
        string encodeTicket = RuntimeMetadataInspection.DescribeMethods(typeof(MfaChallengeService), "EncodeTicket");
        string decodeTicket = RuntimeMetadataInspection.DescribeMethods(typeof(MfaChallengeService), "DecodeTicket");
        Assert.Contains("HMACSHA256", encodeTicket, StringComparison.Ordinal);
        Assert.Contains("MfaChallenge:TicketSigningKey", encodeTicket, StringComparison.Ordinal);
        Assert.Contains("CryptographicOperations.FixedTimeEquals", decodeTicket, StringComparison.Ordinal);
        Assert.Contains("AccountSubjectHashRequirement.TryResolve", decodeTicket, StringComparison.Ordinal);
        Assert.DoesNotContain("LegacyTicketVersion", decodeTicket, StringComparison.Ordinal);
    }

    [Fact]
    public async Task MfaProofTokens_AreBoundToSubjectActionAndCryptographicRandomness()
    {
        var cache = new RecordingCounterCache();
        var service = new MfaChallengeService(cache, cache, cache, cache, cache, NullLogger<MfaChallengeService>.Instance);
        string first = await service.CreateProofTokenAsync(42, s_atomicSubjectHash, "passkey.delete", TimeSpan.FromMinutes(1));
        string second = await service.CreateProofTokenAsync(42, s_atomicSubjectHash, "passkey.delete", TimeSpan.FromMinutes(1));
        string otherSubject = await service.CreateProofTokenAsync(42, s_lockedSubjectHash, "passkey.delete", TimeSpan.FromMinutes(1));
        string otherAction = await service.CreateProofTokenAsync(42, s_atomicSubjectHash, "profile.email", TimeSpan.FromMinutes(1));

        Assert.NotEqual(first, second);
        Assert.Equal(4, cache.StringWriteIdentities.Distinct(StringComparer.Ordinal).Count());
        string createProof = RuntimeMetadataInspection.DescribeMethods(
            typeof(MfaChallengeService),
            nameof(MfaChallengeService.CreateProofTokenAsync));
        string validateProof = RuntimeMetadataInspection.DescribeMethods(
            typeof(MfaChallengeService),
            nameof(MfaChallengeService.ValidateAndConsumeProofTokenAsync));

        Assert.Contains("RandomNumberGenerator.GetBytes", createProof, StringComparison.Ordinal);
        Assert.Contains("BuildProofIdentity", createProof, StringComparison.Ordinal);
        Assert.Contains("subject", createProof, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("BuildProofIdentity", validateProof, StringComparison.Ordinal);
        Assert.DoesNotContain("Guid.NewGuid", createProof, StringComparison.Ordinal);
    }

    private sealed class RecordingCounterCache : IUnifiedCache
    {
        public Dictionary<string, long> Counters { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Removed { get; } = new(StringComparer.Ordinal);
        public List<string[]> AtomicIncrementBatches { get; } = [];
        public List<TimeSpan> AtomicIncrementBatchTtls { get; } = [];
        public List<string> StringWriteIdentities { get; } = [];
        public int SingleIncrementCalls
        {
            get; private set;
        }

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
        {
            StringWriteIdentities.Add(identity);
            return Task.CompletedTask;
        }

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
        {
            SingleIncrementCalls++;
            Counters.TryGetValue(identity, out long current);
            current += value;
            Counters[identity] = current;
            return Task.FromResult(current);
        }

        public Task<long[]> IncrementManyAsync(CachePolicyId policyId, IReadOnlyList<string> identities, long value = 1, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("MFA failure counters must use IncrementManyWithExpiryAsync.");

        public Task<long[]> IncrementManyWithExpiryAsync(CachePolicyId policyId, IReadOnlyList<string> identities, TimeSpan ttl, long value = 1, CancellationToken cancellationToken = default)
        {
            AtomicIncrementBatches.Add([.. identities]);
            AtomicIncrementBatchTtls.Add(ttl);
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
