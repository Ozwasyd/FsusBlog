using System.Text.RegularExpressions;

using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Infrastructure.Fonts;

public sealed record FontManifestValidation(
    bool IsValid,
    IReadOnlyList<string> Errors);

public static class FontPackageLimits
{
    public const long MaxCriticalBytes = 16 * 1024 * 1024;
    public const long MaxTotalBytes = 64 * 1024 * 1024;
    public const int MaxFaces = 32;
}

public static partial class FontManifestValidator
{
    private static readonly HashSet<string> s_categories = new(StringComparer.Ordinal)
    {
        FontCategories.UiSans,
        FontCategories.ProseSans,
        FontCategories.CodeMono,
        FontCategories.CjkSans,
        FontCategories.Emoji
    };

    private static readonly HashSet<string> s_styles = new(StringComparer.Ordinal)
    {
        FontFaceStyles.Normal,
        FontFaceStyles.Italic,
        FontFaceStyles.Oblique
    };

    private static readonly HashSet<string> s_displayModes = new(StringComparer.Ordinal)
    {
        FontDisplayModes.Auto,
        FontDisplayModes.Block,
        FontDisplayModes.Swap,
        FontDisplayModes.Fallback,
        FontDisplayModes.Optional
    };

    public static FontManifestValidation Validate(FontManifest? manifest, Version currentFsusBlogVersion)
    {
        ArgumentNullException.ThrowIfNull(currentFsusBlogVersion);

        if (manifest is null)
        {
            return new FontManifestValidation(false, ["font_manifest_required"]);
        }

        var errors = new HashSet<string>(StringComparer.Ordinal);
        if (!FontIdPattern().IsMatch(manifest.Id ?? string.Empty))
        {
            errors.Add("font_id_invalid");
        }

        if (string.IsNullOrWhiteSpace(manifest.Name)
            || string.IsNullOrWhiteSpace(manifest.Family))
        {
            errors.Add("font_identity_invalid");
        }

        if (!SemanticVersionPattern().IsMatch(manifest.Version ?? string.Empty))
        {
            errors.Add("font_version_invalid");
        }

        if (!string.Equals(manifest.Type, "font", StringComparison.Ordinal))
        {
            errors.Add("font_type_invalid");
        }

        if (!s_categories.Contains(manifest.Category ?? string.Empty))
        {
            errors.Add("font_category_invalid");
        }

        ValidateTextSet(manifest.Scripts, "font_scripts_invalid", errors);
        ValidateTextSet(manifest.Locales, "font_locales_invalid", errors);
        if (!FontVersionRange.IsMatch(manifest.FsusBlog, currentFsusBlogVersion))
        {
            errors.Add("font_fsusblog_version_incompatible");
        }

        ValidateFaces(manifest, errors);
        ValidateLicense(manifest.License, errors);
        ValidateBudgets(manifest.Budgets, errors);
        if (manifest.Budgets is not null
            && manifest.Faces is not null
            && manifest.Faces.Count > manifest.Budgets.MaxFaces)
        {
            errors.Add("font_budget_face_count_exceeded");
        }

        ValidateLoading(manifest.Loading, errors);

        return new FontManifestValidation(errors.Count == 0, [.. errors.Order(StringComparer.Ordinal)]);
    }

    private static void ValidateFaces(FontManifest manifest, HashSet<string> errors)
    {
        if (manifest.Faces is null || manifest.Faces.Count == 0)
        {
            errors.Add("font_faces_required");
            return;
        }

        var identities = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < manifest.Faces.Count; index++)
        {
            FontFaceDescriptor face = manifest.Faces[index];
            if (face.Weight is < 1 or > 1000
                || !s_styles.Contains(face.Style ?? string.Empty))
            {
                errors.Add("font_face_descriptor_invalid");
            }

            if (!FontPackagePath.TryNormalize(face.File, out string normalized)
                || !normalized.StartsWith("fonts/", StringComparison.Ordinal)
                || !normalized.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase))
            {
                errors.Add("font_face_file_invalid");
            }

