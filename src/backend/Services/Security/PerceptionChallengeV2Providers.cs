using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Services.Security;

public sealed class PerceptionChallengeV2TokenProtector(IPerceptionSealedTokenService sealedTokens)
    : IPerceptionChallengeV2TokenProtector
{
    public Task<PerceptionChallengeV2SealResult> SealAsync(
        PerceptionChallengeV2TokenClaims claims,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(claims);
        cancellationToken.ThrowIfCancellationRequested();

        var payload = new PerceptionSealedTokenPayload(
            claims.ChallengeId,
            PerceptionChallengeV2Contracts.ToWireTaskKind(claims.TaskKind),
            claims.Action,
            claims.RouteKey,
            claims.SubjectHash,
            claims.ClientIpHash,
            claims.DeviceFpHash,
            HashValue(claims.ContextualUserAgentMaterial()),
            claims.Algorithm,
            claims.Family,
            claims.Variant,
            claims.RecipeHashHex,
            claims.ExpectedAnswerHashHex ?? string.Empty,
            claims.ExpectedX.HasValue && claims.ExpectedY.HasValue
                ? PerceptionChallengeV2Hashing.HashPointHex(claims.ExpectedX.Value, claims.ExpectedY.Value)
                : string.Empty,
            CoordinateToleranceToPixels(claims.CoordinateTolerance),
            claims.ExpectedStepHashHex ?? string.Empty,
            claims.IssuedAt.ToUnixTimeMilliseconds(),
            claims.ExpiresAt.ToUnixTimeMilliseconds(),
            claims.MaxAttempts,
            750,
            60_000,
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)),
            claims.KeyVersion,
            claims.PolicyVersion)
        {
            ExpectedX = claims.ExpectedX,
            ExpectedY = claims.ExpectedY,
            CoordinateTolerance = claims.CoordinateTolerance
        };

        string sealedToken = sealedTokens.Seal(payload);
        string signatureHex = HashValue(sealedToken);
        return Task.FromResult(new PerceptionChallengeV2SealResult(true, "ok", sealedToken, signatureHex, payload.KeyVersion));
    }

    public Task<PerceptionChallengeV2UnsealResult> UnsealAsync(
        string sealedToken,
        string signatureHex,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string token = sealedToken ?? string.Empty;
        string expectedSignature = HashValue(token);
        if (!PerceptionChallengeV2Hashing.FixedTimeEqualsHex(signatureHex ?? string.Empty, expectedSignature))
        {
            return Task.FromResult(PerceptionChallengeV2UnsealResult.Failed("token_tampered"));
        }

        PerceptionSealedTokenOpenResult opened = sealedTokens.Open(token);
        if (!opened.Succeeded || opened.Payload is null)
        {
            return Task.FromResult(PerceptionChallengeV2UnsealResult.Failed(opened.Reason));
        }

        PerceptionSealedTokenPayload payload = opened.Payload;
        if (!PerceptionChallengeV2Contracts.TryParseWireTaskKind(payload.TaskKind, out RenderRecipeV2TaskKind taskKind))
        {
            return Task.FromResult(PerceptionChallengeV2UnsealResult.Failed("task_kind_invalid"));
        }

        SecurityChallengeKind challengeKind = PerceptionChallengeV2Contracts.ToChallengeKind(taskKind);
        var claims = new PerceptionChallengeV2TokenClaims(
            payload.ChallengeId,
            SecurityChallengeContracts.ToWireName(challengeKind),
            payload.Algorithm,
            payload.KeyVersion,
            taskKind,
            payload.Action,
            payload.RouteKey,
            payload.SubjectHash,
            payload.ClientIpHash,
            payload.DeviceFpHash,
            payload.PolicyVersion,
            payload.RecipeHashHex,
            DateTimeOffset.FromUnixTimeMilliseconds(payload.IssuedAtUnixMs),
            DateTimeOffset.FromUnixTimeMilliseconds(payload.ExpiresAtUnixMs),
            payload.MaxAttempts,
            string.IsNullOrWhiteSpace(payload.ExpectedAnswerHashHex) ? null : payload.ExpectedAnswerHashHex,
            string.IsNullOrWhiteSpace(payload.ExpectedStepHashHex) ? null : payload.ExpectedStepHashHex,
            payload.ExpectedX,
            payload.ExpectedY,
            payload.CoordinateTolerance)
        {
            Family = payload.Family,
            Variant = payload.Variant
        };

        return Task.FromResult(PerceptionChallengeV2UnsealResult.Success(claims));
    }

    private static int CoordinateToleranceToPixels(double? tolerance)
        => tolerance.HasValue ? Math.Clamp((int)Math.Ceiling(tolerance.Value * 128), 0, 128) : 0;

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}

