using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.Themes;

public sealed partial class ThemeTokenCompiler
{
    public const string CurrentSchemaVersion = "fsusblog.theme.tokens.v1";

    private static readonly string[] s_requiredSemanticTokens =
    [
        "surface.page",
        "surface.panel",
        "surface.elevated",
        "surface.overlay",
        "text.primary",
        "text.secondary",
        "text.muted",
        "text.inverse",
        "border.default",
        "border.subtle",
        "action.primary.bg",
        "action.primary.text",
        "status.success.bg",
        "status.warning.bg",
        "status.error.bg"
    ];

    private static readonly IReadOnlyDictionary<string, string> s_semanticVariables =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["surface.page"] = "--fsus-color-page-bg",
            ["surface.panel"] = "--fsus-color-panel-bg",
            ["surface.elevated"] = "--fsus-color-elevated-bg",
            ["surface.overlay"] = "--fsus-color-overlay-bg",
            ["text.primary"] = "--fsus-color-text-primary",
            ["text.secondary"] = "--fsus-color-text-secondary",
            ["text.muted"] = "--fsus-color-text-muted",
            ["text.inverse"] = "--fsus-color-text-inverse",
            ["border.default"] = "--fsus-color-border-default",
            ["border.subtle"] = "--fsus-color-border-subtle",
            ["action.primary.bg"] = "--fsus-color-action-primary-bg",
            ["action.primary.text"] = "--fsus-color-action-primary-text",
            ["status.success.bg"] = "--fsus-color-status-success-bg",
            ["status.warning.bg"] = "--fsus-color-status-warning-bg",
            ["status.error.bg"] = "--fsus-color-status-error-bg"
        };

    public CompiledThemeTokens Compile(string themeId, string tokenJson)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(themeId);
        if (!ThemeIdExpression().IsMatch(themeId))
        {
            throw new ThemeTokenException(
                "theme_token_theme_id_invalid",
                "Theme token scope must use the 'fsusblog.theme.<name>' namespace.");
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(tokenJson);
        try
        {
            using JsonDocument document = JsonDocument.Parse(tokenJson, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16
            });
            ParsedTokenDocument parsed = ParseDocument(document.RootElement);
            string css = EmitCss(themeId, parsed);
            string contentHash = Convert.ToHexStringLower(
                SHA256.HashData(Encoding.UTF8.GetBytes(css)));
            return new CompiledThemeTokens(
                CurrentSchemaVersion,
                parsed.DefaultMode,
                css,
                contentHash);
        }
        catch (ThemeTokenException)
        {
            throw;
        }
        catch (JsonException exception)
        {
            throw new ThemeTokenException(
                "theme_token_document_invalid",
                "Theme token document is invalid JSON.",
                exception);
        }
    }

    private static ParsedTokenDocument ParseDocument(JsonElement root)
    {
        RequireObject(root, "Theme token document root must be an object.");
        EnsureProperties(root, ["schema", "defaultMode", "modes", "variants"]);
        string schema = RequiredString(root, "schema");
        if (!string.Equals(schema, CurrentSchemaVersion, StringComparison.Ordinal))
        {
            throw new ThemeTokenException(
                "theme_token_schema_version_unsupported",
                $"Theme token schema '{schema}' is not supported.");
        }

        string defaultMode = RequiredString(root, "defaultMode");
        if (defaultMode is not ("light" or "dark"))
        {
            throw new ThemeTokenException(
                "theme_token_default_mode_invalid",
                "Theme token defaultMode must be light or dark.");
        }

        JsonElement modesElement = RequiredObject(root, "modes");
        EnsureProperties(modesElement, ["light", "dark"]);
        var modes = new Dictionary<string, TokenSet>(StringComparer.Ordinal);
        foreach (string mode in new[] { "light", "dark" })
        {
            if (!modesElement.TryGetProperty(mode, out JsonElement modeElement))
            {
                throw new ThemeTokenException(
                    "theme_token_mode_missing",
                    $"Theme token mode '{mode}' is required.");
            }

            TokenSet tokenSet = ParseTokenSet(modeElement, allowPartialLayers: false);
            ValidateRequiredSemantics(tokenSet, mode);
            modes.Add(mode, tokenSet);
        }

        JsonElement variantsElement = RequiredObject(root, "variants");
        EnsureProperties(variantsElement, ["reducedMotion", "highContrast"]);
        TokenSet reducedMotion = ParseRequiredVariant(variantsElement, "reducedMotion");
        TokenSet highContrast = ParseRequiredVariant(variantsElement, "highContrast");
        RequireVariantTokens(
            reducedMotion,
            "reducedMotion",
            ("primitive", "motion.fast"),
            ("primitive", "motion.panel"));
        RequireVariantTokens(
            highContrast,
            "highContrast",
            ("semantic", "surface.page"),
            ("semantic", "text.primary"),
            ("semantic", "border.default"),
            ("semantic", "border.subtle"));

        return new ParsedTokenDocument(defaultMode, modes, reducedMotion, highContrast);
    }

    private static TokenSet ParseRequiredVariant(JsonElement variants, string name)
    {
        if (!variants.TryGetProperty(name, out JsonElement variant))
        {
            throw new ThemeTokenException(
                "theme_token_variant_missing",
                $"Theme token variant '{name}' is required.");
        }

        return ParseTokenSet(variant, allowPartialLayers: true);
    }

    private static TokenSet ParseTokenSet(JsonElement element, bool allowPartialLayers)
    {
        RequireObject(element, "Theme token mode or variant must be an object.");
        EnsureProperties(element, ["primitive", "semantic", "component", "context"]);
        return new TokenSet(
            ParseLayer(element, "primitive", allowPartialLayers),
            ParseLayer(element, "semantic", allowPartialLayers),
            ParseLayer(element, "component", allowPartialLayers),
            ParseLayer(element, "context", allowPartialLayers));
    }

    private static IReadOnlyDictionary<string, string> ParseLayer(
        JsonElement tokenSet,
        string layer,
        bool optional)
    {
        if (!tokenSet.TryGetProperty(layer, out JsonElement layerElement))
        {
            if (optional)
            {
                return new Dictionary<string, string>(StringComparer.Ordinal);
            }

            throw new ThemeTokenException(
                "theme_token_layer_missing",
                $"Theme token layer '{layer}' is required.");
        }

        RequireObject(layerElement, $"Theme token layer '{layer}' must be an object.");
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (JsonProperty property in layerElement.EnumerateObject())
        {
            if (!TokenNameExpression().IsMatch(property.Name)
                || property.Value.ValueKind != JsonValueKind.String)
            {
                throw new ThemeTokenException(
                    "theme_token_entry_invalid",
                    $"Theme token '{layer}.{property.Name}' has an invalid name or value.");
            }

            string value = property.Value.GetString()!;
            if (string.IsNullOrWhiteSpace(value)
                || value.Length > 256
                || value.IndexOfAny([';', '{', '}']) >= 0
                    && !TokenReferenceExpression().IsMatch(value))
            {
                throw new ThemeTokenException(
                    "theme_token_value_invalid",
                    $"Theme token '{property.Name}' has an unsafe or invalid value.");
            }

            values.Add(property.Name, value);
        }

        if (!optional && values.Count == 0)
        {
            throw new ThemeTokenException(
                "theme_token_layer_empty",
                $"Theme token layer '{layer}' cannot be empty.");
        }

        return values;
    }

    private static void ValidateRequiredSemantics(TokenSet tokenSet, string mode)
    {
        foreach (string token in s_requiredSemanticTokens)
        {
            if (!tokenSet.Semantic.ContainsKey(token))
            {
                throw new ThemeTokenException(
                    "theme_token_required_semantic_missing",
                    $"Theme token mode '{mode}' is missing required semantic token '{token}'.");
            }
        }
    }

    private static void RequireVariantTokens(
        TokenSet tokenSet,
        string variant,
        params (string Layer, string Token)[] requirements)
    {
        foreach ((string layer, string token) in requirements)
        {
            IReadOnlyDictionary<string, string> values = tokenSet.Layer(layer);
            if (!values.ContainsKey(token))
            {
                throw new ThemeTokenException(
                    "theme_token_variant_entry_missing",
                    $"Theme token variant '{variant}' is missing '{layer}.{token}'.");
            }
        }
    }

    private static string EmitCss(string themeId, ParsedTokenDocument document)
    {
        var css = new StringBuilder();
        css.Append("/* ")
            .Append(CurrentSchemaVersion)
            .AppendLine(" - generated; do not edit */");
        EmitTokenSet(css, $""":root[data-theme="{themeId}"]""", document.Modes[document.DefaultMode]);

        string alternateMode = document.DefaultMode == "light" ? "dark" : "light";
        EmitTokenSet(
            css,
            $""":root[data-theme="{themeId}"][data-color-scheme="{alternateMode}"]""",
            document.Modes[alternateMode]);
        EmitTokenSet(
            css,
            $""":root[data-theme="{themeId}"][data-reduced-motion="true"]""",
            document.ReducedMotion);
        EmitTokenSet(
            css,
            $""":root[data-theme="{themeId}"][data-high-contrast="true"]""",
            document.HighContrast);
        return css.ToString();
    }

    private static void EmitTokenSet(StringBuilder css, string selector, TokenSet tokenSet)
    {
        IReadOnlyDictionary<string, string> resolved = ResolveValues(tokenSet);
        css.Append(selector).AppendLine(" {");
        foreach ((string variable, string value) in tokenSet.All()
                     .Select(entry => (VariableName(entry.Layer, entry.Name), resolved[entry.Name]))
                     .OrderBy(static entry => entry.Item1, StringComparer.Ordinal))
        {
            css.Append("  ").Append(variable).Append(": ").Append(value).AppendLine(";");
        }

        css.AppendLine("}");
    }

    private static IReadOnlyDictionary<string, string> ResolveValues(TokenSet tokenSet)
    {
        var raw = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach ((_, string name, string value) in tokenSet.All())
        {
            if (!raw.TryAdd(name, value))
            {
                throw new ThemeTokenException(
                    "theme_token_name_duplicate",
                    $"Theme token '{name}' is declared in more than one layer.");
            }
        }

        var resolved = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string name in raw.Keys)
        {
            Resolve(name, raw, resolved, new HashSet<string>(StringComparer.Ordinal));
        }

        return resolved;
    }

    private static string Resolve(
        string name,
        IReadOnlyDictionary<string, string> raw,
        IDictionary<string, string> resolved,
        ISet<string> resolving)
    {
        if (resolved.TryGetValue(name, out string? value))
        {
            return value;
        }

        if (!raw.TryGetValue(name, out string? rawValue))
        {
            throw new ThemeTokenException(
                "theme_token_reference_missing",
                $"Theme token reference '{name}' does not exist in this mode or variant.");
        }

        if (!resolving.Add(name))
        {
            throw new ThemeTokenException(
                "theme_token_reference_cycle",
                $"Theme token reference cycle includes '{name}'.");
        }

        Match reference = TokenReferenceExpression().Match(rawValue);
        value = reference.Success
            ? Resolve(reference.Groups["name"].Value, raw, resolved, resolving)
            : rawValue;
        resolving.Remove(name);
        resolved[name] = value;
        return value;
    }

    private static string VariableName(string layer, string token)
    {
        if (layer == "semantic" && s_semanticVariables.TryGetValue(token, out string? semantic))
        {
            return semantic;
        }

        if (layer == "primitive")
        {
            if (token.StartsWith("motion.", StringComparison.Ordinal)
                || token.StartsWith("radius.", StringComparison.Ordinal)
                || token.StartsWith("space.", StringComparison.Ordinal)
                || token.StartsWith("shadow.", StringComparison.Ordinal))
            {
                return $"--fsus-{Kebab(token)}";
            }

            return $"--fsus-primitive-{Kebab(token)}";
        }

        return $"--fsus-{Kebab(token)}";
    }

    private static string Kebab(string token)
        => CamelBoundaryExpression()
            .Replace(token.Replace('.', '-'), "-$1")
            .ToLowerInvariant();

    private static void RequireObject(JsonElement element, string message)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            throw new ThemeTokenException("theme_token_document_invalid", message);
        }
    }

    private static JsonElement RequiredObject(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out JsonElement value)
            || value.ValueKind != JsonValueKind.Object)
        {
            throw new ThemeTokenException(
                "theme_token_document_invalid",
                $"Theme token property '{property}' must be an object.");
        }

        return value;
    }

    private static string RequiredString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out JsonElement value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new ThemeTokenException(
                "theme_token_document_invalid",
                $"Theme token property '{property}' must be a non-empty string.");
        }

        return value.GetString()!;
    }

    private static void EnsureProperties(JsonElement element, IReadOnlyCollection<string> allowed)
    {
        foreach (JsonProperty property in element.EnumerateObject())
        {
            if (!allowed.Contains(property.Name, StringComparer.Ordinal))
            {
                throw new ThemeTokenException(
                    "theme_token_property_unknown",
                    $"Theme token property '{property.Name}' is not allowed.");
            }
        }
    }

    private sealed record ParsedTokenDocument(
        string DefaultMode,
        IReadOnlyDictionary<string, TokenSet> Modes,
        TokenSet ReducedMotion,
        TokenSet HighContrast);

    private sealed record TokenSet(
        IReadOnlyDictionary<string, string> Primitive,
        IReadOnlyDictionary<string, string> Semantic,
        IReadOnlyDictionary<string, string> Component,
        IReadOnlyDictionary<string, string> Context)
    {
        public IEnumerable<(string Layer, string Name, string Value)> All()
        {
            foreach ((string layer, IReadOnlyDictionary<string, string> values) in new[]
                     {
                         ("primitive", Primitive),
                         ("semantic", Semantic),
                         ("component", Component),
                         ("context", Context)
                     })
            {
                foreach ((string name, string value) in values)
                {
                    yield return (layer, name, value);
                }
            }
        }

        public IReadOnlyDictionary<string, string> Layer(string layer)
            => layer switch
            {
                "primitive" => Primitive,
                "semantic" => Semantic,
                "component" => Component,
                "context" => Context,
                _ => throw new InvalidOperationException($"Unknown token layer '{layer}'.")
            };
    }

    [GeneratedRegex(@"^fsusblog\.theme\.[a-z0-9](?:[a-z0-9.-]{0,94}[a-z0-9])?$", RegexOptions.CultureInvariant)]
    private static partial Regex ThemeIdExpression();

    [GeneratedRegex(@"^[a-z][A-Za-z0-9]*(?:\.[a-z0-9][A-Za-z0-9]*)+$", RegexOptions.CultureInvariant)]
    private static partial Regex TokenNameExpression();

    [GeneratedRegex(@"^\{(?<name>[a-z][A-Za-z0-9]*(?:\.[a-z0-9][A-Za-z0-9]*)+)\}$", RegexOptions.CultureInvariant)]
    private static partial Regex TokenReferenceExpression();

    [GeneratedRegex(@"([A-Z])", RegexOptions.CultureInvariant)]
    private static partial Regex CamelBoundaryExpression();
}
