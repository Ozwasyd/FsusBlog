using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Authoring;

public sealed record CommentModerationQueueCandidate(
    long CommentId,
    int AppealPriority,
    int RiskScore,
    DateTime CreatedAtUtc);

public sealed record CommentModerationQueueCursor(
    int AppealPriority,
    int RiskScore,
    long CreatedAtUtcTicks,
    long CommentId);

public sealed record CommentModerationClaimCommandResult(
    bool Success,
    string Code,
    CommentModerationQueueClaim? Claim = null,
    string? ClaimToken = null,
    string? CommentRowVersion = null);

public sealed class CommentModerationQueueService(
    TimeProvider timeProvider,
    Func<string>? claimTokenFactory = null)
{
    public static readonly TimeSpan MinimumLease = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan MaximumLease = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan MinimumProcessSla = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan MaximumProcessSla = TimeSpan.FromHours(24);

    private readonly Func<string> _claimTokenFactory = claimTokenFactory ?? CreateToken;

    public IReadOnlyList<CommentModerationQueueCandidate> Page(
        IEnumerable<CommentModerationQueueCandidate> candidates,
        CommentModerationQueueCursor? after,
        int limit)
    {
        int boundedLimit = Math.Clamp(limit, 1, 100);
        return candidates
            .Where(IsValidCandidate)
            .Where(candidate => after is null || IsAfter(candidate, after))
            .OrderByDescending(static candidate => candidate.AppealPriority)
            .ThenByDescending(static candidate => candidate.RiskScore)
            .ThenBy(static candidate => candidate.CreatedAtUtc)
            .ThenBy(static candidate => candidate.CommentId)
            .Take(boundedLimit)
            .ToArray();
    }

    public static string EncodeCursor(CommentModerationQueueCandidate candidate)
    {
        if (!IsValidCandidate(candidate))
        {
            throw new ArgumentOutOfRangeException(nameof(candidate));
        }

        string payload = FormattableString.Invariant(
            $"v1:{candidate.AppealPriority}:{candidate.RiskScore}:{candidate.CreatedAtUtc.ToUniversalTime().Ticks}:{candidate.CommentId}");
        return Convert.ToBase64String(Encoding.ASCII.GetBytes(payload))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    public static bool TryDecodeCursor(string? encoded, out CommentModerationQueueCursor? cursor)
    {
        cursor = null;
        if (string.IsNullOrWhiteSpace(encoded) || encoded.Length > 256)
        {
            return false;
        }

        try
        {
            string normalized = encoded.Replace('-', '+').Replace('_', '/');
            normalized = normalized.PadRight(normalized.Length + ((4 - normalized.Length % 4) % 4), '=');
            string[] parts = Encoding.ASCII.GetString(Convert.FromBase64String(normalized)).Split(':');
            if (parts.Length != 5
                || !StringComparer.Ordinal.Equals(parts[0], "v1")
                || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out int appealPriority)
                || !int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out int riskScore)
                || !long.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out long ticks)
                || !long.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out long commentId)
                || appealPriority is < 0 or > 2
                || riskScore is < 0 or > 1_000_000
                || ticks < DateTime.UnixEpoch.Ticks
                || ticks > DateTime.MaxValue.Ticks
                || commentId <= 0)
            {
                return false;
            }

            cursor = new(appealPriority, riskScore, ticks, commentId);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    public CommentModerationClaimCommandResult Claim(
        CommentModerationQueueClaim? current,
        long commentId,
        long ownerAdminPrincipalId,
        TimeSpan lease,
        TimeSpan processSla,
        string? note = null,
        string escalationStatus = CommentModerationEscalationStatuses.None)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        if (commentId <= 0
            || ownerAdminPrincipalId <= 0
            || !IsAllowedLease(lease)
            || !IsAllowedProcessSla(processSla)
            || !CommentModerationEscalationStatuses.IsAllowed(escalationStatus)
            || NormalizeNote(note, out string? normalizedNote) is false)
        {
            return new(false, "comment_moderation_claim_invalid");
        }
        if (current is not null && current.CommentId != commentId)
        {
            return new(false, "comment_moderation_claim_identity_mismatch");
        }
        if (current?.State == CommentModerationClaimStates.Completed)
        {
            return new(false, "comment_moderation_claim_completed");
        }
        if (current?.State == CommentModerationClaimStates.Active && current.LeaseExpiresAtUtc > now)
        {
            return new(false, "comment_moderation_claim_conflict", current);
        }

        string token = _claimTokenFactory();
        if (!IsValidToken(token))
        {
            throw new InvalidOperationException("Claim token factory returned an invalid token.");
        }

        var claim = new CommentModerationQueueClaim
        {
            CommentId = commentId,
            OwnerAdminPrincipalId = ownerAdminPrincipalId,
            ClaimTokenHash = HashToken(token),
            State = CommentModerationClaimStates.Active,
            ClaimedAtUtc = now,
            LeaseExpiresAtUtc = now.Add(lease),
            ProcessSlaDueAtUtc = now.Add(processSla),
            Note = normalizedNote,
            EscalationStatus = escalationStatus,
            ClaimGeneration = checked((current?.ClaimGeneration ?? 0) + 1)
        };
        return new(true, "ok", claim, token);
    }

    public CommentModerationClaimCommandResult Renew(
        CommentModerationQueueClaim current,
        long ownerAdminPrincipalId,
        string claimToken,
        TimeSpan lease)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        if (!IsAllowedLease(lease)
            || !OwnsActiveLease(current, ownerAdminPrincipalId, claimToken, now))
        {
            return new(false, "comment_moderation_claim_conflict", current);
        }

        CommentModerationQueueClaim renewed = Copy(current);
        renewed.RenewedAtUtc = now;
        renewed.LeaseExpiresAtUtc = now.Add(lease);
        return new(true, "ok", renewed);
    }

    public CommentModerationClaimCommandResult Release(
        CommentModerationQueueClaim current,
        long ownerAdminPrincipalId,
        string claimToken)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        if (!OwnsActiveLease(current, ownerAdminPrincipalId, claimToken, now))
        {
            return new(false, "comment_moderation_claim_conflict", current);
        }

        CommentModerationQueueClaim released = Copy(current);
        released.State = CommentModerationClaimStates.Released;
        released.ReleasedAtUtc = now;
        released.LeaseExpiresAtUtc = now;
        return new(true, "ok", released);
    }

    public CommentModerationClaimCommandResult Complete(
        CommentModerationQueueClaim current,
        long ownerAdminPrincipalId,
        string claimToken)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        if (!OwnsActiveLease(current, ownerAdminPrincipalId, claimToken, now))
        {
            return new(false, "comment_moderation_claim_conflict", current);
        }

        CommentModerationQueueClaim completed = Copy(current);
        completed.State = CommentModerationClaimStates.Completed;
        completed.ReleasedAtUtc = now;
        completed.LeaseExpiresAtUtc = now;
        return new(true, "ok", completed);
    }

    public CommentModerationQueueClaim RecoverExpired(CommentModerationQueueClaim current)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        if (current.State != CommentModerationClaimStates.Active || current.LeaseExpiresAtUtc > now)
        {
            return current;
        }

        CommentModerationQueueClaim expired = Copy(current);
        expired.State = CommentModerationClaimStates.Expired;
        expired.ReleasedAtUtc = now;
        return expired;
    }

    public static bool VerifyToken(CommentModerationQueueClaim claim, string token)
    {
        if (!IsValidToken(token) || claim.ClaimTokenHash.Length != 64)
        {
            return false;
        }

        byte[] expected;
        try
        {
            expected = Convert.FromHexString(claim.ClaimTokenHash);
        }
        catch (FormatException)
        {
            return false;
        }
        byte[] actual = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    private static bool IsAfter(CommentModerationQueueCandidate candidate, CommentModerationQueueCursor cursor)
        => candidate.AppealPriority < cursor.AppealPriority
            || (candidate.AppealPriority == cursor.AppealPriority && candidate.RiskScore < cursor.RiskScore)
            || (candidate.AppealPriority == cursor.AppealPriority
                && candidate.RiskScore == cursor.RiskScore
                && candidate.CreatedAtUtc.ToUniversalTime().Ticks > cursor.CreatedAtUtcTicks)
            || (candidate.AppealPriority == cursor.AppealPriority
                && candidate.RiskScore == cursor.RiskScore
                && candidate.CreatedAtUtc.ToUniversalTime().Ticks == cursor.CreatedAtUtcTicks
                && candidate.CommentId > cursor.CommentId);

    private static bool IsValidCandidate(CommentModerationQueueCandidate candidate)
        => candidate.CommentId > 0
            && candidate.AppealPriority is >= 0 and <= 2
            && candidate.RiskScore is >= 0 and <= 1_000_000
            && candidate.CreatedAtUtc != default;

    private static bool OwnsActiveLease(
        CommentModerationQueueClaim current,
        long ownerAdminPrincipalId,
        string claimToken,
        DateTime now)
        => ownerAdminPrincipalId > 0
            && current.State == CommentModerationClaimStates.Active
            && current.OwnerAdminPrincipalId == ownerAdminPrincipalId
            && current.LeaseExpiresAtUtc > now
            && VerifyToken(current, claimToken);

    private static bool IsAllowedLease(TimeSpan value)
        => value >= MinimumLease && value <= MaximumLease;

    private static bool IsAllowedProcessSla(TimeSpan value)
        => value >= MinimumProcessSla && value <= MaximumProcessSla;

    private static bool NormalizeNote(string? value, out string? normalized)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            normalized = null;
            return true;
        }

        normalized = value.Trim();
        return normalized.Length <= 1000;
    }

    private static bool IsValidToken(string? value)
        => value is { Length: >= 32 and <= 128 }
            && value.All(static character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');

    private static string HashToken(string token)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private static string CreateToken()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

    private static CommentModerationQueueClaim Copy(CommentModerationQueueClaim source)
        => new()
        {
            CommentId = source.CommentId,
            OwnerAdminPrincipalId = source.OwnerAdminPrincipalId,
            ClaimTokenHash = source.ClaimTokenHash,
            State = source.State,
            ClaimedAtUtc = source.ClaimedAtUtc,
            LeaseExpiresAtUtc = source.LeaseExpiresAtUtc,
            RenewedAtUtc = source.RenewedAtUtc,
            ReleasedAtUtc = source.ReleasedAtUtc,
            ProcessSlaDueAtUtc = source.ProcessSlaDueAtUtc,
            Note = source.Note,
            EscalationStatus = source.EscalationStatus,
            ClaimGeneration = source.ClaimGeneration,
            RowVersion = source.RowVersion
        };
}