            if (!identities.Add($"{face.Weight}:{face.Style}"))
            {
                errors.Add("font_face_duplicate");
            }
        }
    }

    private static void ValidateLicense(FontLicenseDescriptor? license, HashSet<string> errors)
    {
        if (license is null
            || string.IsNullOrWhiteSpace(license.Name)
            || !FontPackagePath.TryNormalize(license.File, out string licenseFile)
            || !FontPackagePath.TryNormalize(license.Source, out string sourceFile)
            || !licenseFile.StartsWith("license/", StringComparison.Ordinal)
            || !sourceFile.StartsWith("license/", StringComparison.Ordinal))
        {
            errors.Add("font_license_invalid");
        }
    }

    private static void ValidateBudgets(FontBudgetDescriptor? budgets, HashSet<string> errors)
    {
        if (budgets is null
            || budgets.CriticalBytes < 0
            || budgets.TotalBytes <= 0
            || budgets.CriticalBytes > budgets.TotalBytes
            || budgets.CriticalBytes > FontPackageLimits.MaxCriticalBytes
            || budgets.TotalBytes > FontPackageLimits.MaxTotalBytes
            || budgets.MaxFaces <= 0
            || budgets.MaxFaces > FontPackageLimits.MaxFaces)
        {
            errors.Add("font_budget_invalid");
        }
    }

    private static void ValidateLoading(FontLoadingDescriptor? loading, HashSet<string> errors)
    {
        if (loading is null || !s_displayModes.Contains(loading.Display ?? string.Empty))
        {
            errors.Add("font_loading_invalid");
            return;
        }

        if (!IsValidTextSet(loading.Preload)
            || !IsValidTextSet(loading.Defer)
            || loading.Preload.Intersect(loading.Defer, StringComparer.Ordinal).Any())
        {
            errors.Add("font_loading_weights_invalid");
        }
    }

    private static void ValidateTextSet(
        IReadOnlyList<string>? values,
        string errorCode,
        HashSet<string> errors)
    {
        if (!IsValidTextSet(values))
        {
            errors.Add(errorCode);
        }
    }

    private static bool IsValidTextSet(IReadOnlyList<string>? values)
        => values is not null
            && values.All(static value => !string.IsNullOrWhiteSpace(value))
            && values.Distinct(StringComparer.Ordinal).Count() == values.Count;

    [GeneratedRegex(@"^fsusblog\.font\.[a-z0-9]+(?:-[a-z0-9]+)*$", RegexOptions.CultureInvariant)]
    private static partial Regex FontIdPattern();

    [GeneratedRegex(@"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex SemanticVersionPattern();
}

internal static class FontVersionRange
{
    public static bool IsMatch(string? range, Version current)
    {
        if (string.IsNullOrWhiteSpace(range))
        {
            return false;
        }

        string[] constraints = range.Split(
            ' ',
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (constraints.Length == 0)
        {
            return false;
        }

        foreach (string constraint in constraints)
        {
            string operation = constraint.StartsWith(">=", StringComparison.Ordinal)
                || constraint.StartsWith("<=", StringComparison.Ordinal)
                ? constraint[..2]
                : constraint[..1];
            string rawVersion = constraint[operation.Length..];
            if (!Version.TryParse(rawVersion, out Version? expected))
            {
                return false;
            }

            int comparison = current.CompareTo(expected);
            bool matched = operation switch
            {
                ">=" => comparison >= 0,
                ">" => comparison > 0,
                "<=" => comparison <= 0,
                "<" => comparison < 0,
                "=" => comparison == 0,
                _ => false
            };
            if (!matched)
            {
                return false;
            }
        }

        return true;
    }
}

internal static class FontPackagePath
{
    public static bool TryNormalize(string? value, out string normalized)
    {
        normalized = string.Empty;
        if (string.IsNullOrWhiteSpace(value)
            || value.IndexOf('\0') >= 0
            || value.Contains('\\', StringComparison.Ordinal)
            || value.StartsWith("/", StringComparison.Ordinal))
        {
            return false;
        }

        string[] segments = value.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || segments.Any(static segment => segment is "." or ".."))
        {
            return false;
        }

        normalized = string.Join('/', segments);
        return string.Equals(value, normalized, StringComparison.Ordinal);
    }
}