public static class PerceptionChallengeV2TokenClaimExtensions
{
    public static string ContextualUserAgentMaterial(this PerceptionChallengeV2TokenClaims claims)
        => string.Join('|', claims.ChallengeId, claims.Action, claims.RouteKey, claims.PolicyVersion);
}

public sealed class DefaultPerceptionChallengeV2TaskSource(IConfiguration configuration)
    : IPerceptionChallengeV2TaskSource
{
    private const int CanvasWidth = 320;
    private const int CanvasHeight = 180;

    public Task<PerceptionChallengeV2TaskMaterial> CreateAsync(
        PerceptionChallengeV2TaskSourceRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PerceptionChallengeV2TaskMaterial material = request.TaskKind switch
        {
            RenderRecipeV2TaskKind.Character => CreateCharacterMaterial(),
            RenderRecipeV2TaskKind.Localization => CreateLocalizationMaterial(),
            RenderRecipeV2TaskKind.MicroInteraction => CreateMicroInteractionMaterial(),
            _ => CreateCharacterMaterial()
        };

        return Task.FromResult(material);
    }

    private PerceptionChallengeV2TaskMaterial CreateCharacterMaterial()
    {
        string? answer = configuration["Security:PerceptionV2:TextTask:FixedText"];
        if (string.IsNullOrWhiteSpace(answer))
        {
            answer = GenerateTextTaskAnswer();
        }

        return new PerceptionChallengeV2TaskMaterial(
            RenderRecipeV2TaskKind.Character,
            CreateRecipe(RenderRecipeV2TaskKind.Character, answer),
            answer,
            null,
            null,
            null,
            null);
    }

    private PerceptionChallengeV2TaskMaterial CreateLocalizationMaterial()
    {
        double x = ReadCoordinate("Security:PerceptionV2:Localization:FixedX", 0.60, CanvasWidth);
        double y = ReadCoordinate("Security:PerceptionV2:Localization:FixedY", 0.55, CanvasHeight);
        return new PerceptionChallengeV2TaskMaterial(
            RenderRecipeV2TaskKind.Localization,
            CreateRecipe(RenderRecipeV2TaskKind.Localization, "loc"),
            null,
            x,
            y,
            10d / CanvasWidth,
            null);
    }

    private PerceptionChallengeV2TaskMaterial CreateMicroInteractionMaterial()
    {
        string? step = configuration["Security:PerceptionV2:MicroInteraction:FixedSteps"];
        if (string.IsNullOrWhiteSpace(step))
        {
            step = "drag:confirm";
        }

        (double x, double y) = ResolveFinalStepPoint(step);
        return new PerceptionChallengeV2TaskMaterial(
            RenderRecipeV2TaskKind.MicroInteraction,
            CreateRecipe(RenderRecipeV2TaskKind.MicroInteraction, "micro"),
            null,
            x,
            y,
            8d / CanvasWidth,
            step);
    }

    private static RenderRecipeV2 CreateRecipe(RenderRecipeV2TaskKind taskKind, string seed)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes($"{taskKind}:{seed}"));
        string seedHex = Convert.ToHexStringLower(digest);
        double a = 0.10 + (digest[0] / 255d * 0.20);
        double b = 0.30 + (digest[1] / 255d * 0.20);
        double c = 0.60 + (digest[2] / 255d * 0.20);
        var layer = new RenderRecipeV2Layer(
            "ink-main",
            0.92,
            [
                new RenderStrokeSegmentV2(
                    "stroke-a",
                    "round",
                    "#172033ff",
                    0.035,
                    [
                        new RenderPointV2(a, 0.22),
                        new RenderPointV2(b, 0.50),
                        new RenderPointV2(c, 0.34)
                    ]),
                new RenderStrokeSegmentV2(
                    "stroke-b",
                    "calligraphic",
                    "#31415eff",
                    0.026,
                    [
                        new RenderPointV2(0.18, 0.70),
                        new RenderPointV2(0.48, 0.60),
                        new RenderPointV2(0.78, 0.74)
                    ])
            ],
            [new RenderNoiseFieldV2("grain-a", seedHex, 0.22, 0.35)],
            [new RenderWarpFieldV2("warp-a", seedHex, 0.08, 9.0)],
            [new RenderOccluderV2("mask-a", "rect", 0.36, 0.42, 0.18, 0.08, 8, "#f8fafccc")]);

        return new RenderRecipeV2(
            RenderRecipeV2Contracts.Schema,
            taskKind,
            [layer],
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["canvasWidth"] = CanvasWidth.ToString(CultureInfo.InvariantCulture),
                ["canvasHeight"] = CanvasHeight.ToString(CultureInfo.InvariantCulture),
                ["inputMode"] = taskKind == RenderRecipeV2TaskKind.Character ? "text" : "pointer",
                ["motionProfile"] = "static"
            });
    }

    private static string GenerateTextTaskAnswer()
    {
        const string alphabet = "AEFHKMRTY2347";
        Span<char> result = stackalloc char[5];
        for (int i = 0; i < result.Length; i++)
        {
            result[i] = alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)];
        }

        return new string(result);
    }

    private double ReadCoordinate(string key, double fallback, int pixelScale)
    {
        string? raw = configuration[key];
        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out double value) || !double.IsFinite(value))
        {
            return fallback;
        }

        if (value > 1)
        {
            value /= pixelScale;
        }

        return Math.Clamp(value, 0d, 1d);
    }

    private static (double X, double Y) ResolveFinalStepPoint(string step)
    {
        string last = step.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault() ?? string.Empty;
        int colon = last.IndexOf(':');
        string coordinates = colon >= 0 ? last[(colon + 1)..] : last;
        string[] parts = coordinates.Split(',', StringSplitOptions.TrimEntries);
        if (parts.Length >= 2 &&
            double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out double x) &&
            double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out double y))
        {
            if (x > 1) x /= CanvasWidth;
            if (y > 1) y /= CanvasHeight;
            return (Math.Clamp(x, 0d, 1d), Math.Clamp(y, 0d, 1d));
        }

        return (0.70, 0.35);
    }
}

