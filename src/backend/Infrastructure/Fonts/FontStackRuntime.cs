using System.Text;

using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Infrastructure.Fonts;

public sealed class FontTokenException(string code, string message) : InvalidOperationException(message)
{
    public string Code { get; } = code;
}

public sealed record FontThemeTypographyPreferences(
    IReadOnlyDictionary<string, string> SemanticFamilyReferences);

public sealed record FontStackResolutionRequest(
    string Scope,
    string? Locale = null,
    string? Script = null,
    FontThemeTypographyPreferences? Theme = null);

public sealed record FontTokenResolution(
    string SchemaVersion,
    long ConfigVersion,
    bool UsedSafeFallback,
    IReadOnlyDictionary<string, string> FamilyStacks,
    IReadOnlyDictionary<string, string> TokenValues,
    IReadOnlyDictionary<string, string> SemanticReferences,
    string CssVariables);

public interface IFontStackRuntime
{
    Task<FontTokenResolution> ResolveAsync(
        FontStackResolutionRequest request,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Resolves registry activations into injection-safe, locale-aware font token values.
/// Font loading remains a separate concern; every output retains a local/system fallback.
/// </summary>
public sealed class FontStackRuntime(IFontRegistry registry) : IFontStackRuntime
{
    private static readonly IReadOnlyDictionary<string, string> s_defaultSemanticReferences =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [FontTokenSchema.Typography.BodyFamily] = FontTokenSchema.Family.Ui,
            [FontTokenSchema.Typography.ArticleFamily] = FontTokenSchema.Family.Prose,
            [FontTokenSchema.Typography.HeadingFamily] = FontTokenSchema.Family.Ui,
            [FontTokenSchema.Typography.CodeFamily] = FontTokenSchema.Family.Code,
            [FontTokenSchema.Typography.AdminTableFamily] = FontTokenSchema.Family.Ui
        };

    private static readonly IReadOnlyDictionary<string, string> s_primitiveValues =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [FontTokenSchema.Weight.Regular] = "400",
            [FontTokenSchema.Weight.Medium] = "500",
            [FontTokenSchema.Weight.Bold] = "700",
            [FontTokenSchema.Size.Body] = "1rem",
            [FontTokenSchema.Size.Article] = "1rem",
            [FontTokenSchema.Size.Code] = "0.875rem",
            [FontTokenSchema.Size.Caption] = "0.75rem",
            [FontTokenSchema.LineHeight.Body] = "1.6",
            [FontTokenSchema.LineHeight.Article] = "1.75",
            [FontTokenSchema.LineHeight.Code] = "1.6",
            [FontTokenSchema.LetterSpacing.Ui] = "0",
            [FontTokenSchema.LetterSpacing.Prose] = "0",
            [FontTokenSchema.LetterSpacing.Code] = "0"
        };

    private static readonly HashSet<string> s_genericFamilies = new(StringComparer.OrdinalIgnoreCase)
    {
        "serif",
        "sans-serif",
        "monospace",
        "system-ui",
        "ui-sans-serif",
        "ui-monospace",
        "ui-serif",
        "emoji",
        "math",
        "fangsong"
    };

    private static readonly HashSet<string> s_knownCjkFamilies = new(StringComparer.OrdinalIgnoreCase)
    {
        "Noto Sans SC",
        "Noto Sans TC",
        "Noto Sans JP",
        "Noto Sans CJK",
        "PingFang SC",
        "Microsoft YaHei"
    };

    private static readonly IReadOnlyList<string> s_platformEmojiFallback =
    [
        "Apple Color Emoji",
        "Segoe UI Emoji",
        "Noto Color Emoji"
    ];

    private static readonly HashSet<string> s_platformEmojiFamilies = new(
        s_platformEmojiFallback,
        StringComparer.OrdinalIgnoreCase);

    public async Task<FontTokenResolution> ResolveAsync(
        FontStackResolutionRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Scope);

        FontRegistrySnapshot snapshot = await registry.ReadAsync(cancellationToken).ConfigureAwait(false);
        FontActivation? activation = snapshot.Activations.FirstOrDefault(
            value => string.Equals(value.Scope, request.Scope, StringComparison.Ordinal));
        bool usedSafeFallback = false;
        if (activation is null && !string.Equals(request.Scope, FontActivation.DefaultScope, StringComparison.Ordinal))
        {
            activation = snapshot.Activations.FirstOrDefault(
                value => string.Equals(value.Scope, FontActivation.DefaultScope, StringComparison.Ordinal));
            usedSafeFallback = true;
        }

