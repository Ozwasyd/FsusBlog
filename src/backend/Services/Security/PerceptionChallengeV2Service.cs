using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Shared.Contracts.Security;

using StackExchange.Redis;

namespace FsusBlog.Server.Services.Security;

public static class PerceptionChallengeV2Constants
{
    public const string WireAlgorithm = PerceptionSealedChallengeV2Contracts.Algorithm;
    public static readonly TimeSpan ClockSkew = TimeSpan.FromSeconds(30);
    public const int DefaultMaxAttempts = 3;
    public const int MinSolveDurationMs = 750;
    public const int MaxSolveDurationMs = 60_000;
}

public static class PerceptionChallengeV2Contracts
{
    public static string ToWireTaskKind(RenderRecipeV2TaskKind taskKind)
        => taskKind switch
        {
            RenderRecipeV2TaskKind.Localization => "localization",
            RenderRecipeV2TaskKind.MicroInteraction => "microInteraction",
            _ => "unknown"
        };

    public static bool TryParseWireTaskKind(string? value, out RenderRecipeV2TaskKind taskKind)
    {
        taskKind = RenderRecipeV2TaskKind.Unknown;
        string normalized = (value ?? string.Empty).Trim();
        if (string.Equals(normalized, "localization", StringComparison.Ordinal))
        {
            taskKind = RenderRecipeV2TaskKind.Localization;
            return true;
        }

        if (string.Equals(normalized, "microInteraction", StringComparison.Ordinal) ||
            string.Equals(normalized, "micro-interaction", StringComparison.Ordinal))
        {
            taskKind = RenderRecipeV2TaskKind.MicroInteraction;
            return true;
        }

        return false;
    }

    public static SecurityChallengeKind ToChallengeKind(RenderRecipeV2TaskKind taskKind)
        => taskKind switch
        {
            RenderRecipeV2TaskKind.Localization => SecurityChallengeKind.PerceptionLocalizationV2,
            RenderRecipeV2TaskKind.MicroInteraction => SecurityChallengeKind.PerceptionMicroInteractionV2,
            _ => SecurityChallengeKind.Unknown
        };
}

public static class PerceptionChallengeV2Hashing
{
    public static string HashStepHex(string step)
        => HashUtf8Hex(NormalizeStep(step));

    public static string HashPointHex(double x, double y)
        => HashUtf8Hex(string.Create(CultureInfo.InvariantCulture, $"{NormalizeCoordinate(x):0.######},{NormalizeCoordinate(y):0.######}"));

    public static string NormalizeStep(string step)
        => TextHelpers.LowerTrimmed(step) ?? string.Empty;

    public static double NormalizeCoordinate(double value)
        => double.IsFinite(value) ? Math.Clamp(value, 0d, 1d) : double.NaN;

    public static bool FixedTimeEqualsHex(string left, string right)
    {
        string normalizedLeft = TextHelpers.LowerTrimmed(left) ?? string.Empty;
        string normalizedRight = TextHelpers.LowerTrimmed(right) ?? string.Empty;
        return normalizedLeft.Length == normalizedRight.Length &&
               CryptographicOperations.FixedTimeEquals(
                   Encoding.ASCII.GetBytes(normalizedLeft),
                   Encoding.ASCII.GetBytes(normalizedRight));
    }

    private static string HashUtf8Hex(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}

public sealed record PerceptionChallengeV2IssueRequest(
    HttpContext Context,
    string Action,
    string RouteKey,
    string TenantId,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    int EscalationLevel,
    string Traceparent,
    RenderRecipeV2TaskKind TaskKind)
{
    public string ChallengeId { get; init; } = string.Empty;
    public int RiskScore
    {
        get; init;
    }

    public int EffectiveRiskScore
    {
        get; init;
    }

    public PerceptionChallengeGeneratorDistributionPolicy GeneratorDistributionPolicy
    {
        get; init;
    } =
        PerceptionChallengeGeneratorDistributionPolicy.Default;
}

public sealed record PerceptionChallengeV2VerifyRequest(
    HttpContext Context,
    string Kind,
    string ChallengeId,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    IReadOnlyDictionary<string, string> ProviderPayload);

public sealed record PerceptionChallengeV2TaskSourceRequest(
    HttpContext Context,
    RenderRecipeV2TaskKind TaskKind,
    string Action,
    string RouteKey,
    string PolicyVersion)
{
    public string Family { get; init; } = PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField;

    public string Variant
    {
        get; init;
    } =
        PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField);
}