public abstract class PerceptionChallengeV2ProviderBase(
    IPerceptionChallengeV2IssueService issueService,
    IPerceptionChallengeV2TokenProtector tokenProtector,
    IUnifiedCache cache,
    IChallengeV2AuditEventWriter auditEventWriter,
    ISecurityRiskSignalSink riskSignalSink,
    TimeProvider timeProvider,
    RenderRecipeV2TaskKind taskKind,
    SecurityChallengeKind challengeKind,
    bool requiresHighRiskEscalation) : ISecurityChallengeProvider
{
    private const string GenericFailure = "perception_challenge_failed";
    private static readonly TimeSpan RiskSignalTtl = TimeSpan.FromMinutes(10);
    private static readonly JsonSerializerOptions RenderRecipeJsonOptions = CreateRenderRecipeJsonOptions();

    public string Kind => SecurityChallengeContracts.ToWireName(challengeKind);

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(
        SecurityChallengeProviderIssueRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        long startedAt = Stopwatch.GetTimestamp();

        if (requiresHighRiskEscalation && request.EscalationLevel < 2)
        {
            return SecurityChallengeProviderIssueResult.Failed("perception_micro_interaction_escalation_required");
        }

        PerceptionChallengeV2IssueResult issued = await issueService.IssueAsync(
            new PerceptionChallengeV2IssueRequest(
                request.Context,
                request.Action,
                request.RouteKey,
                request.TenantId,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.PolicyVersion,
                request.EscalationLevel,
                request.Traceparent,
                taskKind),
            cancellationToken);

        if (!issued.Succeeded || issued.Assignment is null)
        {
            return SecurityChallengeProviderIssueResult.Failed(issued.Reason);
        }

        SecurityChallengeAssignment assignment = issued.Assignment.Kind == challengeKind
            ? issued.Assignment
            : issued.Assignment with { Kind = challengeKind };

        IReadOnlyDictionary<string, string> providerPayload = ToProviderPayload(issued.Payload);
        FsusObservability.RecordSecurityChallengeV2Issued(
            Kind,
            request.Action,
            request.PolicyVersion,
            PerceptionChallengeV2Contracts.ToWireTaskKind(taskKind),
            EstimateProviderPayloadBytes(providerPayload),
            FsusObservability.GetElapsed(startedAt));
        return SecurityChallengeProviderIssueResult.Success(assignment, providerPayload);
    }

    public async Task<SecurityChallengeProviderVerifyResult> VerifyAsync(
        SecurityChallengeProviderVerifyRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        long startedAt = Stopwatch.GetTimestamp();
        int payloadBytes = EstimateProviderPayloadBytes(request.ProviderPayload);
        TimeSpan? solveDuration = ReadSolveDuration(request.ProviderPayload);

        if (!TryParseProviderPayload(request.ProviderPayload, out PerceptionChallengeV2ProviderPayload payload))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "perception_payload_invalid", "PerceptionInvalid", null, cancellationToken);
            RecordV2Failed(request, "perception_payload_invalid", payloadBytes, startedAt, solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        PerceptionChallengeV2UnsealResult unsealed = await tokenProtector.UnsealAsync(payload.SealedToken, payload.SignatureHex, cancellationToken);
        if (!unsealed.Succeeded || unsealed.Claims is null)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "perception_token_invalid", "PerceptionInvalid", payload.SealedToken, cancellationToken);
            RecordV2Failed(request, "perception_token_invalid", payloadBytes, startedAt, solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        PerceptionChallengeV2TokenClaims claims = unsealed.Claims;
        string? bindingError = ValidateProviderBinding(request, payload, claims);
        if (bindingError is not null)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, bindingError, "PerceptionInvalid", payload.SealedToken, cancellationToken);
            RecordV2Failed(request, bindingError, payloadBytes, startedAt, solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        if (claims.ExpiresAt <= timeProvider.GetUtcNow())
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Expired, "perception_expired", "PerceptionInvalid", payload.SealedToken, cancellationToken);
            RecordV2Failed(request, "perception_expired", payloadBytes, startedAt, solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        long attemptCount = await cache.IncrementAsync(
            CachePolicyId.SecurityPerceptionChallenge,
            AttemptIdentity(request.ChallengeId),
            1,
            cancellationToken);
        if (attemptCount > claims.MaxAttempts)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "perception_attempt_exceeded", "PerceptionAttemptExceeded", payload.SealedToken, cancellationToken);
            RecordV2Failed(request, "perception_attempt_exceeded", payloadBytes, startedAt, solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        if (!TryValidateDuration(request.ProviderPayload, out string? durationReason, out string? durationDetail))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, durationReason!, durationDetail!, payload.SealedToken, cancellationToken);
            RecordV2Failed(request, durationReason!, payloadBytes, startedAt, solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        if (!ValidateProviderAnswer(request.ProviderPayload, claims, out string? answerReason))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, answerReason!, "PerceptionInvalid", payload.SealedToken, cancellationToken);
            RecordV2Failed(request, answerReason!, payloadBytes, startedAt, solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        TimeSpan consumeTtl = claims.ExpiresAt - timeProvider.GetUtcNow();
        bool consumed = await cache.TryAcquireLeaseAsync(
            CachePolicyId.SecurityPerceptionChallenge,
            ConsumeIdentity(request.ChallengeId),
            "1",
            consumeTtl <= TimeSpan.Zero ? TimeSpan.FromSeconds(1) : consumeTtl,
            cancellationToken);
        if (!consumed)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Replayed, "perception_replayed", "PerceptionReplay", payload.SealedToken, cancellationToken);
            FsusObservability.RecordSecurityChallengeV2Replayed(
                Kind,
                request.Action,
                "perception_replayed",
                request.PolicyVersion,
                PerceptionChallengeV2Contracts.ToWireTaskKind(taskKind),
                payloadBytes,
                FsusObservability.GetElapsed(startedAt),
                solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Verified, "ok", payload.SealedToken, cancellationToken);
        FsusObservability.RecordSecurityChallengeV2Verified(
            Kind,
            request.Action,
            request.PolicyVersion,
            PerceptionChallengeV2Contracts.ToWireTaskKind(taskKind),
            payloadBytes,
            FsusObservability.GetElapsed(startedAt),
            solveDuration);
        return SecurityChallengeProviderVerifyResult.Success(claims.ExpiresAt);
    }

    protected static bool IsEnabled(IConfiguration configuration, string key)
        => SecuritySystemModes.IsEnforcing(SecuritySystemModes.Normalize(configuration[key] ?? SecuritySystemModes.Disabled));

    private IReadOnlyDictionary<string, string> ToProviderPayload(PerceptionChallengeV2IssuePayload payload)
    {
        string recipeJson = JsonSerializer.Serialize(payload.Recipe, RenderRecipeJsonOptions);
        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["algorithm"] = payload.Algorithm,
            ["keyVersion"] = payload.KeyVersion,
            ["taskKind"] = PerceptionChallengeV2Contracts.ToWireTaskKind(payload.TaskKind),
            ["recipeJson"] = recipeJson,
            ["recipeHashHex"] = payload.RecipeHashHex,
            ["sealedToken"] = payload.SealedToken,
            ["signatureHex"] = payload.SignatureHex,
            ["issuedAtUnixMs"] = payload.IssuedAtUnixMs.ToString(CultureInfo.InvariantCulture),
            ["expiresAtUnixMs"] = payload.ExpiresAtUnixMs.ToString(CultureInfo.InvariantCulture)
        };
    }

    private static JsonSerializerOptions CreateRenderRecipeJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
        return options;
    }

    private string? ValidateProviderBinding(
        SecurityChallengeProviderVerifyRequest request,
        PerceptionChallengeV2ProviderPayload payload,
        PerceptionChallengeV2TokenClaims claims)
    {
        if (claims.TaskKind != taskKind) return "perception_task_kind_mismatch";
        if (!FixedEquals(request.ChallengeId, claims.ChallengeId)) return "perception_challenge_id_mismatch";
        if (!FixedEquals(request.Action, claims.Action)) return "perception_action_mismatch";
        if (!FixedEquals(request.RouteKey, claims.RouteKey)) return "perception_route_key_mismatch";
        if (!FixedEquals(request.SubjectHash, claims.SubjectHash)) return "perception_subject_hash_mismatch";
        if (!FixedEquals(request.ClientIpHash, claims.ClientIpHash)) return "perception_client_ip_hash_mismatch";
        if (!FixedEquals(request.DeviceFpHash, claims.DeviceFpHash)) return "perception_device_hash_mismatch";
        if (!FixedEquals(request.PolicyVersion, claims.PolicyVersion)) return "perception_policy_version_mismatch";
        if (!PerceptionChallengeV2Hashing.FixedTimeEqualsHex(payload.RecipeHashHex, claims.RecipeHashHex)) return "perception_recipe_hash_mismatch";
        return null;
    }

    private static bool ValidateProviderAnswer(
        IReadOnlyDictionary<string, string> providerPayload,
        PerceptionChallengeV2TokenClaims claims,
        out string? reason)
    {
        reason = null;
        return claims.TaskKind switch
        {
            RenderRecipeV2TaskKind.Character => ValidateTextAnswer(providerPayload, claims, out reason),
            RenderRecipeV2TaskKind.Localization => ValidatePoint(providerPayload, claims, false, out reason),
            RenderRecipeV2TaskKind.MicroInteraction => ValidatePoint(providerPayload, claims, true, out reason),
            _ => Fail("perception_task_kind_invalid", out reason)
        };
    }

    private static bool ValidateTextAnswer(IReadOnlyDictionary<string, string> providerPayload, PerceptionChallengeV2TokenClaims claims, out string? reason)
    {
        reason = null;
        if (!TryGet(providerPayload, "answerText", out string answer) ||
            string.IsNullOrWhiteSpace(claims.ExpectedAnswerHashHex) ||
            !PerceptionChallengeV2Hashing.FixedTimeEqualsHex(PerceptionChallengeV2Hashing.HashAnswerHex(answer), claims.ExpectedAnswerHashHex))
        {
            reason = "perception_text_answer_invalid";
            return false;
        }

        return true;
    }

    private static bool ValidatePoint(
        IReadOnlyDictionary<string, string> providerPayload,
        PerceptionChallengeV2TokenClaims claims,
        bool requireStep,
        out string? reason)
    {
        reason = null;
        if (!TryGetDouble(providerPayload, "x", out double x) ||
            !TryGetDouble(providerPayload, "y", out double y) ||
            claims.ExpectedX is not { } expectedX ||
            claims.ExpectedY is not { } expectedY ||
            claims.CoordinateTolerance is not { } tolerance)
        {
            reason = "perception_coordinate_invalid";
            return false;
        }

        if (x > 1) x /= 320d;
        if (y > 1) y /= 180d;

        double dx = x - expectedX;
        double dy = y - expectedY;
        if (Math.Sqrt((dx * dx) + (dy * dy)) > tolerance)
        {
            reason = "perception_coordinate_invalid";
            return false;
        }

        if (requireStep)
        {
            string stepKey = providerPayload.ContainsKey("step") ? "step" : "stepSummary";
            if (!TryGet(providerPayload, stepKey, out string step) ||
                string.IsNullOrWhiteSpace(claims.ExpectedStepHashHex) ||
                !PerceptionChallengeV2Hashing.FixedTimeEqualsHex(PerceptionChallengeV2Hashing.HashStepHex(step), claims.ExpectedStepHashHex))
            {
                reason = "perception_steps_invalid";
                return false;
            }
        }

        return true;
    }

    private static bool TryValidateDuration(
        IReadOnlyDictionary<string, string> payload,
        out string? reason,
        out string? detail)
    {
        reason = null;
        detail = null;
        if (!TryGetInt(payload, "solveDurationMs", out int solveDurationMs))
        {
            reason = "perception_solve_duration_invalid";
            detail = "PerceptionInvalid";
            return false;
        }

        if (solveDurationMs < 750)
        {
            reason = "perception_solve_too_fast";
            detail = "PerceptionSolveTooFast";
            return false;
        }

        if (solveDurationMs > 60_000)
        {
            reason = "perception_solve_too_slow";
            detail = "PerceptionSolveTooSlow";
            return false;
        }

        return true;
    }

    private void RecordV2Failed(
        SecurityChallengeProviderVerifyRequest request,
        string reason,
        int payloadBytes,
        long startedAt,
        TimeSpan? solveDuration)
        => FsusObservability.RecordSecurityChallengeV2Failed(
            Kind,
            request.Action,
            reason,
            request.PolicyVersion,
            PerceptionChallengeV2Contracts.ToWireTaskKind(taskKind),
            payloadBytes,
            FsusObservability.GetElapsed(startedAt),
            solveDuration);

    private static TimeSpan? ReadSolveDuration(IReadOnlyDictionary<string, string> providerPayload)
        => TryGetInt(providerPayload, "solveDurationMs", out int solveDurationMs) && solveDurationMs >= 0
            ? TimeSpan.FromMilliseconds(solveDurationMs)
            : null;

    private static int EstimateProviderPayloadBytes(IReadOnlyDictionary<string, string> payload)
    {
        int bytes = 2;
        foreach (KeyValuePair<string, string> item in payload)
        {
            bytes += Encoding.UTF8.GetByteCount(item.Key);
            bytes += Encoding.UTF8.GetByteCount(item.Value ?? string.Empty);
            bytes += 6;
        }

        return bytes;
    }

    private async Task RecordRejectedAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string riskDetail,
        string? sealedToken,
        CancellationToken cancellationToken)
    {
        await RecordAttemptAsync(request, outcome, reason, sealedToken, cancellationToken);
        await riskSignalSink.AddRiskAsync(
            new SecurityRiskSignal(
                request.Context,
                SecurityRiskReason.SecurityChallengeRejected,
                10,
                RiskSignalTtl,
                SecurityRiskSources.RiskControl,
                string.IsNullOrWhiteSpace(request.Action) ? "security_challenge" : request.Action,
                riskDetail),
            cancellationToken);
    }

    private Task RecordAttemptAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string? sealedToken,
        CancellationToken cancellationToken)
    {
        var attempt = new SecurityChallengeAttemptRequest(
                request.ChallengeId,
                outcome,
                reason,
                string.IsNullOrWhiteSpace(sealedToken) ? null : HashValue(sealedToken),
                request.ClientIpHash,
                request.DeviceFpHash,
                request.Context.TraceIdentifier,
                ResolveTraceparent(request.Context),
                timeProvider.GetUtcNow().UtcDateTime);
        return auditEventWriter.WriteAsync(
            ChallengeV2AuditEvent.FromAttempt(
                attempt,
                ChallengeV2EventKind.FromAttempt(outcome, reason, request.Action),
                request.Kind,
                request.Action),
            cancellationToken).AsTask();
    }

    private static string AttemptIdentity(string challengeId)
        => $"{challengeId}:attempt";

    private static string ConsumeIdentity(string challengeId)
        => $"{challengeId}:consume";

    private static string? ResolveTraceparent(HttpContext context)
        => context.Request.Headers.TryGetValue("traceparent", out var values) ? values.ToString() : null;

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static bool TryParseProviderPayload(
        IReadOnlyDictionary<string, string> payload,
        out PerceptionChallengeV2ProviderPayload parsed)
    {
        parsed = default;
        if (!TryGet(payload, "algorithm", out string algorithm) ||
            !TryGet(payload, "keyVersion", out string keyVersion) ||
            !TryGet(payload, "taskKind", out string taskKindValue) ||
            !TryGet(payload, "recipeHashHex", out string recipeHashHex) ||
            !TryGet(payload, "sealedToken", out string sealedToken) ||
            !TryGet(payload, "signatureHex", out string signatureHex) ||
            !PerceptionChallengeV2Contracts.TryParseWireTaskKind(taskKindValue, out RenderRecipeV2TaskKind parsedTaskKind) ||
            !string.Equals(algorithm, PerceptionChallengeV2Constants.WireAlgorithm, StringComparison.Ordinal))
        {
            return false;
        }

        parsed = new PerceptionChallengeV2ProviderPayload(keyVersion, parsedTaskKind, recipeHashHex, sealedToken, signatureHex);
        return true;
    }

    private static bool TryGet(IReadOnlyDictionary<string, string> payload, string key, out string value)
    {
        value = string.Empty;
        if (!payload.TryGetValue(key, out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        value = raw.Trim();
        return true;
    }

    private static bool TryGetInt(IReadOnlyDictionary<string, string> payload, string key, out int value)
    {
        value = 0;
        return TryGet(payload, key, out string raw) &&
               int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }

    private static bool TryGetDouble(IReadOnlyDictionary<string, string> payload, string key, out double value)
    {
        value = 0;
        return TryGet(payload, key, out string raw) &&
               double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out value) &&
               double.IsFinite(value);
    }

    private static bool FixedEquals(string left, string right)
    {
        byte[] leftBytes = Encoding.UTF8.GetBytes(left ?? string.Empty);
        byte[] rightBytes = Encoding.UTF8.GetBytes(right ?? string.Empty);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static bool Fail(string failReason, out string? reason)
    {
        reason = failReason;
        return false;
    }

    private readonly record struct PerceptionChallengeV2ProviderPayload(
        string KeyVersion,
        RenderRecipeV2TaskKind TaskKind,
        string RecipeHashHex,
        string SealedToken,
        string SignatureHex);
}

internal static class PerceptionChallengeV2StandaloneFactory
{
    public static IPerceptionChallengeV2IssueService CreateIssueService(IConfiguration configuration, TimeProvider timeProvider)
        => new PerceptionChallengeV2IssueService(
            new DefaultPerceptionChallengeV2TaskSource(configuration),
            CreateTokenProtector(configuration, timeProvider),
            timeProvider);

    public static IPerceptionChallengeV2TokenProtector CreateTokenProtector(IConfiguration configuration, TimeProvider timeProvider)
        => new PerceptionChallengeV2TokenProtector(
            new PerceptionSealedTokenService(
                new ConfigurationBackedOptionsMonitor<PerceptionSealedTokenOptions>(CreateTokenOptions(configuration)),
                timeProvider));

    private static PerceptionSealedTokenOptions CreateTokenOptions(IConfiguration configuration)
    {
        const string fallbackKeyVersion = "current";
        string currentKeyVersion = NormalizeToken(
            configuration[$"{PerceptionSealedTokenOptions.SectionName}:CurrentKeyVersion"],
            fallbackKeyVersion);
        var options = new PerceptionSealedTokenOptions
        {
            CurrentKeyVersion = currentKeyVersion
        };

        IConfigurationSection keysSection = configuration.GetSection($"{PerceptionSealedTokenOptions.SectionName}:Keys");
        foreach (IConfigurationSection child in keysSection.GetChildren())
        {
            if (!string.IsNullOrWhiteSpace(child.Key) && !string.IsNullOrWhiteSpace(child.Value))
            {
                options.Keys[child.Key.Trim()] = child.Value.Trim();
            }
        }

        if (options.Keys.Count == 0)
        {
            string signingMaterial = NormalizeToken(
                configuration["Security:PerceptionV2:SigningKey"],
                "perception-v2-local-test-signing-key");
            options.Keys[currentKeyVersion] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(signingMaterial)));
        }

        if (!options.Keys.ContainsKey(options.CurrentKeyVersion))
        {
            options.CurrentKeyVersion = options.Keys.Keys.First();
        }

        return options;
    }

    private static string NormalizeToken(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}

