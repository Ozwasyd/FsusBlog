using System.Data.Common;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface ISecurityChallengePersistenceService
{
    Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default);

    Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default);

    Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default);

    Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default);

    Task<string?> GetStatusAsync(string challengeId, CancellationToken cancellationToken = default)
        => Task.FromResult<string?>(null);
}

public sealed record SecurityChallengeIssueRequest(
    string ChallengeId,
    string Kind,
    string Algorithm,
    string Action,
    string RouteKey,
    string SubjectHash,
    string ClientIpHash,
    string DeviceFpHash,
    string PolicyVersion,
    string PayloadHash,
    string? TraceId,
    string? Traceparent,
    DateTime IssuedAtUtc,
    DateTime ExpiresAtUtc);

public sealed record SecurityChallengeAttemptRequest(
    string ChallengeId,
    string Outcome,
    string? Reason,
    string? PayloadHash,
    string? ClientIpHash,
    string? DeviceFpHash,
    string? TraceId,
    string? Traceparent,
    DateTime? AttemptedAtUtc = null);

internal sealed record SecurityChallengeMetricContext(
    string Kind,
    string Action,
    string PolicyVersion,
    DateTime IssuedAtUtc);

public sealed class SecurityChallengePersistenceService(ISqlSugarClient db) : ISecurityChallengePersistenceService
{
    private static readonly string[] s_validStatuses =
    [
        SecurityChallengeStatuses.Issued,
        SecurityChallengeStatuses.Verified,
        SecurityChallengeStatuses.Expired,
        SecurityChallengeStatuses.Replayed,
        SecurityChallengeStatuses.Failed,
        SecurityChallengeStatuses.Revoked
    ];

    public async Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        DateTime issuedAt = request.IssuedAtUtc.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(request.IssuedAtUtc, DateTimeKind.Utc)
            : request.IssuedAtUtc.ToUniversalTime();
        DateTime expiresAt = request.ExpiresAtUtc.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(request.ExpiresAtUtc, DateTimeKind.Utc)
            : request.ExpiresAtUtc.ToUniversalTime();
        if (expiresAt <= issuedAt)
        {
            throw new ArgumentException("expires_at_utc must be after issued_at_utc", nameof(request));
        }

        DateTime now = DateTime.UtcNow;
        var entity = new SecurityChallenge
        {
            ChallengeId = NormalizeRequired(request.ChallengeId, nameof(request.ChallengeId), 64),
            Status = SecurityChallengeStatuses.Issued,
            Kind = NormalizeRequired(request.Kind, nameof(request.Kind), 64),
            Algorithm = NormalizeRequired(request.Algorithm, nameof(request.Algorithm), 64),
            Action = NormalizeRequired(request.Action, nameof(request.Action), 96),
            RouteKey = NormalizeRequired(request.RouteKey, nameof(request.RouteKey), 256),
            SubjectHash = NormalizeHash(request.SubjectHash, nameof(request.SubjectHash), required: true)!,
            ClientIpHash = NormalizeHash(request.ClientIpHash, nameof(request.ClientIpHash), required: true)!,
            DeviceFpHash = NormalizeHash(request.DeviceFpHash, nameof(request.DeviceFpHash), required: true)!,
            PolicyVersion = NormalizeRequired(request.PolicyVersion, nameof(request.PolicyVersion), 64),
            PayloadHash = NormalizeHash(request.PayloadHash, nameof(request.PayloadHash), required: true)!,
            TraceId = NormalizeOptional(request.TraceId, 64),
            Traceparent = NormalizeOptional(request.Traceparent, 128),
            IssuedAtUtc = issuedAt,
            ExpiresAtUtc = expiresAt,
            CreatedAtUtc = now,
            UpdatedAtUtc = now
        };

