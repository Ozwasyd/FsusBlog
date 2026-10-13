using System.Text;

using FsusBlog.Contracts.Articles;

namespace FsusBlog.Contracts.ArticleCapture;

/// <summary>Closed capture input; expected site is a correlation precondition, never actor authority.</summary>
public sealed record ArticleInboxCaptureRequest(
    int SchemaVersion, Guid RequestId, string ExpectedSiteScope, string Title, string MarkdownContent);

/// <summary>Only original durable Inbox receipt facts; no document, permission or historical site grant.</summary>
public sealed record ArticleInboxCaptureReceipt(
    Guid ReceiptId, Guid RequestId, long OwnerAdminPrincipalId, int ArticleId,
    long DraftId, long DraftServerRevision, long RevisionId, int RevisionNo,
    string OutboxEventId, Guid AuditReference, string AuditDigest,
    string SourceDigest, string ContentDigest, long OccurredAtUtcTicks, bool IsIdempotentReplay);

/// <summary>
/// Authenticated request context and a historical create outcome. Null receipt means only
/// unobserved at lookup, not cancelled, saved, absent forever or permission to change UUID.
/// RequestSiteScope describes this request, not a stored site binding on the old receipt.
/// </summary>
public sealed record ArticleInboxCaptureResponse(
    int SchemaVersion, Guid RequestId, long AuthenticatedAdminPrincipalId,
    string RequestSiteScope, ArticleInboxCaptureReceipt? Receipt);

/// <summary>Intrinsic bounded payload validation and correlation; no authority is granted by a DTO.</summary>
public static class ArticleInboxCaptureContract
{
    public const int SchemaVersion = 1;
    public const int MaxSiteScopeCharacters = 128;
    public const int MaxSiteScopeBytes = 512;
    public const int MaxTitleBytes = 1_024;
    public const int MaxMarkdownBytes = 800_000;
    public const int MaxRequestPayloadBytes = 801_568;
    public const int MaxResponsePayloadBytes = 882;
    public const int MaxRequestFrameBytes = MaxRequestPayloadBytes + 16;
    public const int MaxResponseFrameBytes = MaxResponsePayloadBytes + 16;
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    public static bool IsValidRequest(ArticleInboxCaptureRequest? value)
        => value is not null && value.SchemaVersion == SchemaVersion && value.RequestId != Guid.Empty
            && ValidSite(value.ExpectedSiteScope) && value.Title is not null && value.MarkdownContent is not null
            && value.Title.Length <= ArticleProductionNormalizers.MaxTitleLength
            && !value.Title.Any(char.IsControl) && ValidUtf8(value.Title, MaxTitleBytes)
            && value.MarkdownContent.Length <= ArticleProductionNormalizers.MaxContentLength
            && ValidUtf8(value.MarkdownContent, MaxMarkdownBytes)
            && (!string.IsNullOrWhiteSpace(value.Title) || !string.IsNullOrWhiteSpace(value.MarkdownContent));

    public static bool IsValidReceipt(ArticleInboxCaptureReceipt? value)
        => value is not null && value.ReceiptId != Guid.Empty && value.RequestId != Guid.Empty
            && value.OwnerAdminPrincipalId > 0 && value.ArticleId > 0 && value.DraftId > 0
            && value.DraftServerRevision == 1 && value.RevisionId > 0 && value.RevisionNo == 1
            && value.AuditReference != Guid.Empty && Hex(value.OutboxEventId, 32)
            && Hex(value.AuditDigest, 64) && Hex(value.SourceDigest, 64) && Hex(value.ContentDigest, 64)
            && value.OccurredAtUtcTicks > 0 && value.OccurredAtUtcTicks <= DateTime.MaxValue.Ticks;

    public static bool IsValidResponse(ArticleInboxCaptureResponse? value)
        => value is not null && value.SchemaVersion == SchemaVersion && value.RequestId != Guid.Empty
            && value.AuthenticatedAdminPrincipalId > 0 && ValidSite(value.RequestSiteScope)
            && (value.Receipt is null || IsValidReceipt(value.Receipt)
                && value.Receipt.RequestId == value.RequestId
                && value.Receipt.OwnerAdminPrincipalId == value.AuthenticatedAdminPrincipalId);

    public static bool MatchesRequest(ArticleInboxCaptureRequest? request, ArticleInboxCaptureResponse? response)
        => IsValidRequest(request) && IsValidResponse(response) && request!.RequestId == response!.RequestId
            && string.Equals(request.ExpectedSiteScope, response.RequestSiteScope, StringComparison.Ordinal);

    private static bool ValidSite(string? value)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= MaxSiteScopeCharacters
            && string.Equals(value, value.Trim(), StringComparison.Ordinal) && !value.Any(char.IsControl)
            && ValidUtf8(value, MaxSiteScopeBytes);

    private static bool Hex(string? value, int length)
        => value is not null && value.Length == length
            && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool ValidUtf8(string value, int maxBytes)
    {
        try
        {
            return s_utf8.GetByteCount(value) <= maxBytes;
        }
        catch (EncoderFallbackException)
        {
            return false;
        }
    }
}