public sealed class PerceptionTextTaskV2Provider(
    IPerceptionChallengeV2IssueService issueService,
    IPerceptionChallengeV2TokenProtector tokenProtector,
    IUnifiedCache cache,
    ISecurityChallengePersistenceService persistence,
    IChallengeV2AuditEventWriter auditEventWriter,
    ISecurityRiskSignalSink riskSignalSink,
    TimeProvider timeProvider)
    : PerceptionChallengeV2ProviderBase(
        issueService,
        tokenProtector,
        cache,
        auditEventWriter,
        riskSignalSink,
        timeProvider,
        RenderRecipeV2TaskKind.Character,
        SecurityChallengeKind.PerceptionTextTaskV2,
        false)
{
    public const string WireKind = "perceptionTextTaskV2";
    public const string Algorithm = PerceptionChallengeV2Constants.WireAlgorithm;

    internal PerceptionTextTaskV2Provider(
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        ISecurityRiskSignalSink riskSignalSink,
        IConfiguration configuration,
        TimeProvider timeProvider)
        : this(cache, persistence, new DirectChallengeV2AuditEventWriter(persistence), riskSignalSink, configuration, timeProvider)
    {
    }

    internal PerceptionTextTaskV2Provider(
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        IChallengeV2AuditEventWriter auditEventWriter,
        ISecurityRiskSignalSink riskSignalSink,
        IConfiguration configuration,
        TimeProvider timeProvider)
        : this(
            PerceptionChallengeV2StandaloneFactory.CreateIssueService(configuration, timeProvider),
            PerceptionChallengeV2StandaloneFactory.CreateTokenProtector(configuration, timeProvider),
            cache,
            persistence,
            auditEventWriter,
            riskSignalSink,
            timeProvider)
    {
    }

    public PerceptionTextTaskV2Provider(
        IPerceptionChallengeV2IssueService issueService,
        IPerceptionChallengeV2TokenProtector tokenProtector,
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        ISecurityRiskSignalSink riskSignalSink,
        TimeProvider timeProvider)
        : this(issueService, tokenProtector, cache, persistence, new DirectChallengeV2AuditEventWriter(persistence), riskSignalSink, timeProvider)
    {
    }
}

