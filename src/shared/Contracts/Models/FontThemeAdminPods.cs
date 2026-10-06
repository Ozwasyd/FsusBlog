using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Packed Font Theme Payload Header wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct FontThemePayloadHeaderPod
{
    public readonly int Version;
    public readonly int RecordCount;
    public readonly int PayloadLength;
    public readonly int Reserved0;
}

/// <summary>
/// Packed Font Registry Item wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct FontRegistryItemPod
{
    public readonly long InstalledAtUnixMs;
    public readonly long UpdatedAtUnixMs;
    public readonly long TotalSizeBytes;
    public readonly int FaceCount;
    public readonly int CriticalFaceCount;
    public readonly byte Enabled;
    public readonly byte BuiltIn;
    public readonly byte InstallState;
    public readonly byte Reserved0;
    public readonly Utf8SliceRef FontId;
    public readonly Utf8SliceRef Name;
    public readonly Utf8SliceRef Family;
    public readonly Utf8SliceRef Category;
    public readonly Utf8SliceRef Version;
}

/// <summary>
/// Packed Font Registry Detail wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct FontRegistryDetailPod
{
    public readonly long InstalledAtUnixMs;
    public readonly long UpdatedAtUnixMs;
    public readonly long TotalSizeBytes;
    public readonly int FaceCount;
    public readonly int CriticalFaceCount;
    public readonly byte Enabled;
    public readonly byte BuiltIn;
    public readonly byte InstallState;
    public readonly byte Reserved0;
    public readonly Utf8SliceRef FontId;
    public readonly Utf8SliceRef Name;
    public readonly Utf8SliceRef Family;
    public readonly Utf8SliceRef Category;
    public readonly Utf8SliceRef Version;
    public readonly Utf8SliceRef LicenseText;
    public readonly Utf8SliceRef LicenseSourceJson;
    public readonly Utf8SliceRef ManifestJson;
}

/// <summary>
/// Packed Font Face wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct FontFacePod
{
    public readonly long SizeBytes;
    public readonly int Weight;
    public readonly byte Critical;
    public readonly byte HasUnicodeRange;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef Style;
    public readonly Utf8SliceRef FilePath;
    public readonly Utf8SliceRef ContentHash;
    public readonly Utf8SliceRef UnicodeRange;
    public readonly Utf8SliceRef FontDisplay;
}

/// <summary>
/// Packed Font Activation wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct FontActivationPod
{
    public readonly long ConfigVersion;
    public readonly long UpdatedAtUnixMs;
    public readonly Utf8SliceRef Scope;
    public readonly Utf8SliceRef UiFontId;
    public readonly Utf8SliceRef ProseFontId;
    public readonly Utf8SliceRef CodeFontId;
    public readonly Utf8SliceRef CjkFontId;
    public readonly Utf8SliceRef EmojiFontId;
}

/// <summary>
/// Packed Theme Registry Item wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ThemeRegistryItemPod
{
    public readonly long InstalledAtUnixMs;
    public readonly long UpdatedAtUnixMs;
    public readonly byte Enabled;
    public readonly byte InstallState;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef ThemeId;
    public readonly Utf8SliceRef Name;
    public readonly Utf8SliceRef Version;
    public readonly Utf8SliceRef Author;
    public readonly Utf8SliceRef Description;
    public readonly Utf8SliceRef Type;
    public readonly Utf8SliceRef PackageHash;
    public readonly Utf8SliceRef PackageLocation;
}

/// <summary>
/// Packed Theme Registry Detail wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ThemeRegistryDetailPod
{
    public readonly long InstalledAtUnixMs;
    public readonly long UpdatedAtUnixMs;
    public readonly long CssBytes;
    public readonly long AssetBytes;
    public readonly long PreviewBytes;
    public readonly int MaxSelectors;
    public readonly int MaxSelectorDepth;
    public readonly int MaxImportant;
    public readonly int MaxMotionDurationMs;
    public readonly byte Enabled;
    public readonly byte InstallState;
    public readonly byte SupportsPublic;
    public readonly byte SupportsAdmin;
    public readonly byte SupportsConsole;
    public readonly byte SupportsHighContrast;
    public readonly byte SupportsReducedMotion;
    public readonly byte SupportsRtl;
    public readonly byte PermissionScript;
    public readonly byte PermissionNetwork;
    public readonly byte PermissionFilesystem;
    public readonly byte Reserved0;
    public readonly Utf8SliceRef ThemeId;
    public readonly Utf8SliceRef Name;
    public readonly Utf8SliceRef Version;
    public readonly Utf8SliceRef Author;
    public readonly Utf8SliceRef Description;
    public readonly Utf8SliceRef Type;
    public readonly Utf8SliceRef PackageHash;
    public readonly Utf8SliceRef PackageLocation;
    public readonly Utf8SliceRef ManifestJson;
    public readonly Utf8SliceRef ConfigSchemaJson;
}

/// <summary>
/// Packed Theme Activation wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ThemeActivationPod
{
    public readonly long ConfigVersion;
    public readonly long UpdatedAtUnixMs;
    public readonly byte HasActiveThemeId;
    public readonly byte HasMode;
    public readonly byte HasActivationId;
    public readonly byte HasAssetVersion;
    public readonly byte HasConfigVersion;
    public readonly byte HasUpdatedAt;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef Scope;
    public readonly Utf8SliceRef ActiveThemeId;
    public readonly Utf8SliceRef Mode;
    public readonly Utf8SliceRef ActivationId;
    public readonly Utf8SliceRef AssetVersion;
}

/// <summary>
/// Packed Theme Activation History wire record; slice offsets refer to the contiguous bounded UTF-8 blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct ThemeActivationHistoryPod
{
    public readonly long ConfigVersion;
    public readonly long PreviousConfigVersion;
    public readonly long StartedAtUnixMs;
    public readonly long CompletedAtUnixMs;
    public readonly byte HasThemeId;
    public readonly byte HasPreviousThemeId;
    public readonly byte HasAssetVersion;
    public readonly byte HasPreviousAssetVersion;
    public readonly byte HasConfigVersion;
    public readonly byte HasPreviousConfigVersion;
    public readonly byte HasMode;
    public readonly byte HasPreviousMode;
    public readonly byte HasFailureReason;
    public readonly byte Status;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef Id;
    public readonly Utf8SliceRef Scope;
    public readonly Utf8SliceRef ThemeId;
    public readonly Utf8SliceRef PreviousThemeId;
    public readonly Utf8SliceRef AssetVersion;
    public readonly Utf8SliceRef PreviousAssetVersion;
    public readonly Utf8SliceRef Mode;
    public readonly Utf8SliceRef PreviousMode;
    public readonly Utf8SliceRef FailureReason;
    public readonly Utf8SliceRef ActivatedBy;
}
