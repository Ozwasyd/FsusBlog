using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;

using Microsoft.AspNetCore.WebUtilities;

using SqlSugar;

namespace FsusBlog.Server.Services.Security;

public readonly record struct CommentManagementCapability(string Secret, string Commitment);

public readonly record struct CommentManagementChallengeResult(
    bool Issued,
    string? Challenge,
    DateTime? ExpiresAtUtc,
    string? FailureCode,
    int CurrentVersion)
{
    public static CommentManagementChallengeResult Failed(string code) => new(false, null, null, code, 0);
}

public interface ICommentManagementCapabilityService
{
    CommentManagementCapability IssueCapability();

    Task<CommentManagementChallengeResult> IssueChallengeAsync(
        long commentId,
        string capabilitySecret,
        string purpose,
        CancellationToken cancellationToken);

    Task<bool> ConsumeChallengeAsync(
        long commentId,
        string challenge,
        string purpose,
        CancellationToken cancellationToken);

    bool VerifyCapability(string capabilitySecret, string expectedCommitment);
}

public sealed class CommentManagementCapabilityService(
    ISqlSugarClient db,
    TimeProvider timeProvider) : ICommentManagementCapabilityService
{
    internal const int SecretBytes = 32;
    internal static TimeSpan ChallengeLifetime => TimeSpan.FromMinutes(5);

    public CommentManagementCapability IssueCapability()
        => CreateCapability();

    internal static CommentManagementCapability CreateCapability()
    {
        string secret = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(SecretBytes));
        return new CommentManagementCapability(secret, ComputeCommitment(secret));
    }

    public async Task<CommentManagementChallengeResult> IssueChallengeAsync(
        long commentId,
        string capabilitySecret,
        string purpose,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (commentId <= 0 || !CommentManagementPurposes.IsKnown(purpose))
        {
            return CommentManagementChallengeResult.Failed("comment_management_request_invalid");
        }

        Comment? comment = await db.Queryable<Comment>()
            .Where(comment => comment.Id == commentId
                && comment.ManagementCapabilityHash != null)
            .FirstAsync(cancellationToken);
        if (comment?.ManagementCapabilityHash is null
            || !VerifyCapability(capabilitySecret, comment.ManagementCapabilityHash))
        {
            return CommentManagementChallengeResult.Failed("comment_management_capability_invalid");
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        DateTime expiresAt = now.Add(ChallengeLifetime);
        string challenge = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(SecretBytes));
        await db.Insertable(new CommentManagementChallenge
        {
            ChallengeHash = ComputeCommitment(challenge),
            CommentId = commentId,
            Purpose = purpose,
            ExpiresAtUtc = expiresAt,
            UsedAtUtc = null
        }).ExecuteCommandAsync(cancellationToken);

        return new CommentManagementChallengeResult(true, challenge, expiresAt, null, comment.CurrentVersion);
    }

    public async Task<bool> ConsumeChallengeAsync(
        long commentId,
        string challenge,
        string purpose,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (commentId <= 0
            || string.IsNullOrWhiteSpace(challenge)
            || !CommentManagementPurposes.IsKnown(purpose))
        {
            return false;
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        int affected = await db.Updateable<CommentManagementChallenge>()
            .SetColumns(item => item.UsedAtUtc == now)
            .Where(item => item.ChallengeHash == ComputeCommitment(challenge)
                && item.CommentId == commentId
                && item.Purpose == purpose
                && item.UsedAtUtc == null
                && item.ExpiresAtUtc >= now)
            .ExecuteCommandAsync(cancellationToken);
        return affected == 1;
    }

    public bool VerifyCapability(string capabilitySecret, string expectedCommitment)
    {
        if (string.IsNullOrWhiteSpace(capabilitySecret)
            || expectedCommitment.Length != 64)
        {
            return false;
        }

        byte[] expected;
        try
        {
            expected = Convert.FromHexString(expectedCommitment);
        }
        catch (FormatException)
        {
            return false;
        }

        Span<byte> actual = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(capabilitySecret), actual);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    internal static string ComputeCommitment(string secret)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(secret))).ToLowerInvariant();
}

public static class CommentManagementPurposes
{
    public const string Edit = "edit";
    public const string Delete = "delete";
    public const string Status = "status";
    public const string Appeal = "appeal";

    public static bool IsKnown(string value)
        => value is Edit or Delete or Status or Appeal;
}