        string script = ResolveScript(request.Locale, request.Script);
        FontRegistryEntry ui = ResolveRole(
            snapshot,
            activation?.UiFontId,
            FontCategories.UiSans,
            FontBuiltIns.UiSans,
            ref usedSafeFallback);
        FontRegistryEntry prose = ResolveRole(
            snapshot,
            activation?.ProseFontId,
            FontCategories.ProseSans,
            FontBuiltIns.ProseSans,
            ref usedSafeFallback);
        FontRegistryEntry code = ResolveRole(
            snapshot,
            activation?.CodeFontId,
            FontCategories.CodeMono,
            FontBuiltIns.CodeMono,
            ref usedSafeFallback);
        FontRegistryEntry cjk = ResolveRole(
            snapshot,
            activation?.CjkFontId,
            FontCategories.CjkSans,
            FontBuiltIns.CjkSans,
            ref usedSafeFallback);
        FontRegistryEntry emoji = ResolveRole(
            snapshot,
            activation?.EmojiFontId,
            FontCategories.Emoji,
            FontBuiltIns.Emoji,
            ref usedSafeFallback);

        IReadOnlyList<string> cjkFallback = CjkFallback(script);
        var stacks = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [FontTokenSchema.Family.Ui] = FormatStack(
                NonCjkFamilies(ui),
                cjkFallback,
                ["system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"]),
            [FontTokenSchema.Family.Prose] = FormatStack(
                NonCjkFamilies(prose),
                cjkFallback,
                ["system-ui", "sans-serif"]),
            [FontTokenSchema.Family.Code] = FormatStack(
                Families(code),
                ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"]),
            [FontTokenSchema.Family.Cjk] = FormatStack(
                NonCjkFamilies(cjk),
                cjkFallback,
                ["system-ui", "sans-serif"]),
            [FontTokenSchema.Family.Emoji] = FormatStack(
                s_platformEmojiFallback,
                Families(emoji).Where(
                    family => !s_platformEmojiFamilies.Contains(family)),
                ["sans-serif"])
        };

        IReadOnlyDictionary<string, string> semanticReferences = ResolveThemeReferences(request.Theme);
        Dictionary<string, string> tokenValues = FontTokenSchema.All.ToDictionary(
            token => token,
            token => ResolveTokenValue(token, stacks, semanticReferences),
            StringComparer.Ordinal);

