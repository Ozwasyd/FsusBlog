using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed contract for the sole server-side projection of a private article pin collection.
/// Permission, site and session revisions are supplied by a trusted server provider, never by
/// request payload or a caller-provided boolean.
/// </summary>
public static class AuthorArticlePinProjectionContract
{
    public const int SchemaVersion = 1;
    public const int DefaultPageSize = 64;
    public const int MaxPageSize = 256;
    public const int MaxRevisionReferenceLength = 256;

    public static void ValidateRequest(AuthorArticlePinProjectionRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        AuthorArticlePinContract.ValidateOwner(request.Owner);
        AuthorArticlePinContract.ValidateRequestId(request.RequestId);
        if (request.Limit is < 1 or > MaxPageSize)
        {
            throw new AuthorArticlePinProjectionValidationException("article_pin_projection_limit_invalid");
        }

        if (request.ExpectedCollectionRevision is < 0
            || InvalidRevisionReference(request.ExpectedArticleProjectionDigest)
            || InvalidRevisionReference(request.ExpectedPermissionRevision)
            || InvalidRevisionReference(request.ExpectedSiteRevision)
            || InvalidRevisionReference(request.ExpectedSessionRevision))
        {
            throw new AuthorArticlePinProjectionValidationException("article_pin_projection_revision_invalid");
        }

        if (request.Cursor is { Length: > 2048 })
        {
            throw new AuthorArticlePinProjectionValidationException("article_pin_projection_cursor_invalid");
        }
    }

    public static void ValidateOpenRequest(AuthorArticlePinOpenValidationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        AuthorArticlePinContract.ValidateOwner(request.Owner);
        AuthorArticlePinContract.ValidateRequestId(request.RequestId);
        AuthorArticlePinContract.ValidateArticleId(request.ArticleId);
        if (request.CollectionRevision < 0
            || !IsRequiredRevisionReference(request.ArticleVersionReference)
            || !IsRequiredRevisionReference(request.RevisionVersionReference)
            || !IsRequiredRevisionReference(request.PermissionRevision)
            || !IsRequiredRevisionReference(request.PermissionReference)
            || !IsRequiredRevisionReference(request.SiteRevision)
            || !IsRequiredRevisionReference(request.SessionRevision))
        {
            throw new AuthorArticlePinProjectionValidationException("article_pin_open_revision_invalid");
        }
    }

    public static bool IsRequiredRevisionReference(string? value)
        => !string.IsNullOrEmpty(value) && !InvalidRevisionReference(value);

    public static string ComputePermissionDigest(AuthorArticlePinPermissionSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var values = new List<object?>
        {
            SchemaVersion,
            snapshot.Owner.AdminPrincipalId,
            snapshot.Owner.SiteScope,
            snapshot.PermissionRevision,
            snapshot.SiteRevision,
            snapshot.SessionRevision,
            (int)snapshot.Status,
            snapshot.ReasonCode,
            snapshot.Decisions.Count
        };
        foreach (AuthorArticlePinPermissionDecision decision in snapshot.Decisions
            .OrderBy(static decision => decision.ArticleId))
        {
            values.Add(decision.ArticleId);
            values.Add(decision.CanProject);
            values.Add(decision.CanOpen);
            values.Add(decision.PermissionReference);
        }
        return HashCanonical([.. values]);
    }

    public static string ComputeArticleFactDigest(AuthorArticlePinArticleFact fact)
        => HashCanonical(
            SchemaVersion,
            fact.ArticleId,
            fact.Title,
            (int)fact.Status,
            fact.CurrentRevisionId,
            fact.RevisionNo,
            fact.ArticleVersionReference,
            fact.RevisionVersionReference,
            fact.Exists,
            fact.IsDeleted);

