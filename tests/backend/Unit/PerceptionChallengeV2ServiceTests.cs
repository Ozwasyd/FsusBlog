using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PerceptionChallengeV2ServiceTests
{
    private static readonly DateTimeOffset BaselineNow = DateTimeOffset.Parse("2026-06-19T08:00:00Z", CultureInfo.InvariantCulture);
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public async Task IssueAsync_ReturnsSealedStatelessPayloadWithoutSemanticRecipeLeak()
    {
        var taskSource = new FakeTaskSource(CreateTaskMaterial(RenderRecipeV2TaskKind.Character, answer: "K7M2"));
        var protector = new FakeTokenProtector();
        var clock = new MutableTimeProvider(BaselineNow);
        var service = new PerceptionChallengeV2IssueService(taskSource, protector, clock);

        PerceptionChallengeV2IssueResult result = await service.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(PerceptionChallengeV2Constants.WireAlgorithm, result.Payload.Algorithm);
        Assert.Equal(RenderRecipeV2TaskKind.Character, result.Payload.TaskKind);
        Assert.False(string.IsNullOrWhiteSpace(result.Payload.Family));
        Assert.False(string.IsNullOrWhiteSpace(result.Payload.Variant));
        Assert.Equal("sealed-token", result.Payload.SealedToken);
        Assert.Equal("sig-hex", result.Payload.SignatureHex);
        Assert.True(SecurityChallengeContracts.ValidateAssignment(result.Assignment).IsValid);
        Assert.True(RenderRecipeV2Contracts.ValidateRecipe(result.Payload.Recipe, result.Payload.RecipeHashHex).IsValid);
        Assert.DoesNotContain("answer", JsonSerializer.Serialize(result.Payload.Recipe), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("glyph", JsonSerializer.Serialize(result.Payload.Recipe), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("charId", JsonSerializer.Serialize(result.Payload.Recipe), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("K7M2", JsonSerializer.Serialize(result.Payload), StringComparison.Ordinal);
        Assert.True(JsonSerializer.SerializeToUtf8Bytes(result.Payload).Length < 4096);

        Assert.NotNull(protector.LastSealClaims);
        Assert.Equal(result.Assignment.ChallengeId, protector.LastSealClaims.ChallengeId);
        Assert.Equal(RenderRecipeV2TaskKind.Character, protector.LastSealClaims.TaskKind);
        Assert.Equal(result.Payload.RecipeHashHex, protector.LastSealClaims.RecipeHashHex);
        Assert.Equal(result.Payload.Family, protector.LastSealClaims.Family);
        Assert.Equal(result.Payload.Variant, protector.LastSealClaims.Variant);
        Assert.Matches("^[0-9a-f]{64}$", protector.LastSealClaims.ExpectedAnswerHashHex);
        Assert.Null(protector.LastSealClaims.ExpectedStepHashHex);
        Assert.Null(protector.LastSealClaims.ExpectedX);
        Assert.Single(taskSource.Requests);
    }

    [Fact]
    public async Task IssueAsync_UsesGeneratorPolicyForFamilyVariantAndPassesSelectionToRecipeAndToken()
    {
        var taskSource = new FakeTaskSource(CreateTaskMaterial(RenderRecipeV2TaskKind.Character, answer: "K7M2"));
        var protector = new FakeTokenProtector();
        var clock = new MutableTimeProvider(BaselineNow);
        var service = new PerceptionChallengeV2IssueService(taskSource, protector, clock);
        PerceptionChallengeGeneratorDistributionPolicy policy = CreateGeneratorPolicy(
            new PerceptionChallengeGeneratorFamilyPolicy(
                "text-stroke",
                Weight: 0,
                Enabled: true,
                [new PerceptionChallengeGeneratorVariantPolicy("quiet", 100, true)]),
            new PerceptionChallengeGeneratorFamilyPolicy(
                "spline-field",
                Weight: 100,
                Enabled: true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("curve-a", 0, true),
                    new PerceptionChallengeGeneratorVariantPolicy("curve-b", 100, true)
                ]));

        PerceptionChallengeV2IssueResult result = await service.IssueAsync(
            CreateIssueRequest() with
            {
                GeneratorDistributionPolicy = policy,
                EffectiveRiskScore = 45
            },
            CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal("spline-field", result.Payload.Family);
        Assert.Equal("curve-b", result.Payload.Variant);
        Assert.Equal("spline-field", Assert.Single(taskSource.Requests).Family);
        Assert.Equal("curve-b", taskSource.Requests[0].Variant);
        Assert.Equal("spline-field", protector.LastSealClaims!.Family);
        Assert.Equal("curve-b", protector.LastSealClaims.Variant);
        string serializedPayload = JsonSerializer.Serialize(result.Payload);
        Assert.DoesNotContain("K7M2", serializedPayload, StringComparison.Ordinal);
        Assert.DoesNotContain("glyphIds", serializedPayload, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("charIds", serializedPayload, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("expectedPoint", serializedPayload, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GeneratorSelector_AppliesWeightedActionRiskAndRedTeamPolicyWithFallback()
    {
        PerceptionChallengeGeneratorDistributionPolicy policy = CreateGeneratorPolicy(
            new PerceptionChallengeGeneratorFamilyPolicy(
                "text-stroke",
                Weight: 100,
                Enabled: true,
                [new PerceptionChallengeGeneratorVariantPolicy("plain", 100, true)]),
            new PerceptionChallengeGeneratorFamilyPolicy(
                "spline-field",
                Weight: 10,
                Enabled: true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("curve-a", 0, true),
                    new PerceptionChallengeGeneratorVariantPolicy("curve-b", 100, true)
                ]),
            new PerceptionChallengeGeneratorFamilyPolicy(
                "fourier-field",
                Weight: 100,
                Enabled: true,
                [new PerceptionChallengeGeneratorVariantPolicy("phase-a", 100, true)])
            {
                RedTeamPenaltyPercent = 100
            },
            new PerceptionChallengeGeneratorFamilyPolicy(
                "topology-cut",
                Weight: 1,
                Enabled: true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("cut-a", 0, true),
                    new PerceptionChallengeGeneratorVariantPolicy("cut-b", 100, true)
                ]))
        with
        {
            ActionOverrides = new Dictionary<string, PerceptionChallengeGeneratorOverride>(StringComparer.Ordinal)
            {
                ["auth.login"] = new(
                    new Dictionary<string, int>(StringComparer.Ordinal)
                    {
                        ["text-stroke"] = 0,
                        ["spline-field"] = 100
                    },
                    new Dictionary<string, IReadOnlyDictionary<string, int>>(StringComparer.Ordinal))
            },
            RiskOverrides =
            [
                new PerceptionChallengeGeneratorRiskOverride(
                    MinEffectiveRiskScore: 60,
                    MaxEffectiveRiskScore: 1000,
                    new PerceptionChallengeGeneratorOverride(
                        new Dictionary<string, int>(StringComparer.Ordinal)
                        {
                            ["spline-field"] = 0,
                            ["topology-cut"] = 100
                        },
                        new Dictionary<string, IReadOnlyDictionary<string, int>>(StringComparer.Ordinal)),
                    "high_risk_topology_cut")
            ]
        };

        PerceptionChallengeV2GeneratorSelection actionSelection =
            PerceptionChallengeV2GeneratorSelector.Select(policy, "auth.login", 45, "seed-low");
        PerceptionChallengeV2GeneratorSelection riskSelection =
            PerceptionChallengeV2GeneratorSelector.Select(policy, "auth.login", 75, "seed-high");
        PerceptionChallengeV2GeneratorSelection fallbackSelection =
            PerceptionChallengeV2GeneratorSelector.Select(CreateGeneratorPolicy(
                new PerceptionChallengeGeneratorFamilyPolicy(
                    "unsupported-family",
                    Weight: 0,
                    Enabled: false,
                    [])), "auth.login", 75, "seed-fallback");

        Assert.Equal("spline-field", actionSelection.Family);
        Assert.Equal("curve-b", actionSelection.Variant);
        Assert.Equal("topology-cut", riskSelection.Family);
        Assert.Equal("cut-b", riskSelection.Variant);
        Assert.Contains(fallbackSelection.Family, PerceptionChallengeV2GeneratorFamilyRegistry.SupportedFamilies);
        Assert.False(string.IsNullOrWhiteSpace(fallbackSelection.Variant));
    }

    [Fact]
    public async Task VerifyAsync_AcceptsCharacterAnswerThroughAttemptGateAndReturnsProofExpiry()
    {
        PerceptionChallengeV2TokenClaims claims = CreateClaims(RenderRecipeV2TaskKind.Character) with
        {
            ExpectedAnswerHashHex = PerceptionChallengeV2Hashing.HashAnswerHex("K7M2")
        };
        var fixture = CreateVerifyFixture(claims);
        Dictionary<string, string> payload = CreateProviderPayload(claims);
        payload["answerText"] = " k7m2 ";
        payload["solveDurationMs"] = "2400";

        PerceptionChallengeV2VerifyResult result = await fixture.Service.VerifyAsync(
            CreateVerifyRequest(payload),
            CancellationToken.None);

        Assert.True(result.Verified, result.Reason);
        Assert.Equal(claims.ExpiresAt, result.ProofExpiresAt);
        Assert.Equal([claims.ChallengeId], fixture.Gate.AttemptChallengeIds);
        Assert.Equal([claims.ChallengeId], fixture.Gate.ConsumeChallengeIds);
        Assert.Equal("ok", Assert.Single(fixture.Audit.Events).Attempt.Reason);
        Assert.Empty(fixture.RiskSink.Signals);
    }

    [Theory]
    [InlineData("keyVersion", "perception_key_version_mismatch")]
    [InlineData("taskKind", "perception_task_kind_mismatch")]
    [InlineData("challengeId", "perception_challenge_id_mismatch")]
    [InlineData("action", "perception_action_mismatch")]
    [InlineData("routeKey", "perception_route_key_mismatch")]
    [InlineData("subjectHash", "perception_subject_hash_mismatch")]
    [InlineData("clientIpHash", "perception_client_ip_hash_mismatch")]
    [InlineData("deviceFpHash", "perception_device_fp_hash_mismatch")]
    [InlineData("policyVersion", "perception_policy_version_mismatch")]
    [InlineData("recipeHash", "perception_recipe_hash_mismatch")]
    public async Task VerifyAsync_RejectsSealedTokenBindingMismatches(string field, string expectedReason)
    {
        PerceptionChallengeV2TokenClaims claims = CreateClaims(RenderRecipeV2TaskKind.Character) with
        {
            ExpectedAnswerHashHex = PerceptionChallengeV2Hashing.HashAnswerHex("K7M2")
        };
        var fixture = CreateVerifyFixture(MutateClaims(claims, field));
        Dictionary<string, string> payload = CreateProviderPayload(claims);
        payload["answerText"] = "K7M2";
        payload["solveDurationMs"] = "2400";

        PerceptionChallengeV2VerifyResult result = await fixture.Service.VerifyAsync(
            CreateVerifyRequest(payload),
            CancellationToken.None);

        Assert.False(result.Verified);
        Assert.Equal(expectedReason, result.Reason);
        Assert.Empty(fixture.Gate.ConsumeChallengeIds);
        Assert.Equal(expectedReason, Assert.Single(fixture.Audit.Events).Attempt.Reason);
    }

    [Fact]
    public async Task VerifyAsync_CoversLocalizationAndMicroInteractionWithoutImageRecompute()
    {
        PerceptionChallengeV2TokenClaims localizationClaims = CreateClaims(RenderRecipeV2TaskKind.Localization) with
        {
            ExpectedX = 0.42,
            ExpectedY = 0.36,
            CoordinateTolerance = 0.04
        };
        var localization = CreateVerifyFixture(localizationClaims);
        Dictionary<string, string> localizationPayload = CreateProviderPayload(localizationClaims);
        localizationPayload["x"] = "0.44";
        localizationPayload["y"] = "0.34";
        localizationPayload["solveDurationMs"] = "2400";

        PerceptionChallengeV2VerifyResult localizationResult = await localization.Service.VerifyAsync(
            CreateVerifyRequest(localizationPayload),
            CancellationToken.None);

        Assert.True(localizationResult.Verified, localizationResult.Reason);

        PerceptionChallengeV2TokenClaims microClaims = CreateClaims(RenderRecipeV2TaskKind.MicroInteraction) with
        {
            ExpectedStepHashHex = PerceptionChallengeV2Hashing.HashStepHex("drag:confirm"),
            ExpectedX = 0.72,
            ExpectedY = 0.24,
            CoordinateTolerance = 0.05
        };
        var micro = CreateVerifyFixture(microClaims);
        Dictionary<string, string> microPayload = CreateProviderPayload(microClaims);
        microPayload["step"] = "drag:confirm";
        microPayload["x"] = "0.70";
        microPayload["y"] = "0.22";
        microPayload["solveDurationMs"] = "2400";

        PerceptionChallengeV2VerifyResult microResult = await micro.Service.VerifyAsync(
            CreateVerifyRequest(microPayload),
            CancellationToken.None);

        Assert.True(microResult.Verified, microResult.Reason);
        Assert.Empty(localization.TaskSource.Requests);
        Assert.Empty(micro.TaskSource.Requests);
    }

    [Theory]
    [InlineData("attempt_exceeded", "perception_attempt_exceeded", "PerceptionAttemptExceeded")]
    [InlineData("redis_unavailable", "perception_redis_unavailable", "PerceptionRedisUnavailable")]
    [InlineData("challenge_replayed", "perception_replayed", "PerceptionReplay")]
    public async Task VerifyAsync_RedisAttemptAndReplayFailuresFailClosedAndWriteRisk(
        string gateReason,
        string expectedReason,
        string riskDetail)
    {
        PerceptionChallengeV2TokenClaims claims = CreateClaims(RenderRecipeV2TaskKind.Character) with
        {
            ExpectedAnswerHashHex = PerceptionChallengeV2Hashing.HashAnswerHex("K7M2")
        };
        var fixture = CreateVerifyFixture(claims);
        if (gateReason == "challenge_replayed")
        {
            fixture.Gate.ConsumeResult = PerceptionChallengeV2ConsumeResult.Replayed;
        }
        else
        {
            fixture.Gate.AttemptResult = new PerceptionChallengeV2AttemptGateResult(false, gateReason, 4);
        }

        Dictionary<string, string> payload = CreateProviderPayload(claims);
        payload["answerText"] = "K7M2";
        payload["solveDurationMs"] = "2400";

        PerceptionChallengeV2VerifyResult result = await fixture.Service.VerifyAsync(
            CreateVerifyRequest(payload),
            CancellationToken.None);

        Assert.False(result.Verified);
        Assert.Equal(expectedReason, result.Reason);
        Assert.Contains(fixture.RiskSink.Signals, signal => signal.Detail == riskDetail);
        Assert.Equal(expectedReason, Assert.Single(fixture.Audit.Events).Attempt.Reason);
    }

    [Fact]
    public async Task RedisGate_UsesSpecifiedKeysSetNxIncrementAndExpiryAlignedToChallengeWindow()
    {
        var database = Substitute.For<IDatabase>();
        database.StringIncrementAsync(Arg.Any<RedisKey>(), Arg.Any<long>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(1L));
        database.KeyExpireAsync(Arg.Any<RedisKey>(), Arg.Any<TimeSpan?>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        database.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        var clock = new MutableTimeProvider(BaselineNow);
        var gate = new RedisPerceptionChallengeV2Gate(redis, new DefaultRuntimeKeyScope(), clock);
        DateTimeOffset expiresAt = BaselineNow.AddMinutes(5);

        PerceptionChallengeV2AttemptGateResult attempt = await gate.RegisterAttemptAsync("challenge-1", expiresAt, 3, CancellationToken.None);
        PerceptionChallengeV2ConsumeResult consume = await gate.TryConsumeOnceAsync("challenge-1", expiresAt, CancellationToken.None);

        Assert.True(attempt.Allowed, attempt.Reason);
        Assert.True(consume.Consumed, consume.Reason);
        await database.Received(1).StringIncrementAsync(
            Arg.Is<RedisKey>(key => key.ToString() == "security:challenge:v2:attempt:challenge-1"),
            1,
            Arg.Any<CommandFlags>());
        await database.Received(1).KeyExpireAsync(
            Arg.Is<RedisKey>(key => key.ToString() == "security:challenge:v2:attempt:challenge-1"),
            Arg.Is<TimeSpan?>(ttl => ttl.HasValue && ttl.Value == TimeSpan.FromMinutes(5).Add(PerceptionChallengeV2Constants.ClockSkew)),
            Arg.Any<CommandFlags>());
        await database.Received(1).StringSetAsync(
            Arg.Is<RedisKey>(key => key.ToString() == "security:challenge:v2:used:challenge-1"),
            Arg.Is<RedisValue>(value => value.ToString() == "1"),
            Arg.Is<TimeSpan?>(ttl => ttl.HasValue && ttl.Value == TimeSpan.FromMinutes(5).Add(PerceptionChallengeV2Constants.ClockSkew)),
            When.NotExists,
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public void RuntimeServices_RegisterPerceptionChallengeV2Services()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build());

        Assert.Contains(services, static item => item.ServiceType == typeof(IPerceptionChallengeV2IssueService)
            && item.ImplementationType == typeof(PerceptionChallengeV2IssueService)
            && item.Lifetime == ServiceLifetime.Scoped);
        Assert.Contains(services, static item => item.ServiceType == typeof(IPerceptionChallengeV2VerifyService)
            && item.ImplementationType == typeof(PerceptionChallengeV2VerifyService)
            && item.Lifetime == ServiceLifetime.Scoped);
        Assert.Contains(services, static item => item.ServiceType == typeof(IPerceptionChallengeV2RedisGate)
            && item.ImplementationType == typeof(RedisPerceptionChallengeV2Gate)
            && item.Lifetime == ServiceLifetime.Scoped);
    }

    private static PerceptionChallengeV2IssueRequest CreateIssueRequest()
        => new(
            CreateContext(),
            "comment.create",
            "article:42",
            "tenant-main",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            2,
            Traceparent,
            RenderRecipeV2TaskKind.Character);

    private static PerceptionChallengeV2VerifyRequest CreateVerifyRequest(IReadOnlyDictionary<string, string> payload)
        => new(
            CreateContext(),
            PerceptionChallengeV2Constants.WireKind,
            "challenge-1",
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

    private static PerceptionChallengeV2TaskMaterial CreateTaskMaterial(
        RenderRecipeV2TaskKind taskKind,
        string? answer = null)
        => new(
            taskKind,
            CreateRecipe(taskKind),
            answer,
            ExpectedX: taskKind == RenderRecipeV2TaskKind.Character ? null : 0.5,
            ExpectedY: taskKind == RenderRecipeV2TaskKind.Character ? null : 0.5,
            CoordinateTolerance: taskKind == RenderRecipeV2TaskKind.Character ? null : 0.05,
            ExpectedStep: taskKind == RenderRecipeV2TaskKind.MicroInteraction ? "drag:confirm" : null);

    private static RenderRecipeV2 CreateRecipe(RenderRecipeV2TaskKind taskKind)
        => new(
            RenderRecipeV2Contracts.Schema,
            taskKind,
            [
                new RenderRecipeV2Layer(
                    "foreground",
                    0.95,
                    [
                        new RenderStrokeSegmentV2(
                            "stroke-1",
                            "round",
                            "#111827ff",
                            0.04,
                            [new RenderPointV2(0.12, 0.18), new RenderPointV2(0.38, 0.46)])
                    ],
                    [new RenderNoiseFieldV2("grain-a", new string('a', 64), 0.18, 0.16)],
                    [],
                    [])
            ],
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["inputMode"] = taskKind == RenderRecipeV2TaskKind.Character ? "text" : "pointer"
            });

    private static PerceptionChallengeV2TokenClaims CreateClaims(RenderRecipeV2TaskKind taskKind)
        => new(
            "challenge-1",
            SecurityChallengeContracts.ToWireName(PerceptionChallengeV2Contracts.ToChallengeKind(taskKind)),
            PerceptionChallengeV2Constants.WireAlgorithm,
            "k1",
            taskKind,
            "comment.create",
            "article:42",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            BaselineNow,
            BaselineNow.AddMinutes(5),
            3,
            null,
            null,
            null,
            null,
            null);

    private static PerceptionChallengeV2TokenClaims MutateClaims(PerceptionChallengeV2TokenClaims claims, string field)
        => field switch
        {
            "keyVersion" => claims with { KeyVersion = "k2" },
            "taskKind" => claims with { TaskKind = RenderRecipeV2TaskKind.Localization },
            "challengeId" => claims with { ChallengeId = "challenge-2" },
            "action" => claims with { Action = "comment.reply" },
            "routeKey" => claims with { RouteKey = "article:99" },
            "subjectHash" => claims with { SubjectHash = HashB },
            "clientIpHash" => claims with { ClientIpHash = HashA },
            "deviceFpHash" => claims with { DeviceFpHash = HashA },
            "policyVersion" => claims with { PolicyVersion = "risk-policy-v3" },
            "recipeHash" => claims with { RecipeHashHex = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
            _ => claims
        };

    private static PerceptionChallengeGeneratorDistributionPolicy CreateGeneratorPolicy(
        params PerceptionChallengeGeneratorFamilyPolicy[] families)
        => new(
            "unit-generator-policy",
            families);

    private static Dictionary<string, string> CreateProviderPayload(PerceptionChallengeV2TokenClaims claims)
        => new(StringComparer.Ordinal)
        {
            ["algorithm"] = claims.Algorithm,
            ["keyVersion"] = claims.KeyVersion,
            ["taskKind"] = PerceptionChallengeV2Contracts.ToWireTaskKind(claims.TaskKind),
            ["recipeHashHex"] = claims.RecipeHashHex,
            ["sealedToken"] = "sealed-token",
            ["signatureHex"] = "sig-hex",
            ["issuedAtUnixMs"] = claims.IssuedAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture),
            ["expiresAtUnixMs"] = claims.ExpiresAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)
        };

    private static VerifyFixture CreateVerifyFixture(PerceptionChallengeV2TokenClaims claims)
    {
        var protector = new FakeTokenProtector { ClaimsToUnseal = claims };
        var gate = new FakeRedisGate();
        var riskSink = new CapturingRiskSink();
        var taskSource = new FakeTaskSource(CreateTaskMaterial(claims.TaskKind));
        var audit = new RecordingAuditWriter();
        var service = new PerceptionChallengeV2VerifyService(protector, gate, riskSink, audit, new MutableTimeProvider(BaselineNow));
        return new VerifyFixture(service, protector, gate, riskSink, taskSource, audit);
    }

    private sealed record VerifyFixture(
        PerceptionChallengeV2VerifyService Service,
        FakeTokenProtector Protector,
        FakeRedisGate Gate,
        CapturingRiskSink RiskSink,
        FakeTaskSource TaskSource,
        RecordingAuditWriter Audit);

    private sealed class FakeTaskSource(PerceptionChallengeV2TaskMaterial material) : IPerceptionChallengeV2TaskSource
    {
        public List<PerceptionChallengeV2TaskSourceRequest> Requests { get; } = [];

        public Task<PerceptionChallengeV2TaskMaterial> CreateAsync(PerceptionChallengeV2TaskSourceRequest request, CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            return Task.FromResult(material);
        }
    }

    private sealed class FakeTokenProtector : IPerceptionChallengeV2TokenProtector
    {
        public PerceptionChallengeV2TokenClaims? LastSealClaims { get; private set; }
        public PerceptionChallengeV2TokenClaims? ClaimsToUnseal { get; init; }

        public Task<PerceptionChallengeV2SealResult> SealAsync(PerceptionChallengeV2TokenClaims claims, CancellationToken cancellationToken = default)
        {
            LastSealClaims = claims;
            return Task.FromResult(new PerceptionChallengeV2SealResult(true, "ok", "sealed-token", "sig-hex", claims.KeyVersion));
        }

        public Task<PerceptionChallengeV2UnsealResult> UnsealAsync(string sealedToken, string signatureHex, CancellationToken cancellationToken = default)
            => Task.FromResult(ClaimsToUnseal is null
                ? PerceptionChallengeV2UnsealResult.Failed("token_invalid")
                : PerceptionChallengeV2UnsealResult.Success(ClaimsToUnseal));
    }

    private sealed class FakeRedisGate : IPerceptionChallengeV2RedisGate
    {
        public PerceptionChallengeV2AttemptGateResult AttemptResult { get; set; } = PerceptionChallengeV2AttemptGateResult.Accepted(1);
        public PerceptionChallengeV2ConsumeResult ConsumeResult { get; set; } = PerceptionChallengeV2ConsumeResult.ConsumedOnce;
        public List<string> AttemptChallengeIds { get; } = [];
        public List<string> ConsumeChallengeIds { get; } = [];

        public Task<PerceptionChallengeV2AttemptGateResult> RegisterAttemptAsync(string challengeId, DateTimeOffset expiresAt, int maxAttempts, CancellationToken cancellationToken = default)
        {
            AttemptChallengeIds.Add(challengeId);
            return Task.FromResult(AttemptResult);
        }

        public Task<PerceptionChallengeV2ConsumeResult> TryConsumeOnceAsync(string challengeId, DateTimeOffset expiresAt, CancellationToken cancellationToken = default)
        {
            ConsumeChallengeIds.Add(challengeId);
            return Task.FromResult(ConsumeResult);
        }
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

    private sealed class RecordingAuditWriter : IChallengeV2AuditEventWriter
    {
        public List<ChallengeV2AuditEvent> Events { get; } = [];

        public ValueTask WriteAsync(ChallengeV2AuditEvent auditEvent, CancellationToken cancellationToken = default)
        {
            Events.Add(auditEvent);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;
        public override DateTimeOffset GetUtcNow() => UtcNow;
    }
}
