using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamPreflightGrantServiceTests
{
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private static readonly DateTimeOffset s_now = new(2026, 7, 19, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ExchangeTarget_IsDeterministicAndCanResumeOnlyWhileGrantExists()
    {
        var cache = new MemoryGrantCache();
        var envelopeState = new MutableEnvelopeStateService(CreateEnvelope());
        var service = new NotificationStreamPreflightGrantService(cache, cache, new FixedTimeProvider(s_now), envelopeState);
        SecurityChallengeProofClaims proof = CreateProof();
        NotificationStreamPreflightGrantBinding binding = CreateBinding();

        NotificationStreamPreflightGrantExchange first = service.CreateExchangeTarget("fcp_proof-token", proof);
        NotificationStreamPreflightGrantExchange second = service.CreateExchangeTarget("fcp_proof-token", proof);
        await cache.SetRawAsync(
            CachePolicyId.SecurityChallengeProof,
            first.CacheIdentity,
            first.Payload,
            first.Ttl);

        string? resumed = await service.TryResumeExchangeAsync("fcp_proof-token", binding, CancellationToken.None);
        NotificationStreamPreflightGrantConsumeResult consumed = await service.ConsumeAsync(
            first.Token,
            binding,
            CancellationToken.None);
        string? afterConsume = await service.TryResumeExchangeAsync("fcp_proof-token", binding, CancellationToken.None);

        Assert.Equal(first.Token, second.Token);
        Assert.Equal(first.CacheIdentity, second.CacheIdentity);
        Assert.Equal(first.Payload, second.Payload);
        Assert.Equal(first.Token, resumed);
        Assert.True(consumed.Accepted);
        Assert.Null(afterConsume);
    }

    [Fact]
    public async Task TryResumeExchangeAsync_BindingMismatchDoesNotExposePreparedGrant()
    {
        var cache = new MemoryGrantCache();
        var service = new NotificationStreamPreflightGrantService(
            cache,
            cache,
            new FixedTimeProvider(s_now),
            new MutableEnvelopeStateService(CreateEnvelope()));
        NotificationStreamPreflightGrantExchange target = service.CreateExchangeTarget("fcp_proof-token", CreateProof());
        await cache.SetRawAsync(CachePolicyId.SecurityChallengeProof, target.CacheIdentity, target.Payload, target.Ttl);

        string? resumed = await service.TryResumeExchangeAsync(
            "fcp_proof-token",
            CreateBinding() with
            {
                RouteKey = "notification:other"
            },
            CancellationToken.None);

        Assert.Null(resumed);
    }

    [Fact]
    public async Task RevokedEnvelope_InvalidatesPreparedAndUnconsumedGrant()
    {
        var cache = new MemoryGrantCache();
        var envelopeState = new MutableEnvelopeStateService(CreateEnvelope());
        var service = new NotificationStreamPreflightGrantService(cache, cache, new FixedTimeProvider(s_now), envelopeState);
        NotificationStreamPreflightGrantExchange target = service.CreateExchangeTarget("fcp_proof-token", CreateProof());
        await cache.SetRawAsync(CachePolicyId.SecurityChallengeProof, target.CacheIdentity, target.Payload, target.Ttl);
        envelopeState.State = envelopeState.State! with
        {
            Status = SecurityChallengeEnvelopeStatuses.Revoked,
            TerminalReason = "client_cancelled"
        };

        string? resumed = await service.TryResumeExchangeAsync("fcp_proof-token", CreateBinding(), CancellationToken.None);
        NotificationStreamPreflightGrantConsumeResult consumed = await service.ConsumeAsync(
            target.Token,
            CreateBinding(),
            CancellationToken.None);

        Assert.Null(resumed);
        Assert.False(consumed.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.Revoked, consumed.Outcome);
    }

    private static SecurityChallengeProofClaims CreateProof()
        => new(
            "challenge-final",
            "sha256PowV1",
            "notification.subscribe",
            "notification:subscribe",
            HashA,
            HashB,
            HashC,
            s_now.AddMinutes(-1),
            s_now.AddMinutes(5),
            "proof-nonce",
            "risk-v2",
            EnvelopeId: "envelope-1",
            RequiredKinds: ["sha256PowV1"],
            OrderedMemberChallengeIds: ["challenge-final"]);

    private static SecurityChallengeEnvelopeState CreateEnvelope()
        => new(
            "envelope-1",
            "notification.subscribe",
            "notification:subscribe",
            HashA,
            HashB,
            HashC,
            "risk-v2",
            ["challenge-final"],
            ["sha256PowV1"],
            [SecurityChallengeEnvelopeMemberStatuses.Verified],
            s_now.AddMinutes(-1).ToUnixTimeMilliseconds(),
            s_now.AddMinutes(5).ToUnixTimeMilliseconds(),
            SecurityChallengeEnvelopeStatuses.Completed,
            2,
            ProofToken: "fcp_proof-token",
            ProofNonce: "proof-nonce",
            ProofIssuedAtUnixMs: s_now.AddMinutes(-1).ToUnixTimeMilliseconds(),
            ProofExpiresAtUnixMs: s_now.AddMinutes(5).ToUnixTimeMilliseconds());

    private static NotificationStreamPreflightGrantBinding CreateBinding()
        => new("notification.subscribe", "notification:subscribe", HashA, HashB, HashC, "risk-v2");

    private sealed class MemoryGrantCache : ICacheRawWriter, ICacheRawReader, ICacheOneTimeStore
    {
        private readonly Dictionary<string, byte[]> _values = new(StringComparer.Ordinal);

        public Task SetRawAsync(
            CachePolicyId policyId,
            string identity,
            byte[] value,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _values[Key(policyId, identity)] = value;
            return Task.CompletedTask;
        }

        public Task SetNegativeAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_values.TryGetValue(Key(policyId, identity), out byte[]? value)
                ? new CacheReadResult<byte[]>(true, value)
                : new CacheReadResult<byte[]>(false, null));
        }

        public async Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            CacheReadResult<byte[]> read = await TryGetRawAsync(policyId, identity, cancellationToken);
            return read.Hit && read.Value is not null
                ? new CacheReadResult<ReadOnlyMemory<byte>>(true, read.Value)
                : new CacheReadResult<ReadOnlyMemory<byte>>(false, default);
        }

        public Task<bool> ConsumeOnceAsync(
            CachePolicyId policyId,
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(_values.Remove(Key(policyId, identity)));
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string key = Key(policyId, identity);
            if (!_values.Remove(key, out byte[]? payload))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, value) = decoder(payload);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, value)
                : new CacheReadResult<T>(false, default));
        }

        private static string Key(CachePolicyId policyId, string identity) => $"{policyId}:{identity}";
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class MutableEnvelopeStateService(SecurityChallengeEnvelopeState? state) : ISecurityChallengeEnvelopeStateService
    {
        public SecurityChallengeEnvelopeState? State { get; set; } = state;

        public Task<SecurityChallengeEnvelopeState?> GetAsync(string envelopeId, CancellationToken cancellationToken = default)
            => Task.FromResult(State is not null && string.Equals(State.EnvelopeId, envelopeId, StringComparison.Ordinal)
                ? State
                : null);

        public Task<bool> CreateAsync(SecurityChallengeEnvelopeState state, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeEnvelopeMemberResult> ValidateMemberAsync(
            SecurityChallengeEnvelopeMemberRequest request,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeEnvelopeMemberResult> ReserveMemberAsync(
            SecurityChallengeEnvelopeMemberRequest request,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeEnvelopeMemberResult> CompleteMemberAsync(
            SecurityChallengeEnvelopeMemberRequest request,
            SecurityChallengeProofPreparation? proofPreparation = null,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeEnvelopeMemberResult> CompleteIssuanceAsync(
            SecurityChallengeEnvelopeMemberRequest request,
            int memberIndex,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeEnvelopeMemberResult> CompleteProofAsync(
            SecurityChallengeEnvelopeMemberRequest request,
            string proofToken,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<bool> FailAsync(
            SecurityChallengeEnvelopeMemberRequest request,
            string reason,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<bool> RevokeAsync(
            SecurityChallengeEnvelopeBindingRequest request,
            string reason,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }
}
