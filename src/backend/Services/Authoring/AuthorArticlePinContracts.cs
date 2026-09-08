using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed server-side contract for one author's site-scoped article pin collection.
/// Pin facts never own article metadata, public ranking, or presentation state.
/// </summary>
public static class AuthorArticlePinContract
{
    public const int SchemaVersion = 1;
    public const int MaxPinsPerOwner = 1_000;
    public const int MaxReorderBatchSize = 64;
    public const int MaxSiteScopeLength = 128;
    public const int MaxPageSize = 256;
    public const long OrderKeyGap = 1_000_000;

    public static void ValidateOwner(AuthorArticlePinOwner owner)
    {
        if (owner.AdminPrincipalId <= 0
            || string.IsNullOrWhiteSpace(owner.SiteScope)
            || owner.SiteScope.Length > MaxSiteScopeLength
            || !string.Equals(owner.SiteScope, owner.SiteScope.Trim(), StringComparison.Ordinal)
            || owner.SiteScope.Any(char.IsControl))
        {
            throw new AuthorArticlePinValidationException("article_pin_owner_invalid");
        }
    }

    public static void ValidateArticleId(int articleId)
    {
        if (articleId <= 0)
        {
            throw new AuthorArticlePinValidationException("article_pin_article_identity_invalid");
        }
    }

    public static void ValidateRequestId(Guid requestId)
    {
        if (requestId == Guid.Empty)
        {
            throw new AuthorArticlePinValidationException("article_pin_request_identity_invalid");
        }
    }

    public static void ValidateExpectedRevision(long expectedRevision)
    {
        if (expectedRevision < 0)
        {
            throw new AuthorArticlePinValidationException("article_pin_expected_revision_invalid");
        }
    }

    public static void ValidateReorder(
        IReadOnlyList<int> articleIds,
        int? afterArticleId)
    {
        ArgumentNullException.ThrowIfNull(articleIds);
        if (articleIds.Count is 0 or > MaxReorderBatchSize
            || articleIds.Any(static articleId => articleId <= 0)
            || articleIds.Count != articleIds.Distinct().Count())
        {
            throw new AuthorArticlePinValidationException("article_pin_reorder_members_invalid");
        }

        if (afterArticleId is <= 0 || (afterArticleId.HasValue && articleIds.Contains(afterArticleId.Value)))
        {
            throw new AuthorArticlePinValidationException("article_pin_reorder_anchor_invalid");
        }
    }

    public static string ComputeCommandDigest(
        string commandKind,
        AuthorArticlePinOwner owner,
        long expectedRevision,
        IReadOnlyList<int> articleIds,
        int? afterArticleId)
    {
        ValidateOwner(owner);
        ValidateExpectedRevision(expectedRevision);
        ArgumentNullException.ThrowIfNull(articleIds);
        return HashCanonical(
            SchemaVersion,
            commandKind,
            owner.AdminPrincipalId,
            owner.SiteScope,
            expectedRevision,
            string.Join(',', articleIds),
            afterArticleId);
    }

    public static string ComputePinDigest(
        AuthorArticlePinOwner owner,
        Guid pinId,
        int articleId,
        long orderKey,
        long createdRevision,
        long updatedRevision)
    {
        ValidateOwner(owner);
        ValidateArticleId(articleId);
        if (pinId == Guid.Empty
            || orderKey <= 0
            || createdRevision <= 0
            || updatedRevision < createdRevision)
        {
            throw new AuthorArticlePinValidationException("article_pin_record_invalid");
        }

        return HashCanonical(
            SchemaVersion,
            pinId,
            owner.AdminPrincipalId,
            owner.SiteScope,
            articleId,
            orderKey,
            createdRevision,
            updatedRevision);
    }

