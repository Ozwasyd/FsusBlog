using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.Themes;

public enum ThemeInstallState
{
    Discovered,
    Validated,
    Installed,
    Enabled,
    Disabled,
    Failed,
    RolledBack,
    Uninstalled
}

public sealed record ThemeManifest
{
    public required string Id
    {
        get;
        init;
    }

    public required string Name
    {
        get;
        init;
    }

    public required string Version
    {
        get;
        init;
    }

    public required string Fsusblog
    {
        get;
        init;
    }

    public required string Author
    {
        get;
        init;
    }

    public required string Description
    {
        get;
        init;
    }

    public required string Type
    {
        get;
        init;
    }

    public required ThemeEntryManifest Entry
    {
        get;
        init;
    }

    public required IReadOnlyList<string> Modes
    {
        get;
        init;
    }

    public required ThemeSupportManifest Supports
    {
        get;
        init;
    }

    public required IReadOnlyDictionary<string, string> Assets
    {
        get;
        init;
    }

    public required string ConfigSchema
    {
        get;
        init;
    }

    public required ThemePermissionManifest Permissions
    {
        get;
        init;
    }

    public required ThemeBudgetManifest Budgets
    {
        get;
        init;
    }
}

public sealed record ThemeEntryManifest
{
    public required string Tokens
    {
        get;
        init;
    }

    public required string Theme
    {
        get;
        init;
    }

    public string? Prose
    {
        get;
        init;
    }

    public string? Code
    {
        get;
        init;
    }
}

public sealed record ThemeSupportManifest
{
    public bool Public
    {
        get;
        init;
    }

    public bool Admin
    {
        get;
        init;
    }

    public bool Console
    {
        get;
        init;
    }

    public bool HighContrast
    {
        get;
        init;
    }

    public bool ReducedMotion
    {
        get;
        init;
    }

    public bool Rtl
    {
        get;
        init;
    }
}

public sealed record ThemePermissionManifest
{
    public bool Script
    {
        get;
        init;
    }

    public bool Network
    {
        get;
        init;
    }

    public bool Filesystem
    {
        get;
        init;
    }
}

public sealed record ThemeBudgetManifest
{
    public long CssBytes
    {
        get;
        init;
    }

    public long AssetBytes
    {
        get;
        init;
    }

    public int MaxSelectors
    {
        get;
        init;
    }
}

public sealed record ThemePackageEntry(
    string Path,
    string ContentHash,
    long SizeBytes);

public sealed record ThemeAssetMetadata(
    string AssetKey,
    string Path,
    string ContentHash,
    long SizeBytes);

public sealed record ValidatedThemePackage(
    ThemeManifest Manifest,
    string ManifestJson,
    string ConfigSchemaJson,
    string PackageHash,
    ReadOnlyMemory<byte> PackageBytes,
    IReadOnlyList<ThemePackageEntry> Entries,
    IReadOnlyDictionary<string, ThemeAssetMetadata> Assets);

public sealed record ThemePackageStoreReceipt(
    string Location,
    bool Created);

public readonly record struct ThemeActivationScope
{
    private const string UserPreviewPrefix = "user-preview:";

    private ThemeActivationScope(string value)
    {
        Value = value;
    }

    public static ThemeActivationScope SiteWide
    {
        get;
    } = new("site-wide");

    public static ThemeActivationScope Public
    {
        get;
    } = new("public");

    public static ThemeActivationScope Admin
    {
        get;
    } = new("admin");

    public static ThemeActivationScope Console
    {
        get;
    } = new("console");

    public string Value
    {
        get;
    }

    public static ThemeActivationScope UserPreview(long userId)
    {
        if (userId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(userId));
        }

        return new ThemeActivationScope($"{UserPreviewPrefix}{userId}");
    }

    public static ThemeActivationScope Parse(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        if (value is "site-wide" or "public" or "admin" or "console")
        {
            return new ThemeActivationScope(value);
        }

        if (value.StartsWith(UserPreviewPrefix, StringComparison.Ordinal)
            && long.TryParse(
                value.AsSpan(UserPreviewPrefix.Length),
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture,
                out long userId)
            && userId > 0)
        {
            return UserPreview(userId);
        }

        throw new ArgumentException("Theme activation scope is invalid.", nameof(value));
    }

    public override string ToString() => Value;
}

public sealed record ThemeRegistrySnapshot(
    ThemeManifest Manifest,
    string ManifestJson,
    string ConfigSchemaJson,
    string PackageHash,
    string PackageLocation,
    ThemeInstallState InstallState,
    bool Enabled,
    DateTimeOffset InstalledAtUtc,
    DateTimeOffset UpdatedAtUtc);

public sealed record ThemeActivationSnapshot(
    ThemeActivationScope Scope,
    string ActiveThemeId,
    string Mode,
    DateTimeOffset UpdatedAtUtc);

public sealed class ThemePackageException(
    string errorCode,
    string message,
    Exception? innerException = null) : Exception(message, innerException)
{
    public string ErrorCode
    {
        get;
    } = errorCode;
}

public sealed class ThemeLifecycleException(
    string errorCode,
    string message,
    Exception? innerException = null) : Exception(message, innerException)
{
    public string ErrorCode
    {
        get;
    } = errorCode;
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = false,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow)]
[JsonSerializable(typeof(ThemeManifest))]
internal partial class ThemeJsonSerializerContext : JsonSerializerContext;