    public static string ComputeArticleVersionReference(
        int articleId,
        string title,
        Entities.ArticleStatus status,
        bool isDeleted,
        long currentRevisionId,
        int revisionNo)
        => $"article-projection:v{SchemaVersion}:{HashCanonical(
            SchemaVersion,
            articleId,
            title,
            (int)status,
            isDeleted,
            currentRevisionId,
            revisionNo)}";

    public static string ComputeItemDigest(AuthorArticlePinProjectionItem item)
        => HashCanonical(
            SchemaVersion,
            item.PinId,
            item.ArticleId,
            item.OrderReference,
            item.Title,
            (int)item.Status,
            item.CurrentRevisionId,
            item.RevisionNo,
            item.ArticleVersionReference,
            item.RevisionVersionReference,
            item.PermissionReference,
            item.OpenEligible);

    public static string ComputeOrderReference(
        AuthorArticlePinOwner owner,
        AuthorArticlePin pin)
        => HashCanonical(
            SchemaVersion,
            owner.AdminPrincipalId,
            owner.SiteScope,
            pin.PinId,
            pin.OrderKey,
            pin.UpdatedRevision);

    public static string ComputeArticleProjectionDigest(
        IReadOnlyList<AuthorArticlePinArticleFact> facts)
    {
        var values = new List<object?> { SchemaVersion, facts.Count };
        foreach (AuthorArticlePinArticleFact fact in facts.OrderBy(static fact => fact.ArticleId))
        {
            values.Add(fact.ArticleId);
            values.Add(fact.Exists && !fact.IsDeleted && fact.Status != Entities.ArticleStatus.Deleted
                ? fact.ContentDigest
                : HashCanonical(SchemaVersion, fact.ArticleId, "closed-removed"));
        }
        return HashCanonical([.. values]);
    }

    public static string ComputeCacheIdentity(
        AuthorArticlePinOwner owner,
        long collectionRevision,
        string collectionDigest,
        string articleProjectionDigest,
        AuthorArticlePinPermissionSnapshot permission,
        string? cursor,
        int limit)
    {
        var values = new List<object?>
        {
            SchemaVersion,
            owner.AdminPrincipalId,
            owner.SiteScope,
            collectionRevision,
            collectionDigest,
            articleProjectionDigest,
            permission.PermissionRevision,
            permission.ContentDigest,
            permission.SiteRevision,
            permission.SessionRevision,
            HashText(cursor ?? string.Empty),
            limit
        };
        return HashCanonical([.. values]);
    }

    public static string ComputePageDigest(AuthorArticlePinProjectionPage page)
        => HashCanonical(
            SchemaVersion,
            (int)page.Status,
            page.CollectionRevision,
            page.CollectionDigest,
            page.ArticleProjectionDigest,
            page.PermissionRevision,
            page.SiteRevision,
            page.SessionRevision,
            page.FilteredCount,
            string.Join(',', page.Items.Select(static item => item.ContentDigest)),
            page.NextCursor,
            page.HasMore,
            string.Join(',', page.StaleReasons),
            page.CacheReference);

    public static string ComputeReceiptDigest(AuthorArticlePinProjectionReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        var values = new List<object?>
        {
            SchemaVersion,
            receipt.ReceiptId,
            receipt.RequestId,
            receipt.Owner.AdminPrincipalId,
            receipt.Owner.SiteScope,
            receipt.CollectionRevision,
            receipt.CollectionDigest,
            receipt.ArticleProjectionDigest,
            receipt.PermissionRevision,
            receipt.SiteRevision,
            receipt.SessionRevision,
            (int)receipt.Status,
            receipt.ResultCount,
            receipt.PageCount,
            receipt.InputCursorDigest,
            receipt.NextCursorDigest,
            receipt.CacheReference,
            receipt.ResultContentDigest
        };
        AddSequence(values, receipt.ResultArticleIds);
        AddSequence(values, receipt.ResultOrderReferences);
        AddSequence(values, receipt.ResultArticleVersionReferences);
        AddSequence(values, receipt.ResultPermissionReferences);
        AddSequence(values, receipt.ResultStatuses.Select(static status => (int)status));
        AddSequence(values, receipt.ResultItemDigests);
        return HashCanonical([.. values]);
    }

    public static string ComputeClosedRemovalDigest(
        AuthorArticlePinOwner owner,
        long collectionRevision,
        Guid pinId,
        int articleId,
        string reasonCode)
        => HashCanonical(
            SchemaVersion,
            owner.AdminPrincipalId,
            owner.SiteScope,
            collectionRevision,
            pinId,
            articleId,
            reasonCode);

    public static Guid CreateReceiptId(Guid requestId, string resultContentDigest)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes($"{requestId:D}:{resultContentDigest}"));
        Span<byte> bytes = digest.AsSpan(0, 16);
        bytes[6] = (byte)((bytes[6] & 0x0f) | 0x70);
        bytes[8] = (byte)((bytes[8] & 0x3f) | 0x80);
        return new Guid(bytes);
    }

    public static string HashText(string value) => HashCanonical(SchemaVersion, value);

    internal static string ComputeCursorDigest(AuthorArticlePinProjectionCursor cursor)
        => HashCanonical(
            SchemaVersion,
            cursor.SchemaVersion,
            cursor.OwnerDigest,
            cursor.CollectionRevision,
            cursor.CollectionDigest,
            cursor.ArticleProjectionDigest,
            cursor.PermissionRevision,
            cursor.PermissionDigest,
            cursor.SiteRevision,
            cursor.SessionRevision,
            cursor.LastPinId);

    private static bool InvalidRevisionReference(string? value)
        => value is not null
            && (value.Length is 0 or > MaxRevisionReferenceLength
                || !string.Equals(value, value.Trim(), StringComparison.Ordinal)
                || value.Any(char.IsControl));

    private static string HashCanonical(params object?[] values)
    {
        var canonical = new StringBuilder();
        foreach (object? value in values)
        {
            string text = value switch
            {
                null => "null",
                bool boolean => boolean ? "true" : "false",
                IFormattable formattable => formattable.ToString(null, System.Globalization.CultureInfo.InvariantCulture),
                _ => value.ToString() ?? string.Empty
            };
            canonical.Append(text.Length).Append(':').Append(text).Append(';');
        }
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }

    private static void AddSequence<T>(List<object?> values, IEnumerable<T> items)
    {
        T[] materialized = [.. items];
        values.Add(materialized.Length);
        foreach (T item in materialized)
        {
            values.Add(item);
        }
    }
}

