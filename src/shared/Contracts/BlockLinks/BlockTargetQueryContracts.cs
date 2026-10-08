using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>Bounded query contracts; they neither authorize callers nor produce parse inventories.</summary>
public static class BlockTargetQuerySchemas
{
    public const int Version = 1;
    public const int MaximumPageSize = 100;
    public const int MaximumSearchLength = 128;
    public const int MaximumSnippetLength = 256;
    public const string Request = "fsusblog.block-target-query.v1";
    public const string Cursor = "fsusblog.block-target-cursor.v1";
    public const string Token = "fsusblog.block-target-token.v1";
    public const string Page = "fsusblog.block-target-page.v1";
}

/// <summary>Each query page has exactly one layer; block inventories are never global.</summary>
public enum BlockTargetQueryLayer : byte
{
    Articles = 1,
    Headings = 2,
    Blocks = 3
}

/// <summary>Distinguishes editable current targets from current public publication targets.</summary>
public enum BlockTargetQueryScope : byte
{
    AuthoringCurrent = 1,
    CurrentPublicPublication = 2
}

/// <summary>Exact selected article revision; the digest is evidence, never target identity.</summary>
public sealed record BlockTargetArticleCoordinate(
    string ArticleIdentity,
    string RevisionIdentity,
    long RevisionNumber,
    ArticleRelationRevisionKind RevisionKind,
    ArticleRelationLifecycleState Lifecycle,
    ArticleRelationPermissionState Permission,
    string ContentDigest);

/// <summary>All producer generations that invalidate a cursor or selected target on drift.</summary>
public sealed record BlockTargetQueryCoordinate(
    string ActorIdentity,
    string SiteIdentity,
    string PermissionContextDigest,
    long PermissionRevision,
    long QueryRevision,
    long IndexRevision,
    long RouteRevision,
    int AnchorContractVersion,
    string AnchorContractDigest);

/// <summary>Layered request. Heading/block requests require an exact selected revision.</summary>
public sealed record BlockTargetQueryRequest(
    string Schema,
    int SchemaVersion,
    BlockTargetQueryCoordinate Coordinate,
    BlockTargetQueryLayer Layer,
    BlockTargetQueryScope Scope,
    BlockTargetArticleCoordinate? Article,
    string Search,
    int Limit,
    long RequestSequence,
    string RequestDigest);

/// <summary>Server continuation bound to one exact request; no corpus totals or hidden content.</summary>
public sealed record BlockTargetQueryCursor(
    string Schema,
    int SchemaVersion,
    string RequestDigest,
    string Continuation,
    string CursorDigest);

/// <summary>
/// One valid canonical block result. Duplicate/invalid/orphan inventories cannot mint a
/// selectable token. Source coordinates and route remain projections, not durable identity.
/// </summary>
public sealed record BlockTargetQueryToken(
    string Schema,
    int SchemaVersion,
    string RequestDigest,
    ArticleBlockTarget Target,
    BlockTargetArticleCoordinate Article,
    string SourceNodeIdentity,
    int SourceStart,
    int SourceEnd,
    string BlockKind,
    string ContextSnippet,
    string CanonicalSlug,
    string TokenDigest);

/// <summary>Unavailable conceals both absence and denial; blocked is authorized diagnostic only.</summary>
public enum BlockTargetQueryPageStatus : byte
{
    Ready = 1,
    Blocked = 2,
    Unavailable = 3,
    Cancelled = 4
}

/// <summary>Nonselectable canonical inventory outcomes with no first-match recovery.</summary>
public enum BlockTargetInventoryDiagnostic : byte
{
    None = 0,
    Duplicate = 1,
    Invalid = 2,
    Malformed = 3,
    Orphan = 4
}

/// <summary>
/// Selected-article block page. Non-ready pages carry no items, cursor or totals;
/// missing and denied use the same Unavailable shape. Diagnostics require prior authorization.
/// </summary>
public sealed record BlockTargetQueryPage(
    string Schema,
    int SchemaVersion,
    string RequestDigest,
    BlockTargetQueryPageStatus Status,
    BlockTargetInventoryDiagnostic Diagnostic,
    IReadOnlyList<BlockTargetQueryToken> Items,
    BlockTargetQueryCursor? Next,
    string PageDigest);

/// <summary>Safe contract refusal; no source, title, counts or existence facts.</summary>
public readonly record struct BlockTargetQueryValidationResult(bool IsValid, string? ReasonCode)
{
    public static BlockTargetQueryValidationResult Valid() => new(true, null);

    public static BlockTargetQueryValidationResult Invalid(string reasonCode) => new(false, reasonCode);
}
