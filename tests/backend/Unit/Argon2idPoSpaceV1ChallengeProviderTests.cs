using System.Collections.Concurrent;
using System.Net;
using System.Text.Json.Nodes;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using FsusBlog.Shared.Contracts.Governance;
namespace FsusBlog.Server.Tests.Unit;

public sealed class Argon2idPoSpaceV1ChallengeProviderTests
{
    private const string ClientIp = "203.0.113.47";
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void RuntimeServices_RegisterArgon2idPoSpaceProvider()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeProvider)
                && item.ImplementationType == typeof(Argon2idPoSpaceV1ChallengeProvider));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Contains(services, static item => item.ServiceType == typeof(IPoSpaceUnsupportedAssignmentStore)
            && item.ImplementationType == typeof(SqlPoSpaceUnsupportedAssignmentStore)
            && item.Lifetime == ServiceLifetime.Scoped);
        Assert.Contains(services, static item => item.ServiceType == typeof(IPoSpaceUnsupportedReissueService)
            && item.ImplementationType == typeof(PoSpaceUnsupportedReissueService)
            && item.Lifetime == ServiceLifetime.Scoped);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_DisabledMode_FailsClosedWithoutPersisting()
    {
        ProviderFixture fixture = CreateFixture(mode: SecuritySystemModes.Disabled);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("pospace_disabled", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
        Assert.Empty(fixture.Cache.Strings);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_EnabledMode_ReturnsAssignmentPayloadAndPersistsAuditMetadata()
    {
        ProviderFixture fixture = CreateFixture(mode: SecuritySystemModes.Enforce);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(SecurityChallengeKind.Argon2IdPoSpaceV1, result.Assignment.Kind);
        Assert.True(SecurityChallengeContracts.ValidateAssignment(result.Assignment).IsValid);
        Assert.Equal(
            ["algorithm", "iterations", "lanes", "memoryKib", "saltHex", "targetDurationMs"],
            result.ProviderPayload.Keys.Order(StringComparer.Ordinal));
        Assert.Equal("19456", result.ProviderPayload["memoryKib"]);
        Assert.Equal("2", result.ProviderPayload["iterations"]);
        Assert.Equal("1", result.ProviderPayload["lanes"]);
        Assert.Equal("100", result.ProviderPayload["targetDurationMs"]);
        SecurityChallengeIssueRequest issued = Assert.Single(fixture.Persistence.Issues);
        Assert.Equal(result.Assignment.ChallengeId, issued.ChallengeId);
        Assert.Equal(Argon2idPoSpaceV1ChallengeProvider.WireKind, issued.Kind);
        Assert.Equal(Argon2idPoSpaceV1ChallengeProvider.Algorithm, issued.Algorithm);
        Assert.NotEqual(result.ProviderPayload["saltHex"], issued.PayloadHash);
        Assert.Matches("^[0-9a-f]{64}$", issued.PayloadHash);
        Assert.True(fixture.Cache.Strings.ContainsKey($"{CachePolicyId.SecurityPoSpaceChallenge}:{issued.ChallengeId}"));
    }

    [Theory]
    [InlineData(19_455, 2, 1, 100)]
    [InlineData(65_537, 2, 1, 100)]
    [InlineData(19_456, 1, 1, 100)]
    [InlineData(19_456, 7, 1, 100)]
    [InlineData(19_456, 2, 0, 100)]
    [InlineData(19_456, 2, 5, 100)]
    [InlineData(19_456, 2, 1, 99)]
    [InlineData(19_456, 2, 1, 5_001)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_RejectsParameterBounds(int memoryKib, int iterations, int lanes, int targetDurationMs)
    {
        ProviderFixture fixture = CreateFixture(
            mode: SecuritySystemModes.Enforce,
            memoryKib: memoryKib,
            iterations: iterations,
            lanes: lanes,
            targetDurationMs: targetDurationMs);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("pospace_parameters_invalid", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_AcceptsExactMaximumParameters()
    {
        ProviderFixture fixture = CreateFixture(
            SecuritySystemModes.Enforce,
            memoryKib: 65_536,
            iterations: 6,
            lanes: 4,
            targetDurationMs: 5_000);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal("65536", result.ProviderPayload["memoryKib"]);
        Assert.Equal("6", result.ProviderPayload["iterations"]);
        Assert.Equal("4", result.ProviderPayload["lanes"]);
        Assert.Equal("5000", result.ProviderPayload["targetDurationMs"]);
    }

    [Theory]
    [InlineData("MemoryKib", "019456")]
    [InlineData("MemoryKib", "+19456")]
    [InlineData("Iterations", "2.0")]
    [InlineData("Lanes", " 1")]
    [InlineData("TargetDurationMs", "NaN")]
    [InlineData("TargetDurationMs", "2147483648")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_RejectsNonCanonicalConfiguredDecimals(string key, string value)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:PoSpaceV1:Mode"] = SecuritySystemModes.Enforce,
                [$"Security:PoSpaceV1:{key}"] = value
            })
            .Build();
        ProviderFixture fixture = CreateFixture(configuration);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("pospace_parameters_invalid", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_MissingParameters_UsesLegalGeneratedDefaults()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:PoSpaceV1:Mode"] = SecuritySystemModes.Enforce
            })
            .Build();
        ProviderFixture fixture = CreateFixture(configuration);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal("19456", result.ProviderPayload["memoryKib"]);
        Assert.Equal("2", result.ProviderPayload["iterations"]);
        Assert.Equal("1", result.ProviderPayload["lanes"]);
        Assert.Equal("750", result.ProviderPayload["targetDurationMs"]);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_MobileUserAgentAboveMobileMemoryLimit_FailsClosed()
    {
        ProviderFixture fixture = CreateFixture(mode: SecuritySystemModes.Enforce, memoryKib: 19_456);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(CreateContext("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("pospace_mobile_unsupported", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_AcceptsArgon2idProofAndRejectsReplay()
    {
        ProviderFixture fixture = CreateFixture(mode: SecuritySystemModes.Enforce);
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        string nonceHex = "00112233445566778899aabbccddeeff";
        string proofHex = await Argon2idPoSpaceV1ChallengeProvider.ComputeProofHexAsync(
            CreateProofRequest(issued.Assignment!.ChallengeId, issued.ProviderPayload, nonceHex, proofHex: string.Empty),
            nonceHex,
            CancellationToken.None);

        SecurityChallengeProviderVerifyResult accepted = await fixture.Provider.VerifyAsync(
            CreateProofRequest(issued.Assignment.ChallengeId, issued.ProviderPayload, nonceHex, proofHex),
            CancellationToken.None);
        SecurityChallengeProviderVerifyResult replay = await fixture.Provider.VerifyAsync(
            CreateProofRequest(issued.Assignment.ChallengeId, issued.ProviderPayload, nonceHex, proofHex),
            CancellationToken.None);

        Assert.True(accepted.Succeeded, accepted.Reason);
        Assert.False(replay.Succeeded);
        Assert.Equal("pospace_replayed", replay.Reason);
        Assert.Equal(2, fixture.Persistence.Attempts.Count);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, fixture.Persistence.Attempts[0].Outcome);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Replayed, fixture.Persistence.Attempts[1].Outcome);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task FixedVector_FrontendProofIsAcceptedAndReplayFailsClosed()
    {
        JsonObject vector = BackendTestPaths.ReadJsonFromRoot("tests", "fixtures", "security", "pospace-v1-vector.json");
        JsonObject assignment = vector["assignment"]!.AsObject();
        JsonObject providerPayload = vector["providerPayload"]!.AsObject();
        JsonObject verifyPayload = vector["verifyPayload"]!.AsObject();
        string AssignmentValue(string name) => assignment[name]!.GetValue<string>();
        var payload = providerPayload.ToDictionary(
            static item => item.Key,
            static item => item.Value!.GetValue<string>(),
            StringComparer.Ordinal);
        var request = new SecurityChallengeProviderVerifyRequest(
            CreateContext(),
            Argon2idPoSpaceV1ChallengeProvider.WireKind,
            AssignmentValue("challengeId"),
            AssignmentValue("action"),
            AssignmentValue("routeKey"),
            AssignmentValue("subjectHash"),
            AssignmentValue("clientIpHash"),
            AssignmentValue("deviceFpHash"),
            AssignmentValue("policyVersion"),
            payload);

        string proofHex = await Argon2idPoSpaceV1ChallengeProvider.ComputeProofHexAsync(
            request,
            vector["nonceHex"]!.GetValue<string>(),
            CancellationToken.None);

        Assert.Equal(vector["expectedProofHex"]!.GetValue<string>(), proofHex);
        ProviderFixture fixture = CreateFixture(SecuritySystemModes.Enforce);
        fixture.Cache.Strings.TryAdd($"{CachePolicyId.SecurityPoSpaceChallenge}:{request.ChallengeId}", "vector");
        SecurityChallengeProviderVerifyRequest verifyRequest = request with
        {
            ProviderPayload = verifyPayload.ToDictionary(
                static item => item.Key,
                static item => item.Value!.GetValue<string>(),
                StringComparer.Ordinal)
        };
        SecurityChallengeProviderVerifyResult accepted = await fixture.Provider.VerifyAsync(verifyRequest, CancellationToken.None);
        SecurityChallengeProviderVerifyResult replay = await fixture.Provider.VerifyAsync(verifyRequest, CancellationToken.None);
        Assert.True(accepted.Succeeded, accepted.Reason);
        Assert.Equal("pospace_replayed", replay.Reason);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_RejectsTamperedProof()
    {
        ProviderFixture fixture = CreateFixture(mode: SecuritySystemModes.Enforce);
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        string nonceHex = "00112233445566778899aabbccddeeff";

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateProofRequest(issued.Assignment!.ChallengeId, issued.ProviderPayload, nonceHex, new string('f', 64)),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("pospace_proof_invalid", result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempt.Outcome);
        Assert.Equal("pospace_proof_invalid", attempt.Reason);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal(SecurityRiskReason.SecurityChallengeRejected, signal.Reason);
        Assert.Equal("PoSpaceInvalid", signal.Detail);
    }

    private static ProviderFixture CreateFixture(
        string mode,
        int memoryKib = 19_456,
        int iterations = 2,
        int lanes = 1,
        int targetDurationMs = 100)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:PoSpaceV1:Mode"] = mode,
                ["Security:PoSpaceV1:MemoryKib"] = memoryKib.ToString(),
                ["Security:PoSpaceV1:Iterations"] = iterations.ToString(),
                ["Security:PoSpaceV1:Lanes"] = lanes.ToString(),
                ["Security:PoSpaceV1:TargetDurationMs"] = targetDurationMs.ToString()
            })
            .Build();
        return CreateFixture(configuration);
    }

    private static ProviderFixture CreateFixture(IConfiguration configuration)
    {
        var cache = new RecordingCache();
        var persistence = new RecordingChallengePersistence();
        var riskSink = new CapturingRiskSink();
        var provider = new Argon2idPoSpaceV1ChallengeProvider(cache, cache, persistence, riskSink, configuration, TimeProvider.System);
        return new ProviderFixture(provider, cache, persistence, riskSink);
    }

    private static SecurityChallengeProviderIssueRequest CreateIssueRequest(DefaultHttpContext? context = null)
        => new(
            context ?? CreateContext(),
            Argon2idPoSpaceV1ChallengeProvider.WireKind,
            "public.read",
            "/article/42",
            "tenant-main",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            2,
            Traceparent);

    private static SecurityChallengeProviderVerifyRequest CreateProofRequest(
        string challengeId,
        IReadOnlyDictionary<string, string> issuePayload,
        string nonceHex,
        string proofHex)
    {
        var payload = new Dictionary<string, string>(issuePayload, StringComparer.Ordinal)
        {
            ["nonceHex"] = nonceHex,
            ["proofHex"] = proofHex
        };
        return new SecurityChallengeProviderVerifyRequest(
            CreateContext(),
            Argon2idPoSpaceV1ChallengeProvider.WireKind,
            challengeId,
            "public.read",
            "/article/42",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            payload);
    }

    private static DefaultHttpContext CreateContext(string userAgent = "Mozilla/5.0 (X11; Linux x86_64)")
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(ClientIp);
        context.TraceIdentifier = "trace-unit";
        context.Request.Headers.UserAgent = userAgent;
        context.Request.Headers["traceparent"] = Traceparent;
        return context;
    }

    private sealed record ProviderFixture(
        Argon2idPoSpaceV1ChallengeProvider Provider,
        RecordingCache Cache,
        RecordingChallengePersistence Persistence,
        CapturingRiskSink RiskSink);

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public List<SecurityChallengeIssueRequest> Issues { get; } = [];

        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
        {
            Issues.Add(request);
            return Task.FromResult(new SecurityChallenge
            {
                ChallengeId = request.ChallengeId,
                Status = SecurityChallengeStatuses.Issued,
                Kind = request.Kind,
                Algorithm = request.Algorithm,
                Action = request.Action,
                RouteKey = request.RouteKey,
                SubjectHash = request.SubjectHash,
                ClientIpHash = request.ClientIpHash,
                DeviceFpHash = request.DeviceFpHash,
                PolicyVersion = request.PolicyVersion,
                PayloadHash = request.PayloadHash,
                TraceId = request.TraceId,
                Traceparent = request.Traceparent,
                IssuedAtUtc = request.IssuedAtUtc,
                ExpiresAtUtc = request.ExpiresAtUtc
            });
        }

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
        {
            Attempts.Add(request);
            return Task.FromResult(new SecurityChallengeAttempt
            {
                AttemptId = SecurityChallengeContracts.CreateChallengeId(),
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

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(false);
    }

    private sealed class CapturingRiskSink : ISecurityRiskSignalSink
    {
        public List<SecurityRiskSignal> Signals { get; } = [];

        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
        {
            Signals.Add(signal);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class RecordingCache : IUnifiedCache
    {
        public ConcurrentDictionary<string, string> Strings { get; } = new(StringComparer.Ordinal);

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(Strings.TryAdd($"{policyId}:{identity}", value));

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(Strings.TryGetValue($"{policyId}:{identity}", out string? value) ? value : null);

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<T>));

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<byte[]>));

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<ReadOnlyMemory<byte>>));

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            Strings[$"{policyId}:{identity}"] = value;
            return Task.CompletedTask;
        }

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => Task.FromResult(0L);

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(Strings.TryRemove($"{policyId}:{identity}", out _));

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<T>));

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            Strings.TryRemove($"{policyId}:{identity}", out _);
            return Task.CompletedTask;
        }

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult<IAsyncDisposable>(NullAsyncDisposable.Instance);

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}:{version}";

        private sealed class NullAsyncDisposable : IAsyncDisposable
        {
            public static readonly NullAsyncDisposable Instance = new();

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}
