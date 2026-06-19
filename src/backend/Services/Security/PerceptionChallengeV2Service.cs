using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Shared.Contracts.Security;
using StackExchange.Redis;

namespace FsusBlog.Server.Services.Security;

public static class PerceptionChallengeV2Constants
{
    public const string WireKind = "perceptionCharacterV2";
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
            RenderRecipeV2TaskKind.Character => "character",
            RenderRecipeV2TaskKind.Localization => "localization",
            RenderRecipeV2TaskKind.MicroInteraction => "microInteraction",
            _ => "unknown"
        };

    public static bool TryParseWireTaskKind(string? value, out RenderRecipeV2TaskKind taskKind)
    {
        taskKind = RenderRecipeV2TaskKind.Unknown;
        string normalized = (value ?? string.Empty).Trim();
        if (string.Equals(normalized, "character", StringComparison.Ordinal) ||
            string.Equals(normalized, "text-task", StringComparison.Ordinal) ||
            string.Equals(normalized, "textTask", StringComparison.Ordinal))
        {
            taskKind = RenderRecipeV2TaskKind.Character;
            return true;
        }

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
            RenderRecipeV2TaskKind.Character => SecurityChallengeKind.PerceptionCharacterV2,
            RenderRecipeV2TaskKind.Localization => SecurityChallengeKind.PerceptionLocalizationV2,
            RenderRecipeV2TaskKind.MicroInteraction => SecurityChallengeKind.PerceptionMicroInteractionV2,
            _ => SecurityChallengeKind.Unknown
        };
}

public static class PerceptionChallengeV2Hashing
{
    public static string HashAnswerHex(string answer)
        => HashUtf8Hex(NormalizeAnswer(answer));

    public static string HashStepHex(string step)
        => HashUtf8Hex(NormalizeStep(step));

    public static string HashPointHex(double x, double y)
        => HashUtf8Hex(string.Create(CultureInfo.InvariantCulture, $"{NormalizeCoordinate(x):0.######},{NormalizeCoordinate(y):0.######}"));

    public static string NormalizeAnswer(string answer)
    {
        string value = answer ?? string.Empty;
        var builder = new StringBuilder(value.Length);
        foreach (char ch in value)
        {
            if (!char.IsWhiteSpace(ch))
            {
                builder.Append(char.ToUpperInvariant(ch));
            }
        }

        return builder.ToString();
    }

    public static string NormalizeStep(string step)
        => (step ?? string.Empty).Trim().ToLowerInvariant();

    public static double NormalizeCoordinate(double value)
        => double.IsFinite(value) ? Math.Clamp(value, 0d, 1d) : double.NaN;

    public static bool FixedTimeEqualsHex(string left, string right)
    {
        string normalizedLeft = (left ?? string.Empty).Trim().ToLowerInvariant();
        string normalizedRight = (right ?? string.Empty).Trim().ToLowerInvariant();
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
    public int RiskScore { get; init; }

    public int EffectiveRiskScore { get; init; }

    public PerceptionChallengeGeneratorDistributionPolicy GeneratorDistributionPolicy { get; init; } =
        PerceptionChallengeGeneratorDistributionPolicy.Default;
}

public sealed record PerceptionChallengeV2VerifyRequest(
    HttpContext Context,
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
    public string Family { get; init; } = PerceptionChallengeV2GeneratorFamilyRegistry.TextStroke;

    public string Variant { get; init; } =
        PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(PerceptionChallengeV2GeneratorFamilyRegistry.TextStroke);
}

public sealed record PerceptionChallengeV2TaskMaterial(
    RenderRecipeV2TaskKind TaskKind,
    RenderRecipeV2 Recipe,
    string? ExpectedAnswer,
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
    string? ExpectedAnswerHashHex,
    string? ExpectedStepHashHex,
    double? ExpectedX,
    double? ExpectedY,
    double? CoordinateTolerance)
{
    public string Family { get; init; } = PerceptionChallengeV2GeneratorFamilyRegistry.TextStroke;

    public string Variant { get; init; } =
        PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(PerceptionChallengeV2GeneratorFamilyRegistry.TextStroke);
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
    public string Family { get; init; } = PerceptionChallengeV2GeneratorFamilyRegistry.TextStroke;

    public string Variant { get; init; } =
        PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(PerceptionChallengeV2GeneratorFamilyRegistry.TextStroke);
}

public sealed record PerceptionChallengeV2IssueResult(
    bool Succeeded,
    string Reason,
    SecurityChallengeAssignment? Assignment,
    PerceptionChallengeV2IssuePayload Payload)
{
    public static PerceptionChallengeV2IssueResult Failed(string reason)
        => new(false, NormalizeReason(reason), null, EmptyPayload);

    public static PerceptionChallengeV2IssueResult Success(SecurityChallengeAssignment assignment, PerceptionChallengeV2IssuePayload payload)
        => new(true, "ok", assignment, payload);

    private static readonly RenderRecipeV2 EmptyRecipe =
        new(RenderRecipeV2Contracts.Schema, RenderRecipeV2TaskKind.Unknown, [], new Dictionary<string, string>(StringComparer.Ordinal));

    private static readonly PerceptionChallengeV2IssuePayload EmptyPayload =
        new(string.Empty, string.Empty, RenderRecipeV2TaskKind.Unknown, EmptyRecipe, string.Empty, string.Empty, string.Empty, 0, 0);

    private static string NormalizeReason(string reason)
        => string.IsNullOrWhiteSpace(reason) ? "perception_issue_failed" : reason.Trim();
}

public sealed record PerceptionChallengeV2VerifyResult(bool Verified, string Reason, string? ProofToken)
{
    public static PerceptionChallengeV2VerifyResult Success(string proofToken)
        => new(true, "ok", proofToken);

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

