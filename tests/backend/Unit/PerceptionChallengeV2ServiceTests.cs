using System.Globalization;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using StackExchange.Redis;
using FsusBlog.Shared.Contracts.Governance;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PerceptionChallengeV2ServiceTests
{
    private static readonly DateTimeOffset s_baselineNow = DateTimeOffset.Parse("2026-06-19T08:00:00Z", CultureInfo.InvariantCulture);
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_ReturnsSealedStatelessPayloadWithoutSemanticRecipeLeak()
    {
        var taskSource = new FakeTaskSource(CreateTaskMaterial(RenderRecipeV2TaskKind.MicroInteraction, step: "drag:confirm"));
        var protector = new FakeTokenProtector();
        var clock = new MutableTimeProvider(s_baselineNow);
        var service = new PerceptionChallengeV2IssueService(taskSource, protector, clock);

        PerceptionChallengeV2IssueResult result = await service.IssueAsync(CreateIssueRequest(), CancellationToken.None);

        Assert.True(result.Succeeded, result.Reason);
        Assert.NotNull(result.Assignment);
        Assert.Equal(PerceptionChallengeV2Constants.WireAlgorithm, result.Payload.Algorithm);
        Assert.Equal(RenderRecipeV2TaskKind.MicroInteraction, result.Payload.TaskKind);
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
        Assert.Equal(RenderRecipeV2TaskKind.MicroInteraction, protector.LastSealClaims.TaskKind);
        Assert.Equal(result.Payload.RecipeHashHex, protector.LastSealClaims.RecipeHashHex);
        Assert.Equal(result.Payload.Family, protector.LastSealClaims.Family);
        Assert.Equal(result.Payload.Variant, protector.LastSealClaims.Variant);
        Assert.Matches("^[0-9a-f]{64}$", protector.LastSealClaims.ExpectedStepHashHex);
        Assert.Equal(0.5, protector.LastSealClaims.ExpectedX);
        Assert.Single(taskSource.Requests);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task IssueAsync_UsesGeneratorPolicyForFamilyVariantAndPassesSelectionToRecipeAndToken()
    {
        var taskSource = new FakeTaskSource(CreateTaskMaterial(RenderRecipeV2TaskKind.MicroInteraction, step: "drag:confirm"));
        var protector = new FakeTokenProtector();
        var clock = new MutableTimeProvider(s_baselineNow);
        var service = new PerceptionChallengeV2IssueService(taskSource, protector, clock);
        PerceptionChallengeGeneratorDistributionPolicy policy = CreateGeneratorPolicy(
            new PerceptionChallengeGeneratorFamilyPolicy(
                "localization-field",
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void GeneratorSelector_AppliesWeightedActionRiskAndRedTeamPolicyWithFallback()
    {
        PerceptionChallengeGeneratorDistributionPolicy policy = CreateGeneratorPolicy(
            new PerceptionChallengeGeneratorFamilyPolicy(
                "localization-field",
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
                        ["localization-field"] = 0,
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void GeneratorSelector_PickRejectsEmptyCandidatesWithClearError()
    {
        Type weightedVariantType = GetWeightedVariantType();
        Array candidates = Array.CreateInstance(weightedVariantType, 0);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => InvokeWeightedPick(candidates));

        Assert.Contains("candidate set is empty", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void GeneratorSelector_PickReturnsSingleCandidate()
    {
        Type weightedVariantType = GetWeightedVariantType();
        Array candidates = Array.CreateInstance(weightedVariantType, 1);
        object candidate = Activator.CreateInstance(
            weightedVariantType,
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            binder: null,
            args: ["single-variant", 100],
            culture: null)!;
        candidates.SetValue(candidate, 0);

        object selected = InvokeWeightedPick(candidates);

        Assert.Same(candidate, selected);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task DefaultTaskSource_BuildsDistinctRecipeStructuresForSupportedFamilies()
    {
        var source = new DefaultPerceptionChallengeV2TaskSource(CreatePerceptionGeneratorConfiguration());
        var hashes = new HashSet<string>(StringComparer.Ordinal);
        var signatures = new HashSet<string>(StringComparer.Ordinal);

        foreach (string family in PerceptionChallengeV2GeneratorFamilyRegistry.SupportedFamilies)
        {
            string variant = PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(family);
            RenderRecipeV2TaskKind taskKind = family == PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField
                ? RenderRecipeV2TaskKind.Localization
                : RenderRecipeV2TaskKind.MicroInteraction;

            PerceptionChallengeV2TaskMaterial material = await source.CreateAsync(
                CreateTaskSourceRequest(taskKind, family, variant),
                CancellationToken.None);
            RenderRecipeV2ValidationResult validation = RenderRecipeV2Contracts.ValidateRecipe(material.Recipe);

            Assert.True(validation.IsValid, $"{family}:{validation.ErrorCode}");
            Assert.Equal(taskKind, material.TaskKind);
            Assert.True(hashes.Add(validation.RecipeHashHex), $"duplicate recipe hash for {family}");
            Assert.True(signatures.Add(RecipeStructuralSignature(material.Recipe)), $"duplicate recipe structure for {family}");
            AssertFamilySpecificStructure(family, material);
        }
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task DefaultTaskSource_VariantChangesStructureAndRecipeHash()
    {
        var source = new DefaultPerceptionChallengeV2TaskSource(CreatePerceptionGeneratorConfiguration());

        foreach (string family in PerceptionChallengeV2GeneratorFamilyRegistry.SupportedFamilies)
        {
            string[] variants = PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariants(family)
                .Select(static variant => variant.Variant)
                .Take(2)
                .ToArray();
            Assert.True(variants.Length >= 2, $"{family} must expose at least two variants");
            RenderRecipeV2TaskKind taskKind = family == PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField
                ? RenderRecipeV2TaskKind.Localization
                : RenderRecipeV2TaskKind.MicroInteraction;

            PerceptionChallengeV2TaskMaterial first = await source.CreateAsync(
                CreateTaskSourceRequest(taskKind, family, variants[0]),
                CancellationToken.None);
            PerceptionChallengeV2TaskMaterial second = await source.CreateAsync(
                CreateTaskSourceRequest(taskKind, family, variants[1]),
                CancellationToken.None);
            string firstHash = RenderRecipeV2Contracts.ComputeRecipeHashHex(first.Recipe);
            string secondHash = RenderRecipeV2Contracts.ComputeRecipeHashHex(second.Recipe);

            Assert.NotEqual(firstHash, secondHash);
            Assert.NotEqual(RecipeStructuralSignature(first.Recipe), RecipeStructuralSignature(second.Recipe));
            Assert.True(RenderRecipeV2Contracts.ValidateRecipe(first.Recipe, firstHash).IsValid);
            Assert.True(RenderRecipeV2Contracts.ValidateRecipe(second.Recipe, secondHash).IsValid);
        }
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task DefaultTaskSource_LocalizationTargetIsBoundToVisualMaterialWithoutMetadataLeak()
    {
        var source = new DefaultPerceptionChallengeV2TaskSource(CreatePerceptionGeneratorConfiguration());

        PerceptionChallengeV2TaskMaterial material = await source.CreateAsync(
            CreateTaskSourceRequest(
                RenderRecipeV2TaskKind.Localization,
                PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField,
                "anchor-region"),
            CancellationToken.None);

        Assert.Equal(0.62, material.ExpectedX!.Value);
        Assert.Equal(0.45, material.ExpectedY!.Value);
        Assert.True(HasPrimitiveNear(material.Recipe, material.ExpectedX!.Value, material.ExpectedY!.Value, 0.03));
        string recipeJson = JsonSerializer.Serialize(material.Recipe);
        Assert.DoesNotContain("expected", recipeJson, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("target", recipeJson, StringComparison.OrdinalIgnoreCase);
        Assert.True(RenderRecipeV2Contracts.ValidateRecipe(material.Recipe).IsValid);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task DefaultTaskSource_RecipeHashRejectsStructuralTampering()
    {
        var source = new DefaultPerceptionChallengeV2TaskSource(CreatePerceptionGeneratorConfiguration());
        PerceptionChallengeV2TaskMaterial material = await source.CreateAsync(
            CreateTaskSourceRequest(
                RenderRecipeV2TaskKind.MicroInteraction,
                PerceptionChallengeV2GeneratorFamilyRegistry.PiecewiseWarp,
                "warp-tiled"),
            CancellationToken.None);
        string recipeHash = RenderRecipeV2Contracts.ComputeRecipeHashHex(material.Recipe);
        RenderRecipeV2Layer firstLayer = material.Recipe.Layers[0];
        RenderRecipeV2 tampered = material.Recipe with
        {
            Layers =
            [
                firstLayer with
                {
                    WarpFields =
                    [
                        firstLayer.WarpFields[0] with { Amplitude = firstLayer.WarpFields[0].Amplitude + 0.01 },
                        .. firstLayer.WarpFields.Skip(1)
                    ]
                },
                .. material.Recipe.Layers.Skip(1)
            ]
        };

        RenderRecipeV2ValidationResult result = RenderRecipeV2Contracts.ValidateRecipe(tampered, recipeHash);

        Assert.False(result.IsValid);
        Assert.Equal("recipe_hash_mismatch", result.ErrorCode);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_AcceptsCharacterAnswerThroughAttemptGateAndReturnsProofExpiry()
    {
        PerceptionChallengeV2TokenClaims claims = CreateClaims(RenderRecipeV2TaskKind.MicroInteraction) with
        {
            ExpectedStepHashHex = PerceptionChallengeV2Hashing.HashStepHex("K7M2")
        };
        var fixture = CreateVerifyFixture(claims);
        Dictionary<string, string> payload = CreateProviderPayload(claims);
        payload["stepSummary"] = " k7m2 ";
        payload["x"] = "0.5";
        payload["y"] = "0.5";
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_RejectsSealedTokenBindingMismatches(string field, string expectedReason)
    {
        PerceptionChallengeV2TokenClaims claims = CreateClaims(RenderRecipeV2TaskKind.MicroInteraction) with
        {
            ExpectedStepHashHex = PerceptionChallengeV2Hashing.HashStepHex("K7M2")
        };
        var fixture = CreateVerifyFixture(MutateClaims(claims, field));
        Dictionary<string, string> payload = CreateProviderPayload(claims);
        payload["stepSummary"] = "K7M2";
        payload["x"] = "0.5";
        payload["y"] = "0.5";
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_RedisAttemptAndReplayFailuresFailClosedAndWriteRisk(
        string gateReason,
        string expectedReason,
        string riskDetail)
    {
        PerceptionChallengeV2TokenClaims claims = CreateClaims(RenderRecipeV2TaskKind.MicroInteraction) with
        {
            ExpectedStepHashHex = PerceptionChallengeV2Hashing.HashStepHex("K7M2")
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
        payload["stepSummary"] = "K7M2";
        payload["x"] = "0.5";
        payload["y"] = "0.5";
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task RedisGate_UsesSpecifiedKeysSetNxIncrementAndExpiryAlignedToChallengeWindow()
    {
        var database = Substitute.For<IDatabase>();
        string? attemptScript = null;
        RedisKey[]? attemptKeys = null;
        RedisValue[]? attemptValues = null;
        database.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                attemptScript = call.ArgAt<string>(0);
                attemptKeys = call.ArgAt<RedisKey[]>(1);
                attemptValues = call.ArgAt<RedisValue[]>(2);
                return Task.FromResult(RedisResult.Create((RedisValue)1L));
            });
        database.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        var clock = new MutableTimeProvider(s_baselineNow);
        var gate = new RedisPerceptionChallengeV2Gate(redis, new DefaultRuntimeKeyScope(), clock);
        DateTimeOffset expiresAt = s_baselineNow.AddMinutes(5);

        PerceptionChallengeV2AttemptGateResult attempt = await gate.RegisterAttemptAsync("challenge-1", expiresAt, 3, CancellationToken.None);
        PerceptionChallengeV2ConsumeResult consume = await gate.TryConsumeOnceAsync("challenge-1", expiresAt, CancellationToken.None);

        Assert.True(attempt.Allowed, attempt.Reason);
        Assert.True(consume.Consumed, consume.Reason);
        Assert.NotNull(attemptScript);
        Assert.Contains("redis.call('INCR'", attemptScript, StringComparison.Ordinal);
        Assert.Contains("redis.call('PEXPIRE'", attemptScript, StringComparison.Ordinal);
        RedisKey attemptKey = Assert.Single(attemptKeys!);
        Assert.Equal("security:challenge:v2:attempt:challenge-1", attemptKey.ToString());
        RedisValue ttlValue = Assert.Single(attemptValues!);
        Assert.Equal(
            (long)TimeSpan.FromMinutes(5).Add(PerceptionChallengeV2Constants.ClockSkew).TotalMilliseconds,
            (long)ttlValue);
        await database.Received(1).StringSetAsync(
            Arg.Is<RedisKey>(key => key.ToString() == "security:challenge:v2:used:challenge-1"),
            Arg.Is<RedisValue>(value => value.ToString() == "1"),
            Arg.Is<TimeSpan?>(ttl => ttl.HasValue && ttl.Value == TimeSpan.FromMinutes(5).Add(PerceptionChallengeV2Constants.ClockSkew)),
            When.NotExists,
            Arg.Any<CommandFlags>());
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task RedisGate_AttemptCounterUsesSingleRedisScript()
    {
        var database = Substitute.For<IDatabase>();
        database.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(RedisResult.Create((RedisValue)1L)));
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        var gate = new RedisPerceptionChallengeV2Gate(
            redis,
            new DefaultRuntimeKeyScope(),
            new MutableTimeProvider(s_baselineNow));

        PerceptionChallengeV2AttemptGateResult result = await gate.RegisterAttemptAsync(
            "challenge-script-contract",
            s_baselineNow.AddMinutes(5),
            maxAttempts: 3,
            CancellationToken.None);

        Assert.True(result.Allowed, result.Reason);
        var scriptCall = Assert.Single(database.ReceivedCalls(), static call =>
            call.GetMethodInfo().Name == nameof(IDatabase.ScriptEvaluateAsync));
        string script = Assert.IsType<string>(scriptCall.GetArguments()[0]);
        Assert.Contains("redis.call('INCR'", script, StringComparison.Ordinal);
        Assert.Contains("redis.call('PEXPIRE'", script, StringComparison.Ordinal);
        string[] callNames = database.ReceivedCalls().Select(static call => call.GetMethodInfo().Name).ToArray();
        Assert.DoesNotContain("StringIncrementAsync", callNames);
        Assert.DoesNotContain("KeyExpireAsync", callNames);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
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
            RenderRecipeV2TaskKind.MicroInteraction);

    private static PerceptionChallengeV2VerifyRequest CreateVerifyRequest(IReadOnlyDictionary<string, string> payload)
        => new(
            CreateContext(),
            PerceptionMicroInteractionV2Provider.WireKind,
            "challenge-1",
            "comment.create",
            "article:42",
            HashA,
            HashB,
            HashC,
            "risk-policy-v2",
            payload);

    private static PerceptionChallengeV2TaskSourceRequest CreateTaskSourceRequest(
        RenderRecipeV2TaskKind taskKind,
        string family,
        string variant)
        => new(
            CreateContext(),
            taskKind,
            "comment.create",
            "article:42",
            "risk-policy-v2")
        {
            Family = family,
            Variant = variant
        };

    private static IConfiguration CreatePerceptionGeneratorConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>(StringComparer.Ordinal)
            {
                ["Security:PerceptionV2:MicroInteraction:FixedSteps"] = "drag:0.68,0.36",
                ["Security:PerceptionV2:Localization:FixedX"] = "0.62",
                ["Security:PerceptionV2:Localization:FixedY"] = "0.45",
                ["Security:PerceptionV2:MicroInteraction:FixedSteps"] = "drag:0.68,0.36",
                ["Security:PerceptionV2:Generator:FixedSeed"] = "unit-perception-seed"
            })
            .Build();

    private static string RecipeStructuralSignature(RenderRecipeV2 recipe)
        => string.Join(
            '|',
            recipe.Layers.Count,
            string.Join(
                ';',
                recipe.Layers.Select(static layer => string.Join(
                    ',',
                    layer.LayerId,
                    layer.StrokeSegments.Count,
                    layer.StrokeSegments.Sum(static stroke => stroke.Points.Count),
                    layer.StrokeSegments.Sum(static stroke => stroke.Width).ToString("0.0000", CultureInfo.InvariantCulture),
                    layer.NoiseFields.Count,
                    layer.NoiseFields.Sum(static field => field.Intensity).ToString("0.0000", CultureInfo.InvariantCulture),
                    layer.WarpFields.Count,
                    layer.WarpFields.Sum(static field => field.Amplitude + field.Frequency / 100d).ToString("0.0000", CultureInfo.InvariantCulture),
                    layer.Occluders.Count,
                    string.Join("+", layer.Occluders.Select(static mask => mask.Shape))))),
            recipe.PresentationHints["motionProfile"],
            recipe.PresentationHints["palette"],
            recipe.PresentationHints["contrast"]);

    private static void AssertFamilySpecificStructure(string family, PerceptionChallengeV2TaskMaterial material)
    {
        RenderRecipeV2 recipe = material.Recipe;
        switch (family)
        {
            case PerceptionChallengeV2GeneratorFamilyRegistry.SplineField:
                Assert.Equal(2, recipe.Layers.Count);
                Assert.Contains(recipe.Layers, static layer => layer.LayerId == "spline-guide");
                break;
            case PerceptionChallengeV2GeneratorFamilyRegistry.FourierField:
                Assert.True(recipe.Layers[0].WarpFields.Count >= 2);
                Assert.Contains(recipe.Layers[0].StrokeSegments, static stroke => stroke.SegmentId.StartsWith("wave-", StringComparison.Ordinal));
                break;
            case PerceptionChallengeV2GeneratorFamilyRegistry.PiecewiseWarp:
                Assert.True(recipe.Layers[0].WarpFields.Count >= 2);
                Assert.Contains("warp", recipe.Layers[0].LayerId, StringComparison.Ordinal);
                break;
            case PerceptionChallengeV2GeneratorFamilyRegistry.TopologyCut:
                Assert.Equal(2, recipe.Layers.Count);
                Assert.NotEmpty(recipe.Layers.SelectMany(static layer => layer.Occluders));
                break;
            case PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField:
                Assert.Equal(RenderRecipeV2TaskKind.Localization, recipe.TaskKind);
                Assert.True(HasPrimitiveNear(recipe, material.ExpectedX!.Value, material.ExpectedY!.Value, 0.03));
                break;
        }
    }

    private static bool HasPrimitiveNear(RenderRecipeV2 recipe, double x, double y, double tolerance)
        => recipe.Layers.Any(layer =>
            layer.StrokeSegments.SelectMany(static stroke => stroke.Points).Any(point => IsNear(point.X, point.Y, x, y, tolerance)) ||
            layer.Occluders.Any(mask => IsNear(mask.X, mask.Y, x, y, tolerance)));

    private static bool IsNear(double actualX, double actualY, double expectedX, double expectedY, double tolerance)
        => Math.Abs(actualX - expectedX) <= tolerance && Math.Abs(actualY - expectedY) <= tolerance;

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
        string? step = null)
        => new(
            taskKind,
            CreateRecipe(taskKind),
            ExpectedX: 0.5,
            ExpectedY: 0.5,
            CoordinateTolerance: 0.05,
            ExpectedStep: taskKind == RenderRecipeV2TaskKind.MicroInteraction ? step ?? "drag:confirm" : null);

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
                ["inputMode"] = "pointer"
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
            s_baselineNow,
            s_baselineNow.AddMinutes(5),
            3,
            null,
            0.5,
            0.5,
            0.05);

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

    private static Type GetWeightedVariantType()
        => typeof(PerceptionChallengeV2GeneratorSelector).GetNestedType("WeightedVariant", BindingFlags.NonPublic)!;

    private static object InvokeWeightedPick(Array candidates)
    {
        Type candidateType = candidates.GetType().GetElementType()!;
        MethodInfo pick = typeof(PerceptionChallengeV2GeneratorSelector)
            .GetMethod("Pick", BindingFlags.NonPublic | BindingFlags.Static)!
            .MakeGenericMethod(candidateType);

        try
        {
            return pick.Invoke(null, [candidates, "seed", "variant"])!;
        }
        catch (TargetInvocationException exception) when (exception.InnerException is not null)
        {
            throw exception.InnerException;
        }
    }

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
        var service = new PerceptionChallengeV2VerifyService(protector, gate, riskSink, audit, new MutableTimeProvider(s_baselineNow));
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
        public PerceptionChallengeV2TokenClaims? LastSealClaims
        {
            get; private set;
        }
        public PerceptionChallengeV2TokenClaims? ClaimsToUnseal
        {
            get; init;
        }

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