public sealed record PerceptionChallengeV2TaskMaterial(
    RenderRecipeV2TaskKind TaskKind,
    RenderRecipeV2 Recipe,
    double? ExpectedX,
    double? ExpectedY,
    double? CoordinateTolerance,
    string? ExpectedStep);

public sealed record PerceptionChallengeV2TokenClaims(
    string ChallengeId,
    string Kind,
    string Algorithm,
    string KeyVersion,
    RenderRecipeV2TaskKind TaskKind,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    string RecipeHashHex,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    int MaxAttempts,
    string? ExpectedStepHashHex,
    double? ExpectedX,
    double? ExpectedY,
    double? CoordinateTolerance)
{
    public string Family { get; init; } = PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField;

    public string Variant
    {
        get; init;
    } =
        PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField);
}

public sealed record PerceptionChallengeV2IssuePayload(
    string Algorithm,
    string KeyVersion,
    RenderRecipeV2TaskKind TaskKind,
    RenderRecipeV2 Recipe,
    string RecipeHashHex,
    string SealedToken,
    string SignatureHex,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs)
{
    public string Family { get; init; } = PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField;

    public string Variant
    {
        get; init;
    } =
        PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField);
}

public sealed record PerceptionChallengeV2IssueResult(
    bool Succeeded,
    string Reason,
    SecurityChallengeAssignment? Assignment,
    PerceptionChallengeV2IssuePayload Payload)
{
    public static PerceptionChallengeV2IssueResult Failed(string reason)
        => new(false, NormalizeReason(reason), null, s_emptyPayload);

    public static PerceptionChallengeV2IssueResult Success(SecurityChallengeAssignment assignment, PerceptionChallengeV2IssuePayload payload)
        => new(true, "ok", assignment, payload);

    private static readonly RenderRecipeV2 s_emptyRecipe =
        new(RenderRecipeV2Contracts.Schema, RenderRecipeV2TaskKind.Unknown, [], new Dictionary<string, string>(StringComparer.Ordinal));

    private static readonly PerceptionChallengeV2IssuePayload s_emptyPayload =
        new(string.Empty, string.Empty, RenderRecipeV2TaskKind.Unknown, s_emptyRecipe, string.Empty, string.Empty, string.Empty, 0, 0);

    private static string NormalizeReason(string reason)
        => string.IsNullOrWhiteSpace(reason) ? "perception_issue_failed" : reason.Trim();
}

public sealed record PerceptionChallengeV2VerifyResult(bool Verified, string Reason, DateTimeOffset? ProofExpiresAt)
{
    public static PerceptionChallengeV2VerifyResult Success(DateTimeOffset? proofExpiresAt = null)
        => new(true, "ok", proofExpiresAt);

    public static PerceptionChallengeV2VerifyResult Failed(string reason)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "perception_verify_failed" : reason.Trim(), null);
}

public sealed record PerceptionChallengeV2SealResult(
    bool Succeeded,
    string Reason,
    string SealedToken,
    string SignatureHex,
    string KeyVersion)
{
    public static PerceptionChallengeV2SealResult Failed(string reason)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "seal_failed" : reason.Trim(), string.Empty, string.Empty, string.Empty);
}

public sealed record PerceptionChallengeV2UnsealResult(
    bool Succeeded,
    string Reason,
    PerceptionChallengeV2TokenClaims? Claims)
{
    public static PerceptionChallengeV2UnsealResult Success(PerceptionChallengeV2TokenClaims claims)
        => new(true, "ok", claims);

    public static PerceptionChallengeV2UnsealResult Failed(string reason)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "token_invalid" : reason.Trim(), null);
}