        string challengeId = SecurityChallengeContracts.CreateChallengeId();
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
            string.IsNullOrWhiteSpace(material.ExpectedAnswer) ? null : PerceptionChallengeV2Hashing.HashAnswerHex(material.ExpectedAnswer),
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
    ISecurityChallengeProofService proofService,
    ISecurityRiskSignalSink riskSignalSink,
    TimeProvider timeProvider) : IPerceptionChallengeV2VerifyService
{
    public async Task<PerceptionChallengeV2VerifyResult> VerifyAsync(PerceptionChallengeV2VerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (!TryParseCommonPayload(request.ProviderPayload, out PerceptionChallengeV2VerifyPayload payload))
        {
            await RecordRiskAsync(request, "perception_payload_invalid", cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed("payload_invalid");
        }

        PerceptionChallengeV2UnsealResult unsealed = await tokenProtector.UnsealAsync(payload.SealedToken, payload.SignatureHex, cancellationToken);
        if (!unsealed.Succeeded || unsealed.Claims is null)
        {
            await RecordRiskAsync(request, "perception_token_invalid", cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(unsealed.Reason);
        }

        PerceptionChallengeV2TokenClaims claims = unsealed.Claims;
        string? bindingMismatch = ValidateBinding(request, payload, claims);
        if (bindingMismatch is not null)
        {
            await RecordRiskAsync(request, $"perception_{bindingMismatch}", cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(bindingMismatch);
        }

        if (claims.ExpiresAt <= timeProvider.GetUtcNow())
        {
            await RecordRiskAsync(request, "perception_token_expired", cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed("token_expired");
        }

        PerceptionChallengeV2AttemptGateResult attempt = await redisGate.RegisterAttemptAsync(
            claims.ChallengeId,
            claims.ExpiresAt,
            claims.MaxAttempts,
            cancellationToken);
        if (!attempt.Allowed)
        {
            await RecordRiskAsync(request, MapGateRiskDetail(attempt.Reason), cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(attempt.Reason);
        }

        if (!TryValidateSolveDuration(request.ProviderPayload, claims, out string? durationReason))
        {
            await RecordRiskAsync(request, $"perception_{durationReason}", cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(durationReason ?? "solve_duration_invalid");
        }

        if (!ValidateTaskAnswer(request.ProviderPayload, claims, out string? answerReason))
        {
            await RecordRiskAsync(request, $"perception_{answerReason}", cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(answerReason ?? "answer_invalid");
        }

        PerceptionChallengeV2ConsumeResult consume = await redisGate.TryConsumeOnceAsync(claims.ChallengeId, claims.ExpiresAt, cancellationToken);
        if (!consume.Consumed)
        {
            await RecordRiskAsync(request, consume.Reason == "challenge_replayed" ? "perception_challenge_replayed" : "perception_redis_unavailable", cancellationToken);
            return PerceptionChallengeV2VerifyResult.Failed(consume.Reason);
        }

        SecurityChallengeProofMintResult proof = await proofService.MintProofAsync(
            new SecurityChallengeProofMintRequest(
                claims.ChallengeId,
                claims.Kind,
                claims.Action,
                claims.RouteKey,
                claims.SubjectHash,
                claims.ClientIpHash,
                claims.DeviceFpHash,
                claims.PolicyVersion,
                timeProvider.GetUtcNow(),
                claims.ExpiresAt),
            cancellationToken);
        return PerceptionChallengeV2VerifyResult.Success(proof.ProofToken);
    }

    private ValueTask RecordRiskAsync(PerceptionChallengeV2VerifyRequest request, string detail, CancellationToken cancellationToken)
        => riskSignalSink.AddRiskAsync(
            new SecurityRiskSignal(
                request.Context,
                SecurityRiskReason.SecurityChallengeRejected,
                10,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.RiskControl,
                string.IsNullOrWhiteSpace(request.Action) ? "security_challenge" : request.Action,
                detail),
            cancellationToken);

    private static string? ValidateBinding(
        PerceptionChallengeV2VerifyRequest request,
        PerceptionChallengeV2VerifyPayload payload,
        PerceptionChallengeV2TokenClaims claims)
    {
        if (!FixedEquals(payload.KeyVersion, claims.KeyVersion)) return "key_version_mismatch";
        if (payload.TaskKind != claims.TaskKind) return "task_kind_mismatch";
        if (!FixedEquals(request.ChallengeId, claims.ChallengeId)) return "challenge_id_mismatch";
        if (!FixedEquals(request.Action, claims.Action)) return "action_mismatch";
        if (!FixedEquals(request.RouteKey, claims.RouteKey)) return "route_key_mismatch";
        if (!FixedEquals(request.SubjectHash, claims.SubjectHash)) return "subject_hash_mismatch";
        if (!FixedEquals(request.ClientIpHash, claims.ClientIpHash)) return "client_ip_hash_mismatch";
        if (!FixedEquals(request.DeviceFpHash, claims.DeviceFpHash)) return "device_fp_hash_mismatch";
        if (!FixedEquals(request.PolicyVersion, claims.PolicyVersion)) return "policy_version_mismatch";
        if (!PerceptionChallengeV2Hashing.FixedTimeEqualsHex(payload.RecipeHashHex, claims.RecipeHashHex)) return "recipe_hash_mismatch";
        if (!FixedEquals(payload.Algorithm, claims.Algorithm)) return "algorithm_mismatch";
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
            reason = "solve_duration_invalid";
            return false;
        }

        if (solveDurationMs < 0)
        {
            reason = "solve_duration_invalid";
            return false;
        }

        if (solveDurationMs < PerceptionChallengeV2Constants.MinSolveDurationMs)
        {
            reason = "solve_too_fast";
            return false;
        }

        if (solveDurationMs > PerceptionChallengeV2Constants.MaxSolveDurationMs)
        {
            reason = "solve_too_slow";
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
            RenderRecipeV2TaskKind.Character => ValidateCharacter(providerPayload, claims, out reason),
            RenderRecipeV2TaskKind.Localization => ValidateCoordinates(providerPayload, claims, requireStep: false, out reason),
            RenderRecipeV2TaskKind.MicroInteraction => ValidateCoordinates(providerPayload, claims, requireStep: true, out reason),
            _ => Fail("task_kind_invalid", out reason)
        };
    }

    private static bool ValidateCharacter(IReadOnlyDictionary<string, string> providerPayload, PerceptionChallengeV2TokenClaims claims, out string? reason)
    {
        reason = null;
        if (!TryGet(providerPayload, "answerText", out string answer) ||
            string.IsNullOrWhiteSpace(claims.ExpectedAnswerHashHex))
        {
            reason = "answer_invalid";
            return false;
        }

        if (!PerceptionChallengeV2Hashing.FixedTimeEqualsHex(
                PerceptionChallengeV2Hashing.HashAnswerHex(answer),
                claims.ExpectedAnswerHashHex))
        {
            reason = "answer_invalid";
            return false;
        }

        return true;
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
            reason = "coordinate_invalid";
            return false;
        }

        double dx = x - expectedX;
        double dy = y - expectedY;
        if (Math.Sqrt((dx * dx) + (dy * dy)) > tolerance)
        {
            reason = "coordinate_invalid";
            return false;
        }

        if (requireStep)
        {
            if (!TryGet(providerPayload, "step", out string step) ||
                string.IsNullOrWhiteSpace(claims.ExpectedStepHashHex) ||
                !PerceptionChallengeV2Hashing.FixedTimeEqualsHex(
                    PerceptionChallengeV2Hashing.HashStepHex(step),
                    claims.ExpectedStepHashHex))
            {
                reason = "steps_invalid";
                return false;
            }
        }

        return true;
    }

    private static string MapGateRiskDetail(string reason)
        => reason switch
        {
            "attempt_exceeded" => "perception_attempt_exceeded",
            "redis_unavailable" => "perception_redis_unavailable",
            _ => "perception_attempt_rejected"
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
            !PerceptionChallengeV2Contracts.TryParseWireTaskKind(taskKindValue, out RenderRecipeV2TaskKind taskKind))
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
            long count = await _database.StringIncrementAsync(key, 1, CommandFlags.None).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await _database.KeyExpireAsync(key, ttl, CommandFlags.None).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
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