        await db.Insertable(entity).ExecuteCommandAsync();
        SecurityChallenge stored = await db.Queryable<SecurityChallenge>().SingleAsync(item => item.ChallengeId == entity.ChallengeId);
        FsusObservability.RecordSecurityChallengeIssued(stored.Kind, stored.Action, stored.PolicyVersion);
        return stored;
    }

    public async Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        string challengeId = NormalizeRequired(request.ChallengeId, nameof(request.ChallengeId), 64);
        string outcome = NormalizeOutcome(request.Outcome);
        DateTime attemptedAt = request.AttemptedAtUtc is { } provided
            ? (provided.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(provided, DateTimeKind.Utc) : provided.ToUniversalTime())
            : DateTime.UtcNow;

        var attempt = new SecurityChallengeAttempt
        {
            AttemptId = Guid.CreateVersion7().ToString("D"),
            ChallengeId = challengeId,
            Outcome = outcome,
            Reason = NormalizeOptional(request.Reason, 128),
            PayloadHash = NormalizeHash(request.PayloadHash, nameof(request.PayloadHash), required: false),
            ClientIpHash = NormalizeHash(request.ClientIpHash, nameof(request.ClientIpHash), required: false),
            DeviceFpHash = NormalizeHash(request.DeviceFpHash, nameof(request.DeviceFpHash), required: false),
            TraceId = NormalizeOptional(request.TraceId, 64),
            Traceparent = NormalizeOptional(request.Traceparent, 128),
            AttemptedAtUtc = attemptedAt,
            CreatedAtUtc = DateTime.UtcNow
        };

        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await db.Insertable(attempt).ExecuteCommandAsync();
            SecurityChallengeMetricContext? metric = await ReadChallengeMetricContextAsync(
                    challengeId,
                    outcome,
                    attemptedAt)
                .ConfigureAwait(false);
            if (metric is null)
            {
                metric = await LoadChallengeMetricContextAsync(challengeId).ConfigureAwait(false);
                if (metric is null)
                {
                    throw new InvalidOperationException("Security challenge not found.");
                }
            }

            return metric;
        });

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Security challenge attempt persistence failed.", transaction.ErrorException);
        }

        RecordAttemptMetric(transaction.Data, attempt);
        return attempt;
    }

    public async Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
    {
        try
        {
            await RecordAttemptAsync(
                new SecurityChallengeAttemptRequest(
                    challengeId,
                    SecurityChallengeAttemptOutcomes.Expired,
                    string.IsNullOrWhiteSpace(reason) ? "expired" : reason,
                    PayloadHash: null,
                    ClientIpHash: null,
                    DeviceFpHash: null,
                    TraceId: null,
                    Traceparent: null,
                    DateTime.UtcNow),
                cancellationToken);
            return true;
        }
        catch (InvalidOperationException ex) when (IsNotFoundError(ex))
        {
            return false;
        }
    }

    public async Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default)
    {
        try
        {
            await RecordAttemptAsync(
                new SecurityChallengeAttemptRequest(
                    challengeId,
                    SecurityChallengeAttemptOutcomes.Revoked,
                    string.IsNullOrWhiteSpace(reason) ? "revoked" : reason,
                    PayloadHash: null,
                    ClientIpHash: null,
                    DeviceFpHash: null,
                    TraceId: null,
                    Traceparent: null,
                    DateTime.UtcNow),
                cancellationToken);
            return true;
        }
        catch (InvalidOperationException ex) when (IsNotFoundError(ex))
        {
            return false;
        }
    }

    public async Task<string?> GetStatusAsync(string challengeId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string normalizedChallengeId = NormalizeRequired(challengeId, nameof(challengeId), 64);
        return await db.Queryable<SecurityChallenge>()
            .Where(item => item.ChallengeId == normalizedChallengeId)
            .Select(item => item.Status)
            .SingleAsync();
    }

    private async Task<SecurityChallengeMetricContext?> ReadChallengeMetricContextAsync(
        string challengeId,
        string outcome,
        DateTime attemptedAt)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            UPDATE security_challenge
            SET status = CASE WHEN status NOT IN ('verified', 'revoked', 'expired') THEN @Status ELSE status END,
                verified_at_utc = CASE WHEN status NOT IN ('verified', 'revoked', 'expired') AND @Status = 'verified' THEN @AttemptedAt ELSE verified_at_utc END,
                revoked_at_utc = CASE WHEN status NOT IN ('verified', 'revoked', 'expired') AND @Status = 'revoked' THEN @AttemptedAt ELSE revoked_at_utc END,
                updated_at_utc = CASE WHEN status NOT IN ('verified', 'revoked', 'expired') THEN @AttemptedAt ELSE updated_at_utc END
            WHERE challenge_id = @ChallengeId
              AND status NOT IN ('verified', 'revoked', 'expired')
            RETURNING
                kind AS "Kind",
                action AS "Action",
                policy_version AS "PolicyVersion",
                issued_at_utc AS "IssuedAtUtc";
            """,
            new SugarParameter("@Status", outcome),
            new SugarParameter("@AttemptedAt", attemptedAt),
            new SugarParameter("@ChallengeId", challengeId));

        return await ReadMetricContextAsync(reader).ConfigureAwait(false);
    }

    private async Task<SecurityChallengeMetricContext?> LoadChallengeMetricContextAsync(string challengeId)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                kind AS "Kind",
                action AS "Action",
                policy_version AS "PolicyVersion",
                issued_at_utc AS "IssuedAtUtc"
            FROM security_challenge
            WHERE challenge_id = @ChallengeId
            LIMIT 1;
            """,
            new SugarParameter("@ChallengeId", challengeId));

        return await ReadMetricContextAsync(reader).ConfigureAwait(false);
    }

    private static async Task<SecurityChallengeMetricContext?> ReadMetricContextAsync(DbDataReader reader)
    {
        if (!await reader.ReadAsync().ConfigureAwait(false))
        {
            return null;
        }

        int fKind = reader.GetOrdinal("Kind");
        int fAction = reader.GetOrdinal("Action");
        int fPolicyVersion = reader.GetOrdinal("PolicyVersion");
        int fIssuedAt = reader.GetOrdinal("IssuedAtUtc");
        return new SecurityChallengeMetricContext(
            reader.IsDBNull(fKind) ? string.Empty : reader.GetString(fKind),
            reader.IsDBNull(fAction) ? string.Empty : reader.GetString(fAction),
            reader.IsDBNull(fPolicyVersion) ? string.Empty : reader.GetString(fPolicyVersion),
            reader.GetDateTime(fIssuedAt));
    }

    private static void RecordAttemptMetric(SecurityChallengeMetricContext challenge, SecurityChallengeAttempt attempt)
    {
        TimeSpan? solveDuration = attempt.AttemptedAtUtc >= challenge.IssuedAtUtc
            ? attempt.AttemptedAtUtc - challenge.IssuedAtUtc
            : null;
        string reason = string.IsNullOrWhiteSpace(attempt.Reason) ? attempt.Outcome : attempt.Reason;
        if (string.Equals(attempt.Outcome, SecurityChallengeAttemptOutcomes.Verified, StringComparison.Ordinal))
        {
            FsusObservability.RecordSecurityChallengeVerified(challenge.Kind, challenge.Action, challenge.PolicyVersion, solveDuration);
            return;
        }

        if (string.Equals(attempt.Outcome, SecurityChallengeAttemptOutcomes.Replayed, StringComparison.Ordinal))
        {
            FsusObservability.RecordSecurityChallengeReplayed(challenge.Kind, challenge.Action, reason, challenge.PolicyVersion);
            return;
        }

        FsusObservability.RecordSecurityChallengeFailed(challenge.Kind, challenge.Action, reason, challenge.PolicyVersion);
    }

    private static string NormalizeRequired(string? value, string name, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new ArgumentException($"{name} is required", name);
        }

        if (normalized.Length > maxLength)
        {
            throw new ArgumentException($"{name} exceeds {maxLength} characters", name);
        }

        return normalized;
    }

    private static string? NormalizeOptional(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return null;
        }

        if (normalized.Length > maxLength)
        {
            throw new ArgumentException($"Value exceeds {maxLength} characters");
        }

        return normalized;
    }

    private static string NormalizeOutcome(string value)
    {
        string normalized = NormalizeRequired(value, nameof(value), 32).ToLowerInvariant().Replace('-', '_');
        if (!s_validStatuses.Contains(normalized, StringComparer.Ordinal) || string.Equals(normalized, SecurityChallengeStatuses.Issued, StringComparison.Ordinal))
        {
            throw new ArgumentException($"Unsupported security challenge attempt outcome: {value}", nameof(value));
        }

        return normalized;
    }

    private static string? NormalizeHash(string? value, string name, bool required)
    {
        string normalized = TextHelpers.LowerTrimmed(value) ?? string.Empty;
        if (normalized.Length == 0)
        {
            if (required)
            {
                throw new ArgumentException($"{name} is required", name);
            }

            return null;
        }

        if (normalized.Length != 64 || !IsHex(normalized))
        {
            throw new ArgumentException($"{name} must be a 64-character hex hash", name);
        }

        return normalized;
    }

    private static bool IsHex(string value)
    {
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f')))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsNotFoundError(InvalidOperationException ex)
        => ex.Message.Contains("not found", StringComparison.OrdinalIgnoreCase)
            || ex.InnerException?.Message.Contains("not found", StringComparison.OrdinalIgnoreCase) == true;
}