public sealed record PerceptionChallengeV2AttemptGateResult(bool Allowed, string Reason, long AttemptCount)
{
    public static PerceptionChallengeV2AttemptGateResult Accepted(long attemptCount)
        => new(true, "ok", attemptCount);

    public static PerceptionChallengeV2AttemptGateResult Rejected(string reason, long attemptCount)
        => new(false, string.IsNullOrWhiteSpace(reason) ? "attempt_rejected" : reason.Trim(), attemptCount);
}

public sealed record PerceptionChallengeV2ConsumeResult(bool Consumed, string Reason)
{
    public static PerceptionChallengeV2ConsumeResult ConsumedOnce { get; } = new(true, "ok");
    public static PerceptionChallengeV2ConsumeResult Replayed { get; } = new(false, "challenge_replayed");
    public static PerceptionChallengeV2ConsumeResult RedisUnavailable { get; } = new(false, "redis_unavailable");
}

public interface IPerceptionChallengeV2TaskSource
{
    Task<PerceptionChallengeV2TaskMaterial> CreateAsync(PerceptionChallengeV2TaskSourceRequest request, CancellationToken cancellationToken = default);
}

public interface IPerceptionChallengeV2TokenProtector
{
    Task<PerceptionChallengeV2SealResult> SealAsync(PerceptionChallengeV2TokenClaims claims, CancellationToken cancellationToken = default);

    Task<PerceptionChallengeV2UnsealResult> UnsealAsync(string sealedToken, string signatureHex, CancellationToken cancellationToken = default);
}

public interface IPerceptionChallengeV2RedisGate
{
    Task<PerceptionChallengeV2AttemptGateResult> RegisterAttemptAsync(string challengeId, DateTimeOffset expiresAt, int maxAttempts, CancellationToken cancellationToken = default);

    Task<PerceptionChallengeV2ConsumeResult> TryConsumeOnceAsync(string challengeId, DateTimeOffset expiresAt, CancellationToken cancellationToken = default);
}

public interface IPerceptionChallengeV2IssueService
{
    Task<PerceptionChallengeV2IssueResult> IssueAsync(PerceptionChallengeV2IssueRequest request, CancellationToken cancellationToken = default);
}

public interface IPerceptionChallengeV2VerifyService
{
    Task<PerceptionChallengeV2VerifyResult> VerifyAsync(PerceptionChallengeV2VerifyRequest request, CancellationToken cancellationToken = default);
}

