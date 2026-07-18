using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed class HumanReadProofV1ChallengeProviderTests
{
    private static readonly DateTimeOffset s_baselineNow = DateTimeOffset.Parse("2026-06-18T12:00:00Z");
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void RuntimeServices_RegisterHumanReadProofV1Provider()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeProvider)
                && item.ImplementationType == typeof(HumanReadProofV1ChallengeProvider));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
    }

    [Fact]
    public async Task IssueAsync_PublicRead_ReturnsAssignmentPayloadAndPersistsAuditMetadata()
    {
        ProviderFixture fixture = CreateFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(SecurityChallengeKind.HumanReadProofV1, result.Assignment.Kind);
        Assert.Equal(RiskActionNames.PublicRead, result.Assignment.Action);
        Assert.True(SecurityChallengeContracts.ValidateAssignment(result.Assignment).IsValid);
        Assert.Equal(HumanReadProofV1ChallengeProvider.Algorithm, result.ProviderPayload["algorithm"]);
        Assert.Equal("token-1", result.ProviderPayload["token"]);
        Assert.Equal("article", result.ProviderPayload["scope"]);
        Assert.Equal("/article/42", result.ProviderPayload["routeKey"]);
        Assert.Equal("42", result.ProviderPayload["articleId"]);
        Assert.Equal("8000", result.ProviderPayload["minDwellMs"]);
        SecurityChallengeIssueRequest issued = Assert.Single(fixture.Persistence.Issues);
        Assert.Equal(result.Assignment.ChallengeId, issued.ChallengeId);
        Assert.Equal(HumanReadProofV1ChallengeProvider.WireKind, issued.Kind);
        Assert.Equal(HumanReadProofV1ChallengeProvider.Algorithm, issued.Algorithm);
        Assert.NotEqual("token-1", issued.PayloadHash);
        Assert.Matches("^[0-9a-f]{64}$", issued.PayloadHash);
    }

    [Fact]
    public async Task IssueAsync_NonPublicRead_FailsClosedWithoutChallenge()
    {
        ProviderFixture fixture = CreateFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(action: RiskActionNames.CommentCreate, routeKey: "comment.create"),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("human_read_proof_public_read_only", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
        Assert.Null(fixture.ProofService.ChallengeRequest);
    }

    [Fact]
    public async Task VerifyAsync_PublicReadAcceptedProof_ReturnsSuccessAndRecordsAttempt()
    {
        ProviderFixture fixture = CreateFixture();
        var payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["token"] = "token-1",
            ["scope"] = "article",
            ["routeKey"] = "/article/42",
            ["articleId"] = "42",
            ["dwellMs"] = "9000"
        };

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(payload),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal(new HumanReadSubmitRequest("token-1", "article", "/article/42", 42, 9000), fixture.ProofService.SubmitRequest);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, attempt.Outcome);
        Assert.Equal("counted", attempt.Reason);
    }

    [Fact]
    public async Task VerifyAsync_NonPublicRead_FailsClosedWithoutConsumingProof()
    {
        ProviderFixture fixture = CreateFixture();

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(
                new Dictionary<string, string>(StringComparer.Ordinal) { ["token"] = "token-1" },
                action: RiskActionNames.AuthLogin,
                routeKey: "auth.login"),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("human_read_proof_public_read_only", result.Reason);
        Assert.Empty(fixture.Persistence.Attempts);
        Assert.Null(fixture.ProofService.SubmitRequest);
    }

    private static ProviderFixture CreateFixture()
    {
        var proof = new RecordingHumanReadProofService
        {
            ChallengeResponse = new HumanReadChallengeResponse("token-1", "article", "/article/42", 42, 8000, s_baselineNow, s_baselineNow.AddMinutes(5)),
            SubmitResponse = new HumanReadSubmitResponse(true, "counted")
        };
        var persistence = new RecordingChallengePersistence();
        var provider = new HumanReadProofV1ChallengeProvider(proof, persistence, TimeProvider.System);
        return new ProviderFixture(provider, proof, persistence);
    }

    private static SecurityChallengeProviderIssueRequest CreateIssueRequest(
        string action = RiskActionNames.PublicRead,
        string routeKey = "/article/42")
        => new(
            new DefaultHttpContext(),
            HumanReadProofV1ChallengeProvider.WireKind,
            action,
            routeKey,
            "tenant-main",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            1,
            Traceparent);

    private static SecurityChallengeProviderVerifyRequest CreateVerifyRequest(
        IReadOnlyDictionary<string, string> payload,
        string action = RiskActionNames.PublicRead,
        string routeKey = "/article/42")
        => new(
            new DefaultHttpContext(),
            HumanReadProofV1ChallengeProvider.WireKind,
            SecurityChallengeContracts.CreateChallengeId(),
            action,
            routeKey,
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            payload);

    private sealed record ProviderFixture(
        HumanReadProofV1ChallengeProvider Provider,
        RecordingHumanReadProofService ProofService,
        RecordingChallengePersistence Persistence);

    private sealed class RecordingHumanReadProofService : IHumanReadProofService
    {
        public HumanReadChallengeRequest? ChallengeRequest
        {
            get; private set;
        }
        public HumanReadChallengeResponse? ChallengeResponse
        {
            get; init;
        }
        public HumanReadSubmitRequest? SubmitRequest
        {
            get; private set;
        }
        public HumanReadSubmitResponse SubmitResponse { get; init; } = new(false, "proof_invalid");

        public ValueTask<HumanReadChallengeResponse?> CreateChallengeAsync(
            HttpContext context,
            HumanReadChallengeRequest request,
            CancellationToken cancellationToken = default)
        {
            ChallengeRequest = request;
            return ValueTask.FromResult(ChallengeResponse);
        }

        public ValueTask<HumanReadSubmitResponse> SubmitAsync(
            HttpContext context,
            HumanReadSubmitRequest request,
            CancellationToken cancellationToken = default)
        {
            SubmitRequest = request;
            return ValueTask.FromResult(SubmitResponse);
        }
    }

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public List<SecurityChallengeIssueRequest> Issues { get; } = [];
        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
        {
            Issues.Add(request);
            return Task.FromResult(new SecurityChallenge { ChallengeId = request.ChallengeId, Kind = request.Kind });
        }

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
        {
            Attempts.Add(request);
            return Task.FromResult(new SecurityChallengeAttempt { ChallengeId = request.ChallengeId, Outcome = request.Outcome });
        }

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }
}
