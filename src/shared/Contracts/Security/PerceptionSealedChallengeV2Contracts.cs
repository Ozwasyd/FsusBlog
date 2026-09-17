namespace FsusBlog.Shared.Contracts.Security;

/// <summary>
/// Enumerates security-protocol values represented by <c>PerceptionSealedTaskKind</c>.
/// </summary>
public enum PerceptionSealedTaskKind : byte
{
    Unknown = 0,
    Localization = 2,
    MicroInteraction = 3
}

/// <summary>
/// Enumerates security-protocol values represented by <c>PerceptionSealedResultPayloadKind</c>.
/// </summary>
public enum PerceptionSealedResultPayloadKind : byte
{
    Unknown = 0,
    Coordinates = 2,
    Steps = 3
}

/// <summary>
/// Defines the security transport contract represented by <c>PerceptionSealedChallengeV2</c>.
/// </summary>
public sealed record class PerceptionSealedChallengeV2(
    SecurityChallengeAssignment Assignment,
    string Algorithm,
    PerceptionSealedTaskKind TaskKind,
    string RenderRecipeBase64,
    string RecipeHashHex,
    string SealedTokenBase64,
    string SignatureHex,
    int GridWidth,
    int GridHeight,
    string Family,
    string Variant,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs);

/// <summary>
/// Defines the security transport contract represented by <c>PerceptionSealedResultV2</c>.
/// </summary>
public sealed record class PerceptionSealedResultV2(
    SecurityChallengeAssignment Assignment,
    string Algorithm,
    PerceptionSealedTaskKind TaskKind,
    PerceptionSealedResultPayloadKind PayloadKind,
    string ResponsePayloadBase64,
    string RecipeHashHex,
    string SealedTokenBase64,
    string SignatureHex,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs);

/// <summary>
/// Defines the security transport contract represented by <c>PerceptionSealedContractValidationResult</c>.
/// </summary>
public sealed record PerceptionSealedContractValidationResult(bool IsValid, string ErrorCode)
{
    public static PerceptionSealedContractValidationResult Valid { get; } = new(true, string.Empty);
}

/// <summary>
/// Provides canonical validation and serialization rules for the <c>PerceptionSealedChallengeV2Contracts</c> security contract family.
/// </summary>
public static class PerceptionSealedChallengeV2Contracts
{
    public const string Algorithm = "fsu.challenge/perception-sealed@v2";
    public const int MaxGridSize = 128;

    public static PerceptionSealedTaskKind ToTaskKind(SecurityChallengeKind kind)
        => kind switch
        {
            SecurityChallengeKind.PerceptionLocalizationV2 => PerceptionSealedTaskKind.Localization,
            SecurityChallengeKind.PerceptionMicroInteractionV2 => PerceptionSealedTaskKind.MicroInteraction,
            _ => PerceptionSealedTaskKind.Unknown
        };

    public static SecurityChallengeKind ToChallengeKind(PerceptionSealedTaskKind taskKind)
        => taskKind switch
        {
            PerceptionSealedTaskKind.Localization => SecurityChallengeKind.PerceptionLocalizationV2,
            PerceptionSealedTaskKind.MicroInteraction => SecurityChallengeKind.PerceptionMicroInteractionV2,
            _ => SecurityChallengeKind.Unknown
        };

    public static PerceptionSealedContractValidationResult ValidateChallenge(PerceptionSealedChallengeV2? challenge)
    {
        if (challenge is null)
        {
            return Invalid("challenge_missing");
        }

        PerceptionSealedContractValidationResult common = ValidateCommon(
            challenge.Assignment,
            challenge.Algorithm,
            challenge.TaskKind,
            challenge.RecipeHashHex,
            challenge.SealedTokenBase64,
            challenge.SignatureHex,
            challenge.IssuedAtUnixMs,
            challenge.ExpiresAtUnixMs);
        if (!common.IsValid)
        {
            return common;
        }

        if (!IsBase64(challenge.RenderRecipeBase64))
            return Invalid("render_recipe_invalid");
        if (!IsGridDimension(challenge.GridWidth))
            return Invalid("grid_width_invalid");
        if (!IsGridDimension(challenge.GridHeight))
            return Invalid("grid_height_invalid");
        if (!IsSafeToken(challenge.Family))
            return Invalid("family_invalid");
        if (!IsSafeToken(challenge.Variant))
            return Invalid("variant_invalid");

        return PerceptionSealedContractValidationResult.Valid;
    }