public sealed class PerceptionChallengeV2IssueService(
    IPerceptionChallengeV2TaskSource taskSource,
    IPerceptionChallengeV2TokenProtector tokenProtector,
    TimeProvider timeProvider) : IPerceptionChallengeV2IssueService
{
    private const int ChallengeTtlSeconds = 300;

    public async Task<PerceptionChallengeV2IssueResult> IssueAsync(PerceptionChallengeV2IssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        string challengeId = string.IsNullOrWhiteSpace(request.ChallengeId)
            ? SecurityChallengeContracts.CreateChallengeId()
            : request.ChallengeId;
        PerceptionChallengeV2GeneratorSelection generatorSelection = PerceptionChallengeV2GeneratorSelector.Select(
            request.GeneratorDistributionPolicy,
            request.Action,
            request.EffectiveRiskScore,
            string.Join('|', challengeId, request.PolicyVersion, request.Action, request.RouteKey, request.Traceparent));

        PerceptionChallengeV2TaskMaterial material = await taskSource.CreateAsync(
            new PerceptionChallengeV2TaskSourceRequest(
                request.Context,
                request.TaskKind,
                request.Action,
                request.RouteKey,
                request.PolicyVersion)
            {
                Family = generatorSelection.Family,
                Variant = generatorSelection.Variant
            },
            cancellationToken);

        if (material.TaskKind == RenderRecipeV2TaskKind.Unknown || material.TaskKind != request.TaskKind)
        {
            return PerceptionChallengeV2IssueResult.Failed("task_kind_invalid");
        }

        RenderRecipeV2ValidationResult recipeValidation = RenderRecipeV2Contracts.ValidateRecipe(material.Recipe);
        if (!recipeValidation.IsValid)
        {
            return PerceptionChallengeV2IssueResult.Failed(recipeValidation.ErrorCode);
        }

        DateTimeOffset issuedAt = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = issuedAt.AddSeconds(ChallengeTtlSeconds);
        SecurityChallengeKind challengeKind = PerceptionChallengeV2Contracts.ToChallengeKind(material.TaskKind);
        string wireKind = SecurityChallengeContracts.ToWireName(challengeKind);
        var assignment = new SecurityChallengeAssignment(
            challengeId,
            request.Traceparent,
            request.TenantId,
            challengeKind,
            request.EscalationLevel,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            issuedAt.ToUnixTimeMilliseconds(),
            expiresAt.ToUnixTimeMilliseconds());

        var claims = new PerceptionChallengeV2TokenClaims(
            challengeId,
            wireKind,
            PerceptionChallengeV2Constants.WireAlgorithm,
            "current",
            material.TaskKind,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            request.PolicyVersion,
            recipeValidation.RecipeHashHex,
            issuedAt,
            expiresAt,
            PerceptionChallengeV2Constants.DefaultMaxAttempts,
            string.IsNullOrWhiteSpace(material.ExpectedStep) ? null : PerceptionChallengeV2Hashing.HashStepHex(material.ExpectedStep),
            material.ExpectedX,
            material.ExpectedY,
            material.CoordinateTolerance)
        {
            Family = generatorSelection.Family,
            Variant = generatorSelection.Variant
        };

        PerceptionChallengeV2SealResult sealedResult = await tokenProtector.SealAsync(claims, cancellationToken);
        if (!sealedResult.Succeeded)
        {
            return PerceptionChallengeV2IssueResult.Failed(sealedResult.Reason);
        }

        var payload = new PerceptionChallengeV2IssuePayload(
            PerceptionChallengeV2Constants.WireAlgorithm,
            sealedResult.KeyVersion,
            material.TaskKind,
            material.Recipe,
            recipeValidation.RecipeHashHex,
            sealedResult.SealedToken,
            sealedResult.SignatureHex,
            issuedAt.ToUnixTimeMilliseconds(),
            expiresAt.ToUnixTimeMilliseconds())
        {
            Family = generatorSelection.Family,
            Variant = generatorSelection.Variant
        };
        return PerceptionChallengeV2IssueResult.Success(assignment, payload);
    }
}

