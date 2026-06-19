namespace FsusBlog.Shared.Contracts.Security;

public enum SecurityChallengeKind : byte
{
    Unknown = 0,
    Sha256PowV1 = 1,
    Argon2IdPoSpaceV1 = 2,
    CaptchaV1 = 3,
    HumanReadProofV1 = 4,
    PasskeyStepUpV1 = 5,
    AdminPasskeyStepUpV1 = 6,
    RecoveryKeyProofV1 = 7,
    AnonymousCredentialProofV1 = 8,
    ZkAnonymousCommentProofV1 = 9,
    PerceptionCharacterV2 = 10,
    PerceptionLocalizationV2 = 11,
    PerceptionMicroInteractionV2 = 12,
    PerceptionTextTaskV2 = 13
}

public sealed record class SecurityChallengeAssignment(
    string ChallengeId,
    string Traceparent,
    string TenantId,
    SecurityChallengeKind Kind,
    int EscalationLevel,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs);

public sealed record class SecurityChallengeEnvelope(
    string EnvelopeId,
    string PolicyVersion,
    IReadOnlyList<SecurityChallengeAssignment> Assignments);

public enum SecurityChallengeDecisionKind : byte
{
    Unknown = 0,
    Allow = 1,
    Challenge = 2,
    StepUp = 3,
    QueueForModeration = 4,
    Throttle = 5,
    Block = 6
}

public sealed record class SecurityChallengeIssueBinaryRequest(
    string Action,
    string RouteKey,
    string DeviceFingerprint,
    string AttributesJson);

public sealed record class SecurityChallengeVerifyBinaryRequest(
    string ChallengeId,
    SecurityChallengeKind Kind,
    string Action,
    string RouteKey,
    string ProviderPayloadJson);

public sealed record class SecurityChallengeProviderPayload(
    string ChallengeId,
    string PayloadJson);

public sealed record class SecurityChallengeIssueBinaryResponse(
    SecurityChallengeDecisionKind Decision,
    int RiskScore,
    int EffectiveRiskScore,
    int EscalationLevel,
    string PolicyVersion,
    int RetryAfterMs,
    SecurityChallengeEnvelope? Envelope,
    IReadOnlyList<SecurityChallengeProviderPayload> ProviderPayloads);

public sealed record class SecurityChallengeVerifyBinaryResponse(
    bool Verified,
    string ChallengeId,
    SecurityChallengeKind Kind,
    string PolicyVersion,
    string ProofToken,
    string Reason,
    int RetryAfterMs);

public sealed record SecurityChallengeValidationResult(bool IsValid, string ErrorCode)
{
    public static SecurityChallengeValidationResult Valid { get; } = new(true, string.Empty);
}

public static class SecurityChallengeContracts
{
    public const int MaxAssignmentsPerEnvelope = 8;

    public static readonly IReadOnlySet<SecurityChallengeKind> SupportedKinds = new HashSet<SecurityChallengeKind>
    {
        SecurityChallengeKind.Sha256PowV1,
        SecurityChallengeKind.Argon2IdPoSpaceV1,
        SecurityChallengeKind.CaptchaV1,
        SecurityChallengeKind.HumanReadProofV1,
        SecurityChallengeKind.PasskeyStepUpV1,
        SecurityChallengeKind.AdminPasskeyStepUpV1,
        SecurityChallengeKind.RecoveryKeyProofV1,
        SecurityChallengeKind.AnonymousCredentialProofV1,
        SecurityChallengeKind.ZkAnonymousCommentProofV1,
        SecurityChallengeKind.PerceptionCharacterV2,
        SecurityChallengeKind.PerceptionLocalizationV2,
        SecurityChallengeKind.PerceptionMicroInteractionV2
    };

    public static string CreateChallengeId()
        => Guid.CreateVersion7().ToString("D");

    public static bool TryParseKind(string? value, out SecurityChallengeKind kind)
    {
        kind = SecurityChallengeKind.Unknown;
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return false;
        }

        if (string.Equals(normalized, "security.pow", StringComparison.Ordinal))
        {
            kind = SecurityChallengeKind.Sha256PowV1;
            return true;
        }

        if (string.Equals(normalized, "perceptionTextTaskV2", StringComparison.Ordinal))
        {
            kind = SecurityChallengeKind.PerceptionTextTaskV2;
            return true;
        }

        foreach (SecurityChallengeKind candidate in SupportedKinds)
        {
            if (string.Equals(ToWireName(candidate), normalized, StringComparison.Ordinal))
            {
                kind = candidate;
                return true;
            }
        }