public sealed class PerceptionLocalizationV2Provider(
    IPerceptionChallengeV2IssueService issueService,
    IPerceptionChallengeV2TokenProtector tokenProtector,
    IUnifiedCache cache,
    ISecurityChallengePersistenceService persistence,
    IChallengeV2AuditEventWriter auditEventWriter,
    ISecurityRiskSignalSink riskSignalSink,
    TimeProvider timeProvider)
    : PerceptionChallengeV2ProviderBase(
        issueService,
        tokenProtector,
        cache,
        auditEventWriter,
        riskSignalSink,
        timeProvider,
        RenderRecipeV2TaskKind.Localization,
        SecurityChallengeKind.PerceptionLocalizationV2,
        false)
{
    public const string WireKind = "perceptionLocalizationV2";
    public const string Algorithm = PerceptionChallengeV2Constants.WireAlgorithm;

    internal PerceptionLocalizationV2Provider(
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        ISecurityRiskSignalSink riskSignalSink,
        IConfiguration configuration,
        TimeProvider timeProvider)
        : this(cache, persistence, new DirectChallengeV2AuditEventWriter(persistence), riskSignalSink, configuration, timeProvider)
    {
    }

    internal PerceptionLocalizationV2Provider(
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        IChallengeV2AuditEventWriter auditEventWriter,
        ISecurityRiskSignalSink riskSignalSink,
        IConfiguration configuration,
        TimeProvider timeProvider)
        : this(
            PerceptionChallengeV2StandaloneFactory.CreateIssueService(configuration, timeProvider),
            PerceptionChallengeV2StandaloneFactory.CreateTokenProtector(configuration, timeProvider),
            cache,
            persistence,
            auditEventWriter,
            riskSignalSink,
            timeProvider)
    {
    }

    public PerceptionLocalizationV2Provider(
        IPerceptionChallengeV2IssueService issueService,
        IPerceptionChallengeV2TokenProtector tokenProtector,
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        ISecurityRiskSignalSink riskSignalSink,
        TimeProvider timeProvider)
        : this(issueService, tokenProtector, cache, persistence, new DirectChallengeV2AuditEventWriter(persistence), riskSignalSink, timeProvider)
    {
    }
}