public sealed class PerceptionChallengeV2VerifyService(
    IPerceptionChallengeV2TokenProtector tokenProtector,
    IPerceptionChallengeV2RedisGate redisGate,
    ISecurityRiskSignalSink riskSignalSink,
    IChallengeV2AuditEventWriter auditEventWriter,
    TimeProvider timeProvider) : IPerceptionChallengeV2VerifyService
{
    public async Task<PerceptionChallengeV2VerifyResult> VerifyAsync(PerceptionChallengeV2VerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (!TryParseCommonPayload(request.ProviderPayload, out PerceptionChallengeV2VerifyPayload payload))
        {
            await RecordRejectedAsync(
                request,
                SecurityChallengeAttemptOutcomes.Failed,
                "perception_payload_invalid",
                "PerceptionInvalid",
                null,
                cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed("perception_payload_invalid");
        }

        PerceptionChallengeV2UnsealResult unsealed = await tokenProtector.UnsealAsync(payload.SealedToken, payload.SignatureHex, cancellationToken);
        if (!unsealed.Succeeded || unsealed.Claims is null)
        {
            await RecordRejectedAsync(
                request,
                SecurityChallengeAttemptOutcomes.Failed,
                "perception_token_invalid",
                "PerceptionInvalid",
                payload.SealedToken,
                cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed("perception_token_invalid");
        }

        PerceptionChallengeV2TokenClaims claims = unsealed.Claims;
        string? bindingMismatch = ValidateBinding(request, payload, claims);
        if (bindingMismatch is not null)
        {
            string reason = $"perception_{bindingMismatch}";
            await RecordRejectedAsync(
                request,
                SecurityChallengeAttemptOutcomes.Failed,
                reason,
                "PerceptionInvalid",
                payload.SealedToken,
                cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(reason);
        }

        if (claims.ExpiresAt <= timeProvider.GetUtcNow())
        {
            await RecordRejectedAsync(
                request,
                SecurityChallengeAttemptOutcomes.Expired,
                "perception_expired",
                "PerceptionInvalid",
                payload.SealedToken,
                cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed("perception_expired");
        }

        PerceptionChallengeV2AttemptGateResult attempt = await redisGate.RegisterAttemptAsync(
            claims.ChallengeId,
            claims.ExpiresAt,
            claims.MaxAttempts,
            cancellationToken);
        if (!attempt.Allowed)
        {
            string reason = MapAttemptGateReason(attempt.Reason);
            await RecordRejectedAsync(
                request,
                SecurityChallengeAttemptOutcomes.Failed,
                reason,
                MapRiskDetail(reason),
                payload.SealedToken,
                cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(reason);
        }

        if (!TryValidateSolveDuration(request.ProviderPayload, claims, out string? durationReason))
        {
            string reason = durationReason ?? "perception_solve_duration_invalid";
            await RecordRejectedAsync(
                request,
                SecurityChallengeAttemptOutcomes.Failed,
                reason,
                MapRiskDetail(reason),
                payload.SealedToken,
                cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(reason);
        }

        if (!ValidateTaskAnswer(request.ProviderPayload, claims, out string? answerReason))
        {
            string reason = answerReason ?? "perception_answer_invalid";
            await RecordRejectedAsync(
                request,
                SecurityChallengeAttemptOutcomes.Failed,
                reason,
                "PerceptionInvalid",
                payload.SealedToken,
                cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(reason);
        }

        PerceptionChallengeV2ConsumeResult consume = await redisGate.TryConsumeOnceAsync(claims.ChallengeId, claims.ExpiresAt, cancellationToken);
        if (!consume.Consumed)
        {
            string reason = MapConsumeReason(consume.Reason);
            await RecordRejectedAsync(
                request,
                reason == "perception_replayed" ? SecurityChallengeAttemptOutcomes.Replayed : SecurityChallengeAttemptOutcomes.Failed,
                reason,
                MapRiskDetail(reason),
                payload.SealedToken,
                cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(reason);
        }

        await RecordAttemptAsync(
            request,
            SecurityChallengeAttemptOutcomes.Verified,
            "ok",
            payload.SealedToken,
            cancellationToken);
        return PerceptionChallengeV2VerifyResult.Success(claims.ExpiresAt);
    }

    private async Task RecordRejectedAsync(
        PerceptionChallengeV2VerifyRequest request,
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
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.RiskControl,
                string.IsNullOrWhiteSpace(request.Action) ? "security_challenge" : request.Action,
                riskDetail),
            cancellationToken);
    }

    private ValueTask RecordAttemptAsync(
        PerceptionChallengeV2VerifyRequest request,
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
            cancellationToken);
    }

    private static string? ValidateBinding(
        PerceptionChallengeV2VerifyRequest request,
        PerceptionChallengeV2VerifyPayload payload,
        PerceptionChallengeV2TokenClaims claims)
    {
        if (!FixedEquals(payload.KeyVersion, claims.KeyVersion))
            return "key_version_mismatch";
        if (payload.TaskKind != claims.TaskKind)
            return "task_kind_mismatch";
        if (!FixedEquals(request.ChallengeId, claims.ChallengeId))
            return "challenge_id_mismatch";
        if (!FixedEquals(request.Action, claims.Action))
            return "action_mismatch";
        if (!FixedEquals(request.RouteKey, claims.RouteKey))
            return "route_key_mismatch";
        if (!FixedEquals(request.SubjectHash, claims.SubjectHash))
            return "subject_hash_mismatch";
        if (!FixedEquals(request.ClientIpHash, claims.ClientIpHash))
            return "client_ip_hash_mismatch";
        if (!FixedEquals(request.DeviceFpHash, claims.DeviceFpHash))
            return "device_fp_hash_mismatch";
        if (!FixedEquals(request.PolicyVersion, claims.PolicyVersion))
            return "policy_version_mismatch";
        if (!PerceptionChallengeV2Hashing.FixedTimeEqualsHex(payload.RecipeHashHex, claims.RecipeHashHex))
            return "recipe_hash_mismatch";
        if (!FixedEquals(payload.Algorithm, claims.Algorithm))
            return "algorithm_mismatch";
        return null;
    }

    private static bool TryValidateSolveDuration(
        IReadOnlyDictionary<string, string> providerPayload,
        PerceptionChallengeV2TokenClaims claims,
        out string? reason)
    {
        reason = null;
        if (!TryGetInt(providerPayload, "solveDurationMs", out int solveDurationMs))
        {
            reason = "perception_solve_duration_invalid";
            return false;
        }

        if (solveDurationMs < 0)
        {
            reason = "perception_solve_duration_invalid";
            return false;
        }

        if (solveDurationMs < PerceptionChallengeV2Constants.MinSolveDurationMs)
        {
            reason = "perception_solve_too_fast";
            return false;
        }

        if (solveDurationMs > PerceptionChallengeV2Constants.MaxSolveDurationMs)
        {
            reason = "perception_solve_too_slow";
            return false;
        }

        return true;
    }

    private static bool ValidateTaskAnswer(
        IReadOnlyDictionary<string, string> providerPayload,
        PerceptionChallengeV2TokenClaims claims,
        out string? reason)
    {
        reason = null;
        return claims.TaskKind switch
        {
            RenderRecipeV2TaskKind.Localization => ValidateCoordinates(providerPayload, claims, requireStep: false, out reason),
            RenderRecipeV2TaskKind.MicroInteraction => ValidateCoordinates(providerPayload, claims, requireStep: true, out reason),
            _ => Fail("perception_task_kind_invalid", out reason)
        };
    }

    private static bool ValidateCoordinates(
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

        if (x > 1)
            x /= 320d;
        if (y > 1)
            y /= 180d;

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
                !PerceptionChallengeV2Hashing.FixedTimeEqualsHex(
                    PerceptionChallengeV2Hashing.HashStepHex(step),
                    claims.ExpectedStepHashHex))
            {
                reason = "perception_steps_invalid";
                return false;
            }
        }

        return true;
    }

    private static string MapAttemptGateReason(string reason)
        => reason switch
        {
            "attempt_exceeded" => "perception_attempt_exceeded",
            "redis_unavailable" => "perception_redis_unavailable",
            "challenge_expired" => "perception_expired",
            _ => "perception_attempt_rejected"
        };

    private static string MapConsumeReason(string reason)
        => reason switch
        {
            "challenge_replayed" => "perception_replayed",
            "redis_unavailable" => "perception_redis_unavailable",
            "challenge_expired" => "perception_expired",
            _ => "perception_consume_failed"
        };

    private static string MapRiskDetail(string reason)
        => reason switch
        {
            "perception_attempt_exceeded" => "PerceptionAttemptExceeded",
            "perception_replayed" => "PerceptionReplay",
            "perception_solve_too_fast" => "PerceptionSolveTooFast",
            "perception_solve_too_slow" => "PerceptionSolveTooSlow",
            "perception_redis_unavailable" => "PerceptionRedisUnavailable",
            _ => "PerceptionInvalid"
        };

    private static bool TryParseCommonPayload(IReadOnlyDictionary<string, string> payload, out PerceptionChallengeV2VerifyPayload parsed)
    {
        parsed = default;
        if (!TryGet(payload, "algorithm", out string algorithm) ||
            !TryGet(payload, "keyVersion", out string keyVersion) ||
            !TryGet(payload, "taskKind", out string taskKindValue) ||
            !TryGet(payload, "recipeHashHex", out string recipeHashHex) ||
            !TryGet(payload, "sealedToken", out string sealedToken) ||
            !TryGet(payload, "signatureHex", out string signatureHex) ||
            !PerceptionChallengeV2Contracts.TryParseWireTaskKind(taskKindValue, out RenderRecipeV2TaskKind taskKind) ||
            !string.Equals(algorithm, PerceptionChallengeV2Constants.WireAlgorithm, StringComparison.Ordinal))
        {
            return false;
        }

        parsed = new PerceptionChallengeV2VerifyPayload(
            algorithm,
            keyVersion,
            taskKind,
            recipeHashHex,
            sealedToken,
            signatureHex);
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

    private static string? ResolveTraceparent(HttpContext context)
        => context.Request.Headers.TryGetValue("traceparent", out var values) ? values.ToString() : null;

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static bool Fail(string failReason, out string? reason)
    {
        reason = failReason;
        return false;
    }

    private readonly record struct PerceptionChallengeV2VerifyPayload(
        string Algorithm,
        string KeyVersion,
        RenderRecipeV2TaskKind TaskKind,
        string RecipeHashHex,
        string SealedToken,
        string SignatureHex);
}

public sealed class RedisPerceptionChallengeV2Gate(
    IConnectionMultiplexer redis,
    IRuntimeKeyScope keyScope,
    TimeProvider timeProvider) : IPerceptionChallengeV2RedisGate
{
    private readonly IDatabase _database = redis.GetDatabase();

    public async Task<PerceptionChallengeV2AttemptGateResult> RegisterAttemptAsync(
        string challengeId,
        DateTimeOffset expiresAt,
        int maxAttempts,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string key = keyScope.PrefixKey($"security:challenge:v2:attempt:{NormalizeChallengeId(challengeId)}");
        TimeSpan? ttl = ResolveTtl(expiresAt);
        if (!ttl.HasValue)
        {
            return PerceptionChallengeV2AttemptGateResult.Rejected("challenge_expired", 0);
        }

        try
        {
            const string Script = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
""";
            long ttlMilliseconds = Math.Max(1L, (long)Math.Ceiling(ttl.Value.TotalMilliseconds));
            RedisResult result = await _database.ScriptEvaluateAsync(
                    Script,
                    [key],
                    [ttlMilliseconds],
                    CommandFlags.None)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            long count = (long)result;
            return count <= Math.Max(1, maxAttempts)
                ? PerceptionChallengeV2AttemptGateResult.Accepted(count)
                : PerceptionChallengeV2AttemptGateResult.Rejected("attempt_exceeded", count);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return PerceptionChallengeV2AttemptGateResult.Rejected("redis_unavailable", 0);
        }
    }

    public async Task<PerceptionChallengeV2ConsumeResult> TryConsumeOnceAsync(
        string challengeId,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string key = keyScope.PrefixKey($"security:challenge:v2:used:{NormalizeChallengeId(challengeId)}");
        TimeSpan? ttl = ResolveTtl(expiresAt);
        if (!ttl.HasValue)
        {
            return new PerceptionChallengeV2ConsumeResult(false, "challenge_expired");
        }

        try
        {
            bool stored = await _database.StringSetAsync(key, "1", ttl, When.NotExists, CommandFlags.None).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return stored ? PerceptionChallengeV2ConsumeResult.ConsumedOnce : PerceptionChallengeV2ConsumeResult.Replayed;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return PerceptionChallengeV2ConsumeResult.RedisUnavailable;
        }
    }

    private TimeSpan? ResolveTtl(DateTimeOffset expiresAt)
    {
        TimeSpan ttl = expiresAt.Add(PerceptionChallengeV2Constants.ClockSkew) - timeProvider.GetUtcNow();
        return ttl <= TimeSpan.Zero ? null : ttl;
    }

    private static string NormalizeChallengeId(string challengeId)
        => (challengeId ?? string.Empty).Trim();
}
