namespace FsusBlog.Shared.Contracts.Security;

public enum PerceptionCharacterV3Representation : byte
{
    Unknown = 0,
    Visual = 1,
    Audio = 2
}

/// <summary>Closed V3 issue union member. It contains final media, never a render recipe or answer oracle.</summary>
public sealed record PerceptionCharacterV3IssuePayload(
    string Algorithm,
    string ChallengeId,
    string EnvelopeId,
    PerceptionCharacterV3Representation Representation,
    string MediaType,
    byte[] MediaBytes,
    ushort PhysicalWidth,
    ushort PhysicalHeight,
    ushort DisplayWidth,
    ushort DisplayHeight,
    byte AttemptBudget,
    string PolicyVersion,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs,
    string StateToken);

/// <summary>Closed V3 verify union member. No issue media, recipe, seed, signature, key or solve duration is accepted.</summary>
public sealed record PerceptionCharacterV3VerifyPayload(
    string Algorithm,
    string ChallengeId,
    string EnvelopeId,
    PerceptionCharacterV3Representation Representation,
    string Answer,
    string StateToken);

public static class PerceptionCharacterV3Contracts
{
    public const string Algorithm = "fsu.challenge/perception-character-raster@v3";
    public const string WireName = "perceptionCharacterV3";
    public const int MaxVisualMediaBytes = 512 * 192;
    public const int MaxAudioMediaBytes = 256 * 1024;
    public const int MaxStateTokenBytes = 2048;
    public const int MaxAnswerChars = 32;

    public static SecurityChallengeValidationResult ValidateIssue(PerceptionCharacterV3IssuePayload? payload)
    {
        if (payload is null)
            return Invalid("v3_issue_missing");
        if (!string.Equals(payload.Algorithm, Algorithm, StringComparison.Ordinal))
            return Invalid("v3_algorithm_invalid");
        if (!IsUuidV7(payload.ChallengeId) || !IsUuidV7(payload.EnvelopeId))
            return Invalid("v3_identity_invalid");
        if (payload.Representation is not (PerceptionCharacterV3Representation.Visual or PerceptionCharacterV3Representation.Audio))
            return Invalid("v3_representation_invalid");
        int maximum = payload.Representation == PerceptionCharacterV3Representation.Visual ? MaxVisualMediaBytes : MaxAudioMediaBytes;
        if (payload.MediaBytes is null || payload.MediaBytes.Length is <= 0 || payload.MediaBytes.Length > maximum)
            return Invalid("v3_media_size_invalid");
        if (payload.Representation == PerceptionCharacterV3Representation.Visual &&
            (payload.MediaBytes.Length != MaxVisualMediaBytes || payload.PhysicalWidth != 512 || payload.PhysicalHeight != 192 || payload.DisplayWidth != 320 || payload.DisplayHeight != 120 || payload.MediaType != "application/x-fsus-gray8"))
            return Invalid("v3_visual_shape_invalid");
        if (payload.Representation == PerceptionCharacterV3Representation.Audio &&
            (payload.MediaType != "audio/wav" || payload.PhysicalWidth != 0 || payload.PhysicalHeight != 0 || payload.DisplayWidth != 0 || payload.DisplayHeight != 0))
            return Invalid("v3_audio_shape_invalid");
        if (payload.AttemptBudget != 2 || payload.ExpiresAtUnixMs <= payload.IssuedAtUnixMs)
            return Invalid("v3_lifetime_invalid");
        if (string.IsNullOrWhiteSpace(payload.PolicyVersion) || string.IsNullOrWhiteSpace(payload.StateToken) || payload.StateToken.Length > MaxStateTokenBytes)
            return Invalid("v3_state_invalid");
        return SecurityChallengeValidationResult.Valid;
    }

    public static SecurityChallengeValidationResult ValidateVerify(PerceptionCharacterV3VerifyPayload? payload)
    {
        if (payload is null)
            return Invalid("v3_verify_missing");
        if (!string.Equals(payload.Algorithm, Algorithm, StringComparison.Ordinal))
            return Invalid("v3_algorithm_invalid");
        if (!IsUuidV7(payload.ChallengeId) || !IsUuidV7(payload.EnvelopeId))
            return Invalid("v3_identity_invalid");
        if (payload.Representation is not (PerceptionCharacterV3Representation.Visual or PerceptionCharacterV3Representation.Audio))
            return Invalid("v3_representation_invalid");
        if (payload.Answer is null || payload.Answer.Length > MaxAnswerChars || string.IsNullOrWhiteSpace(payload.StateToken) || payload.StateToken.Length > MaxStateTokenBytes)
            return Invalid("v3_verify_fields_invalid");
        return SecurityChallengeValidationResult.Valid;
    }

    private static bool IsUuidV7(string? value)
        => value is not null && Guid.TryParseExact(value, "D", out _) && value[14] == '7';

    private static SecurityChallengeValidationResult Invalid(string reason) => new(false, reason);
}