public sealed class PerceptionMicroInteractionV2Provider : PerceptionChallengeV2ProviderBase
{
    public const string WireKind = "perceptionMicroInteractionV2";
    public const string Algorithm = PerceptionChallengeV2Constants.WireAlgorithm;

    public PerceptionMicroInteractionV2Provider(
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        IChallengeV2AuditEventWriter auditEventWriter,
        ISecurityRiskSignalSink riskSignalSink,
        IConfiguration configuration,
        TimeProvider timeProvider)
        : this(
            PerceptionChallengeV2StandaloneFactory.CreateIssueService(configuration, timeProvider),
            PerceptionChallengeV2StandaloneFactory.CreateTokenProtector(configuration, timeProvider),
            cache,
            persistence,
            auditEventWriter,
            riskSignalSink,
            timeProvider,
            configuration)
    {
    }

    public PerceptionMicroInteractionV2Provider(
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        ISecurityRiskSignalSink riskSignalSink,
        IConfiguration configuration,
        TimeProvider timeProvider)
        : this(cache, persistence, new DirectChallengeV2AuditEventWriter(persistence), riskSignalSink, configuration, timeProvider)
    {
    }

    public PerceptionMicroInteractionV2Provider(
        IPerceptionChallengeV2IssueService issueService,
        IPerceptionChallengeV2TokenProtector tokenProtector,
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        IChallengeV2AuditEventWriter auditEventWriter,
        ISecurityRiskSignalSink riskSignalSink,
        TimeProvider timeProvider,
        IConfiguration configuration)
        : base(
            new FeatureGatedIssueService(issueService, configuration),
            tokenProtector,
            cache,
            auditEventWriter,
            riskSignalSink,
            timeProvider,
            RenderRecipeV2TaskKind.MicroInteraction,
            SecurityChallengeKind.PerceptionMicroInteractionV2,
            true)
    {
    }

