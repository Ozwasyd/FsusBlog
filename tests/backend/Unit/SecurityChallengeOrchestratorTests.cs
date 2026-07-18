using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeOrchestratorTests
{
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void RuntimeServices_RegisterSecurityChallengeOrchestrator()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeOrchestrator));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(SecurityChallengeOrchestrator), descriptor.ImplementationType);
    }

    [Fact]
    public async Task IssueAsync_MissingProvider_FailsClosedAndWritesRisk()
    {
        var riskSink = new CapturingRiskSink();
        var orchestrator = new SecurityChallengeOrchestrator([], new MintingProofService(), riskSink);
        SecurityChallengeOrchestrationIssueRequest request = CreateIssueRequest(["sha256PowV1"]);

        SecurityChallengeOrchestrationIssueResult result = await orchestrator.IssueAsync(request, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("provider_missing", result.Reason);
        Assert.Null(result.Envelope);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal(SecurityRiskReason.SecurityChallengeRejected, signal.Reason);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal("provider_missing:sha256PowV1", signal.Detail);
    }

    [Fact]
    public async Task IssueAsync_ProviderFailure_FailsClosedAndWritesRisk()
    {
        var provider = new FakeChallengeProvider("sha256PowV1")
        {
            IssueResult = SecurityChallengeProviderIssueResult.Failed("provider_unavailable")
        };
        var riskSink = new CapturingRiskSink();
        var orchestrator = new SecurityChallengeOrchestrator([provider], new MintingProofService(), riskSink);
        SecurityChallengeOrchestrationIssueRequest request = CreateIssueRequest(["sha256PowV1"]);

        SecurityChallengeOrchestrationIssueResult result = await orchestrator.IssueAsync(request, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("provider_unavailable", result.Reason);
        Assert.Null(result.Envelope);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal("provider_failure:sha256PowV1:provider_unavailable", signal.Detail);
    }

    [Fact]
    public async Task IssueAsync_MultipleChallenges_ReturnsEnvelopeAssignments()
    {
        var pow = new FakeChallengeProvider("sha256PowV1");
        var captcha = new FakeChallengeProvider("captchaV1");
        var orchestrator = new SecurityChallengeOrchestrator([pow, captcha], new MintingProofService(), new CapturingRiskSink());
        SecurityChallengeOrchestrationIssueRequest request = CreateIssueRequest(["sha256PowV1", "captchaV1"]);

        SecurityChallengeOrchestrationIssueResult result = await orchestrator.IssueAsync(request, CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Envelope);
        Assert.Equal("risk-policy-v2", result.Envelope.PolicyVersion);
        Assert.Equal(2, result.Envelope.Assignments.Count);
        Assert.Equal(SecurityChallengeKind.Sha256PowV1, result.Envelope.Assignments[0].Kind);
        Assert.Equal(SecurityChallengeKind.CaptchaV1, result.Envelope.Assignments[1].Kind);
        Assert.All(result.Envelope.Assignments, assignment =>
        {
            Assert.Equal("public.read", assignment.Action);
            Assert.Equal("/article/42", assignment.RouteKey);
            Assert.Equal(HashA, assignment.SubjectHash);
            Assert.Equal(HashB, assignment.ClientIpHash);
            Assert.Equal(HashC, assignment.DeviceFpHash);
            Assert.True(SecurityChallengeContracts.ValidateAssignment(assignment).IsValid);
        });
    }

    [Fact]
    public async Task VerifyAsync_ProviderSuccess_MintsProofToken()
    {
        var provider = new FakeChallengeProvider("sha256PowV1")
        {
            VerifyResult = SecurityChallengeProviderVerifyResult.Success(DateTimeOffset.UtcNow.AddMinutes(5))
        };
        var proof = new MintingProofService();
        var orchestrator = new SecurityChallengeOrchestrator([provider], proof, new CapturingRiskSink());
        SecurityChallengeOrchestrationVerifyRequest request = CreateVerifyRequest("sha256PowV1");

        SecurityChallengeOrchestrationVerifyResult result = await orchestrator.VerifyAsync(request, CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal("challenge-proof-token", result.ProofToken);
        Assert.NotNull(proof.LastMintRequest);
        Assert.Equal(request.ChallengeId, proof.LastMintRequest.ChallengeId);
        Assert.Equal(request.Kind, proof.LastMintRequest.Kind);
        Assert.Equal(request.Action, proof.LastMintRequest.Action);
        Assert.Equal(request.RouteKey, proof.LastMintRequest.RouteKey);
        Assert.Equal(request.SubjectHash, proof.LastMintRequest.SubjectHash);
        Assert.Equal(request.ClientIpHash, proof.LastMintRequest.ClientIpHash);
        Assert.Equal(request.DeviceFpHash, proof.LastMintRequest.DeviceFpHash);
        Assert.Equal(request.PolicyVersion, proof.LastMintRequest.PolicyVersion);
    }

    [Fact]
    public async Task VerifyAsync_ProofMintFailure_FailsClosedAndWritesRisk()
    {
        var provider = new FakeChallengeProvider("sha256PowV1")
        {
            VerifyResult = SecurityChallengeProviderVerifyResult.Success(DateTimeOffset.UtcNow.AddMinutes(5))
        };
        var proof = new MintingProofService { ThrowOnMint = true };
        var riskSink = new CapturingRiskSink();
        var orchestrator = new SecurityChallengeOrchestrator([provider], proof, riskSink);

        SecurityChallengeOrchestrationVerifyResult result = await orchestrator.VerifyAsync(
            CreateVerifyRequest("sha256PowV1"),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("proof_mint_failed", result.Reason);
        Assert.Null(result.ProofToken);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal("proof_mint_failed:sha256PowV1", signal.Detail);
    }

    private static SecurityChallengeOrchestrationIssueRequest CreateIssueRequest(IReadOnlyList<string> challenges)
        => new(
            new DefaultHttpContext(),
            new RiskDecision(
                RiskDecisionKind.Challenge,
                "public.read",
                "/article/42",
                50,
                50,
                1,
                challenges,
                "risk-policy-v2",
                ["challenge"]),
            "tenant-main",
            HashA,
            HashB,
            HashC,
            Traceparent);

    private static SecurityChallengeOrchestrationVerifyRequest CreateVerifyRequest(string kind)
        => new(
            new DefaultHttpContext(),
            kind,
            SecurityChallengeContracts.CreateChallengeId(),
            "public.read",
            "/article/42",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["solution"] = "ok"
            });

    private sealed class FakeChallengeProvider(string kind) : ISecurityChallengeProvider
    {
        public string Kind { get; } = kind;

        public SecurityChallengeProviderIssueResult? IssueResult
        {
            get; init;
        }

        public SecurityChallengeProviderVerifyResult VerifyResult { get; init; } = SecurityChallengeProviderVerifyResult.Success(DateTimeOffset.UtcNow.AddMinutes(5));

        public Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
        {
            if (IssueResult is { } result)
            {
                return Task.FromResult(result);
            }

            SecurityChallengeContracts.TryParseKind(Kind, out SecurityChallengeKind parsed);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var assignment = new SecurityChallengeAssignment(
                SecurityChallengeContracts.CreateChallengeId(),
                request.Traceparent,
                request.TenantId,
                parsed,
                request.EscalationLevel,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                now,
                now + 300_000);
            return Task.FromResult(SecurityChallengeProviderIssueResult.Success(assignment));
        }

        public Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default)
            => Task.FromResult(VerifyResult);
    }

    private sealed class MintingProofService : ISecurityChallengeProofService
    {
        public bool ThrowOnMint
        {
            get; init;
        }

        public SecurityChallengeProofMintRequest? LastMintRequest
        {
            get; private set;
        }

        public Task<SecurityChallengeProofMintResult> MintProofAsync(SecurityChallengeProofMintRequest request, CancellationToken cancellationToken = default)
        {
            LastMintRequest = request;
            if (ThrowOnMint)
            {
                throw new InvalidOperationException("mint failed");
            }

            var claims = new SecurityChallengeProofClaims(
                request.ChallengeId,
                request.Kind,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.IssuedAt,
                request.ExpiresAt,
                "nonce",
                request.PolicyVersion);
            return Task.FromResult(new SecurityChallengeProofMintResult("challenge-proof-token", claims));
        }

        public Task<SecurityChallengeProofConsumeResult> ConsumeProofAsync(SecurityChallengeProofConsumeRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
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
}