public sealed record AuthorArticlePinProjectionRequest(
    AuthorArticlePinOwner Owner,
    Guid RequestId,
    int Limit = AuthorArticlePinProjectionContract.DefaultPageSize,
    string? Cursor = null,
    long? ExpectedCollectionRevision = null,
    string? ExpectedArticleProjectionDigest = null,
    string? ExpectedPermissionRevision = null,
    string? ExpectedSiteRevision = null,
    string? ExpectedSessionRevision = null);

public enum AuthorArticlePinProjectionStatus
{
    Current,
    Stale,
    Unavailable,
    InvalidCursor
}

public sealed record AuthorArticlePinProjectionItem(
    Guid PinId,
    int ArticleId,
    string OrderReference,
    string Title,
    Entities.ArticleStatus Status,
    long CurrentRevisionId,
    int RevisionNo,
    string ArticleVersionReference,
    string RevisionVersionReference,
    string PermissionReference,
    bool OpenEligible,
    string ContentDigest);

public sealed record AuthorArticlePinProjectionReceipt(
    Guid ReceiptId,
    Guid RequestId,
    AuthorArticlePinOwner Owner,
    long CollectionRevision,
    string CollectionDigest,
    string ArticleProjectionDigest,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision,
    AuthorArticlePinProjectionStatus Status,
    int ResultCount,
    int PageCount,
    IReadOnlyList<int> ResultArticleIds,
    IReadOnlyList<string> ResultOrderReferences,
    IReadOnlyList<string> ResultArticleVersionReferences,
    IReadOnlyList<string> ResultPermissionReferences,
    IReadOnlyList<Entities.ArticleStatus> ResultStatuses,
    IReadOnlyList<string> ResultItemDigests,
    string InputCursorDigest,
    string NextCursorDigest,
    string CacheReference,
    string ResultContentDigest,
    DateTime CreatedAtUtc,
    string ContentDigest);

