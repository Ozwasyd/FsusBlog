using FsusBlog.Server.Entities;
using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public interface ISecurityChallengePersistenceService
{
    Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default);

    Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default);

    Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default);

    Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default);
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

public sealed class SecurityChallengePersistenceService(ISqlSugarClient db) : ISecurityChallengePersistenceService
{
    private static readonly string[] ValidStatuses =
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
        return await db.Queryable<SecurityChallenge>().SingleAsync(item => item.ChallengeId == entity.ChallengeId);
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
            int updated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE security_challenge
                SET status = @Status,
                    verified_at_utc = CASE WHEN @Status = 'verified' THEN @AttemptedAt ELSE verified_at_utc END,
                    revoked_at_utc = CASE WHEN @Status = 'revoked' THEN @AttemptedAt ELSE revoked_at_utc END,
                    updated_at_utc = @AttemptedAt
                WHERE challenge_id = @ChallengeId;
                """,
                new SugarParameter("@Status", outcome),
                new SugarParameter("@AttemptedAt", attemptedAt),
                new SugarParameter("@ChallengeId", challengeId));
            if (updated <= 0)
            {
                throw new InvalidOperationException("Security challenge not found.");
            }

            return updated;
        });

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Security challenge attempt persistence failed.", transaction.ErrorException);
        }

        return await db.Queryable<SecurityChallengeAttempt>().SingleAsync(item => item.AttemptId == attempt.AttemptId);
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
        catch (InvalidOperationException ex) when (ex.InnerException?.Message.Contains("not found", StringComparison.OrdinalIgnoreCase) == true)
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
        catch (InvalidOperationException ex) when (ex.InnerException?.Message.Contains("not found", StringComparison.OrdinalIgnoreCase) == true)
        {
            return false;
        }
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
        if (!ValidStatuses.Contains(normalized, StringComparer.Ordinal) || string.Equals(normalized, SecurityChallengeStatuses.Issued, StringComparison.Ordinal))
        {
            throw new ArgumentException($"Unsupported security challenge attempt outcome: {value}", nameof(value));
        }

        return normalized;
    }

    private static string? NormalizeHash(string? value, string name, bool required)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
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
}