    public PerceptionMicroInteractionV2Provider(
        IPerceptionChallengeV2IssueService issueService,
        IPerceptionChallengeV2TokenProtector tokenProtector,
        IUnifiedCache cache,
        ISecurityChallengePersistenceService persistence,
        ISecurityRiskSignalSink riskSignalSink,
        TimeProvider timeProvider,
        IConfiguration configuration)
        : this(
            issueService,
            tokenProtector,
            cache,
            persistence,
            new DirectChallengeV2AuditEventWriter(persistence),
            riskSignalSink,
            timeProvider,
            configuration)
    {
    }

    private sealed class FeatureGatedIssueService(
        IPerceptionChallengeV2IssueService inner,
        IConfiguration configuration) : IPerceptionChallengeV2IssueService
    {
        public Task<PerceptionChallengeV2IssueResult> IssueAsync(
            PerceptionChallengeV2IssueRequest request,
            CancellationToken cancellationToken = default)
        {
            string mode = SecuritySystemModes.Normalize(configuration["Security:PerceptionV2:MicroInteraction:Mode"]);
            return SecuritySystemModes.IsEnforcing(mode)
                ? inner.IssueAsync(request, cancellationToken)
                : Task.FromResult(PerceptionChallengeV2IssueResult.Failed("perception_micro_interaction_disabled"));
        }
    }
}

internal sealed class ConfigurationBackedOptionsMonitor<T>(T value) : IOptionsMonitor<T>
{
    public T CurrentValue { get; } = value;

    public T Get(string? name) => CurrentValue;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}