public sealed record AuthorArticlePinProjectionPage(
    AuthorArticlePinProjectionStatus Status,
    int SchemaVersion,
    long CollectionRevision,
    string CollectionDigest,
    string ArticleProjectionDigest,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision,
    int FilteredCount,
    IReadOnlyList<AuthorArticlePinProjectionItem> Items,
    string? NextCursor,
    bool HasMore,
    IReadOnlyList<string> StaleReasons,
    string CacheReference,
    string ContentDigest,
    AuthorArticlePinProjectionReceipt? Receipt)
{
    public static AuthorArticlePinProjectionPage Empty(
        AuthorArticlePinProjectionStatus status,
        params string[] reasons)
        => new(
            status,
            AuthorArticlePinProjectionContract.SchemaVersion,
            0,
            string.Empty,
            string.Empty,
            string.Empty,
            string.Empty,
            string.Empty,
            0,
            [],
            null,
            false,
            reasons,
            string.Empty,
            string.Empty,
            null);
}

public enum AuthorArticlePinPermissionSnapshotStatus
{
    Current,
    Stale,
    Unavailable
}

public sealed record AuthorArticlePinPermissionBatchRequest(
    AuthorArticlePinOwner Owner,
    Guid RequestId,
    IReadOnlyList<int> ArticleIds);

public sealed record AuthorArticlePinPermissionDecision(
    int ArticleId,
    bool CanProject,
    bool CanOpen,
    string PermissionReference);

public sealed record AuthorArticlePinPermissionSnapshot(
    AuthorArticlePinPermissionSnapshotStatus Status,
    AuthorArticlePinOwner Owner,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision,
    IReadOnlyList<AuthorArticlePinPermissionDecision> Decisions,
    string ContentDigest,
    string? ReasonCode = null);

/// <summary>
/// External production boundary owned by the eventual permission-filtered author article query.
/// Implementations must bind the authenticated principal, configured site and current session;
/// absence is an unavailable/deny result, never an allow-all fallback.
/// </summary>
public interface IAuthorArticlePinPermissionProjectionProvider
{
    Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
        AuthorArticlePinPermissionBatchRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class UnavailableAuthorArticlePinPermissionProjectionProvider
    : IAuthorArticlePinPermissionProjectionProvider
{
    public Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
        AuthorArticlePinPermissionBatchRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new AuthorArticlePinPermissionSnapshot(
            AuthorArticlePinPermissionSnapshotStatus.Unavailable,
            request.Owner,
            string.Empty,
            string.Empty,
            string.Empty,
            [],
            string.Empty,
            "article_pin_permission_authority_unavailable"));
    }
}

public sealed record AuthorArticlePinArticleFact(
    int ArticleId,
    string Title,
    Entities.ArticleStatus Status,
    long CurrentRevisionId,
    int RevisionNo,
    string ArticleVersionReference,
    string RevisionVersionReference,
    bool Exists,
    bool IsDeleted,
    string ContentDigest);

public interface IAuthorArticlePinArticleProjectionSource
{
    Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
        IReadOnlyList<int> articleIds,
        CancellationToken cancellationToken = default);
}

public enum AuthorArticlePinProjectionCacheReadStatus
{
    Miss,
    Hit,
    Unavailable
}

public sealed record AuthorArticlePinProjectionCacheReadResult(
    AuthorArticlePinProjectionCacheReadStatus Status,
    AuthorArticlePinProjectionPage? Page,
    string CacheReference);

public interface IAuthorArticlePinProjectionCache
{
    string GetReference(string identity);

    Task<AuthorArticlePinProjectionCacheReadResult> TryReadAsync(
        string identity,
        CancellationToken cancellationToken = default);

    Task<bool> WriteAsync(
        string identity,
        AuthorArticlePinProjectionPage page,
        CancellationToken cancellationToken = default);
}

/// <summary>A direct-read production policy: it never claims a cached hit or masks a cache failure.</summary>
public sealed class DirectAuthorArticlePinProjectionCache : IAuthorArticlePinProjectionCache
{
    public string GetReference(string identity) => $"direct-read:{identity}";

