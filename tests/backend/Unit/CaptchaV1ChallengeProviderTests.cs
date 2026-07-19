using System.Collections.Concurrent;
using System.Net;
using System.Reflection;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CaptchaV1ChallengeProviderTests
{
    private static readonly DateTimeOffset s_baselineNow = DateTimeOffset.Parse("2026-06-18T12:00:00Z");
    private const string SigningKey = "captcha-unit-test-signing-key-with-enough-entropy";
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void RuntimeServices_RegisterCaptchaV1Provider()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(CreateConfiguration());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeProvider)
                && item.ImplementationType == typeof(CaptchaV1ChallengeProvider));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
    }

    [Fact]
    public void CreateSolution_ReusesMiningBufferAndCapsPowAttempts()
    {
        Type codec = typeof(CaptchaV1ChallengeCodec);
        int maxAttempts = (int)codec.GetField(
            "MaxPowNonceAttempts",
            BindingFlags.Static | BindingFlags.NonPublic)!.GetRawConstantValue()!;
        Assert.Equal(4096, maxAttempts);
        Assert.NotEqual(4_000_000, maxAttempts);

        MethodInfo createSolution = codec.GetMethod(
            nameof(CaptchaV1ChallengeCodec.CreateSolution),
            BindingFlags.Public | BindingFlags.Static,
            binder: null,
            types: [typeof(CaptchaV1ChallengeVerifyPayload)],
            modifiers: null)!;
        IReadOnlyList<string> opCodes = RuntimeMetadataInspection.DescribeOpCodes(createSolution);
        Assert.Contains("localloc", opCodes);
        Assert.Equal(1, opCodes.Count(static opCode => opCode == "newarr"));
        Assert.Contains(maxAttempts, RuntimeMetadataInspection.DescribeInt32Constants(createSolution));

        IReadOnlyList<string> references = RuntimeMetadataInspection
            .DescribeDeclaredMemberReferencesInOrderContaining(
                codec,
                "SHA256.HashData",
                "LeadingZeroBits");
        Assert.Contains(
            references,
            static reference => reference.Contains("SHA256.HashData", StringComparison.Ordinal) &&
                                reference.Contains("Span", StringComparison.Ordinal));
    }

    [Fact]
    public async Task IssueAsync_ReturnsAssignmentWithSignedCaptchaPayloadAndPersistsAuditMetadata()
    {
        ProviderFixture fixture = CreateFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(SecurityChallengeKind.CaptchaV1, result.Assignment.Kind);
        Assert.Equal("comment.create", result.Assignment.Action);
        Assert.Equal("article:42", result.Assignment.RouteKey);
        Assert.True(SecurityChallengeContracts.ValidateAssignment(result.Assignment).IsValid);
        Assert.Equal(CaptchaV1ChallengeProvider.Algorithm, result.ProviderPayload["algorithm"]);
        Assert.Matches("^[0-9a-f]{64}$", result.ProviderPayload["polynomialSeedHex"]);
        Assert.Matches("^[0-9a-f]{64}$", result.ProviderPayload["noiseSeedHex"]);
        Assert.Matches("^[0-9a-f]{64}$", result.ProviderPayload["signatureHex"]);
        Assert.DoesNotContain("+", result.ProviderPayload["seedPayloadBase64"], StringComparison.Ordinal);
        Assert.DoesNotContain("/", result.ProviderPayload["seedPayloadBase64"], StringComparison.Ordinal);
        Assert.DoesNotContain("=", result.ProviderPayload["seedPayloadBase64"], StringComparison.Ordinal);
        Assert.Contains("v=1", Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(result.ProviderPayload["seedPayloadBase64"])), StringComparison.Ordinal);
        Assert.False(result.ProviderPayload.ContainsKey("png"));
        Assert.False(result.ProviderPayload.ContainsKey("image"));
        Assert.False(result.ProviderPayload.ContainsKey("pixels"));
        Assert.Equal("64", result.ProviderPayload["gridWidth"]);
        Assert.Equal("24", result.ProviderPayload["gridHeight"]);

        SecurityChallengeIssueRequest issued = Assert.Single(fixture.Persistence.Issues);
        Assert.Equal(result.Assignment.ChallengeId, issued.ChallengeId);
        Assert.Equal(CaptchaV1ChallengeProvider.WireKind, issued.Kind);
        Assert.Equal(CaptchaV1ChallengeProvider.Algorithm, issued.Algorithm);
        Assert.Equal("risk-policy-v2", issued.PolicyVersion);
        Assert.NotEqual(result.ProviderPayload["seedPayloadBase64"], issued.PayloadHash);
        Assert.Matches("^[0-9a-f]{64}$", issued.PayloadHash);
        Assert.True(fixture.Cache.HasIdentity(CachePolicyId.SecurityCaptchaChallenge, result.Assignment.ChallengeId));
    }

    [Fact]
    public async Task VerifyAsync_AcceptsAnswerTokenNonceAndConsumesChallengeOnce()
    {
        ProviderFixture fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        Dictionary<string, string> payload = CreateValidVerifyPayload(issued.ProviderPayload, solveDurationMs: 2500);

        SecurityChallengeProviderVerifyResult accepted = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);
        SecurityChallengeProviderVerifyResult replay = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment.ChallengeId, payload),
            CancellationToken.None);

        Assert.True(accepted.Succeeded, accepted.Reason);
        Assert.False(replay.Succeeded);
        Assert.Equal("captcha_replayed", replay.Reason);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, fixture.Persistence.Attempts[0].Outcome);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Replayed, fixture.Persistence.Attempts[1].Outcome);
        Assert.Equal("CaptchaReplay", Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    [Fact]
    public async Task VerifyAsync_AcceptsSeedPayloadAfterUrlQueryRoundTrip()
    {
        ProviderFixture fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        Dictionary<string, string> payload = CreateValidVerifyPayload(issued.ProviderPayload, solveDurationMs: 2500);
        payload["seedPayloadBase64"] = Uri.UnescapeDataString(Uri.EscapeDataString(payload["seedPayloadBase64"]));

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
    }

    [Fact]
    public async Task VerifyAsync_RejectsStandardBase64SeedPayloadCompatibilityFormat()
    {
        ProviderFixture fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        Dictionary<string, string> payload = CreateValidVerifyPayload(issued.ProviderPayload, solveDurationMs: 2500);
        string standardSeedPayload = Convert.ToBase64String(WebEncoders.Base64UrlDecode(payload["seedPayloadBase64"]));
        payload["seedPayloadBase64"] = standardSeedPayload;
        payload["signatureHex"] = CaptchaV1ChallengeCodec.SignSeedPayload(
            standardSeedPayload,
            Encoding.UTF8.GetBytes(SigningKey));

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("captcha_signature_invalid", result.Reason);
    }

    [Fact]
    public async Task VerifyAsync_RejectsExpiredChallenge()
    {
        ProviderFixture fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        Dictionary<string, string> payload = CreateValidVerifyPayload(issued.ProviderPayload, solveDurationMs: 2500);
        fixture.Clock.Advance(TimeSpan.FromMinutes(6));

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("captcha_expired", result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Expired, attempt.Outcome);
        Assert.Equal("CaptchaInvalid", Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    [Fact]
    public async Task VerifyAsync_RejectsWrongAnswer()
    {
        ProviderFixture fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        Dictionary<string, string> payload = CreateValidVerifyPayload(issued.ProviderPayload, solveDurationMs: 2500);
        payload["answerText"] = "WRNG";

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("captcha_answer_invalid", result.Reason);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempt.Outcome);
        Assert.Equal("CaptchaInvalid", Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    [Theory]
    [InlineData("polynomialSeedHex", "captcha_signature_invalid")]
    [InlineData("signatureHex", "captcha_signature_invalid")]
    [InlineData("responseTokenHex", "captcha_token_invalid")]
    public async Task VerifyAsync_RejectsTamperedSeedSignatureOrToken(string key, string expectedReason)
    {
        ProviderFixture fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        Dictionary<string, string> payload = CreateValidVerifyPayload(issued.ProviderPayload, solveDurationMs: 2500);
        payload[key] = key.EndsWith("Hex", StringComparison.Ordinal)
            ? new string(payload[key][0] == '0' ? '1' : '0', payload[key].Length)
            : "tampered";

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(expectedReason, result.Reason);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, Assert.Single(fixture.Persistence.Attempts).Outcome);
        Assert.Equal("CaptchaInvalid", Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    [Fact]
    public async Task VerifyAsync_RejectsTooFastSolveDuration()
    {
        ProviderFixture fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        Dictionary<string, string> payload = CreateValidVerifyPayload(issued.ProviderPayload, solveDurationMs: 100);

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("captcha_solve_too_fast", result.Reason);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, Assert.Single(fixture.Persistence.Attempts).Outcome);
        Assert.Equal("CaptchaSolveTooFast", Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    [Fact]
    public async Task VerifyAsync_RejectsTooSlowSolveDuration()
    {
        ProviderFixture fixture = CreateFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);
        Dictionary<string, string> payload = CreateValidVerifyPayload(issued.ProviderPayload, solveDurationMs: 60_001);

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("captcha_solve_too_slow", result.Reason);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, Assert.Single(fixture.Persistence.Attempts).Outcome);
        Assert.Equal("CaptchaSolveTooSlow", Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    private static ProviderFixture CreateFixture()
    {
        var cache = new RecordingOneShotCache();
        var persistence = new RecordingChallengePersistence();
        var riskSink = new CapturingRiskSink();
        var clock = new MutableTimeProvider(s_baselineNow);
        var provider = new CaptchaV1ChallengeProvider(cache, cache, persistence, riskSink, CreateConfiguration(), clock);
        return new ProviderFixture(provider, cache, persistence, riskSink, clock);
    }

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SecretKey"] = TestSecrets.SecondaryJwtSigningKey,
                ["Security:CaptchaV1:SigningKey"] = SigningKey
            })
            .Build();

    private static SecurityChallengeProviderIssueRequest CreateIssueRequest()
        => new(
            CreateContext(),
            CaptchaV1ChallengeProvider.WireKind,
            "comment.create",
            "article:42",
            "tenant-main",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            2,
            Traceparent);

    private static SecurityChallengeProviderVerifyRequest CreateVerifyRequest(string challengeId, IReadOnlyDictionary<string, string> payload)
        => new(
            CreateContext(),
            CaptchaV1ChallengeProvider.WireKind,
            challengeId,
            "comment.create",
            "article:42",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            payload);

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.TraceIdentifier = "trace-unit";
        context.Request.Headers["traceparent"] = Traceparent;
        return context;
    }

    private static Dictionary<string, string> CreateValidVerifyPayload(
        IReadOnlyDictionary<string, string> issuePayload,
        int solveDurationMs)
    {
        Dictionary<string, string> payload = new(issuePayload, StringComparer.Ordinal);
        CaptchaV1ChallengeSolution solution = CaptchaV1ChallengeCodec.CreateSolution(issuePayload);
        payload["answerText"] = solution.AnswerText;
        payload["responseTokenHex"] = solution.ResponseTokenHex;
        payload["nonceHex"] = solution.NonceHex;
        payload["solveDurationMs"] = solveDurationMs.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return payload;
    }

    private sealed record ProviderFixture(
        CaptchaV1ChallengeProvider Provider,
        RecordingOneShotCache Cache,
        RecordingChallengePersistence Persistence,
        CapturingRiskSink RiskSink,
        MutableTimeProvider Clock);

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan value) => _utcNow = _utcNow.Add(value);
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

    private sealed class RecordingOneShotCache : IUnifiedCache
    {
        private readonly ConcurrentDictionary<string, string> _strings = new(StringComparer.Ordinal);

        public bool HasIdentity(CachePolicyId policyId, string identity)
            => _strings.ContainsKey($"{policyId}:{identity}");

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            _strings[$"{policyId}:{identity}"] = value;
            return Task.CompletedTask;
        }

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(_strings.TryRemove($"{policyId}:{identity}", out _));

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(_strings.TryGetValue($"{policyId}:{identity}", out string? value) ? value : null);

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(false);

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

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => Task.FromResult(0L);

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => Task.FromResult(default(CacheReadResult<T>));

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

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