        return false;
    }

    public static string ToWireName(SecurityChallengeKind kind)
        => kind switch
        {
            SecurityChallengeKind.Sha256PowV1 => "sha256PowV1",
            SecurityChallengeKind.Argon2IdPoSpaceV1 => "argon2idPoSpaceV1",
            SecurityChallengeKind.CaptchaV1 => "captchaV1",
            SecurityChallengeKind.HumanReadProofV1 => "humanReadProofV1",
            SecurityChallengeKind.PasskeyStepUpV1 => "passkeyStepUpV1",
            SecurityChallengeKind.AdminPasskeyStepUpV1 => "adminPasskeyStepUpV1",
            SecurityChallengeKind.RecoveryKeyProofV1 => "recoveryKeyProofV1",
            SecurityChallengeKind.AnonymousCredentialProofV1 => "anonymousCredentialProofV1",
            SecurityChallengeKind.ZkAnonymousCommentProofV1 => "zkAnonymousCommentProofV1",
            SecurityChallengeKind.PerceptionTextTaskV2 => "perceptionTextTaskV2",
            SecurityChallengeKind.PerceptionCharacterV2 => "perceptionCharacterV2",
            SecurityChallengeKind.PerceptionLocalizationV2 => "perceptionLocalizationV2",
            SecurityChallengeKind.PerceptionMicroInteractionV2 => "perceptionMicroInteractionV2",
            _ => "unknown"
        };

    public static SecurityChallengeValidationResult ValidateAssignment(
        SecurityChallengeAssignment? assignment,
        SecurityChallengeKind? expectedKind = null)
    {
        if (assignment is null)
        {
            return Invalid("assignment_missing");
        }

        if (IsMissing(assignment.ChallengeId)) return Invalid("challenge_id_missing");
        if (IsMissing(assignment.Traceparent)) return Invalid("traceparent_missing");
        if (IsMissing(assignment.TenantId)) return Invalid("tenant_id_missing");
        if (assignment.Kind == SecurityChallengeKind.Unknown || !IsSupportedKind(assignment.Kind)) return Invalid("kind_invalid");
        if (expectedKind.HasValue && assignment.Kind != expectedKind.Value) return Invalid("kind_mismatch");
        if (assignment.EscalationLevel < 0) return Invalid("escalation_level_invalid");
        if (IsMissing(assignment.Action)) return Invalid("action_missing");
        if (IsMissing(assignment.RouteKey)) return Invalid("route_key_missing");
        if (!IsSha256Hex(assignment.SubjectHash)) return Invalid("subject_hash_invalid");
        if (!IsSha256Hex(assignment.ClientIpHash)) return Invalid("client_ip_hash_invalid");
        if (!IsSha256Hex(assignment.DeviceFpHash)) return Invalid("device_fp_hash_invalid");
        if (!IsCompatibleChallengeId(assignment.Kind, assignment.ChallengeId)) return Invalid("challenge_id_invalid");
        if (assignment.ExpiresAtUnixMs <= assignment.IssuedAtUnixMs) return Invalid("expires_at_invalid");

        return SecurityChallengeValidationResult.Valid;
    }

    public static SecurityChallengeValidationResult ValidateEnvelope(SecurityChallengeEnvelope? envelope)
    {
        if (envelope is null) return Invalid("envelope_missing");
        if (IsMissing(envelope.EnvelopeId)) return Invalid("envelope_id_missing");
        if (IsMissing(envelope.PolicyVersion)) return Invalid("policy_version_missing");
        if (envelope.Assignments.Count is <= 0 or > MaxAssignmentsPerEnvelope) return Invalid("assignment_count_invalid");

        foreach (SecurityChallengeAssignment assignment in envelope.Assignments)
        {
            SecurityChallengeValidationResult result = ValidateAssignment(assignment);
            if (!result.IsValid)
            {
                return result;
            }
        }

        return SecurityChallengeValidationResult.Valid;
    }

    private static bool IsCompatibleChallengeId(SecurityChallengeKind kind, string challengeId)
    {
        if (!Guid.TryParseExact(challengeId, "D", out _))
        {
            return false;
        }

        char version = challengeId[14];
        return kind == SecurityChallengeKind.CaptchaV1
            ? version is '4' or '7'
            : version == '7';
    }

    private static bool IsSupportedKind(SecurityChallengeKind kind)
        => SupportedKinds.Contains(kind) || kind == SecurityChallengeKind.PerceptionTextTaskV2;

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

    private static bool IsMissing(string? value)
        => string.IsNullOrWhiteSpace(value);

    private static SecurityChallengeValidationResult Invalid(string errorCode)
        => new(false, errorCode);
}
