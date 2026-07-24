namespace FsusBlog.Shared.Contracts.Fonts;

/// <summary>
/// Describes one versioned FsusBlog font package.
/// </summary>
public sealed record FontManifest(
    string Id,
    string Name,
    string Version,
    string FsusBlog,
    string Type,
    string Family,
    string Category,
    IReadOnlyList<string> Scripts,
    IReadOnlyList<string> Locales,
    IReadOnlyList<FontFaceDescriptor> Faces,
    FontLicenseDescriptor License,
    FontBudgetDescriptor Budgets,
    FontLoadingDescriptor Loading);

/// <summary>
/// Describes one WOFF2 face declared by a font package.
/// </summary>
public sealed record FontFaceDescriptor(
    int Weight,
    string Style,
    string File,
    string? UnicodeRange,
    bool Critical);

/// <summary>
/// Identifies the local license and provenance documents required by a font package.
/// </summary>
public sealed record FontLicenseDescriptor(
    string Name,
    string File,
    string Source);

/// <summary>
/// Sets the package-level byte and face limits enforced before installation.
/// </summary>
public sealed record FontBudgetDescriptor(
    long CriticalBytes,
    long TotalBytes,
    int MaxFaces);

/// <summary>
/// Declares the browser loading policy and face weights selected for eager or deferred loading.
/// </summary>
public sealed record FontLoadingDescriptor(
    string Display,
    IReadOnlyList<string> Preload,
    IReadOnlyList<string> Defer);

public static class FontCategories
{
    public const string UiSans = "ui-sans";
    public const string ProseSans = "prose-sans";
    public const string CodeMono = "code-mono";
    public const string CjkSans = "cjk-sans";
    public const string Emoji = "emoji";
}

public static class FontFaceStyles
{
    public const string Normal = "normal";
    public const string Italic = "italic";
    public const string Oblique = "oblique";
}

public static class FontDisplayModes
{
    public const string Auto = "auto";
    public const string Block = "block";
    public const string Swap = "swap";
    public const string Fallback = "fallback";
    public const string Optional = "optional";
}