        string cssVariables = CompileCss(stacks, semanticReferences);
        return new FontTokenResolution(
            FontTokenSchema.Version,
            activation?.ConfigVersion ?? 0,
            usedSafeFallback || activation is null,
            stacks,
            tokenValues,
            semanticReferences,
            cssVariables);
    }

    private static string ResolveTokenValue(
        string token,
        IReadOnlyDictionary<string, string> stacks,
        IReadOnlyDictionary<string, string> semanticReferences)
    {
        if (stacks.TryGetValue(token, out string? familyStack))
        {
            return familyStack;
        }

        if (s_primitiveValues.TryGetValue(token, out string? primitiveValue))
        {
            return primitiveValue;
        }

        return SemanticTokenValue(token, semanticReferences);
    }

    private static FontRegistryEntry ResolveRole(
        FontRegistrySnapshot snapshot,
        string? id,
        string expectedCategory,
        FontRegistryEntry fallback,
        ref bool usedSafeFallback)
    {
        FontRegistryEntry? selected = id is null
            ? null
            : snapshot.Fonts.FirstOrDefault(
                entry => string.Equals(entry.Id, id, StringComparison.Ordinal));
        if (selected is null
            || !selected.Enabled
            || !string.Equals(selected.Category, expectedCategory, StringComparison.Ordinal)
            || !IsSafeFamilyDeclaration(selected))
        {
            usedSafeFallback = true;
            return fallback;
        }

        return selected;
    }

    private static bool IsSafeFamilyDeclaration(FontRegistryEntry entry)
    {
        if (entry.BuiltIn)
        {
            return true;
        }

        string family = entry.Family.Trim();
        return family.Length is > 0 and <= 128
            && family.All(
                character => char.IsLetterOrDigit(character)
                    || char.IsWhiteSpace(character)
                    || character is '-' or '_');
    }

    private static IReadOnlyDictionary<string, string> ResolveThemeReferences(
        FontThemeTypographyPreferences? preferences)
    {
        var resolved = new Dictionary<string, string>(s_defaultSemanticReferences, StringComparer.Ordinal);
        if (preferences is null)
        {
            return resolved;
        }

        foreach ((string semanticToken, string familyToken) in preferences.SemanticFamilyReferences)
        {
            if (!FontTokenSchema.Typography.FamilyReferences.Contains(semanticToken)
                || !FontTokenSchema.Family.All.Contains(familyToken, StringComparer.Ordinal))
            {
                throw new FontTokenException(
                    "font_theme_reference_invalid",
                    $"Theme typography token '{semanticToken}' must reference a font.family token.");
            }

            resolved[semanticToken] = familyToken;
        }

        return resolved;
    }

    private static string ResolveScript(string? locale, string? explicitScript)
    {
        if (!string.IsNullOrWhiteSpace(explicitScript))
        {
            return explicitScript.Trim().ToLowerInvariant() switch
            {
                "hans" => "Hans",
                "hant" => "Hant",
                "jpan" or "japanese" => "Jpan",
                _ => "Latn"
            };
        }

        string normalized = locale?.Trim().Replace('_', '-').ToLowerInvariant() ?? string.Empty;
        if (normalized.StartsWith("ja", StringComparison.Ordinal))
        {
            return "Jpan";
        }

        if (normalized.StartsWith("zh-hant", StringComparison.Ordinal)
            || normalized.StartsWith("zh-tw", StringComparison.Ordinal)
            || normalized.StartsWith("zh-hk", StringComparison.Ordinal)
            || normalized.StartsWith("zh-mo", StringComparison.Ordinal))
        {
            return "Hant";
        }

        return normalized.StartsWith("zh", StringComparison.Ordinal) ? "Hans" : "Latn";
    }

    private static IReadOnlyList<string> CjkFallback(string script)
        => script switch
        {
            "Hant" => ["Noto Sans TC", "Noto Sans SC", "Noto Sans JP"],
            "Jpan" => ["Noto Sans JP", "Noto Sans SC", "Noto Sans TC"],
            _ => ["Noto Sans SC", "Noto Sans TC", "Noto Sans JP"]
        };

    private static IEnumerable<string> NonCjkFamilies(FontRegistryEntry entry)
        => Families(entry).Where(family => !s_knownCjkFamilies.Contains(family));

    private static IEnumerable<string> Families(FontRegistryEntry entry)
        => entry.BuiltIn
            ? entry.Family.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Select(Unquote)
            : [entry.Family.Trim()];

    private static string Unquote(string value)
    {
        string trimmed = value.Trim();
        return trimmed.Length >= 2
            && ((trimmed[0] == '"' && trimmed[^1] == '"')
                || (trimmed[0] == '\'' && trimmed[^1] == '\''))
            ? trimmed[1..^1]
            : trimmed;
    }

    private static string FormatStack(params IEnumerable<string>[] groups)
    {
        var unique = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var values = new List<string>();
        foreach (IEnumerable<string> group in groups)
        {
            foreach (string raw in group)
            {
                string family = Unquote(raw);
                if (!string.IsNullOrWhiteSpace(family) && unique.Add(family))
                {
                    values.Add(s_genericFamilies.Contains(family) ? family : $"\"{family}\"");
                }
            }
        }

        return string.Join(", ", values);
    }

    private static string CompileCss(
        IReadOnlyDictionary<string, string> stacks,
        IReadOnlyDictionary<string, string> semanticReferences)
    {
        var css = new StringBuilder(":root {\n");
        foreach (string token in FontTokenSchema.Family.All)
        {
            css.Append("  ")
                .Append(CssVariable(token))
                .Append(": ")
                .Append(stacks[token])
                .Append(";\n");
        }

        foreach ((string token, string value) in s_primitiveValues)
        {
            css.Append("  ")
                .Append(CssVariable(token))
                .Append(": ")
                .Append(value)
                .Append(";\n");
        }

        foreach (string token in FontTokenSchema.Typography.All)
        {
            css.Append("  ")
                .Append(CssVariable(token))
                .Append(": ")
                .Append(SemanticTokenValue(token, semanticReferences))
                .Append(";\n");
        }

        return css.Append("}\n").ToString();
    }

    private static string SemanticTokenValue(
        string token,
        IReadOnlyDictionary<string, string> semanticReferences)
        => semanticReferences.TryGetValue(token, out string? familyReference)
            ? $"var({CssVariable(familyReference)})"
            : SemanticPrimitiveReference(token);

    private static string SemanticPrimitiveReference(string token)
        => token switch
        {
            FontTokenSchema.Typography.BodyWeight => "var(--fsus-font-weight-regular)",
            FontTokenSchema.Typography.BodyLineHeight => "var(--fsus-font-line-height-body)",
            FontTokenSchema.Typography.ArticleSize => "var(--fsus-font-size-article)",
            FontTokenSchema.Typography.ArticleLineHeight => "var(--fsus-font-line-height-article)",
            FontTokenSchema.Typography.HeadingWeight => "var(--fsus-font-weight-bold)",
            FontTokenSchema.Typography.CodeSize => "var(--fsus-font-size-code)",
            _ => throw new FontTokenException(
                "font_token_schema_invalid",
                $"Semantic token '{token}' has no primitive reference.")
        };

    private static string CssVariable(string token)
        => token switch
        {
            FontTokenSchema.Family.Ui => "--fsus-font-ui",
            FontTokenSchema.Family.Prose => "--fsus-font-prose",
            FontTokenSchema.Family.Code => "--fsus-font-code",
            FontTokenSchema.Family.Cjk => "--fsus-font-cjk",
            FontTokenSchema.Family.Emoji => "--fsus-font-emoji",
            _ => $"--fsus-{ToKebab(token)}"
        };

    private static string ToKebab(string token)
    {
        var result = new StringBuilder(token.Length + 8);
        foreach (char character in token)
        {
            if (character == '.')
            {
                result.Append('-');
            }
            else if (char.IsUpper(character))
            {
                result.Append('-').Append(char.ToLowerInvariant(character));
            }
            else
            {
                result.Append(character);
            }
        }

        return result.ToString();
    }
}
