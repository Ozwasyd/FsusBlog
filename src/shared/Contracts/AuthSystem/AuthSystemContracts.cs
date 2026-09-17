namespace FsusBlog.Shared.Contracts.AuthSystem;

/// <summary>
/// Defines the authentication and system transport contract represented by <c>TokenPairContract</c>.
/// </summary>
public readonly record struct TokenPairContract(string AccessToken, string RefreshToken);

/// <summary>
/// Defines the authentication and system transport contract represented by <c>AccountSnapshotContract</c>.
/// </summary>
public readonly record struct AccountSnapshotContract(
    int AccountId,
    string IdentityKind,
    string? PublicHandle,
    bool PasskeyEnabled,
    bool RecoveryEnabled,
    bool TotpStepUpEnabled,
    string? AnonymousCredentialStatus,
    string? AnonymousCredentialLevel,
    int Status,
    DateTime? DeletedAt);

/// <summary>
/// Defines the authentication and system transport contract represented by <c>AdminAccountListItemContract</c>.
/// </summary>
public readonly record struct AdminAccountListItemContract(
    int AccountId,
    string IdentityKind,
    string? PublicHandle,
    bool PasskeyInitialized,
    bool RecoveryInitialized,
    DateTime? PrivacyInitializedAt,
    string AnonymousCredentialStatus,
    int RiskFlags,
    int Status,
    DateTime CreateTime,
    DateTime? DeletedAt);

/// <summary>
/// Defines the authentication and system transport contract represented by <c>AdminUserPageContract</c>.
/// </summary>
public sealed record class AdminUserPageContract
{
    public int Total
    {
        get; init;
    }
    public List<AdminAccountListItemContract> Items { get; init; } = [];
}

/// <summary>
/// Defines the authentication and system transport contract represented by <c>SeoConfigContract</c>.
/// </summary>
public readonly record struct SeoConfigContract(
    string Title,
    string Description,
    string Keywords,
    string Author,
    string OgImage,
    string BaseUrl,
    string FaviconSvgUrl,
    string FaviconIcoUrl,
    string FaviconPngUrl,
    string AppleTouchIconUrl,
    string ManifestName,
    string ManifestShortName,
    string PwaIcon192Url,
    string PwaIcon512Url,
    string PwaMaskableIconUrl,
    string ThemeColor,
    string BackgroundColor,
    string SiteLogoUrl,
    string SiteLogoDarkUrl,
    string SiteWordmarkUrl,
    string AdminLogoUrl,
    string AdminCollapsedIconUrl,
    string LoginLogoUrl,
    string LoginIconUrl);

/// <summary>
/// Defines the authentication and system transport contract represented by <c>SiteComplianceConfigContract</c>.
/// </summary>
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

/// <summary>
/// Defines the authentication and system transport contract represented by <c>PageContentContract</c>.
/// </summary>
public readonly record struct PageContentContract(string? Slug, string? Content);
