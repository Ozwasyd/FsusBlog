namespace FsusBlog.Shared.Contracts.AuthorArticlePins;

/// <summary>One private projection request. Actor and site are derived by the authenticated Server facade.</summary>
public sealed record AuthorArticlePinReadRequest(
    int SchemaVersion, Guid RequestId, int Limit, string? Cursor,
    long? ExpectedCollectionRevision, string? ExpectedArticleProjectionDigest,
    string? ExpectedPermissionRevision, string? ExpectedSiteRevision, string? ExpectedSessionRevision);

/// <summary>The same original CAS shape is used for add and remove; the registered operation chooses the command.</summary>
public sealed record AuthorArticlePinMutationRequest(
    int SchemaVersion, Guid RequestId, int ArticleId, long ExpectedRevision);

/// <summary>One bounded original after-anchor plan; it never supplies collection order or an owner grant.</summary>
public sealed record AuthorArticlePinReorderRequest(
    int SchemaVersion, Guid RequestId, long ExpectedRevision, IReadOnlyList<int> ArticleIds, int? AfterArticleId);

/// <summary>Revalidates original projection references before the existing open-or-activate owner can act.</summary>
public sealed record AuthorArticlePinOpenRequest(
    int SchemaVersion, Guid RequestId, int ArticleId, long CollectionRevision,
    string ArticleVersionReference, string RevisionVersionReference, string PermissionRevision,
    string PermissionReference, string SiteRevision, string SessionRevision);

/// <summary>Server-derived response identity, never accepted as request authorization.</summary>
public sealed record AuthorArticlePinResponseOwner(long AdminPrincipalId, string SiteScope);

/// <summary>Original permission-filtered item and ordering reference. ArticleStatus is the original closed numeric status.</summary>
public sealed record AuthorArticlePinItem(
    Guid PinId, int ArticleId, string OrderReference, string Title, int ArticleStatus,
    long CurrentRevisionId, int RevisionNo, string ArticleVersionReference,
    string RevisionVersionReference, string PermissionReference, bool OpenEligible, string ContentDigest);

/// <summary>Faithful transport of an actual original projection receipt; the transport creates no receipt or digest.</summary>
public sealed record AuthorArticlePinReadReceipt(
    Guid ReceiptId, Guid RequestId, AuthorArticlePinResponseOwner Owner,
    long CollectionRevision, string CollectionDigest, string ArticleProjectionDigest,
    string PermissionRevision, string SiteRevision, string SessionRevision, int Status,
    int ResultCount, int PageCount, IReadOnlyList<int> ResultArticleIds,
    IReadOnlyList<string> ResultOrderReferences, IReadOnlyList<string> ResultArticleVersionReferences,
    IReadOnlyList<string> ResultPermissionReferences, IReadOnlyList<int> ResultStatuses,
    IReadOnlyList<string> ResultItemDigests, string InputCursorDigest, string NextCursorDigest,
    string CacheReference, string ResultContentDigest, DateTime CreatedAtUtc, string ContentDigest);

/// <summary>Original page including closed/noncurrent outcomes. No local filtering, order, count or fresh receipt is synthesized.</summary>
public sealed record AuthorArticlePinPage(
    int Status, int SchemaVersion, long CollectionRevision, string CollectionDigest,
    string ArticleProjectionDigest, string PermissionRevision, string SiteRevision, string SessionRevision,
    int FilteredCount, IReadOnlyList<AuthorArticlePinItem> Items, string? NextCursor, bool HasMore,
    IReadOnlyList<string> StaleReasons, string CacheReference, string ContentDigest, AuthorArticlePinReadReceipt? Receipt);

/// <summary>Request correlation around the actual original page. The envelope itself grants no currentness.</summary>
public sealed record AuthorArticlePinReadResponse(int SchemaVersion, Guid RequestId, AuthorArticlePinPage Page);

/// <summary>Original persisted write result including noop and idempotent replay. No optimistic acknowledgement is allowed.</summary>
public sealed record AuthorArticlePinMutationReceipt(
    int SchemaVersion, Guid ReceiptId, AuthorArticlePinResponseOwner Owner, Guid RequestId,
    long PreviousRevision, long Revision, string CommandKind, string Status, string? ReasonCode,
    IReadOnlyList<int> ArticleIds, int? AfterArticleId, int ItemCount, bool Rebalanced, bool IdempotentReplay,
    string CommandDigest, string ContentDigest, DateTime CreatedAtUtc);

