using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("security_challenge")]
[SugarIndex("unique_idx_security_challenge_id", nameof(ChallengeId), OrderByType.Asc, true)]
[SugarIndex("idx_security_challenge_status_expiry", nameof(Status), OrderByType.Asc, nameof(ExpiresAtUtc), OrderByType.Asc)]
[SugarIndex("idx_security_challenge_action_route", nameof(Action), OrderByType.Asc, nameof(RouteKey), OrderByType.Asc)]
[SugarIndex("idx_security_challenge_subject", nameof(SubjectHash), OrderByType.Asc)]
public sealed class SecurityChallenge
{
    [SugarColumn(ColumnName = "id", IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "challenge_id", Length = 64)]
    public string ChallengeId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "status", Length = 32)]
    public string Status { get; set; } = SecurityChallengeStatuses.Issued;

    [SugarColumn(ColumnName = "kind", Length = 64)]
    public string Kind { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "algorithm", Length = 64)]
    public string Algorithm { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "action", Length = 96)]
    public string Action { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "route_key", Length = 256)]
    public string RouteKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "subject_hash", Length = 64)]
    public string SubjectHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "client_ip_hash", Length = 64)]
    public string ClientIpHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "device_fp_hash", Length = 64)]
    public string DeviceFpHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "policy_version", Length = 64)]
    public string PolicyVersion { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "payload_hash", Length = 64)]
    public string PayloadHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "trace_id", Length = 64, IsNullable = true)]
    public string? TraceId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "traceparent", Length = 128, IsNullable = true)]
    public string? Traceparent
    {
        get; set;
    }

    [SugarColumn(ColumnName = "issued_at_utc")]
    public DateTime IssuedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "expires_at_utc")]
    public DateTime ExpiresAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "verified_at_utc", IsNullable = true)]
    public DateTime? VerifiedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revoked_at_utc", IsNullable = true)]
    public DateTime? RevokedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

[SugarTable("security_challenge_attempt")]
[SugarIndex("unique_idx_security_challenge_attempt_id", nameof(AttemptId), OrderByType.Asc, true)]
[SugarIndex("idx_security_challenge_attempt_challenge", nameof(ChallengeId), OrderByType.Asc, nameof(AttemptedAtUtc), OrderByType.Desc)]
[SugarIndex("idx_security_challenge_attempt_outcome", nameof(Outcome), OrderByType.Asc, nameof(AttemptedAtUtc), OrderByType.Desc)]
public sealed class SecurityChallengeAttempt
{
    [SugarColumn(ColumnName = "id", IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "attempt_id", Length = 64)]
    public string AttemptId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "challenge_id", Length = 64)]
    public string ChallengeId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "outcome", Length = 32)]
    public string Outcome { get; set; } = SecurityChallengeAttemptOutcomes.Failed;

    [SugarColumn(ColumnName = "reason", Length = 128, IsNullable = true)]
    public string? Reason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "payload_hash", Length = 64, IsNullable = true)]
    public string? PayloadHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "client_ip_hash", Length = 64, IsNullable = true)]
    public string? ClientIpHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "device_fp_hash", Length = 64, IsNullable = true)]
    public string? DeviceFpHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "trace_id", Length = 64, IsNullable = true)]
    public string? TraceId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "traceparent", Length = 128, IsNullable = true)]
    public string? Traceparent
    {
        get; set;
    }

    [SugarColumn(ColumnName = "attempted_at_utc")]
    public DateTime AttemptedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}

public static class SecurityChallengeStatuses
{
    public const string Issued = "issued";
    public const string Verified = "verified";
    public const string Expired = "expired";
    public const string Replayed = "replayed";
    public const string Failed = "failed";
    public const string Revoked = "revoked";
}

public static class SecurityChallengeAttemptOutcomes
{
    public const string Verified = SecurityChallengeStatuses.Verified;
    public const string Failed = SecurityChallengeStatuses.Failed;
    public const string Replayed = SecurityChallengeStatuses.Replayed;
    public const string Expired = SecurityChallengeStatuses.Expired;
    public const string Revoked = SecurityChallengeStatuses.Revoked;
}
