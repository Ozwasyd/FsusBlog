using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using FsusBlog.Shared.Contracts.Governance;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeOrchestratorTests
{
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void CostClasses_PutCredentialAndProofPrerequisitesBeforeScarceArtifacts()
    {
        Assert.Equal(SecurityChallengeCostClass.Credential, SecurityChallengeOrchestrator.ResolveCostClass("passkeyStepUpV1"));
        Assert.Equal(SecurityChallengeCostClass.CheapProof, SecurityChallengeOrchestrator.ResolveCostClass("sha256PowV1"));
        Assert.Equal(SecurityChallengeCostClass.MemoryProof, SecurityChallengeOrchestrator.ResolveCostClass("argon2idPoSpaceV1"));
        Assert.Equal(SecurityChallengeCostClass.ScarceArtifact, SecurityChallengeOrchestrator.ResolveCostClass("perceptionCharacterV3"));
    }

    [Fact]
    public async Task V3IssueAndVerify_FailClosedBeforeProtocolActivationWithoutCallingProvider()
    {
        var provider = new FakeChallengeProvider("perceptionCharacterV3");
        var orchestrator = new SecurityChallengeOrchestrator(
            [provider], new MintingProofService(), new CapturingRiskSink(),
            new TestSecurityChallengeEnvelopeStateService(), protocolActivationGuard: new ClosedProtocolGuard());

        SecurityChallengeOrchestrationIssueResult issue = await orchestrator.IssueAsync(CreateIssueRequest(["perceptionCharacterV3"]));
        SecurityChallengeOrchestrationVerifyResult verify = await orchestrator.VerifyAsync(CreateVerifyRequest("perceptionCharacterV3"));

        Assert.False(issue.Succeeded);
        Assert.False(verify.Succeeded);
        Assert.Equal("challenge_protocol_unavailable", issue.Reason);
        Assert.Equal("challenge_protocol_unavailable", verify.Reason);
        Assert.Equal(0, provider.IssueCalls);
        Assert.Equal(0, provider.VerifyCalls);
    }
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
        var provider = new FakeChallengeProvider("perceptionCharacterV3")
        {
            IssueResult = SecurityChallengeProviderIssueResult.Failed("provider_unavailable")
        };
        var riskSink = new CapturingRiskSink();
        var orchestrator = new SecurityChallengeOrchestrator([provider], new MintingProofService(), riskSink, new TestSecurityChallengeEnvelopeStateService());
        SecurityChallengeOrchestrationIssueRequest request = CreateIssueRequest(["perceptionCharacterV3"]);

        SecurityChallengeOrchestrationIssueResult result = await orchestrator.IssueAsync(request, CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("provider_unavailable", result.Reason);
        Assert.Null(result.Envelope);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal("provider_failure:perceptionCharacterV3:provider_unavailable", signal.Detail);
    }

    [Fact]
    public async Task IssueAsync_MultipleChallenges_ReturnsOnlyFirstActionableAssignment()
    {
        var perception = new FakeChallengeProvider("perceptionLocalizationV2");
        var characterChallenge = new FakeChallengeProvider("perceptionCharacterV3");
        var orchestrator = new SecurityChallengeOrchestrator([perception, characterChallenge], new MintingProofService(), new CapturingRiskSink(), new TestSecurityChallengeEnvelopeStateService());
        SecurityChallengeOrchestrationIssueRequest request = CreateIssueRequest(["perceptionLocalizationV2", "perceptionCharacterV3"]);

        SecurityChallengeOrchestrationIssueResult result = await orchestrator.IssueAsync(request, CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Envelope);
        Assert.Equal("risk-policy-v2", result.Envelope.PolicyVersion);
        Assert.Single(result.Envelope.Assignments);
        Assert.Equal(SecurityChallengeKind.PerceptionLocalizationV2, result.Envelope.Assignments[0].Kind);
        Assert.Equal(1, perception.IssueCalls);
        Assert.Equal(0, characterChallenge.IssueCalls);
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
    public async Task IssueAndAdvance_PowBeforeV3_DoesNotLeaseScarceMemberEarly()
    {
        var pow = new FakeChallengeProvider("sha256PowV1");
        var v3 = new FakeChallengeProvider("perceptionCharacterV3");
        var orchestrator = new SecurityChallengeOrchestrator(
            [pow, v3], new MintingProofService(), new CapturingRiskSink(),
            new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false));

        SecurityChallengeOrchestrationIssueRequest issueRequest = CreateIssueRequest(["perceptionCharacterV3", "sha256PowV1"]);
        issueRequest.Context.Request.Headers["X-Fsus-Challenge-Representation"] = "audio";
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>((await orchestrator.IssueAsync(issueRequest)).Envelope);

        Assert.Equal(1, pow.IssueCalls);
        Assert.Equal(0, v3.IssueCalls);
        Assert.Equal(SecurityChallengeKind.Sha256PowV1, Assert.Single(envelope.Assignments).Kind);
        SecurityChallengeOrchestrationVerifyResult advanced = await orchestrator.VerifyAsync(CreateVerifyRequest(envelope, 0));
        Assert.True(advanced.Succeeded, advanced.Reason);
        Assert.Equal(1, v3.IssueCalls);
        Assert.Equal("audio", v3.LastIssueRequest?.Representation);
        Assert.Equal(SecurityChallengeKind.PerceptionCharacterV3, advanced.NextAssignment?.Kind);
    }

    [Fact]
    public async Task ConcurrentPowCompletion_IssuesV3AtMostOnce()
    {
        var pow = new FakeChallengeProvider("sha256PowV1");
        var v3 = new FakeChallengeProvider("perceptionCharacterV3");
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator(
            [pow, v3], new MintingProofService(), new CapturingRiskSink(), state);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>((await orchestrator.IssueAsync(
            CreateIssueRequest(["sha256PowV1", "perceptionCharacterV3"]))).Envelope);
        SecurityChallengeOrchestrationVerifyRequest request = CreateVerifyRequest(envelope, 0);

        SecurityChallengeOrchestrationVerifyResult[] results = await Task.WhenAll(
            orchestrator.VerifyAsync(request), orchestrator.VerifyAsync(request));

        Assert.Equal(1, pow.VerifyCalls);
        Assert.Equal(1, v3.IssueCalls);
        Assert.Single(results, static result => result.NextAssignment is not null);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Active, state.Get(envelope.EnvelopeId)?.Status);
    }

    [Fact]
    public async Task OrderedPlan_PowThenPoSpaceThenV3_MaterializesOneMemberPerTransition()
    {
        var pow = new FakeChallengeProvider("sha256PowV1");
        var space = new FakeChallengeProvider("argon2idPoSpaceV1");
        var v3 = new FakeChallengeProvider("perceptionCharacterV3");
        var orchestrator = new SecurityChallengeOrchestrator(
            [pow, space, v3], new MintingProofService(), new CapturingRiskSink(),
            new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false));
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>((await orchestrator.IssueAsync(
            CreateIssueRequest(["sha256PowV1", "argon2idPoSpaceV1", "perceptionCharacterV3"]))).Envelope);

        SecurityChallengeOrchestrationVerifyResult afterPow = await orchestrator.VerifyAsync(CreateVerifyRequest(envelope, 0));
        Assert.Equal(SecurityChallengeKind.Argon2IdPoSpaceV1, afterPow.NextAssignment?.Kind);
        Assert.Equal(0, v3.IssueCalls);
        SecurityChallengeOrchestrationVerifyResult afterSpace = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, Assert.IsType<SecurityChallengeAssignment>(afterPow.NextAssignment)));

        Assert.True(afterSpace.Succeeded, afterSpace.Reason);
        Assert.Equal(SecurityChallengeKind.PerceptionCharacterV3, afterSpace.NextAssignment?.Kind);
        Assert.Equal(1, v3.IssueCalls);
    }

    [Fact]
    public async Task DuplicateV3Plan_FailsBeforeAnyProviderIssue()
    {
        var v3 = new FakeChallengeProvider("perceptionCharacterV3");
        var orchestrator = new SecurityChallengeOrchestrator(
            [v3], new MintingProofService(), new CapturingRiskSink(),
            new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false));

        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionCharacterV3", "perceptionCharacterV3"]));

        Assert.False(issued.Succeeded);
        Assert.Equal("challenge_plan_duplicate", issued.Reason);
        Assert.Equal(0, v3.IssueCalls);
    }

    [Fact]
    public async Task VerifyAsync_MultipleChallenges_ReturnsProgressThenOneAggregateProof()
    {
        var perception = new FakeChallengeProvider("perceptionLocalizationV2");
        var characterChallenge = new FakeChallengeProvider("perceptionCharacterV3");
        var proof = new MintingProofService();
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator([perception, characterChallenge], proof, new CapturingRiskSink(), state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "perceptionCharacterV3"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        SecurityChallengeOrchestrationVerifyResult first = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 0),
            CancellationToken.None);
        SecurityChallengeAssignment secondAssignment = Assert.IsType<SecurityChallengeAssignment>(first.NextAssignment);
        SecurityChallengeOrchestrationVerifyResult second = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, secondAssignment),
            CancellationToken.None);

        Assert.True(first.Succeeded, first.Reason);
        Assert.False(first.EnvelopeCompleted);
        Assert.Equal(1, first.CompletedCount);
        Assert.Equal(2, first.MemberCount);
        Assert.Null(first.ProofToken);
        Assert.True(second.Succeeded, second.Reason);
        Assert.True(second.EnvelopeCompleted);
        Assert.Equal(2, second.CompletedCount);
        Assert.Equal(proof.LastMintRequest?.ProofToken, second.ProofToken);
        Assert.Equal(envelope.EnvelopeId, proof.LastMintRequest?.EnvelopeId);
        Assert.Equal(["perceptionLocalizationV2", "perceptionCharacterV3"], proof.LastMintRequest?.RequiredKinds);
        Assert.Equal(secondAssignment.ChallengeId, proof.LastMintRequest?.ChallengeId);
    }

    [Fact]
    public async Task VerifyAsync_ReplayedMemberIsRejectedWithoutDestroyingConcurrentProgress()
    {
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator(
            [new FakeChallengeProvider("perceptionLocalizationV2"), new FakeChallengeProvider("perceptionCharacterV3")],
            new MintingProofService(),
            new CapturingRiskSink(),
            state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "perceptionCharacterV3"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        SecurityChallengeOrchestrationVerifyResult advanced = await orchestrator.VerifyAsync(CreateVerifyRequest(envelope, 0), CancellationToken.None);
        SecurityChallengeAssignment secondAssignment = Assert.IsType<SecurityChallengeAssignment>(advanced.NextAssignment);
        SecurityChallengeOrchestrationVerifyResult replay = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, 0),
            CancellationToken.None);
        SecurityChallengeOrchestrationVerifyResult final = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, secondAssignment),
            CancellationToken.None);

        Assert.False(replay.Succeeded);
        Assert.Equal("challenge_member_replayed", replay.Reason);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Completed, state.Get(envelope.EnvelopeId)?.Status);
        Assert.True(final.Succeeded, final.Reason);
        Assert.NotNull(final.ProofToken);
    }

    [Fact]
    public async Task VerifyAsync_LaterProviderFailureTerminatesEnvelopeWithoutAggregateProof()
    {
        var characterChallenge = new FakeChallengeProvider("perceptionCharacterV3")
        {
            VerifyResult = SecurityChallengeProviderVerifyResult.Failed("characterChallenge_invalid")
        };
        var proof = new MintingProofService();
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator(
            [new FakeChallengeProvider("perceptionLocalizationV2"), characterChallenge],
            proof,
            new CapturingRiskSink(),
            state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "perceptionCharacterV3"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        SecurityChallengeOrchestrationVerifyResult advanced = await orchestrator.VerifyAsync(CreateVerifyRequest(envelope, 0), CancellationToken.None);
        SecurityChallengeAssignment secondAssignment = Assert.IsType<SecurityChallengeAssignment>(advanced.NextAssignment);
        SecurityChallengeOrchestrationVerifyResult failed = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, secondAssignment),
            CancellationToken.None);
        SecurityChallengeOrchestrationVerifyResult retry = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, secondAssignment),
            CancellationToken.None);

        Assert.False(failed.Succeeded);
        Assert.Equal("characterChallenge_invalid", failed.Reason);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Failed, state.Get(envelope.EnvelopeId)?.Status);
        Assert.False(retry.Succeeded);
        Assert.Equal("challenge_envelope_failed", retry.Reason);
        Assert.Null(proof.LastMintRequest);
    }

    [Fact]
    public async Task VerifyAsync_OutOfOrderMemberRejectsBeforeProviderExecution()
    {
        var perception = new FakeChallengeProvider("perceptionLocalizationV2");
        var characterChallenge = new FakeChallengeProvider("perceptionCharacterV3");
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator(
            [perception, characterChallenge],
            new MintingProofService(),
            new CapturingRiskSink(),
            state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "perceptionCharacterV3"]),
            CancellationToken.None);
        Assert.True(issued.Succeeded, issued.Reason);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>(issued.Envelope);

        SecurityChallengeEnvelopeState planned = Assert.IsType<SecurityChallengeEnvelopeState>(state.Get(envelope.EnvelopeId));
        SecurityChallengeAssignment forged = envelope.Assignments[0] with
        {
            ChallengeId = planned.ChallengeIds[1],
            Kind = SecurityChallengeKind.PerceptionCharacterV3
        };
        SecurityChallengeOrchestrationVerifyResult result = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, forged),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("challenge_member_out_of_order", result.Reason);
        Assert.Equal(0, characterChallenge.VerifyCalls);
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
        Assert.Equal(proof.LastMintRequest?.ProofToken, result.ProofToken);
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
    public async Task VerifyAsync_PerceptionCharacterV3UsesIssuedEnvelopeDeviceAndPolicyBindings()
    {
        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        Assert.True(await state.CreateAsync(new SecurityChallengeEnvelopeState(
            envelopeId,
            "public.read",
            "/article/42",
            HashA,
            HashB,
            HashC,
            "issued-policy",
            [challengeId],
            [PerceptionCharacterV3Contracts.WireName],
            [SecurityChallengeEnvelopeMemberStatuses.Issued],
            now,
            now + 300_000,
            SecurityChallengeEnvelopeStatuses.Active,
            Version: 0)));
        var provider = new FakeChallengeProvider(PerceptionCharacterV3Contracts.WireName);
        var proof = new MintingProofService();
        var orchestrator = new SecurityChallengeOrchestrator([provider], proof, new CapturingRiskSink(), state);
        var typed = new PerceptionCharacterV3VerifyPayload(
            PerceptionCharacterV3Contracts.Algorithm,
            challengeId,
            envelopeId,
            PerceptionCharacterV3Representation.Visual,
            "A7C9Q",
            "opaque-state");
        var request = new SecurityChallengeOrchestrationVerifyRequest(
            new DefaultHttpContext(),
            envelopeId,
            PerceptionCharacterV3Contracts.WireName,
            challengeId,
            "public.read",
            "/article/42",
            HashA,
            HashB,
            new string('d', 64),
            "newly-published-policy",
            new Dictionary<string, string>(StringComparer.Ordinal))
        {
            PerceptionCharacterV3 = typed
        };

        SecurityChallengeOrchestrationVerifyResult result = await orchestrator.VerifyAsync(request, CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal(HashC, provider.LastVerifyRequest!.DeviceFpHash);
        Assert.Equal("issued-policy", provider.LastVerifyRequest.PolicyVersion);
        Assert.Equal(HashC, proof.LastMintRequest!.DeviceFpHash);
        Assert.Equal("issued-policy", proof.LastMintRequest.PolicyVersion);
    }

    [Fact]
    public async Task IssueThenVerifyAsync_SingleMemberUsesSameEnvelopeStateMachine()
    {
        var provider = new FakeChallengeProvider("perceptionCharacterV3");
        var proof = new MintingProofService();
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator([provider], proof, new CapturingRiskSink(), state);
        SecurityChallengeOrchestrationIssueResult issued = await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionCharacterV3"]),
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
        Assert.Equal(proof.LastMintRequest?.ProofToken, verified.ProofToken);
        Assert.Equal(envelope.EnvelopeId, proof.LastMintRequest?.EnvelopeId);
        Assert.Equal(["perceptionCharacterV3"], proof.LastMintRequest?.RequiredKinds);
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
    public async Task VerifyAsync_ProofMintFailure_RetryReusesPreparedTokenWithoutProviderReplay()
    {
        var provider = new FakeChallengeProvider("sha256PowV1");
        var proof = new MintingProofService { FailuresRemaining = 1 };
        var state = new TestSecurityChallengeEnvelopeStateService();
        var orchestrator = new SecurityChallengeOrchestrator([provider], proof, new CapturingRiskSink(), state);
        SecurityChallengeOrchestrationVerifyRequest request = CreateVerifyRequest("sha256PowV1");

        SecurityChallengeOrchestrationVerifyResult failed = await orchestrator.VerifyAsync(request, CancellationToken.None);
        string preparedToken = state.Get(request.EnvelopeId)!.ProofToken!;
        SecurityChallengeOrchestrationVerifyResult retry = await orchestrator.VerifyAsync(request, CancellationToken.None);

        Assert.False(failed.Succeeded);
        Assert.True(retry.Succeeded, retry.Reason);
        Assert.Equal(preparedToken, retry.ProofToken);
        Assert.Equal(1, provider.VerifyCalls);
        Assert.Equal(2, proof.MintCalls);
        Assert.Single(proof.ObservedTokens);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Completed, state.Get(request.EnvelopeId)?.Status);
    }

    [Fact]
    public async Task VerifyAsync_ResponseLossRetryReturnsSameCompletedProofWithoutReminting()
    {
        var provider = new FakeChallengeProvider("sha256PowV1");
        var proof = new MintingProofService();
        var orchestrator = new SecurityChallengeOrchestrator(
            [provider],
            proof,
            new CapturingRiskSink(),
            new TestSecurityChallengeEnvelopeStateService());
        SecurityChallengeOrchestrationVerifyRequest request = CreateVerifyRequest("sha256PowV1");

        SecurityChallengeOrchestrationVerifyResult first = await orchestrator.VerifyAsync(request, CancellationToken.None);
        SecurityChallengeOrchestrationVerifyResult responseLossRetry = await orchestrator.VerifyAsync(request, CancellationToken.None);

        Assert.True(first.Succeeded, first.Reason);
        Assert.True(responseLossRetry.Succeeded, responseLossRetry.Reason);
        Assert.Equal(first.ProofToken, responseLossRetry.ProofToken);
        Assert.Equal(first.ProofExpiresAt, responseLossRetry.ProofExpiresAt);
        Assert.Equal(1, provider.VerifyCalls);
        Assert.Equal(1, proof.MintCalls);
    }

    [Fact]
    public async Task VerifyAsync_ConcurrentFinalRetriesShareOnePreparedToken()
    {
        var perception = new FakeChallengeProvider("perceptionLocalizationV2");
        var characterChallenge = new FakeChallengeProvider("perceptionCharacterV3");
        var proof = new MintingProofService { CoordinateConcurrentMints = true };
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator([perception, characterChallenge], proof, new CapturingRiskSink(), state);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>((await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "perceptionCharacterV3"]),
            CancellationToken.None)).Envelope);
        SecurityChallengeOrchestrationVerifyResult advanced = await orchestrator.VerifyAsync(CreateVerifyRequest(envelope, 0), CancellationToken.None);
        SecurityChallengeOrchestrationVerifyRequest finalRequest = CreateVerifyRequest(envelope, Assert.IsType<SecurityChallengeAssignment>(advanced.NextAssignment));

        SecurityChallengeOrchestrationVerifyResult[] results = await Task.WhenAll(
            orchestrator.VerifyAsync(finalRequest, CancellationToken.None),
            orchestrator.VerifyAsync(finalRequest, CancellationToken.None));

        Assert.All(results, result => Assert.True(result.Succeeded, result.Reason));
        Assert.Single(results.Select(static result => result.ProofToken).Distinct(StringComparer.Ordinal));
        Assert.Single(proof.ObservedTokens);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Completed, state.Get(envelope.EnvelopeId)?.Status);
    }

    [Fact]
    public async Task VerifyAsync_IdentityReplacementRevokeBlocksFinalMember()
    {
        var perception = new FakeChallengeProvider("perceptionLocalizationV2");
        var characterChallenge = new FakeChallengeProvider("perceptionCharacterV3");
        var state = new TestSecurityChallengeEnvelopeStateService(autoCreateSingleMember: false);
        var orchestrator = new SecurityChallengeOrchestrator([perception, characterChallenge], new MintingProofService(), new CapturingRiskSink(), state);
        SecurityChallengeEnvelope envelope = Assert.IsType<SecurityChallengeEnvelope>((await orchestrator.IssueAsync(
            CreateIssueRequest(["perceptionLocalizationV2", "perceptionCharacterV3"]),
            CancellationToken.None)).Envelope);
        SecurityChallengeOrchestrationVerifyResult advanced = await orchestrator.VerifyAsync(CreateVerifyRequest(envelope, 0), CancellationToken.None);
        SecurityChallengeAssignment secondAssignment = Assert.IsType<SecurityChallengeAssignment>(advanced.NextAssignment);
        SecurityChallengeAssignment first = envelope.Assignments[0];
        Assert.True(await state.RevokeAsync(
            new SecurityChallengeEnvelopeBindingRequest(
                envelope.EnvelopeId,
                first.Action,
                first.RouteKey,
                first.SubjectHash,
                first.ClientIpHash,
                first.DeviceFpHash,
                envelope.PolicyVersion),
            "identity_replaced"));

        SecurityChallengeOrchestrationVerifyResult final = await orchestrator.VerifyAsync(
            CreateVerifyRequest(envelope, secondAssignment),
            CancellationToken.None);

        Assert.False(final.Succeeded);
        Assert.Equal("challenge_envelope_revoked", final.Reason);
        Assert.Equal(0, characterChallenge.VerifyCalls);
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
        => CreateVerifyRequest(envelope, envelope.Assignments[memberIndex]);

    private static SecurityChallengeOrchestrationVerifyRequest CreateVerifyRequest(
        SecurityChallengeEnvelope envelope,
        SecurityChallengeAssignment assignment)
    {
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

        public SecurityChallengeProviderVerifyRequest? LastVerifyRequest
        {
            get; private set;
        }

        public SecurityChallengeProviderIssueRequest? LastIssueRequest
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
            LastIssueRequest = request;
            if (IssueResult is { } result)
            {
                return Task.FromResult(result);
            }

            SecurityChallengeContracts.TryParseKind(Kind, out SecurityChallengeKind parsed);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var assignment = new SecurityChallengeAssignment(
                request.ChallengeId,
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
            LastVerifyRequest = request;
            return Task.FromResult(VerifyResult);
        }
    }

    private sealed class ClosedProtocolGuard : ISecurityChallengeProtocolActivationGuard
    {
        public Task<bool> IsOpenAsync(CancellationToken cancellationToken = default) => Task.FromResult(false);

        public Task CloseAsync(CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task OpenAsync(
            PerceptionCharacterV3CutoverReceipt receipt,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class MintingProofService : ISecurityChallengeProofService
    {
        private readonly object _gate = new();
        private readonly TaskCompletionSource _concurrentMintGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _mintCalls;
        public bool ThrowOnMint
        {
            get; init;
        }

        public int FailuresRemaining
        {
            get; set;
        }

        public int MintCalls
        {
            get => Volatile.Read(ref _mintCalls);
        }

        public HashSet<string> ObservedTokens { get; } = new(StringComparer.Ordinal);

        public bool CoordinateConcurrentMints
        {
            get; init;
        }

        public SecurityChallengeProofMintRequest? LastMintRequest
        {
            get; private set;
        }

        public async Task<SecurityChallengeProofMintResult> MintProofAsync(SecurityChallengeProofMintRequest request, CancellationToken cancellationToken = default)
        {
            int mintCall = Interlocked.Increment(ref _mintCalls);
            LastMintRequest = request;
            lock (_gate)
            {
                if (request.ProofToken is not null)
                {
                    ObservedTokens.Add(request.ProofToken);
                }
            }
            if (ThrowOnMint || FailuresRemaining-- > 0)
            {
                throw new InvalidOperationException("mint failed");
            }
            if (CoordinateConcurrentMints)
            {
                if (mintCall >= 2)
                {
                    _concurrentMintGate.TrySetResult();
                }
                await _concurrentMintGate.Task.WaitAsync(cancellationToken);
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
                request.RequiredKinds,
                request.OrderedMemberChallengeIds);
            return new SecurityChallengeProofMintResult(request.ProofToken ?? "challenge-proof-token", claims);
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