/// <summary>Original Current/Stale/Denied/Unavailable open observation, never an open command or session admission.</summary>
public sealed record AuthorArticlePinOpenResponse(
    int SchemaVersion, Guid RequestId, int ArticleId, int Status,
    string ArticleVersionReference, string RevisionVersionReference, string PermissionRevision,
    string SiteRevision, string SessionRevision, string ReasonCode);

/// <summary>Intrinsic request shape only. Permissions, revision truth and freshness remain with the original Server owners.</summary>
public static class AuthorArticlePinTransportContract
{
    public const int SchemaVersion = 1;
    public const int DefaultPageSize = 64;
    public const int MaxPageSize = 256;
    public const int MaxReorderBatchSize = 64;
    public const int MaxPinsPerOwner = 1000;
    public const int MaxSiteScopeLength = 128;
    public const int MaxRevisionReferenceLength = 256;
    public const int MaxCursorLength = 2048;
    public const int MaxTitleLength = 256;

    public static bool IsValidReadRequest(AuthorArticlePinReadRequest? value)
        => value is not null && HasIdentity(value.SchemaVersion, value.RequestId)
            && value.Limit is >= 1 and <= MaxPageSize
            && (value.Cursor is null || IsText(value.Cursor, MaxCursorLength))
            && value.ExpectedCollectionRevision is not < 0
            && IsOptionalReference(value.ExpectedArticleProjectionDigest)
            && IsOptionalReference(value.ExpectedPermissionRevision)
            && IsOptionalReference(value.ExpectedSiteRevision) && IsOptionalReference(value.ExpectedSessionRevision);

    public static bool IsValidMutationRequest(AuthorArticlePinMutationRequest? value)
        => value is not null && HasIdentity(value.SchemaVersion, value.RequestId)
            && value.ArticleId > 0 && value.ExpectedRevision >= 0;

    public static bool IsValidReorderRequest(AuthorArticlePinReorderRequest? value)
        => value is not null && HasIdentity(value.SchemaVersion, value.RequestId) && value.ExpectedRevision >= 0
            && value.ArticleIds is { Count: >= 1 and <= MaxReorderBatchSize }
            && value.ArticleIds.All(static id => id > 0)
            && value.ArticleIds.Distinct().Count() == value.ArticleIds.Count
            && value.AfterArticleId is not <= 0
            && (!value.AfterArticleId.HasValue || !value.ArticleIds.Contains(value.AfterArticleId.Value));

    public static bool IsValidOpenRequest(AuthorArticlePinOpenRequest? value)
        => value is not null && HasIdentity(value.SchemaVersion, value.RequestId)
            && value.ArticleId > 0 && value.CollectionRevision >= 0
            && IsRequiredReference(value.ArticleVersionReference) && IsRequiredReference(value.RevisionVersionReference)
            && IsRequiredReference(value.PermissionRevision) && IsRequiredReference(value.PermissionReference)
            && IsRequiredReference(value.SiteRevision) && IsRequiredReference(value.SessionRevision);

    private static bool HasIdentity(int schemaVersion, Guid requestId)
        => schemaVersion == SchemaVersion && requestId != Guid.Empty;

    private static bool IsOptionalReference(string? value)
        => value is null || IsRequiredReference(value);

    private static bool IsRequiredReference(string? value)
        => value is { Length: > 0 and <= MaxRevisionReferenceLength }
            && IsText(value, MaxRevisionReferenceLength)
            && string.Equals(value, value.Trim(), StringComparison.Ordinal) && !value.Any(char.IsControl);

    private static bool IsText(string value, int maxLength)
    {
        if (value.Length > maxLength)
            return false;
        for (int index = 0; index < value.Length; index++)
        {
            if (!char.IsSurrogate(value[index]))
                continue;
            if (!char.IsHighSurrogate(value[index]) || ++index == value.Length || !char.IsLowSurrogate(value[index]))
                return false;
        }
        return true;
    }
}
