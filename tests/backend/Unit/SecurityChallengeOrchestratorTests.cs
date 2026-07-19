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
        var orchestrator = new SecurityChallengeOrchestrator([], new MintingProofService(), riskSink, new TestSecurityChallengeEnvelopeStateService());
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
        var provider = new FakeChallengeProvider("captchaV1")
        {
            IssueResult = SecurityChallengeProviderIssueResult.Failed("provider_unavailable")
        };
        var riskSink = new CapturingRiskSink();
        var orchestrator = new SecurityChallengeOrchestrator([provider], new MintingProofService(), riskSink, new TestSecurityChallengeEnvelopeStateService());
        SecurityChallengeOrchestrationIssueRequest request = CreateIssueRequest(["captchaV1"]);

        SecurityChallengeOrchestrationIssueResult result = await orchestrator.IssueAsync(request, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("provider_unavailable", result.Reason);
        Assert.Null(result.Envelope);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal("provider_failure:captchaV1:provider_unavailable", signal.Detail);
    }

    [Fact]
    public async Task IssueAsync_MultipleChallenges_ReturnsEnvelopeAssignments()
    {
        var perception = new FakeChallengeProvider("perceptionLocalizationV2");
        var captcha = new FakeChallengeProvider("captchaV1");
        var orchestrator = new SecurityChallengeOrchestrator([perception, captcha], new MintingProofService(), new CapturingRiskSink(), new TestSecurityChallengeEnvelopeStateService());
        SecurityChallengeOrchestrationIssueRequest request = CreateIssueRequest(["perceptionLocalizationV2", "captchaV1"]);

        SecurityChallengeOrchestrationIssueResult result = await orchestrator.IssueAsync(request, CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Envelope);
        Assert.Equal("risk-policy-v2", result.Envelope.PolicyVersion);
        Assert.Equal(2, result.Envelope.Assignments.Count);
        Assert.Equal(SecurityChallengeKind.PerceptionLocalizationV2, result.Envelope.Assignments[0].Kind);
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
    public async Task VerifyAsync_MultipleChallenges_ReturnsProgressThenOneAggregateProof()
    {
        var perception = new FakeChallengeProvider("perceptionLocalizationV2");
        var captcha = new FakeChallengeProvider("captchaV1");
        var proof = new MintingProofService();
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator([perception, captcha], proof, new CapturingRiskSink(), state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "captchaV1"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        SecurityChallengeOrchestrationVerifyResult first = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 0),
            CancellationToken.None);
        SecurityChallengeOrchestrationVerifyResult second = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 1),
            CancellationToken.None);

        Assert.True(first.Succeeded, first.Reason);
        Assert.False(first.EnvelopeCompleted);
        Assert.Equal(1, first.CompletedCount);
        Assert.Equal(2, first.MemberCount);
        Assert.Null(first.ProofToken);
        Assert.True(second.Succeeded, second.Reason);
        Assert.True(second.EnvelopeCompleted);
        Assert.Equal(2, second.CompletedCount);
        Assert.Equal("challenge-proof-token", second.ProofToken);
        Assert.Equal(envelope.EnvelopeId, proof.LastMintRequest?.EnvelopeId);
        Assert.Equal(["perceptionLocalizationV2", "captchaV1"], proof.LastMintRequest?.RequiredKinds);
        Assert.Equal(envelope.Assignments[1].ChallengeId, proof.LastMintRequest?.ChallengeId);
    }

    [Fact]
    public async Task VerifyAsync_ReplayedMemberTerminatesEnvelopeAndPreventsCompletion()
    {
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator(
            [new FakeChallengeProvider("perceptionLocalizationV2"), new FakeChallengeProvider("captchaV1")],
            new MintingProofService(),
            new CapturingRiskSink(),
            state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "captchaV1"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        Assert.True((await orchestrator.VerifyAsync(CreateVerifyRequest(envelope, 0), CancellationToken.None)).Succeeded);
        SecurityChallengeOrchestrationVerifyResult replay = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 0),
            CancellationToken.None);
        SecurityChallengeOrchestrationVerifyResult final = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 1),
            CancellationToken.None);

        Assert.False(replay.Succeeded);
        Assert.Equal("challenge_member_replayed", replay.Reason);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Failed, state.Get(envelope.EnvelopeId)?.Status);
        Assert.False(final.Succeeded);
        Assert.Equal("challenge_envelope_failed", final.Reason);
        Assert.Null(final.ProofToken);
    }

    [Fact]
    public async Task VerifyAsync_LaterProviderFailureTerminatesEnvelopeWithoutAggregateProof()
    {
        var captcha = new FakeChallengeProvider("captchaV1")
        {
            VerifyResult = SecurityChallengeProviderVerifyResult.Failed("captcha_invalid")
        };
        var proof = new MintingProofService();
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator(
            [new FakeChallengeProvider("perceptionLocalizationV2"), captcha],
            proof,
            new CapturingRiskSink(),
            state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "captchaV1"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        Assert.True((await orchestrator.VerifyAsync(CreateVerifyRequest(envelope, 0), CancellationToken.None)).Succeeded);
        SecurityChallengeOrchestrationVerifyResult failed = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 1),
            CancellationToken.None);
        SecurityChallengeOrchestrationVerifyResult retry = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 1),
            CancellationToken.None);

        Assert.False(failed.Succeeded);
        Assert.Equal("captcha_invalid", failed.Reason);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Failed, state.Get(envelope.EnvelopeId)?.Status);
        Assert.False(retry.Succeeded);
        Assert.Equal("challenge_envelope_failed", retry.Reason);
        Assert.Null(proof.LastMintRequest);
    }

    [Fact]
    public async Task VerifyAsync_OutOfOrderMemberRejectsBeforeProviderExecution()
    {
        var perception = new FakeChallengeProvider("perceptionLocalizationV2");
        var captcha = new FakeChallengeProvider("captchaV1");
        var orchestrator = new SecurityChallengeOrchestrator(
            [perception, captcha],
            new MintingProofService(),
            new CapturingRiskSink(),
            new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false));
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "captchaV1"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        SecurityChallengeOrchestrationVerifyResult result = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 1),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("challenge_member_out_of_order", result.Reason);
        Assert.Equal(0, captcha.VerifyCalls);
    }

    [Fact]
    public async Task IssueAsync_ProviderOnlyPoSpace_ReachesRegisteredProvider()
    {
        var provider = new FakeChallengeProvider("argon2idPoSpaceV1");
        var riskSink = new CapturingRiskSink();
        var orchestrator = new SecurityChallengeOrchestrator([provider], new MintingProofService(), riskSink, new TestSecurityChallengeEnvelopeStateService());

        SecurityChallengeOrchestrationIssueResult result = await orchestrator.IssueAsync(
            CreateIssueRequest(["argon2idPoSpaceV1"]),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal(1, provider.IssueCalls);
        Assert.Equal(SecurityChallengeKind.Argon2IdPoSpaceV1, Assert.Single(result.Envelope!.Assignments).Kind);
        Assert.Empty(riskSink.Signals);
    }

    [Fact]
    public async Task VerifyAsync_ProviderSuccess_MintsProofToken()
    {
        var provider = new FakeChallengeProvider("sha256PowV1")
        {
            VerifyResult = SecurityChallengeProviderVerifyResult.Success(DateTimeOffset.UtcNow.AddMinutes(5))
        };
        var proof = new MintingProofService();
        var orchestrator = new SecurityChallengeOrchestrator([provider], proof, new CapturingRiskSink(), new TestSecurityChallengeEnvelopeStateService());
        SecurityChallengeOrchestrationVerifyRequest request = CreateVerifyRequest("sha256PowV1");

        SecurityChallengeOrchestrationVerifyResult result = await orchestrator.VerifyAsync(request, CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal("challenge-proof-token", result.ProofToken);
        Assert.Equal(proof.LastMintRequest?.ExpiresAt, result.ProofExpiresAt);
        Assert.NotNull(proof.LastMintRequest);
        Assert.Equal(request.ChallengeId, proof.LastMintRequest.ChallengeId);
        Assert.Equal(request.EnvelopeId, proof.LastMintRequest.EnvelopeId);
        Assert.Equal(request.Kind, proof.LastMintRequest.Kind);
        Assert.Equal(request.Action, proof.LastMintRequest.Action);
        Assert.Equal(request.RouteKey, proof.LastMintRequest.RouteKey);
        Assert.Equal(request.SubjectHash, proof.LastMintRequest.SubjectHash);
        Assert.Equal(request.ClientIpHash, proof.LastMintRequest.ClientIpHash);
        Assert.Equal(request.DeviceFpHash, proof.LastMintRequest.DeviceFpHash);
        Assert.Equal(request.PolicyVersion, proof.LastMintRequest.PolicyVersion);
    }

    [Fact]
    public async Task IssueThenVerifyAsync_SingleMemberUsesSameEnvelopeStateMachine()
    {
        var provider = new FakeChallengeProvider("captchaV1");
        var proof = new MintingProofService();
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator([provider], proof, new CapturingRiskSink(), state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["captchaV1"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        SecurityChallengeOrchestrationVerifyResult verified = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 0),
            CancellationToken.None);

        Assert.True(verified.Succeeded, verified.Reason);
        Assert.True(verified.EnvelopeCompleted);
        Assert.Equal(1, verified.CompletedCount);
        Assert.Equal(1, verified.MemberCount);
        Assert.Equal("challenge-proof-token", verified.ProofToken);
        Assert.Equal(envelope.EnvelopeId, proof.LastMintRequest?.EnvelopeId);
        Assert.Equal(["captchaV1"], proof.LastMintRequest?.RequiredKinds);
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
        var orchestrator = new SecurityChallengeOrchestrator([provider], proof, riskSink, new TestSecurityChallengeEnvelopeStateService());

        SecurityChallengeOrchestrationVerifyResult result = await orchestrator.VerifyAsync(
            CreateVerifyRequest("sha256PowV1"),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("proof_mint_failed", result.Reason);
        Assert.Null(result.ProofToken);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal("proof_mint_failed:sha256PowV1", signal.Detail);
    }

    [Fact]
    public async Task VerifyAsync_WithoutProviderExpiry_UsesInjectedClockAndReturnsMintedExpiry()
    {
        var provider = new FakeChallengeProvider("sha256PowV1")
        {
            VerifyResult = SecurityChallengeProviderVerifyResult.Success()
        };
        var proof = new MintingProofService();
        var now = new DateTimeOffset(2026, 7, 19, 2, 0, 0, TimeSpan.Zero);
        var orchestrator = new SecurityChallengeOrchestrator(
            [provider],
            proof,
            new CapturingRiskSink(),
            new TestSecurityChallengeEnvelopeStateService(),
            timeProvider: new FixedTimeProvider(now));

        SecurityChallengeOrchestrationVerifyResult result = await orchestrator.VerifyAsync(
            CreateVerifyRequest("sha256PowV1"),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal(now, proof.LastMintRequest?.IssuedAt);
        Assert.Equal(now.AddMinutes(5), result.ProofExpiresAt);
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
            SecurityChallengeContracts.CreateChallengeId(),
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

    private static SecurityChallengeOrchestrationVerifyRequest CreateVerifyRequest(SecurityChallengeEnvelope envelope, int memberIndex)
    {
        SecurityChallengeAssignment assignment = envelope.Assignments[memberIndex];
        return new SecurityChallengeOrchestrationVerifyRequest(
            new DefaultHttpContext(),
            envelope.EnvelopeId,
            SecurityChallengeContracts.ToWireName(assignment.Kind),
            assignment.ChallengeId,
            assignment.Action,
            assignment.RouteKey,
            assignment.SubjectHash,
            assignment.ClientIpHash,
            assignment.DeviceFpHash,
            envelope.PolicyVersion,
            new Dictionary<string, string>(StringComparer.Ordinal) { ["solution"] = "ok" });
    }

    private sealed class FakeChallengeProvider(string kind) : ISecurityChallengeProvider
    {
        public string Kind { get; } = kind;

        public int IssueCalls
        {
            get; private set;
        }

        public int VerifyCalls
        {
            get; private set;
        }

        public SecurityChallengeProviderIssueResult? IssueResult
        {
            get; init;
        }

        public SecurityChallengeProviderVerifyResult VerifyResult { get; init; } = SecurityChallengeProviderVerifyResult.Success(DateTimeOffset.UtcNow.AddMinutes(5));

        public Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
        {
            IssueCalls++;
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
        {
            VerifyCalls++;
            return Task.FromResult(VerifyResult);
        }
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
                request.PolicyVersion,
                request.EnvelopeId,
                request.RequiredKinds);
            return Task.FromResult(new SecurityChallengeProofMintResult("challenge-proof-token", claims));
        }

        public Task<SecurityChallengeProofConsumeResult> ConsumeProofAsync(SecurityChallengeProofConsumeRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
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
