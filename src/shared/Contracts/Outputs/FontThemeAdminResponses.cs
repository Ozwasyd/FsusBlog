namespace FsusBlog.Shared.Contracts.Outputs;

/// <summary>
/// Closed count, UTF-8 byte, blob, and enum limits shared by the Font/Theme POD writers and readers.
/// </summary>
public static class FontThemeAdminContractLimits
{
    public const int MaxRegistryItems = 1_024;
    public const int MaxFontFaces = 32;
    public const int MaxFontActivations = 256;
    public const int MaxThemeModes = 2;
    public const int MaxThemeActivations = 1_024;
    public const int MaxThemeActivationHistory = 50;
    public const int MaxIdentifierBytes = 256;
    public const int MaxLabelBytes = 4 * 1_024;
    public const int MaxFamilyBytes = 16 * 1_024;
    public const int MaxPathBytes = 4 * 1_024;
    public const int MaxHashBytes = 256;
    public const int MaxJsonBytes = 2 * 1_024 * 1_024;
    public const int MaxLicenseBytes = 2 * 1_024 * 1_024;
    public const int MaxUnicodeRangeBytes = 4 * 1_024;
    public const int MaxFailureReasonBytes = 4 * 1_024;
    public const int MaxActorBytes = 1_024;
    public const int MaxBlobBytes = 7 * 1_024 * 1_024;

    public const byte FontInstallStateInstalled = 1;
    public const byte ThemeInstallStateDiscovered = 1;
    public const byte ThemeInstallStateValidated = 2;
    public const byte ThemeInstallStateInstalled = 3;
    public const byte ThemeInstallStateEnabled = 4;
    public const byte ThemeInstallStateDisabled = 5;
    public const byte ThemeInstallStateFailed = 6;
    public const byte ThemeInstallStateRolledBack = 7;
    public const byte ThemeInstallStateUninstalled = 8;
    public const byte ThemeActivationStatusApplied = 1;
    public const byte ThemeActivationStatusRejected = 2;
    public const byte ThemeActivationStatusRolledBack = 3;
    public const byte ThemeActivationStatusResetToDefault = 4;
}

/// <summary>
/// Typed Font Registry List snapshot for the bounded administration POD contract.
/// </summary>
public sealed record FontRegistryListResponse(IReadOnlyList<FontRegistryItemResponse> Items);

/// <summary>
/// Typed Font Registry Item snapshot for the bounded administration POD contract.
/// </summary>
public sealed record FontRegistryItemResponse(
    string FontId,
    string Name,
    string Family,
    string Category,
    string Version,
    string InstallState,
    bool Enabled,
    bool BuiltIn,
    int FaceCount,
    int CriticalFaceCount,
    long TotalSizeBytes,
    DateTimeOffset InstalledAt,
    DateTimeOffset UpdatedAt);

/// <summary>
/// Typed Font Registry Detail snapshot for the bounded administration POD contract.
/// </summary>
public sealed record FontRegistryDetailResponse(
    FontRegistryItemResponse Font,
    string LicenseText,
    string LicenseSourceJson,
    string ManifestJson,
    IReadOnlyList<FontFaceResponse> Faces);

/// <summary>
/// Typed Font Face snapshot for the bounded administration POD contract.
/// </summary>
public sealed record FontFaceResponse(
    int Weight,
    string Style,
    string FilePath,
    string ContentHash,
    long SizeBytes,
    string? UnicodeRange,
    bool Critical,
    string FontDisplay);

/// <summary>
/// Typed Font Activation List snapshot for the bounded administration POD contract.
/// </summary>
public sealed record FontActivationListResponse(IReadOnlyList<FontActivationResponse> Items);

/// <summary>
/// Typed Font Activation snapshot for the bounded administration POD contract.
/// </summary>
public sealed record FontActivationResponse(
    string Scope,
    string UiFontId,
    string ProseFontId,
    string CodeFontId,
    string CjkFontId,
    string EmojiFontId,
    long ConfigVersion,
    DateTimeOffset UpdatedAt);

/// <summary>
/// Typed Theme Registry List snapshot for the bounded administration POD contract.
/// </summary>
public sealed record ThemeRegistryListResponse(IReadOnlyList<ThemeRegistryItemResponse> Items);

/// <summary>
/// Typed Theme Registry Item snapshot for the bounded administration POD contract.
/// </summary>
public sealed record ThemeRegistryItemResponse(
    string ThemeId,
    string Name,
    string Version,
    string Author,
    string Description,
    string Type,
    string InstallState,
    bool Enabled,
    string PackageHash,
    string PackageLocation,
    DateTimeOffset InstalledAtUtc,
    DateTimeOffset UpdatedAtUtc);

/// <summary>
/// Typed Theme Registry Detail snapshot for the bounded administration POD contract.
/// </summary>
public sealed record ThemeRegistryDetailResponse(
    ThemeRegistryItemResponse Theme,
    string ManifestJson,
    string ConfigSchemaJson,
    IReadOnlyList<string> Modes,
    ThemeSupportResponse Supports,
    ThemeBudgetResponse Budgets,
    ThemePermissionResponse Permissions);

/// <summary>
/// Typed Theme Support snapshot for the bounded administration POD contract.
/// </summary>
public sealed record ThemeSupportResponse(
    bool Public,
    bool Admin,
    bool Console,
    bool HighContrast,
    bool ReducedMotion,
    bool Rtl);

/// <summary>
/// Nonnegative Theme resource budgets; Int64 byte budgets must not be narrowed to JavaScript numbers.
/// </summary>
public sealed record ThemeBudgetResponse(
    long CssBytes,
    long AssetBytes,
    int MaxSelectors,
    int MaxSelectorDepth,
    int MaxImportant,
    int MaxMotionDurationMs,
    long PreviewBytes);

/// <summary>
/// Typed Theme Permission snapshot for the bounded administration POD contract.
/// </summary>
public sealed record ThemePermissionResponse(bool Script, bool Network, bool Filesystem);

/// <summary>
/// Typed Theme Activation List snapshot for the bounded administration POD contract.
/// </summary>
public sealed record ThemeActivationListResponse(IReadOnlyList<ThemeActivationResponse> Items);

/// <summary>
/// Scope activation snapshot; explicit nullable fields distinguish an absent activation from a populated one.
/// </summary>
public sealed record ThemeActivationResponse(
    string Scope,
    string? ActiveThemeId,
    string? Mode,
    Guid? ActivationId,
    string? AssetVersion,
    long? ConfigVersion,
    DateTimeOffset? UpdatedAtUtc);

/// <summary>
/// Typed Theme Activation History snapshot for the bounded administration POD contract.
/// </summary>
public sealed record ThemeActivationHistoryResponse(IReadOnlyList<ThemeActivationHistoryItemResponse> Items);

/// <summary>
/// Typed Theme Activation History Item snapshot for the bounded administration POD contract.
/// </summary>
public sealed record ThemeActivationHistoryItemResponse(
    Guid Id,
    string Scope,
    string? ThemeId,
    string? PreviousThemeId,
    string? AssetVersion,
    string? PreviousAssetVersion,
    long? ConfigVersion,
    long? PreviousConfigVersion,
    string? Mode,
    string? PreviousMode,
    string Status,
    string? FailureReason,
    DateTimeOffset StartedAtUtc,
    DateTimeOffset CompletedAtUtc,
    string ActivatedBy);
