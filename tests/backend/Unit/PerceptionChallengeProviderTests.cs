using System.Collections.Concurrent;
using System.Net;
using System.Reflection;

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
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PerceptionChallengeProviderTests
{
    private static readonly DateTimeOffset s_baselineNow = DateTimeOffset.Parse("2026-06-19T08:00:00Z");
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void RuntimeServices_RegisterPerceptionProviders()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(CreateConfiguration());

        AssertRegistered<PerceptionTextTaskV2Provider>(services);
        AssertRegistered<PerceptionLocalizationV2Provider>(services);
        AssertRegistered<PerceptionMicroInteractionV2Provider>(services);
    }

    [Fact]
    public void RuntimeServices_PerceptionProvidersResolveWithoutAmbiguousConstructors()
    {
        var services = new ServiceCollection();
        IConfiguration configuration = CreateConfiguration();
        var clock = new MutableTimeProvider(s_baselineNow);
        IPerceptionChallengeV2IssueService issueService = CreateIssueService(
            configuration,
            clock,
            out IPerceptionChallengeV2TokenProtector tokenProtector);

        services.AddSingleton(configuration);
        services.AddSingleton<TimeProvider>(clock);
        services.AddSingleton<ISecurityChallengePersistenceService>(new RecordingChallengePersistence());
        services.AddSingleton<IChallengeV2AuditEventWriter, NoopChallengeV2AuditEventWriter>();
        services.AddSingleton<ISecurityRiskSignalSink>(new CapturingRiskSink());
        services.AddSingleton<IPerceptionChallengeV2RedisGate>(new RecordingPerceptionRedisGate());
        services.AddSingleton(issueService);
        services.AddSingleton(tokenProtector);
        services.AddScoped<IPerceptionChallengeV2VerifyService, PerceptionChallengeV2VerifyService>();
        services.AddScoped<ISecurityChallengeProvider, PerceptionTextTaskV2Provider>();
        services.AddScoped<ISecurityChallengeProvider, PerceptionLocalizationV2Provider>();

        using ServiceProvider provider = services.BuildServiceProvider(new ServiceProviderOptions
        {
            ValidateOnBuild = true,
            ValidateScopes = true
        });
        using IServiceScope scope = provider.CreateScope();

        ISecurityChallengeProvider[] resolved = scope.ServiceProvider.GetServices<ISecurityChallengeProvider>().ToArray();

        Assert.Contains(resolved, static item => item is PerceptionTextTaskV2Provider);
        Assert.Contains(resolved, static item => item is PerceptionLocalizationV2Provider);
    }

    [Fact]
    public void SecurityChallengeContracts_SupportPerceptionWireKinds()
    {
        Assert.True(SecurityChallengeContracts.TryParseKind("perceptionTextTaskV2", out SecurityChallengeKind textTask));
        Assert.True(SecurityChallengeContracts.TryParseKind("perceptionLocalizationV2", out SecurityChallengeKind localization));
        Assert.True(SecurityChallengeContracts.TryParseKind("perceptionMicroInteractionV2", out SecurityChallengeKind microInteraction));

        Assert.Equal(SecurityChallengeKind.PerceptionTextTaskV2, textTask);
        Assert.Equal(SecurityChallengeKind.PerceptionLocalizationV2, localization);
        Assert.Equal(SecurityChallengeKind.PerceptionMicroInteractionV2, microInteraction);
        Assert.Equal("perceptionTextTaskV2", SecurityChallengeContracts.ToWireName(textTask));
        Assert.Equal("perceptionLocalizationV2", SecurityChallengeContracts.ToWireName(localization));
        Assert.Equal("perceptionMicroInteractionV2", SecurityChallengeContracts.ToWireName(microInteraction));
    }

    [Fact]
    public async Task TextTask_IssueAsync_ReturnsRecipePayloadWithoutExpectedTextOrSemanticIds()
    {
        ProviderFixture<PerceptionTextTaskV2Provider> fixture = CreateTextFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionTextTaskV2Provider.WireKind, escalationLevel: 1),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(SecurityChallengeKind.PerceptionTextTaskV2, result.Assignment.Kind);
        Assert.True(SecurityChallengeContracts.ValidateAssignment(result.Assignment).IsValid);
        Assert.Equal(PerceptionTextTaskV2Provider.Algorithm, result.ProviderPayload["algorithm"]);
        AssertValidRecipe(result.ProviderPayload, RenderRecipeV2TaskKind.Character);
        AssertNoPayloadLeak(result.ProviderPayload, "F7KA2");
        Assert.Empty(fixture.Persistence.Issues);
        Assert.Empty(fixture.Gate.AttemptChallengeIds);
        Assert.Empty(fixture.Gate.ConsumeChallengeIds);
    }

    [Fact]
    public async Task TextTask_VerifyAsync_DelegatesToUnifiedVerifyServiceAndMasksFailureReason()
    {
        IConfiguration configuration = CreateConfiguration();
        var clock = new MutableTimeProvider(s_baselineNow);
        IPerceptionChallengeV2IssueService issueService = CreateIssueService(
            configuration,
            clock,
            out _);
        var verifyService = new RecordingPerceptionVerifyService
        {
            Result = PerceptionChallengeV2VerifyResult.Failed("perception_text_answer_invalid")
        };
        var provider = new PerceptionTextTaskV2Provider(issueService, verifyService);
        IReadOnlyDictionary<string, string> payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["algorithm"] = PerceptionTextTaskV2Provider.Algorithm,
            ["keyVersion"] = "current",
            ["taskKind"] = "character",
            ["recipeHashHex"] = HashA,
            ["sealedToken"] = "sealed-token",
            ["signatureHex"] = "sig-hex",
            ["answerText"] = "WRONG",
            ["solveDurationMs"] = "2400"
        };

        SecurityChallengeProviderVerifyResult result = await provider.VerifyAsync(
            CreateVerifyRequest(PerceptionTextTaskV2Provider.WireKind, "challenge-1", payload),
            CancellationToken.None);

        AssertGenericFailed(result);
        PerceptionChallengeV2VerifyRequest delegated = Assert.Single(verifyService.Requests);
        Assert.Equal("challenge-1", delegated.ChallengeId);
        Assert.Equal("auth.login", delegated.Action);
        Assert.Equal("/api/binary/auth/login", delegated.RouteKey);
        Assert.Same(payload, delegated.ProviderPayload);
    }

    [Fact]
    public async Task TextTask_VerifyAsync_AcceptsNormalizedAnswerAndRejectsReplay()
    {
        ProviderFixture<PerceptionTextTaskV2Provider> fixture = CreateTextFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionTextTaskV2Provider.WireKind, escalationLevel: 1),
            CancellationToken.None);
        Dictionary<string, string> payload = CreateTextVerifyPayload(issued.ProviderPayload, " f7 ka2 ", 2500);

        Assert.Empty(fixture.Persistence.Issues);
        Assert.Empty(fixture.Gate.AttemptChallengeIds);

        SecurityChallengeProviderVerifyResult accepted = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(PerceptionTextTaskV2Provider.WireKind, issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);
        SecurityChallengeProviderVerifyResult replay = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(PerceptionTextTaskV2Provider.WireKind, issued.Assignment.ChallengeId, payload),
            CancellationToken.None);

        Assert.True(accepted.Succeeded, accepted.Reason);
        Assert.False(replay.Succeeded);
        Assert.Equal("perception_challenge_failed", replay.Reason);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, fixture.Persistence.Attempts[0].Outcome);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Replayed, fixture.Persistence.Attempts[1].Outcome);
        Assert.Equal("PerceptionReplay", Assert.Single(fixture.RiskSink.Signals).Detail);
        Assert.Equal(2, fixture.Gate.AttemptCounts[issued.Assignment.ChallengeId]);
    }

    [Fact]
    public async Task TextTask_VerifyAsync_RejectsWrongAnswerWithGenericFailure()
    {
        ProviderFixture<PerceptionTextTaskV2Provider> fixture = CreateTextFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionTextTaskV2Provider.WireKind, escalationLevel: 1),
            CancellationToken.None);

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(
                PerceptionTextTaskV2Provider.WireKind,
                issued.Assignment!.ChallengeId,
                CreateTextVerifyPayload(issued.ProviderPayload, "WRONG", 2500)),
            CancellationToken.None);

        AssertGenericFailed(result);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempt.Outcome);
        Assert.Equal("perception_text_answer_invalid", attempt.Reason);
        Assert.Equal("PerceptionInvalid", Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    [Fact]
    public async Task TextTask_VerifyAsync_RejectsAfterMaxAttemptsWithoutIssueCacheState()
    {
        ProviderFixture<PerceptionTextTaskV2Provider> fixture = CreateTextFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionTextTaskV2Provider.WireKind, escalationLevel: 1),
            CancellationToken.None);
        SecurityChallengeProviderVerifyRequest request = CreateVerifyRequest(
            PerceptionTextTaskV2Provider.WireKind,
            issued.Assignment!.ChallengeId,
            CreateTextVerifyPayload(issued.ProviderPayload, "WRONG", 2500));

        for (int i = 0; i < PerceptionChallengeV2Constants.DefaultMaxAttempts; i++)
        {
            SecurityChallengeProviderVerifyResult failed = await fixture.Provider.VerifyAsync(request, CancellationToken.None);
            AssertGenericFailed(failed);
            Assert.Equal("perception_text_answer_invalid", fixture.Persistence.Attempts[i].Reason);
        }

        SecurityChallengeProviderVerifyResult exceeded = await fixture.Provider.VerifyAsync(request, CancellationToken.None);

        AssertGenericFailed(exceeded);
        Assert.Equal(
            "perception_attempt_exceeded",
            fixture.Persistence.Attempts[^1].Reason);
        Assert.Equal("PerceptionAttemptExceeded", fixture.RiskSink.Signals[^1].Detail);
        Assert.Equal(
            PerceptionChallengeV2Constants.DefaultMaxAttempts + 1,
            fixture.Gate.AttemptCounts[issued.Assignment.ChallengeId]);
    }

    [Fact]
    public async Task TextTask_VerifyAsync_QueuesAuditAttemptWithoutAwaitingPersistence()
    {
        var persistence = new RecordingChallengePersistence();
        var riskSink = new CapturingRiskSink();
        var gate = new RecordingPerceptionRedisGate();
        var clock = new MutableTimeProvider(s_baselineNow);
        IConfiguration configuration = CreateConfiguration();
        IPerceptionChallengeV2IssueService issueService = CreateIssueService(configuration, clock, out IPerceptionChallengeV2TokenProtector tokenProtector);
        var queue = new ChallengeV2AuditEventQueue(
            Options.Create(new ChallengeV2EventWriterOptions { Capacity = 4, HighValueCapacity = 4, BatchSize = 2, FlushWindowMs = 10 }),
            new CapturingLogger<ChallengeV2AuditEventQueue>());
        var verifyService = new PerceptionChallengeV2VerifyService(tokenProtector, gate, riskSink, queue, clock);
        var provider = new PerceptionTextTaskV2Provider(issueService, verifyService);
        SecurityChallengeProviderIssueResult issued = await provider.IssueAsync(
            CreateIssueRequest(PerceptionTextTaskV2Provider.WireKind, escalationLevel: 1),
            CancellationToken.None);

        SecurityChallengeProviderVerifyResult result = await provider.VerifyAsync(
            CreateVerifyRequest(
                PerceptionTextTaskV2Provider.WireKind,
                issued.Assignment!.ChallengeId,
                CreateTextVerifyPayload(issued.ProviderPayload, " f7 ka2 ", 2500)),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Empty(persistence.Attempts);
        Assert.Equal(1, queue.Snapshot().NormalQueuedCount);
    }

    [Theory]
    [InlineData(100, "perception_solve_too_fast", "PerceptionSolveTooFast")]
    [InlineData(90_001, "perception_solve_too_slow", "PerceptionSolveTooSlow")]
    public async Task TextTask_VerifyAsync_RejectsSolveDurationBounds(int solveDurationMs, string attemptReason, string riskDetail)
    {
        ProviderFixture<PerceptionTextTaskV2Provider> fixture = CreateTextFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionTextTaskV2Provider.WireKind, escalationLevel: 1),
            CancellationToken.None);

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(
                PerceptionTextTaskV2Provider.WireKind,
                issued.Assignment!.ChallengeId,
                CreateTextVerifyPayload(issued.ProviderPayload, "F7KA2", solveDurationMs)),
            CancellationToken.None);

        AssertGenericFailed(result);
        Assert.Equal(attemptReason, Assert.Single(fixture.Persistence.Attempts).Reason);
        Assert.Equal(riskDetail, Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    [Fact]
    public async Task Localization_IssueAsync_ReturnsRecipePayloadWithoutExpectedPoint()
    {
        ProviderFixture<PerceptionLocalizationV2Provider> fixture = CreateLocalizationFixture();

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionLocalizationV2Provider.WireKind, escalationLevel: 2),
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(SecurityChallengeKind.PerceptionLocalizationV2, result.Assignment.Kind);
        Assert.Equal(PerceptionLocalizationV2Provider.Algorithm, result.ProviderPayload["algorithm"]);
        AssertValidRecipe(result.ProviderPayload, RenderRecipeV2TaskKind.Localization);
        AssertNoPayloadLeak(result.ProviderPayload, "192");
        Assert.False(result.ProviderPayload.ContainsKey("expectedX"));
        Assert.False(result.ProviderPayload.ContainsKey("expectedY"));
        Assert.False(result.ProviderPayload.ContainsKey("targetX"));
        Assert.False(result.ProviderPayload.ContainsKey("targetY"));
        Assert.Empty(fixture.Persistence.Issues);
        Assert.Empty(fixture.Gate.AttemptChallengeIds);
    }

    [Fact]
    public async Task Localization_VerifyAsync_AcceptsToleranceAndRejectsReplay()
    {
        ProviderFixture<PerceptionLocalizationV2Provider> fixture = CreateLocalizationFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionLocalizationV2Provider.WireKind, escalationLevel: 2),
            CancellationToken.None);
        Dictionary<string, string> payload = CreateLocalizationVerifyPayload(issued.ProviderPayload, x: 197, y: 130, solveDurationMs: 2200);

        SecurityChallengeProviderVerifyResult accepted = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(PerceptionLocalizationV2Provider.WireKind, issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);
        SecurityChallengeProviderVerifyResult replay = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(PerceptionLocalizationV2Provider.WireKind, issued.Assignment.ChallengeId, payload),
            CancellationToken.None);

        Assert.True(accepted.Succeeded, accepted.Reason);
        AssertGenericFailed(replay);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, fixture.Persistence.Attempts[0].Outcome);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Replayed, fixture.Persistence.Attempts[1].Outcome);
    }

    [Theory]
    [InlineData(230, 130, "perception_coordinate_invalid")]
    [InlineData(197, 130, "perception_recipe_hash_mismatch")]
    [InlineData(197, 130, "perception_solve_too_fast")]
    public async Task Localization_VerifyAsync_RejectsOffsetTamperAndTooFast(int x, int y, string expectedAttemptReason)
    {
        ProviderFixture<PerceptionLocalizationV2Provider> fixture = CreateLocalizationFixture();
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionLocalizationV2Provider.WireKind, escalationLevel: 2),
            CancellationToken.None);
        Dictionary<string, string> payload = CreateLocalizationVerifyPayload(issued.ProviderPayload, x, y, solveDurationMs: 2200);
        if (expectedAttemptReason == "perception_recipe_hash_mismatch")
        {
            payload["recipeHashHex"] = new string('f', 64);
        }
        else if (expectedAttemptReason == "perception_solve_too_fast")
        {
            payload["solveDurationMs"] = "100";
        }

        SecurityChallengeProviderVerifyResult result = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(PerceptionLocalizationV2Provider.WireKind, issued.Assignment!.ChallengeId, payload),
            CancellationToken.None);

        AssertGenericFailed(result);
        Assert.Equal(expectedAttemptReason, Assert.Single(fixture.Persistence.Attempts).Reason);
        string expectedRiskDetail = expectedAttemptReason == "perception_solve_too_fast"
            ? "PerceptionSolveTooFast"
            : "PerceptionInvalid";
        Assert.Equal(expectedRiskDetail, Assert.Single(fixture.RiskSink.Signals).Detail);
    }

    [Fact]
    public async Task MicroInteraction_IssueAsync_DefaultDisabledFailsClosedWithoutPersisting()
    {
        ProviderFixture<PerceptionMicroInteractionV2Provider> fixture = CreateMicroFixture(enabled: false);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionMicroInteractionV2Provider.WireKind, escalationLevel: 3),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("perception_micro_interaction_disabled", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
        Assert.Empty(fixture.Gate.AttemptChallengeIds);
    }

    [Fact]
    public async Task MicroInteraction_IssueAsync_EnabledRequiresHighRiskEscalation()
    {
        ProviderFixture<PerceptionMicroInteractionV2Provider> fixture = CreateMicroFixture(enabled: true);

        SecurityChallengeProviderIssueResult result = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionMicroInteractionV2Provider.WireKind, escalationLevel: 1),
            CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal("perception_micro_interaction_escalation_required", result.Reason);
        Assert.Empty(fixture.Persistence.Issues);
    }

    [Fact]
    public async Task MicroInteraction_VerifyAsync_AcceptsExpectedSmallStepSummaryAndRejectsWrongSteps()
    {
        ProviderFixture<PerceptionMicroInteractionV2Provider> fixture = CreateMicroFixture(enabled: true);
        SecurityChallengeProviderIssueResult issued = await fixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionMicroInteractionV2Provider.WireKind, escalationLevel: 3),
            CancellationToken.None);
        Dictionary<string, string> validPayload = CreateMicroVerifyPayload(
            issued.ProviderPayload,
            "click:72,64|click:224,128",
            solveDurationMs: 3200);
        SecurityChallengeProviderVerifyResult accepted = await fixture.Provider.VerifyAsync(
            CreateVerifyRequest(PerceptionMicroInteractionV2Provider.WireKind, issued.Assignment!.ChallengeId, validPayload),
            CancellationToken.None);
        ProviderFixture<PerceptionMicroInteractionV2Provider> secondFixture = CreateMicroFixture(enabled: true);
        SecurityChallengeProviderIssueResult secondIssued = await secondFixture.Provider.IssueAsync(
            CreateIssueRequest(PerceptionMicroInteractionV2Provider.WireKind, escalationLevel: 3),
            CancellationToken.None);
        Dictionary<string, string> wrongPayload = CreateMicroVerifyPayload(
            secondIssued.ProviderPayload,
            "click:72,64|click:260,128",
            solveDurationMs: 3200);
        SecurityChallengeProviderVerifyResult rejected = await secondFixture.Provider.VerifyAsync(
            CreateVerifyRequest(PerceptionMicroInteractionV2Provider.WireKind, secondIssued.Assignment!.ChallengeId, wrongPayload),
            CancellationToken.None);

        Assert.True(accepted.Succeeded, accepted.Reason);
        AssertGenericFailed(rejected);
        Assert.Equal("perception_steps_invalid", Assert.Single(secondFixture.Persistence.Attempts).Reason);
    }

    [Fact]
    public void RiskDecision_MicroInteractionSubsystemGateDefaultsDisabledAndAllowsHighRiskWhenEnabled()
    {
        SecurityRiskActionPolicy authPolicy = CreateMicroPolicy();
        SecurityRiskPolicySnapshotV2 disabled = CreateRiskPolicy(authPolicy, SecuritySystemModes.Disabled);
        SecurityRiskPolicySnapshotV2 enabled = CreateRiskPolicy(authPolicy, SecuritySystemModes.Enforce);
        var service = new RiskDecisionService();

        RiskDecision disabledDecision = service.Decide(CreateRiskContext(RiskActionNames.AuthLogin), disabled, 75);
        RiskDecision enabledDecision = service.Decide(CreateRiskContext(RiskActionNames.AuthLogin), enabled, 75);

        Assert.Equal(RiskDecisionKind.Allow, disabledDecision.Kind);
        Assert.Empty(disabledDecision.RequiredChallenges);
        Assert.Contains("perception_micro_interaction_disabled", disabledDecision.Reasons);
        Assert.Contains("challenge_subsystems_disabled", disabledDecision.Reasons);
        Assert.Equal(RiskDecisionKind.Challenge, enabledDecision.Kind);
        Assert.Equal(["perceptionMicroInteractionV2"], enabledDecision.RequiredChallenges);
        Assert.Equal(3, enabledDecision.EscalationLevel);
    }

    [Fact]
    public void StandaloneFactory_RejectsMissingPerceptionSealedTokenKeys()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>())
            .Build();

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => InvokeStandaloneCreateIssueService(configuration));

        Assert.Contains("Security:PerceptionSealedToken:Keys", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void StandaloneFactory_RejectsStalePerceptionSealedTokenCurrentKeyVersion()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Security:PerceptionSealedToken:CurrentKeyVersion"] = "k2",
                ["Security:PerceptionSealedToken:Keys:k1"] = new string('a', 64)
            })
            .Build();

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => InvokeStandaloneCreateIssueService(configuration));

        Assert.Contains("Security:PerceptionSealedToken:CurrentKeyVersion", exception.Message, StringComparison.Ordinal);
        Assert.Contains("k2", exception.Message, StringComparison.Ordinal);
    }

    private static ProviderFixture<PerceptionTextTaskV2Provider> CreateTextFixture()
    {
        var persistence = new RecordingChallengePersistence();
        var riskSink = new CapturingRiskSink();
        var gate = new RecordingPerceptionRedisGate();
        var clock = new MutableTimeProvider(s_baselineNow);
        IConfiguration configuration = CreateConfiguration();
        IPerceptionChallengeV2IssueService issueService = CreateIssueService(configuration, clock, out IPerceptionChallengeV2TokenProtector tokenProtector);
        var verifyService = new PerceptionChallengeV2VerifyService(
            tokenProtector,
            gate,
            riskSink,
            new DirectChallengeV2AuditEventWriter(persistence),
            clock);
        var provider = new PerceptionTextTaskV2Provider(issueService, verifyService);
        return new ProviderFixture<PerceptionTextTaskV2Provider>(provider, gate, persistence, riskSink, clock);
    }

    private static ProviderFixture<PerceptionLocalizationV2Provider> CreateLocalizationFixture()
    {
        var persistence = new RecordingChallengePersistence();
        var riskSink = new CapturingRiskSink();
        var gate = new RecordingPerceptionRedisGate();
        var clock = new MutableTimeProvider(s_baselineNow);
        IConfiguration configuration = CreateConfiguration();
        IPerceptionChallengeV2IssueService issueService = CreateIssueService(configuration, clock, out IPerceptionChallengeV2TokenProtector tokenProtector);
        var verifyService = new PerceptionChallengeV2VerifyService(
            tokenProtector,
            gate,
            riskSink,
            new DirectChallengeV2AuditEventWriter(persistence),
            clock);
        var provider = new PerceptionLocalizationV2Provider(issueService, verifyService);
        return new ProviderFixture<PerceptionLocalizationV2Provider>(provider, gate, persistence, riskSink, clock);
    }

    private static ProviderFixture<PerceptionMicroInteractionV2Provider> CreateMicroFixture(bool enabled)
    {
        var persistence = new RecordingChallengePersistence();
        var riskSink = new CapturingRiskSink();
        var gate = new RecordingPerceptionRedisGate();
        var clock = new MutableTimeProvider(s_baselineNow);
        IConfiguration configuration = CreateConfiguration(enabled);
        IPerceptionChallengeV2IssueService issueService = CreateIssueService(configuration, clock, out IPerceptionChallengeV2TokenProtector tokenProtector);
        var verifyService = new PerceptionChallengeV2VerifyService(
            tokenProtector,
            gate,
            riskSink,
            new DirectChallengeV2AuditEventWriter(persistence),
            clock);
        var provider = new PerceptionMicroInteractionV2Provider(issueService, verifyService, configuration);
        return new ProviderFixture<PerceptionMicroInteractionV2Provider>(provider, gate, persistence, riskSink, clock);
    }

    private static IPerceptionChallengeV2IssueService CreateIssueService(
        IConfiguration configuration,
        TimeProvider clock,
        out IPerceptionChallengeV2TokenProtector tokenProtector)
    {
        var taskSource = new DefaultPerceptionChallengeV2TaskSource(configuration);
        var tokenService = new PerceptionSealedTokenService(
            new StaticOptionsMonitor<PerceptionSealedTokenOptions>(
                new PerceptionSealedTokenOptions
                {
                    CurrentKeyVersion = "current",
                    Keys = new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["current"] = Convert.ToBase64String(Enumerable.Repeat((byte)7, 32).ToArray())
                    }
                }),
            clock);
        tokenProtector = new PerceptionChallengeV2TokenProtector(tokenService);
        return new PerceptionChallengeV2IssueService(taskSource, tokenProtector, clock);
    }

    private static object InvokeStandaloneCreateIssueService(IConfiguration configuration)
    {
        Type factoryType = typeof(PerceptionTextTaskV2Provider).Assembly.GetType(
            "FsusBlog.Server.Services.Security.PerceptionChallengeV2StandaloneFactory")!;
        MethodInfo method = factoryType.GetMethod("CreateIssueService", BindingFlags.Public | BindingFlags.Static)!;

        try
        {
            return method.Invoke(null, [configuration, new MutableTimeProvider(s_baselineNow)])!;
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            throw exception.InnerException;
        }
    }

    private static IConfiguration CreateConfiguration(bool microInteractionEnabled = true)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Jwt:SecretKey"] = TestSecrets.SecondaryJwtSigningKey,
                ["Security:PerceptionV2:SigningKey"] = "perception-unit-test-signing-key-with-enough-entropy",
                ["Security:PerceptionV2:TextTask:FixedText"] = "F7KA2",
                ["Security:PerceptionV2:Localization:FixedX"] = "192",
                ["Security:PerceptionV2:Localization:FixedY"] = "128",
                ["Security:PerceptionV2:MicroInteraction:Mode"] = microInteractionEnabled ? SecuritySystemModes.Enforce : SecuritySystemModes.Disabled,
                ["Security:PerceptionV2:MicroInteraction:FixedSteps"] = "click:72,64|click:224,128"
            })
            .Build();

    private static SecurityChallengeProviderIssueRequest CreateIssueRequest(string kind, int escalationLevel)
        => new(
            CreateContext(),
            kind,
            "auth.login",
            "/api/binary/auth/login",
            "tenant-main",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            escalationLevel,
            Traceparent);

    private static SecurityChallengeProviderVerifyRequest CreateVerifyRequest(
        string kind,
        string challengeId,
        IReadOnlyDictionary<string, string> payload)
        => new(
            CreateContext(),
            kind,
            challengeId,
            "auth.login",
            "/api/binary/auth/login",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            payload);

    private static Dictionary<string, string> CreateTextVerifyPayload(
        IReadOnlyDictionary<string, string> issuePayload,
        string answerText,
        int solveDurationMs)
    {
        var payload = new Dictionary<string, string>(issuePayload, StringComparer.Ordinal)
        {
            ["answerText"] = answerText,
            ["solveDurationMs"] = solveDurationMs.ToString(System.Globalization.CultureInfo.InvariantCulture)
        };
        return payload;
    }

    private static Dictionary<string, string> CreateLocalizationVerifyPayload(
        IReadOnlyDictionary<string, string> issuePayload,
        int x,
        int y,
        int solveDurationMs)
    {
        var payload = new Dictionary<string, string>(issuePayload, StringComparer.Ordinal)
        {
            ["x"] = x.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["y"] = y.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["solveDurationMs"] = solveDurationMs.ToString(System.Globalization.CultureInfo.InvariantCulture)
        };
        return payload;
    }

    private static Dictionary<string, string> CreateMicroVerifyPayload(
        IReadOnlyDictionary<string, string> issuePayload,
        string stepSummary,
        int solveDurationMs)
    {
        var payload = new Dictionary<string, string>(issuePayload, StringComparer.Ordinal)
        {
            ["stepSummary"] = stepSummary,
            ["x"] = "224",
            ["y"] = "128",
            ["solveDurationMs"] = solveDurationMs.ToString(System.Globalization.CultureInfo.InvariantCulture)
        };
        return payload;
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.44");
        context.TraceIdentifier = "trace-unit";
        context.Request.Headers.UserAgent = "Mozilla/5.0 (X11; Linux x86_64)";
        context.Request.Headers["traceparent"] = Traceparent;
        return context;
    }

    private static void AssertRegistered<TProvider>(IServiceCollection services)
    {
        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(ISecurityChallengeProvider)
                && item.ImplementationType == typeof(TProvider));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
    }

    private static void AssertValidRecipe(
        IReadOnlyDictionary<string, string> providerPayload,
        RenderRecipeV2TaskKind taskKind)
    {
        Assert.True(providerPayload.TryGetValue("recipeJson", out string? recipeJson));
        Assert.True(providerPayload.TryGetValue("recipeHashHex", out string? recipeHashHex));
        RenderRecipeV2ValidationResult validation = RenderRecipeV2Contracts.ValidateRecipeJson(recipeJson, recipeHashHex);
        Assert.True(validation.IsValid, validation.ErrorCode);
        Assert.Matches("^[0-9a-f]{64}$", recipeHashHex);
        Assert.Contains($@"""taskKind"":""{ExpectedTaskKindJson(taskKind)}""", recipeJson, StringComparison.Ordinal);
    }

    private static string ExpectedTaskKindJson(RenderRecipeV2TaskKind taskKind)
        => taskKind switch
        {
            RenderRecipeV2TaskKind.Character => "character",
            RenderRecipeV2TaskKind.Localization => "localization",
            RenderRecipeV2TaskKind.MicroInteraction => "microInteraction",
            _ => "unknown"
        };

    private static void AssertNoPayloadLeak(IReadOnlyDictionary<string, string> providerPayload, string secret)
    {
        foreach (KeyValuePair<string, string> item in providerPayload)
        {
            Assert.DoesNotContain("expected", item.Key, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("glyph", item.Key, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("charId", item.Key, StringComparison.OrdinalIgnoreCase);
            if (!IsOpaqueBindingField(item.Key))
            {
                Assert.DoesNotContain(secret, item.Value, StringComparison.OrdinalIgnoreCase);
            }
        }

        Assert.True(providerPayload.TryGetValue("sealedToken", out string? sealedToken));
        Assert.False(string.IsNullOrWhiteSpace(sealedToken));
    }

    private static bool IsOpaqueBindingField(string key)
        => string.Equals(key, "sealedToken", StringComparison.Ordinal)
            || string.Equals(key, "signatureHex", StringComparison.Ordinal)
            || string.Equals(key, "recipeHashHex", StringComparison.Ordinal);

    private static void AssertGenericFailed(SecurityChallengeProviderVerifyResult result)
    {
        Assert.False(result.Succeeded);
        Assert.Equal("perception_challenge_failed", result.Reason);
    }

    private static SecurityRiskActionPolicy CreateMicroPolicy()
        => new(
            RiskActionNames.AuthLogin,
            new SecurityRiskActionThresholds(49, 50, 75, 100, 100),
            "captchaV1",
            1,
            null,
            AnonymousWriteAllowed: false)
        {
            HardChallengeKinds = ["perceptionMicroInteractionV2"],
            HardChallengeEscalationLevel = 3
        };

    private static SecurityRiskPolicySnapshotV2 CreateRiskPolicy(SecurityRiskActionPolicy authPolicy, string microMode)
    {
        SecurityRiskActionPolicy defaultAction = new(
            "*",
            new SecurityRiskActionThresholds(49, 50, 75, 100, 100),
            "captchaV1",
            1,
            null,
            AnonymousWriteAllowed: false);
        return new SecurityRiskPolicySnapshotV2(
            "risk:test",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
            DateTimeOffset.UnixEpoch,
            SecuritySystemModes.Enforce,
            200,
            125,
            "risk:lkg",
            defaultAction,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.AuthLogin] = authPolicy
            },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.Captcha] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.PerceptionMicroInteraction] = microMode
            });
    }

    private static RiskControlContext CreateRiskContext(string actionName)
        => new(
            actionName,
            actionName,
            RiskControlContextStatuses.Resolved,
            "198.51.100.44",
            "Mozilla/5.0",
            RiskControlContextStatuses.Present,
            new RiskControlActorContext(
                RiskControlActorStatuses.Anonymous,
                RiskControlIdentityKinds.Anonymous,
                null,
                null,
                null,
                null,
                null),
            new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Missing, 0, null, "missing"),
            new RiskControlRegionContext(RiskControlContextStatuses.Missing, "UNKNOWN", null, "missing"),
            VerifiedCrawler: false,
            SocialPreviewBot: false);

    private sealed record ProviderFixture<TProvider>(
        TProvider Provider,
        RecordingPerceptionRedisGate Gate,
        RecordingChallengePersistence Persistence,
        CapturingRiskSink RiskSink,
        MutableTimeProvider Clock)
        where TProvider : ISecurityChallengeProvider;

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

    private sealed class NoopChallengeV2AuditEventWriter : IChallengeV2AuditEventWriter
    {
        public ValueTask WriteAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;
    }

    private sealed class RecordingPerceptionVerifyService : IPerceptionChallengeV2VerifyService
    {
        public List<PerceptionChallengeV2VerifyRequest> Requests { get; } = [];

        public PerceptionChallengeV2VerifyResult Result
        {
            get; init;
        } =
            PerceptionChallengeV2VerifyResult.Success(s_baselineNow.AddMinutes(5));

        public Task<PerceptionChallengeV2VerifyResult> VerifyAsync(
            PerceptionChallengeV2VerifyRequest request,
            CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            return Task.FromResult(Result);
        }
    }

    private sealed class RecordingPerceptionRedisGate : IPerceptionChallengeV2RedisGate
    {
        private readonly HashSet<string> _consumed = new(StringComparer.Ordinal);

        public Dictionary<string, long> AttemptCounts { get; } = new(StringComparer.Ordinal);

        public List<string> AttemptChallengeIds { get; } = [];

        public List<string> ConsumeChallengeIds { get; } = [];

        public Task<PerceptionChallengeV2AttemptGateResult> RegisterAttemptAsync(
            string challengeId,
            DateTimeOffset expiresAt,
            int maxAttempts,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AttemptChallengeIds.Add(challengeId);
            AttemptCounts.TryGetValue(challengeId, out long current);
            long next = current + 1;
            AttemptCounts[challengeId] = next;
            return Task.FromResult(next <= Math.Max(1, maxAttempts)
                ? PerceptionChallengeV2AttemptGateResult.Accepted(next)
                : PerceptionChallengeV2AttemptGateResult.Rejected("attempt_exceeded", next));
        }

        public Task<PerceptionChallengeV2ConsumeResult> TryConsumeOnceAsync(
            string challengeId,
            DateTimeOffset expiresAt,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ConsumeChallengeIds.Add(challengeId);
            return Task.FromResult(_consumed.Add(challengeId)
                ? PerceptionChallengeV2ConsumeResult.ConsumedOnce
                : PerceptionChallengeV2ConsumeResult.Replayed);
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

    private sealed class RecordingCache : IUnifiedCache
    {
        public ConcurrentDictionary<string, string> Strings { get; } = new(StringComparer.Ordinal);

        public ConcurrentDictionary<string, long> Counters { get; } = new(StringComparer.Ordinal);

        public bool HasIdentity(CachePolicyId policyId, string identity)
            => Strings.ContainsKey($"{policyId}:{identity}");

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            Strings[$"{policyId}:{identity}"] = value;
            return Task.CompletedTask;
        }

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(Strings.TryRemove($"{policyId}:{identity}", out _));

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => Task.FromResult(Strings.TryGetValue($"{policyId}:{identity}", out string? value) ? value : null);

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => Task.FromResult(Strings.TryAdd($"{policyId}:{identity}", value));

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
            => Task.FromResult(Counters.AddOrUpdate($"{policyId}:{identity}", value, (_, current) => current + value));

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

    private sealed class StaticOptionsMonitor<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue { get; } = value;

        public T Get(string? name) => CurrentValue;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Messages.Add(formatter(state, exception));
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose()
        {
        }
    }
}
