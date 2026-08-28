using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeProofServiceTests
{
    private static readonly DateTimeOffset s_baselineNow = new(2026, 6, 18, 12, 0, 0, TimeSpan.Zero);
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    [Fact]
    public void HeaderName_IsStable()
    {
        Assert.Equal("X-Fsus-Challenge-Proof", SecurityChallengeProofService.HeaderName);
    }

    [Fact]
    public void RuntimeServices_RegisterSecurityChallengeProofService()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeProofService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(SecurityChallengeProofService), descriptor.ImplementationType);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    public void CachePolicyRegistry_DefinesConsumeOnceChallengeProofPolicy()
    {
        var registry = new CachePolicyRegistry();

        Assert.True(registry.TryGet(CachePolicyId.SecurityChallengeProof, out CachePolicy policy));
        Assert.Equal(CachePolicyId.SecurityChallengeProof, policy.Id);
        Assert.Equal(TimeSpan.Zero, policy.L1Ttl);
        Assert.Equal(TimeSpan.FromMinutes(5), policy.L2Ttl);
        Assert.False(policy.RegisterKeysForPrefixInvalidation);
    }

    [Fact]
    public async Task MintProofAsync_StoresBoundClaimsWithoutRawPayload()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        var clock = new MutableTimeProvider(s_baselineNow);
        var service = new SecurityChallengeProofService(cache, cache, persistence, clock);

        SecurityChallengeProofMintResult result = await service.MintProofAsync(CreateMintRequest(), CancellationToken.None);

        Assert.StartsWith("fcp_", result.ProofToken, StringComparison.Ordinal);
        Assert.Equal(CachePolicyId.SecurityChallengeProof, cache.LastSetPolicyId);
        Assert.Equal(TimeSpan.FromMinutes(5), cache.LastSetTtl);
        Assert.Equal("challenge-1", result.Claims.ChallengeId);
        Assert.Equal("sha256PowV1", result.Claims.Kind);
        Assert.Equal("public.read", result.Claims.Action);
        Assert.Equal("/article/42", result.Claims.RouteKey);
        Assert.Equal(HashA, result.Claims.SubjectHash);
        Assert.Equal(HashB, result.Claims.ClientIpHash);
        Assert.Equal(HashC, result.Claims.DeviceFpHash);
        Assert.Equal("risk-policy-v2", result.Claims.PolicyVersion);
        Assert.Equal(s_baselineNow, result.Claims.IssuedAt);
        Assert.Equal(s_baselineNow.AddMinutes(5), result.Claims.ExpiresAt);
        Assert.False(string.IsNullOrWhiteSpace(result.Claims.Nonce));
        Assert.Equal(["challenge-1"], result.Claims.OrderedMemberChallengeIds);
        Assert.DoesNotContain("payload", cache.LastStoredJson, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(result.ProofToken, cache.LastStoredJson, StringComparison.Ordinal);
        Assert.Empty(persistence.Attempts);
    }

    [Fact]
    public async Task ConsumeProofAsync_AcceptsMatchingProofAndRejectsReplay()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        var clock = new MutableTimeProvider(s_baselineNow);
        var service = new SecurityChallengeProofService(cache, cache, persistence, clock);
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(CreateMintRequest(), CancellationToken.None);

        SecurityChallengeProofConsumeResult accepted = await service.ConsumeProofAsync(
            CreateConsumeRequest(minted.ProofToken),
            CancellationToken.None);
        SecurityChallengeProofConsumeResult replay = await service.ConsumeProofAsync(
            CreateConsumeRequest(minted.ProofToken),
            CancellationToken.None);

        Assert.True(accepted.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.Accepted, accepted.Outcome);
        Assert.Equal("ok", accepted.Reason);
        Assert.False(replay.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.ReplayedOrMissing, replay.Outcome);
        Assert.Equal("proof_replayed_or_missing", replay.Reason);
        Assert.Equal(2, persistence.Attempts.Count);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, persistence.Attempts[0].Outcome);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Replayed, persistence.Attempts[1].Outcome);
        Assert.Equal("proof_replayed_or_missing", persistence.Attempts[1].Reason);
    }

    [Fact]
    public async Task ConsumeProofAsync_AggregateProofRequiresExactOrderedMemberSet()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        persistence.Statuses["challenge-0"] = SecurityChallengeStatuses.Verified;
        persistence.Statuses["challenge-1"] = SecurityChallengeStatuses.Verified;
        var envelopeStates = new StubEnvelopeStateService();
        var service = new SecurityChallengeProofService(cache, cache, persistence, new MutableTimeProvider(s_baselineNow), envelopeStates);
        string envelopeId = Guid.CreateVersion7().ToString("D");
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(
            CreateMintRequest() with
            {
                Kind = "sha256PowV1",
                EnvelopeId = envelopeId,
                RequiredKinds = ["perceptionCharacterV3", "sha256PowV1"],
                OrderedMemberChallengeIds = ["challenge-0", "challenge-1"]
            },
            CancellationToken.None);
        envelopeStates.State = CreateCompletedEnvelopeState(envelopeId, minted.ProofToken);

        SecurityChallengeProofConsumeResult result = await service.ConsumeProofAsync(
            CreateConsumeRequest(minted.ProofToken) with
            {
                RequiredKinds = ["perceptionCharacterV3", "sha256PowV1"]
            },
            CancellationToken.None);

        Assert.True(result.Accepted, result.Reason);
        Assert.Equal(envelopeId, result.Claims?.EnvelopeId);
        Assert.Equal(["perceptionCharacterV3", "sha256PowV1"], result.Claims?.RequiredKinds);
        Assert.Equal(["challenge-0", "challenge-1"], result.Claims?.OrderedMemberChallengeIds);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, Assert.Single(persistence.Attempts).Outcome);
    }

    [Fact]
    public async Task ConsumeProofAsync_AggregateProofRejectsRevokedEarlierMember()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        persistence.Statuses["challenge-0"] = SecurityChallengeStatuses.Revoked;
        persistence.Statuses["challenge-1"] = SecurityChallengeStatuses.Verified;
        var envelopeStates = new StubEnvelopeStateService();
        var service = new SecurityChallengeProofService(cache, cache, persistence, new MutableTimeProvider(s_baselineNow), envelopeStates);
        string envelopeId = Guid.CreateVersion7().ToString("D");
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(
            CreateMintRequest() with
            {
                EnvelopeId = envelopeId,
                RequiredKinds = ["perceptionCharacterV3", "sha256PowV1"],
                OrderedMemberChallengeIds = ["challenge-0", "challenge-1"]
            });
        envelopeStates.State = CreateCompletedEnvelopeState(envelopeId, minted.ProofToken);

        SecurityChallengeProofConsumeResult result = await service.ConsumeProofAsync(
            CreateConsumeRequest(minted.ProofToken) with
            {
                RequiredKinds = ["perceptionCharacterV3", "sha256PowV1"]
            });

        Assert.False(result.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.Revoked, result.Outcome);
        Assert.Equal("proof_revoked", result.Reason);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Revoked, Assert.Single(persistence.Attempts).Outcome);
    }

    [Fact]
    public async Task ConsumeProofAsync_CompletedEnvelopeRevocationInvalidatesUnconsumedProof()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        persistence.Statuses["challenge-1"] = SecurityChallengeStatuses.Verified;
        var envelopeStates = new StubEnvelopeStateService();
        var service = new SecurityChallengeProofService(cache, cache, persistence, new MutableTimeProvider(s_baselineNow), envelopeStates);
        string envelopeId = Guid.CreateVersion7().ToString("D");
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(
            CreateMintRequest() with
            {
                EnvelopeId = envelopeId,
                OrderedMemberChallengeIds = ["challenge-1"]
            });
        envelopeStates.State = CreateCompletedEnvelopeState(envelopeId, minted.ProofToken) with
        {
            ChallengeIds = ["challenge-1"],
            RequiredKinds = ["sha256PowV1"],
            MemberStatuses = [SecurityChallengeEnvelopeMemberStatuses.Verified],
            Status = SecurityChallengeEnvelopeStatuses.Revoked
        };

        SecurityChallengeProofConsumeResult result = await service.ConsumeProofAsync(CreateConsumeRequest(minted.ProofToken));

        Assert.False(result.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.Revoked, result.Outcome);
        Assert.Equal("proof_revoked", result.Reason);
    }

    [Fact]
    public async Task ExchangeProofAsync_ValidClaimsAtomicallyMoveProofToTypedTarget()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        var service = new SecurityChallengeProofService(
            cache,
            cache,
            persistence,
            new MutableTimeProvider(s_baselineNow),
            cacheReader: cache,
            oneTimeExchangeStore: cache);
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(CreateMintRequest());
        int factoryCalls = 0;

        SecurityChallengeProofExchangeResult exchanged = await service.ExchangeProofAsync(
            CreateConsumeRequest(minted.ProofToken),
            claims =>
            {
                factoryCalls++;
                return new SecurityChallengeProofExchangeTarget(
                    "target-token",
                    CachePolicyId.SecurityChallengeProof,
                    "exchange-target",
                    System.Text.Encoding.UTF8.GetBytes(claims.Action),
                    TimeSpan.FromMinutes(1));
            });
        SecurityChallengeProofConsumeResult sourceReplay = await service.ConsumeProofAsync(
            CreateConsumeRequest(minted.ProofToken));

        Assert.True(exchanged.Accepted, exchanged.Reason);
        Assert.Equal("target-token", exchanged.Target?.Token);
        Assert.Equal(1, factoryCalls);
        Assert.True(cache.Contains(CachePolicyId.SecurityChallengeProof, "exchange-target"));
        Assert.False(sourceReplay.Accepted);
    }

    [Fact]
    public async Task ExchangeProofAsync_SourceMissOrInvalidBindingNeverCreatesTarget()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        var service = new SecurityChallengeProofService(
            cache,
            cache,
            persistence,
            new MutableTimeProvider(s_baselineNow),
            cacheReader: cache,
            oneTimeExchangeStore: cache);
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(CreateMintRequest());
        int factoryCalls = 0;
        SecurityChallengeProofExchangeTarget Factory(SecurityChallengeProofClaims _)
        {
            factoryCalls++;
            return new SecurityChallengeProofExchangeTarget(
                "must-not-exist",
                CachePolicyId.SecurityChallengeProof,
                "must-not-exist",
                [1],
                TimeSpan.FromMinutes(1));
        }

        SecurityChallengeProofExchangeResult invalid = await service.ExchangeProofAsync(
            CreateConsumeRequest(minted.ProofToken) with
            {
                RouteKey = "/wrong"
            },
            Factory);
        SecurityChallengeProofExchangeResult missing = await service.ExchangeProofAsync(
            CreateConsumeRequest("fcp_missing"),
            Factory);

        Assert.False(invalid.Accepted);
        Assert.Equal("route_key_mismatch", invalid.Reason);
        Assert.False(missing.Accepted);
        Assert.Equal("proof_replayed_or_missing", missing.Reason);
        Assert.Equal(0, factoryCalls);
        Assert.False(cache.Contains(CachePolicyId.SecurityChallengeProof, "must-not-exist"));
    }

    [Fact]
    public async Task ExchangeProofAsync_RevokedAggregateMemberNeverCreatesTarget()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        persistence.Statuses["challenge-0"] = SecurityChallengeStatuses.Revoked;
        persistence.Statuses["challenge-1"] = SecurityChallengeStatuses.Verified;
        var envelopeStates = new StubEnvelopeStateService();
        var service = new SecurityChallengeProofService(
            cache,
            cache,
            persistence,
            new MutableTimeProvider(s_baselineNow),
            envelopeStates,
            cache,
            cache);
        string envelopeId = Guid.CreateVersion7().ToString("D");
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(
            CreateMintRequest() with
            {
                EnvelopeId = envelopeId,
                RequiredKinds = ["perceptionCharacterV3", "sha256PowV1"],
                OrderedMemberChallengeIds = ["challenge-0", "challenge-1"]
            });
        envelopeStates.State = CreateCompletedEnvelopeState(envelopeId, minted.ProofToken);
        int factoryCalls = 0;

        SecurityChallengeProofExchangeResult result = await service.ExchangeProofAsync(
            CreateConsumeRequest(minted.ProofToken) with
            {
                RequiredKinds = ["perceptionCharacterV3", "sha256PowV1"]
            },
            _ =>
            {
                factoryCalls++;
                return new SecurityChallengeProofExchangeTarget(
                    "must-not-exist",
                    CachePolicyId.SecurityChallengeProof,
                    "revoked-target",
                    [1],
                    TimeSpan.FromMinutes(1));
            });

        Assert.False(result.Accepted);
        Assert.Equal("proof_revoked", result.Reason);
        Assert.Equal(0, factoryCalls);
        Assert.False(cache.Contains(CachePolicyId.SecurityChallengeProof, "revoked-target"));
    }

    [Fact]
    public async Task ConsumeProofAsync_SingleMemberProofCannotSatisfyAggregateDecision()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        var service = new SecurityChallengeProofService(cache, cache, persistence, new MutableTimeProvider(s_baselineNow));
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(CreateMintRequest(), CancellationToken.None);

        SecurityChallengeProofConsumeResult result = await service.ConsumeProofAsync(
            CreateConsumeRequest(minted.ProofToken) with
            {
                RequiredKinds = ["perceptionCharacterV3", "sha256PowV1"]
            },
            CancellationToken.None);

        Assert.False(result.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.BindingMismatch, result.Outcome);
        Assert.Equal("required_kinds_mismatch", result.Reason);
    }

    [Theory]
    [InlineData("challengeId", "challenge_id_mismatch")]
    [InlineData("kind", "kind_mismatch")]
    [InlineData("action", "action_mismatch")]
    [InlineData("routeKey", "route_key_mismatch")]
    [InlineData("subjectHash", "subject_hash_mismatch")]
    [InlineData("clientIpHash", "client_ip_hash_mismatch")]
    [InlineData("deviceFpHash", "device_fp_hash_mismatch")]
    [InlineData("policyVersion", "policy_version_mismatch")]
    public async Task ConsumeProofAsync_RejectsBindingMismatch(string field, string expectedReason)
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        var clock = new MutableTimeProvider(s_baselineNow);
        var service = new SecurityChallengeProofService(cache, cache, persistence, clock);
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(CreateMintRequest(), CancellationToken.None);
        SecurityChallengeProofConsumeRequest request = Mutate(CreateConsumeRequest(minted.ProofToken), field);

        SecurityChallengeProofConsumeResult result = await service.ConsumeProofAsync(request, CancellationToken.None);

        Assert.False(result.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.BindingMismatch, result.Outcome);
        Assert.Equal(expectedReason, result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempt.Outcome);
        Assert.Equal(expectedReason, attempt.Reason);
    }

    [Fact]
    public async Task ConsumeProofAsync_RejectsExpiredProofAfterRedisConsume()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        var clock = new MutableTimeProvider(s_baselineNow);
        var service = new SecurityChallengeProofService(cache, cache, persistence, clock);
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(CreateMintRequest(), CancellationToken.None);
        clock.UtcNow = s_baselineNow.AddMinutes(6);

        SecurityChallengeProofConsumeResult result = await service.ConsumeProofAsync(
            CreateConsumeRequest(minted.ProofToken),
            CancellationToken.None);

        Assert.False(result.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.Expired, result.Outcome);
        Assert.Equal("proof_expired", result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Expired, attempt.Outcome);
        Assert.Equal("proof_expired", attempt.Reason);
    }

    [Fact]
    public async Task ConsumeProofAsync_RedisMissRejectsBeforeVerifiedAttempt()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence();
        var clock = new MutableTimeProvider(s_baselineNow);
        var service = new SecurityChallengeProofService(cache, cache, persistence, clock);

        SecurityChallengeProofConsumeResult result = await service.ConsumeProofAsync(
            CreateConsumeRequest("fcp_missing-token"),
            CancellationToken.None);

        Assert.False(result.Accepted);
        Assert.Equal("proof_replayed_or_missing", result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Replayed, attempt.Outcome);
        Assert.Equal("proof_replayed_or_missing", attempt.Reason);
        Assert.DoesNotContain(persistence.Attempts, static item => item.Outcome == SecurityChallengeAttemptOutcomes.Verified);
    }

    [Fact]
    public async Task ConsumeProofAsync_RejectsRevokedChallengeWithPublicOutcome()
    {
        var cache = new MemoryProofCache();
        var persistence = new RecordingChallengePersistence { Status = SecurityChallengeStatuses.Revoked };
        var service = new SecurityChallengeProofService(cache, cache, persistence, new MutableTimeProvider(s_baselineNow));
        SecurityChallengeProofMintResult minted = await service.MintProofAsync(CreateMintRequest(), CancellationToken.None);

        SecurityChallengeProofConsumeResult result = await service.ConsumeProofAsync(CreateConsumeRequest(minted.ProofToken), CancellationToken.None);

        Assert.False(result.Accepted);
        Assert.Equal(SecurityChallengeProofOutcomes.Revoked, result.Outcome);
        Assert.Equal("proof_revoked", result.Reason);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Revoked, Assert.Single(persistence.Attempts).Outcome);
    }

    private static SecurityChallengeProofMintRequest CreateMintRequest()
        => new(
            "challenge-1",
            "sha256PowV1",
            "public.read",
            "/article/42",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            s_baselineNow,
            s_baselineNow.AddMinutes(5));

    private static SecurityChallengeProofConsumeRequest CreateConsumeRequest(string proofToken)
        => new(
            proofToken,
            "challenge-1",
            "sha256PowV1",
            "public.read",
            "/article/42",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2");

    private static SecurityChallengeProofConsumeRequest Mutate(SecurityChallengeProofConsumeRequest request, string field)
        => field switch
        {
            "challengeId" => request with { ChallengeId = "challenge-2" },
            "kind" => request with { Kind = "perceptionCharacterV3" },
            "action" => request with { Action = "comment.create" },
            "routeKey" => request with { RouteKey = "/article/99" },
            "subjectHash" => request with { SubjectHash = HashB },
            "clientIpHash" => request with { ClientIpHash = HashA },
            "deviceFpHash" => request with { DeviceFpHash = HashA },
            "policyVersion" => request with { PolicyVersion = "risk-policy-v3" },
            _ => request
        };

    private static SecurityChallengeEnvelopeState CreateCompletedEnvelopeState(string envelopeId, string proofToken)
        => new(
            envelopeId,
            "public.read",
            "/article/42",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            ["challenge-0", "challenge-1"],
            ["perceptionCharacterV3", "sha256PowV1"],
            [SecurityChallengeEnvelopeMemberStatuses.Verified, SecurityChallengeEnvelopeMemberStatuses.Verified],
            s_baselineNow.ToUnixTimeMilliseconds(),
            s_baselineNow.AddMinutes(5).ToUnixTimeMilliseconds(),
            SecurityChallengeEnvelopeStatuses.Completed,
            Version: 2,
            ProofToken: proofToken,
            ProofNonce: "proof-nonce",
            ProofIssuedAtUnixMs: s_baselineNow.ToUnixTimeMilliseconds(),
            ProofExpiresAtUnixMs: s_baselineNow.AddMinutes(5).ToUnixTimeMilliseconds());

    private sealed class MemoryProofCache : IUnifiedCache, ICacheOneTimeExchangeStore
    {
        private readonly Dictionary<string, byte[]> _values = new(StringComparer.Ordinal);

        public CachePolicyId LastSetPolicyId
        {
            get; private set;
        }
        public TimeSpan? LastSetTtl
        {
            get; private set;
        }
        public string LastStoredJson { get; private set; } = string.Empty;

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            LastSetPolicyId = policyId;
            LastSetTtl = l2TtlOverride;
            LastStoredJson = System.Text.Encoding.UTF8.GetString(value);
            _values[BuildKey(policyId, identity)] = value;
            return Task.CompletedTask;
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            string key = BuildKey(policyId, identity);
            if (!_values.Remove(key, out byte[]? value))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = decoder(value);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, decoded)
                : new CacheReadResult<T>(false, default));
        }

        public Task<CacheReadResult<T>> ExchangeOnceAndGetAsync<T>(
            CachePolicyId sourcePolicyId,
            string sourceIdentity,
            CachePolicyId targetPolicyId,
            string targetIdentity,
            byte[] targetValue,
            TimeSpan targetTtl,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> sourceDecoder,
            CancellationToken cancellationToken = default)
        {
            string sourceKey = BuildKey(sourcePolicyId, sourceIdentity);
            if (!_values.Remove(sourceKey, out byte[]? sourceValue))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = sourceDecoder(sourceValue);
            if (!success)
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            _values[BuildKey(targetPolicyId, targetIdentity)] = targetValue;
            return Task.FromResult(new CacheReadResult<T>(true, decoded));
        }

        public bool Contains(CachePolicyId policyId, string identity)
            => _values.ContainsKey(BuildKey(policyId, identity));

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}";

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(_values.TryGetValue(BuildKey(policyId, identity), out byte[]? value)
                ? new CacheReadResult<byte[]>(true, value)
                : new CacheReadResult<byte[]>(false, default));
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public string? Status
        {
            get; init;
        }

        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Dictionary<string, string?> Statuses { get; } = new(StringComparer.Ordinal);

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
        {
            Attempts.Add(request);
            return Task.FromResult(new SecurityChallengeAttempt
            {
                ChallengeId = request.ChallengeId,
                Outcome = request.Outcome,
                Reason = request.Reason,
                PayloadHash = request.PayloadHash,
                ClientIpHash = request.ClientIpHash,
                DeviceFpHash = request.DeviceFpHash,
                TraceId = request.TraceId,
                Traceparent = request.Traceparent,
                AttemptedAtUtc = request.AttemptedAtUtc ?? DateTime.UtcNow
            });
        }

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task<string?> GetStatusAsync(string challengeId, CancellationToken cancellationToken = default)
            => Task.FromResult(Statuses.GetValueOrDefault(challengeId, Status));
    }

    private sealed class StubEnvelopeStateService : ISecurityChallengeEnvelopeStateService
    {
        public SecurityChallengeEnvelopeState? State
        {
            get; set;
        }

        public Task<SecurityChallengeEnvelopeState?> GetAsync(string envelopeId, CancellationToken cancellationToken = default)
            => Task.FromResult(State is not null && string.Equals(State.EnvelopeId, envelopeId, StringComparison.Ordinal) ? State : null);

        public Task<bool> CreateAsync(SecurityChallengeEnvelopeState state, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<SecurityChallengeEnvelopeMemberResult> ValidateMemberAsync(SecurityChallengeEnvelopeMemberRequest request, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<SecurityChallengeEnvelopeMemberResult> ReserveMemberAsync(SecurityChallengeEnvelopeMemberRequest request, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<SecurityChallengeEnvelopeMemberResult> CompleteMemberAsync(SecurityChallengeEnvelopeMemberRequest request, SecurityChallengeProofPreparation? proofPreparation = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<SecurityChallengeEnvelopeMemberResult> CompleteIssuanceAsync(SecurityChallengeEnvelopeMemberRequest request, int memberIndex, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<SecurityChallengeEnvelopeMemberResult> CompleteProofAsync(SecurityChallengeEnvelopeMemberRequest request, string proofToken, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> FailAsync(SecurityChallengeEnvelopeMemberRequest request, string reason, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> RevokeAsync(SecurityChallengeEnvelopeBindingRequest request, string reason, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }
}
