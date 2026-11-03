namespace FsusBlog.Contracts.AuthoringNavigation;

/// <summary>Transport data for the existing Server selection revalidation; owner is never a request field.</summary>
public sealed record AuthorArticleSelectionRevalidationRequest(
    int SchemaVersion, int ArticleId, long ServerRevision, Guid RequestId, string PermissionToken);

/// <summary>Only the authenticated Server facade derives this owner; the DTO itself grants no authority.</summary>
public sealed record AuthorArticleSelectionRevalidationOwner(long AdminPrincipalId, string SiteScope);

/// <summary>A fresh selected-ID observation, without query metadata, slug, ranking, epoch or admission receipt.</summary>
public sealed record AuthorArticleSelectionRevalidationResponse(
    int SchemaVersion, bool Current, AuthorArticleSelectionRevalidationOwner Owner,
    int ArticleId, long ServerRevision, Guid RequestId, string? PermissionToken);

/// <summary>Intrinsic DTO shape only. Actual permission, source freshness and cancellation stay with the Server owner.</summary>
public static class AuthorArticleSelectionRevalidationContract
{
    public const int SchemaVersion = 1;
    public const int MaxSiteScopeLength = 128;
    public const int PermissionTokenLength = 64;
    public const int RequestPayloadBytes = 100;
    public const int MaxResponsePayloadBytes = 626;
    public const int MaxRequestFrameBytes = RequestPayloadBytes + 16;
    public const int MaxResponseFrameBytes = MaxResponsePayloadBytes + 16;

    public static bool IsValidRequest(AuthorArticleSelectionRevalidationRequest? value)
        => value is not null && value.SchemaVersion == SchemaVersion
            && IsValidCoordinate(value.ArticleId, value.ServerRevision, value.RequestId)
            && IsValidPermissionToken(value.PermissionToken);

    public static bool IsValidResponse(AuthorArticleSelectionRevalidationResponse? value)
        => value is not null && value.SchemaVersion == SchemaVersion
            && IsValidCoordinate(value.ArticleId, value.ServerRevision, value.RequestId)
            && value.Owner is not null && value.Owner.AdminPrincipalId > 0
            && IsValidSiteScope(value.Owner.SiteScope)
            && (value.Current ? IsValidPermissionToken(value.PermissionToken) : value.PermissionToken is null);

    public static bool MatchesRequest(
        AuthorArticleSelectionRevalidationRequest? request,
        AuthorArticleSelectionRevalidationResponse? response)
        => IsValidRequest(request) && IsValidResponse(response)
            && request!.ArticleId == response!.ArticleId && request.ServerRevision == response.ServerRevision
            && request.RequestId == response.RequestId
            && (!response.Current || string.Equals(request.PermissionToken, response.PermissionToken, StringComparison.Ordinal));

    private static bool IsValidCoordinate(int articleId, long serverRevision, Guid requestId)
        => articleId > 0 && serverRevision > 0 && requestId != Guid.Empty;

    private static bool IsValidPermissionToken(string? value)
        => value is { Length: PermissionTokenLength }
            && value.All(static c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsValidSiteScope(string? value)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= MaxSiteScopeLength
            && string.Equals(value, value.Trim(), StringComparison.Ordinal)
            && !value.Any(char.IsControl) && HasValidScalars(value);

    private static bool HasValidScalars(string value)
    {
        for (int index = 0; index < value.Length; index++)
        {
            if (!char.IsSurrogate(value[index]))
                continue;
            if (!char.IsHighSurrogate(value[index]) || ++index == value.Length
                || !char.IsLowSurrogate(value[index]))
                return false;
        }
        return true;
    }
}
