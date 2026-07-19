using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>
/// Short-lived, single-purpose authority for binding the first Passkey. It is not
/// an authentication session and never contains a normal refresh-token hash.
/// </summary>
[SugarTable("account_enrollment_session")]
[SugarIndex("ux_account_enrollment_account", nameof(AccountId), OrderByType.Asc, true)]
[SugarIndex("idx_account_enrollment_expiry", nameof(ExpiresAt), OrderByType.Asc)]
public sealed class AccountEnrollmentSession
{
    [SugarColumn(ColumnName = "token_hash", IsPrimaryKey = true, Length = 64)]
    public string TokenHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "account_id")]
    public int AccountId
    {
        get; set;
    }

    [SugarColumn(Length = 24, DefaultValue = "pending")]
    public string State { get; set; } = AccountEnrollmentStates.Pending;

    [SugarColumn(ColumnName = "passkey_user_handle", Length = 128)]
    public string PasskeyUserHandle { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "registration_challenge_key", Length = 64, IsNullable = true)]
    public string? RegistrationChallengeKey
    {
        get; set;
    }

    [SugarColumn(ColumnName = "completion_request_hash", Length = 64, IsNullable = true)]
    public string? CompletionRequestHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "completion_lease_until", IsNullable = true)]
    public DateTime? CompletionLeaseUntil
    {
        get; set;
    }

    [SugarColumn(ColumnName = "completed_session_id", Length = 64, IsNullable = true)]
    public string? CompletedSessionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "protected_refresh_token", ColumnDataType = "text", IsNullable = true)]
    public string? ProtectedRefreshToken
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "expires_at")]
    public DateTime ExpiresAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "completed_at", IsNullable = true)]
    public DateTime? CompletedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "cancelled_at", IsNullable = true)]
    public DateTime? CancelledAt
    {
        get; set;
    }
}

public static class AccountEnrollmentStates
{
    public const string Pending = "pending";
    public const string Completing = "completing";
    public const string Completed = "completed";
    public const string Cancelled = "cancelled";
    public const string Expired = "expired";
}