    public Task<AuthorArticlePinProjectionCacheReadResult> TryReadAsync(
        string identity,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new AuthorArticlePinProjectionCacheReadResult(
            AuthorArticlePinProjectionCacheReadStatus.Miss,
            null,
            "direct-read"));
    }

    public Task<bool> WriteAsync(
        string identity,
        AuthorArticlePinProjectionPage page,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(true);
    }
}

public sealed record AuthorArticlePinClosedRemovalObligation(
    AuthorArticlePinOwner Owner,
    long CollectionRevision,
    Guid PinId,
    int ArticleId,
    string ReasonCode,
    string ContentDigest);

public interface IAuthorArticlePinReconciliationSink
{
    /// <summary>
    /// Records content-addressed obligations idempotently. Implementations must CAS on the bound
    /// collection revision before invoking the separate #2311 write authority.
    /// </summary>
    Task<bool> RecordClosedRemovalsAsync(
        IReadOnlyList<AuthorArticlePinClosedRemovalObligation> obligations,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Safe production default when the lifecycle reconciliation owner is absent. Empty work succeeds;
/// a real removal obligation makes the projection unavailable instead of silently dropping cleanup.
/// </summary>
public sealed class UnavailableAuthorArticlePinReconciliationSink : IAuthorArticlePinReconciliationSink
{
    public Task<bool> RecordClosedRemovalsAsync(
        IReadOnlyList<AuthorArticlePinClosedRemovalObligation> obligations,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(obligations.Count == 0);
    }
}

public sealed record AuthorArticlePinProjectionVerificationResult(
    bool Valid,
    IReadOnlyList<string> Reasons,
    string ContentDigest);

public interface IAuthorArticlePinProjectionService
{
    Task<AuthorArticlePinProjectionPage> ReadAsync(
        AuthorArticlePinProjectionRequest request,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinOpenValidationResult> RevalidateOpenAsync(
        AuthorArticlePinOpenValidationRequest request,
        CancellationToken cancellationToken = default);
}

public sealed record AuthorArticlePinOpenValidationRequest(
    AuthorArticlePinOwner Owner,
    Guid RequestId,
    int ArticleId,
    long CollectionRevision,
    string ArticleVersionReference,
    string RevisionVersionReference,
    string PermissionRevision,
    string PermissionReference,
    string SiteRevision,
    string SessionRevision);

public enum AuthorArticlePinOpenValidationStatus
{
    Current,
    Stale,
    Denied,
    Unavailable
}

public sealed record AuthorArticlePinOpenValidationResult(
    AuthorArticlePinOpenValidationStatus Status,
    string ArticleVersionReference,
    string RevisionVersionReference,
    string PermissionRevision,
    string SiteRevision,
    string SessionRevision,
    string ReasonCode);

public sealed class AuthorArticlePinProjectionValidationException(string code)
    : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

internal sealed record AuthorArticlePinProjectionCursor(
    int SchemaVersion,
    string OwnerDigest,
    long CollectionRevision,
    string CollectionDigest,
    string ArticleProjectionDigest,
    string PermissionRevision,
    string PermissionDigest,
    string SiteRevision,
    string SessionRevision,
    Guid LastPinId,
    string ContentDigest);

internal static class AuthorArticlePinProjectionCursorCodec
{
    public static string Encode(AuthorArticlePinProjectionCursor cursor)
    {
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(cursor);
        return Convert.ToBase64String(json).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public static string ComputeContentDigest(AuthorArticlePinProjectionCursor cursor)
        => AuthorArticlePinProjectionContract.ComputeCursorDigest(cursor);

    public static bool TryDecode(string? value, out AuthorArticlePinProjectionCursor? cursor)
    {
        cursor = null;
        if (string.IsNullOrWhiteSpace(value) || value.Length > 2048)
        {
            return false;
        }
        try
        {
            string base64 = value.Replace('-', '+').Replace('_', '/');
            base64 = base64.PadRight((base64.Length + 3) / 4 * 4, '=');
            cursor = JsonSerializer.Deserialize<AuthorArticlePinProjectionCursor>(Convert.FromBase64String(base64));
            return cursor is not null;
        }
        catch (Exception exception) when (exception is FormatException or JsonException)
        {
            return false;
        }
    }
}