    public static PerceptionSealedContractValidationResult ValidateResult(PerceptionSealedResultV2? result)
    {
        if (result is null)
        {
            return Invalid("result_missing");
        }

        PerceptionSealedContractValidationResult common = ValidateCommon(
            result.Assignment,
            result.Algorithm,
            result.TaskKind,
            result.RecipeHashHex,
            result.SealedTokenBase64,
            result.SignatureHex,
            result.IssuedAtUnixMs,
            result.ExpiresAtUnixMs);
        if (!common.IsValid)
        {
            return common;
        }

        if (!IsExpectedPayloadKind(result.TaskKind, result.PayloadKind))
            return Invalid("payload_kind_mismatch");
        if (!IsBase64(result.ResponsePayloadBase64))
            return Invalid("response_payload_invalid");

        return PerceptionSealedContractValidationResult.Valid;
    }

    private static PerceptionSealedContractValidationResult ValidateCommon(
        SecurityChallengeAssignment? assignment,
        string algorithm,
        PerceptionSealedTaskKind taskKind,
        string recipeHashHex,
        string sealedTokenBase64,
        string signatureHex,
        long issuedAtUnixMs,
        long expiresAtUnixMs)
    {
        if (!string.Equals(algorithm, Algorithm, StringComparison.Ordinal))
            return Invalid("algorithm_invalid");
        if (taskKind == PerceptionSealedTaskKind.Unknown)
            return Invalid("task_kind_invalid");

        SecurityChallengeKind expectedKind = ToChallengeKind(taskKind);
        SecurityChallengeValidationResult assignmentResult = SecurityChallengeContracts.ValidateAssignment(assignment, expectedKind);
        if (!assignmentResult.IsValid)
            return Invalid(assignmentResult.ErrorCode);

        if (!IsSha256Hex(recipeHashHex))
            return Invalid("recipe_hash_invalid");
        if (!IsBase64(sealedTokenBase64))
            return Invalid("sealed_token_invalid");
        if (!IsSha256Hex(signatureHex))
            return Invalid("signature_invalid");
        if (expiresAtUnixMs <= issuedAtUnixMs)
            return Invalid("expires_at_invalid");
        if (assignment!.IssuedAtUnixMs != issuedAtUnixMs || assignment.ExpiresAtUnixMs != expiresAtUnixMs)
        {
            return Invalid("assignment_time_mismatch");
        }

        return PerceptionSealedContractValidationResult.Valid;
    }

    private static bool IsExpectedPayloadKind(PerceptionSealedTaskKind taskKind, PerceptionSealedResultPayloadKind payloadKind)
        => (taskKind, payloadKind) switch
        {
            (PerceptionSealedTaskKind.Localization, PerceptionSealedResultPayloadKind.Coordinates) => true,
            (PerceptionSealedTaskKind.MicroInteraction, PerceptionSealedResultPayloadKind.Steps) => true,
            _ => false
        };

    private static bool IsGridDimension(int value)
        => value is > 0 and <= MaxGridSize;

    private static bool IsBase64(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        try
        {
            _ = Convert.FromBase64String(value);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool IsSha256Hex(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length != 64)
        {
            return false;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            char ch = normalized[i];
            if (!((ch >= '0' && ch <= '9') ||
                  (ch >= 'a' && ch <= 'f') ||
                  (ch >= 'A' && ch <= 'F')))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsSafeToken(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length is <= 0 or > 64)
        {
            return false;
        }

        for (int i = 0; i < normalized.Length; i++)
        {
            char ch = normalized[i];
            if (!((ch >= 'a' && ch <= 'z') ||
                  (ch >= 'A' && ch <= 'Z') ||
                  (ch >= '0' && ch <= '9') ||
                  ch is '-' or '_' or ':' or '.'))
            {
                return false;
            }
        }

        return true;
    }

    private static PerceptionSealedContractValidationResult Invalid(string errorCode)
        => new(false, errorCode);
}