    public static string ComputeCollectionDigest(
        AuthorArticlePinOwner owner,
        long revision,
        IReadOnlyList<AuthorArticlePin> pins)
    {
        ValidateOwner(owner);
        if (revision < 0 || pins.Count > MaxPinsPerOwner)
        {
            throw new AuthorArticlePinValidationException("article_pin_collection_invalid");
        }

        var canonical = new List<object?>
        {
            SchemaVersion,
            owner.AdminPrincipalId,
            owner.SiteScope,
            revision,
            pins.Count
        };
        foreach (AuthorArticlePin pin in pins.OrderBy(static pin => pin.OrderKey).ThenBy(static pin => pin.PinId))
        {
            canonical.Add(pin.PinId);
            canonical.Add(pin.ArticleId);
            canonical.Add(pin.OrderKey);
            canonical.Add(pin.CreatedRevision);
            canonical.Add(pin.UpdatedRevision);
            canonical.Add(pin.ContentDigest);
        }
        return HashCanonical([.. canonical]);
    }

    private static string HashCanonical(params object?[] values)
    {
        var canonical = new StringBuilder();
        foreach (object? value in values)
        {
            string text = value switch
            {
                null => "null",
                IFormattable formattable => formattable.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
                _ => value.ToString() ?? string.Empty
            };
            canonical.Append(text.Length).Append(':').Append(text).Append(';');
        }

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }
}

public readonly record struct AuthorArticlePinOwner(long AdminPrincipalId, string SiteScope);

public sealed record AuthorArticlePin(
    Guid PinId,
    int ArticleId,
    long OrderKey,
    long CreatedRevision,
    long UpdatedRevision,
    string ContentDigest);

public sealed record AuthorArticlePinCollectionSnapshot(
    AuthorArticlePinOwner Owner,
    int SchemaVersion,
    long Revision,
    int ItemCount,
    IReadOnlyList<AuthorArticlePin> Pins,
    DateTime UpdatedAtUtc,
    string ContentDigest);

public sealed record AddAuthorArticlePinCommand(
    AuthorArticlePinOwner Owner,
    int ArticleId,
    long ExpectedRevision,
    Guid RequestId);

public sealed record RemoveAuthorArticlePinCommand(
    AuthorArticlePinOwner Owner,
    int ArticleId,
    long ExpectedRevision,
    Guid RequestId);

public sealed record ReorderAuthorArticlePinsCommand(
    AuthorArticlePinOwner Owner,
    long ExpectedRevision,
    Guid RequestId,
    IReadOnlyList<int> ArticleIds,
    int? AfterArticleId)
{
    public IReadOnlyList<int> MovedArticleIds { get; } = [.. ArticleIds];
}

public sealed record AuthorArticlePinWriteReceipt(
    Guid ReceiptId,
    AuthorArticlePinOwner Owner,
    Guid RequestId,
    long PreviousRevision,
    long Revision,
    string CommandKind,
    string Status,
    string? ReasonCode,
    IReadOnlyList<int> ArticleIds,
    int? AfterArticleId,
    int ItemCount,
    bool Rebalanced,
    bool IdempotentReplay,
    string CommandDigest,
    string ContentDigest,
    DateTime CreatedAtUtc);

public sealed record AuthorArticlePinVerificationResult(
    bool Valid,
    IReadOnlyList<string> Reasons,
    long Revision,
    int ItemCount,
    string ContentDigest);

public sealed class AuthorArticlePinValidationException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class AuthorArticlePinRevisionConflictException(long expectedRevision, long actualRevision)
    : InvalidOperationException($"article_pin_revision_conflict expected={expectedRevision} actual={actualRevision}")
{
    public long ExpectedRevision { get; } = expectedRevision;
    public long ActualRevision { get; } = actualRevision;
}

public sealed class AuthorArticlePinIdempotencyConflictException()
    : InvalidOperationException("article_pin_idempotency_conflict");

public sealed class AuthorArticlePinAccessDeniedException()
    : InvalidOperationException("article_pin_access_denied");

public sealed class AuthorArticlePinBudgetExceededException()
    : InvalidOperationException("article_pin_collection_budget_exceeded");

public sealed class AuthorArticlePinTamperDetectedException(string reason)
    : InvalidOperationException($"article_pin_tamper_detected:{reason}");
