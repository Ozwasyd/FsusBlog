namespace FsusBlog.Shared.Contracts.AuthSystem;

public readonly record struct TokenPairContract(string AccessToken, string RefreshToken);

public readonly record struct UserSnapshotContract(
    int Id,
    string Username,
    string Role,
    int Status,
    DateTime CreateTime,
    string? LastLoginIp,
    DateTime? LastLoginTime,
    DateTime? DeletedAt);

public readonly record struct AuthLoginResultContract(
    TokenPairContract Token,
    UserSnapshotContract User);

public readonly record struct UserListItemContract(
    int Id,
    string Username,
    string Role,
    int Status,
    DateTime CreateTime,
    string? LastLoginIp,
    DateTime? LastLoginTime,
    DateTime? DeletedAt);

public sealed record class AdminUserPageContract
{
    public int Total { get; init; }
    public List<UserListItemContract> Items { get; init; } = [];
}

public readonly record struct SeoConfigContract(
    string Title,
    string Description,
    string Keywords,
    string Author,
    string OgImage,
    string BaseUrl);

public readonly record struct SiteComplianceConfigContract(
    bool Enabled,
    string RegionMode,
    string CopyrightOwner,
    int? CopyrightStartYear,
    string CopyrightText,
    string ContentLicenseName,
    string ContentLicenseUrl,
    string IcpRecordNumber,
    string IcpRecordUrl,
    string PoliceRecordNumber,
    string PoliceRecordUrl,
    string PoliceBadgeIconUrl,
    string OperatorName,
    string ContactEmail);

public readonly record struct PageContentContract(string? Slug, string? Content);
