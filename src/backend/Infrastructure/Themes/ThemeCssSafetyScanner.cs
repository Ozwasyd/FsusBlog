using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Infrastructure.Themes;

public sealed partial class ThemeCssSafetyScanner
{
    public const string EvidenceSchema = "fsusblog.theme.css-safety.v1";
    public const long MaximumCssBytes = 64 * 1024;
    public const long MaximumAssetBytes = 512 * 1024;
    public const long MaximumPreviewBytes = 256 * 1024;
    public const int MaximumSelectorCount = 512;
    public const int MaximumSelectorDepth = 4;
    public const int MaximumImportantCount = 8;
    public const int MaximumMotionDurationMs = 1_000;

    private static readonly string[] s_allowedScopeSuffixes =
    [
        ".fsus-theme-scope",
        ".fsus-prose",
        ".fsus-code-block"
    ];

    public ThemeCssSafetyEvidence Scan(
        ThemeManifest manifest,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> entries)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(entries);

        var violations = new List<ThemeCssSafetyViolation>();
        var warnings = new List<string>();
        string[] cssPaths =
        [
            manifest.Entry.Tokens,
            manifest.Entry.Theme,
            .. OptionalPaths(manifest.Entry.Prose, manifest.Entry.Code)
        ];
        cssPaths = [.. cssPaths.Distinct(StringComparer.Ordinal)];
        long cssBytes = 0;
        int selectorCount = 0;
        int maxSelectorDepth = 0;
        int importantCount = 0;
        int maxMotionDurationMs = 0;

        foreach (string path in cssPaths)
        {
            if (!entries.TryGetValue(path, out ReadOnlyMemory<byte> bytes))
            {
                Add(violations, "css_entry_missing", path, "Declared CSS entry is missing.");
                continue;
            }

            cssBytes += bytes.Length;
            string css;
            try
            {
                css = new UTF8Encoding(false, true).GetString(bytes.Span);
            }
            catch (DecoderFallbackException)
            {
                Add(violations, "css_encoding_invalid", path, "CSS must be valid UTF-8.");
                continue;
            }

            ScanCss(
                manifest,
                path,
                css,
                entries,
                violations,
                ref selectorCount,
                ref maxSelectorDepth,
                ref importantCount,
                ref maxMotionDurationMs);
        }

        long assetBytes = manifest.Assets.Values
            .Distinct(StringComparer.Ordinal)
            .Where(entries.ContainsKey)
            .Sum(path => (long)entries[path].Length);
        long previewBytes = manifest.Assets.TryGetValue("preview", out string? previewPath)
            && entries.TryGetValue(previewPath, out ReadOnlyMemory<byte> preview)
                ? preview.Length
                : 0;

        CheckBudget(violations, "css_bytes_exceeded", cssBytes, manifest.Budgets.CssBytes, MaximumCssBytes);
        CheckBudget(violations, "asset_bytes_exceeded", assetBytes, manifest.Budgets.AssetBytes, MaximumAssetBytes);
        CheckBudget(violations, "preview_bytes_exceeded", previewBytes, manifest.Budgets.PreviewBytes, MaximumPreviewBytes);
        CheckBudget(
            violations,
            "selector_count_exceeded",
            selectorCount,
            manifest.Budgets.MaxSelectors,
            MaximumSelectorCount);
        CheckBudget(
            violations,
            "selector_depth_exceeded",
            maxSelectorDepth,
            manifest.Budgets.MaxSelectorDepth,
            MaximumSelectorDepth);
        CheckBudget(
            violations,
            "important_count_exceeded",
            importantCount,
            manifest.Budgets.MaxImportant,
            MaximumImportantCount,
            allowZeroDeclared: true);
        CheckBudget(
            violations,
            "motion_duration_exceeded",
            maxMotionDurationMs,
            manifest.Budgets.MaxMotionDurationMs,
            MaximumMotionDurationMs);

        ThemeCssSafetyViolation[] orderedViolations =
        [
            .. violations
                .Distinct()
                .OrderBy(static item => item.Path, StringComparer.Ordinal)
                .ThenBy(static item => item.Code, StringComparer.Ordinal)
                .ThenBy(static item => item.Detail, StringComparer.Ordinal)
        ];
        return new ThemeCssSafetyEvidence(
            EvidenceSchema,
            manifest.Id,
            orderedViolations.Length == 0 ? "ok" : "blocked",
            cssBytes,
            assetBytes,
            previewBytes,
            selectorCount,
            maxSelectorDepth,
            importantCount,
            maxMotionDurationMs,
            Array.AsReadOnly(orderedViolations),
            Array.AsReadOnly(warnings.ToArray()));
    }

    private static void ScanCss(
        ThemeManifest manifest,
        string path,
        string rawCss,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> entries,
        List<ThemeCssSafetyViolation> violations,
        ref int selectorCount,
        ref int maxSelectorDepth,
        ref int importantCount,
        ref int maxMotionDurationMs)
    {
        string css = CssCommentExpression().Replace(rawCss, string.Empty);
        if (!HasBalancedCss(css))
        {
            Add(
                violations,
                "css_syntax_unbalanced",
                path,
                "CSS braces, parentheses, brackets or strings are unbalanced.");
            return;
        }
        if (ImportExpression().IsMatch(css))
        {
            Add(violations, "remote_import_denied", path, "@import is not allowed.");
        }
        foreach (Match atRule in UnsupportedAtRuleExpression().Matches(css))
        {
            Add(
                violations,
                "at_rule_denied",
                path,
                $"At-rule '{atRule.Value}' is outside the supported CSS subset.");
        }

        foreach (Match match in UrlExpression().Matches(css))
        {
            string rawUrl = match.Groups["url"].Value.Trim().Trim('\'', '"');
            bool safeRelativeUrl = IsSafeRelativeUrl(rawUrl);
            string resolved = safeRelativeUrl ? ResolveAssetPath(path, rawUrl) : string.Empty;
            bool declaredAsset = safeRelativeUrl
                && manifest.Assets.Values.Contains(resolved, StringComparer.Ordinal);
            if (!safeRelativeUrl || !declaredAsset || !entries.ContainsKey(resolved))
            {
                Add(
                    violations,
                    "resource_url_denied",
                    path,
                    $"Resource URL '{rawUrl}' is not a declared package asset.");
            }
        }

        MatchCollection ruleBlocks = RuleBlockExpression().Matches(css);
        if (!string.IsNullOrWhiteSpace(css) && ruleBlocks.Count == 0)
        {
            Add(
                violations,
                "css_syntax_unrecognized",
                path,
                "CSS contains no recognizable declaration block.");
        }
        foreach (Match block in ruleBlocks)
        {
            string selectorText = block.Groups["selector"].Value.Trim();
            if (selectorText.Length == 0 || selectorText.StartsWith('@'))
            {
                continue;
            }

            foreach (string selector in selectorText.Split(','))
            {
                string candidate = selector.Trim();
                selectorCount++;
                int depth = SelectorDepth(candidate);
                maxSelectorDepth = Math.Max(maxSelectorDepth, depth);
                if (!HasAllowedScope(candidate, manifest.Id))
                {
                    Add(
                        violations,
                        "selector_scope_denied",
                        path,
                        $"Selector '{candidate}' is outside a stable theme scope.");
                }
                if (ElementPlusSelectorExpression().IsMatch(candidate))
                {
                    Add(
                        violations,
                        "element_plus_internal_selector_denied",
                        path,
                        $"Selector '{candidate}' targets Element Plus internals.");
                }
                if (BareElementSelectorExpression().IsMatch(RemoveAllowedScopePrefix(candidate, manifest.Id)))
                {
                    Add(
                        violations,
                        "bare_element_selector_denied",
                        path,
                        $"Selector '{candidate}' contains a bare element or universal selector.");
                }
            }

            string declarations = block.Groups["body"].Value;
            importantCount += ImportantExpression().Matches(declarations).Count;
            ScanDeclarations(
                path,
                declarations,
                violations,
                ref maxMotionDurationMs);
        }
    }

    private static void ScanDeclarations(
        string path,
        string declarations,
        List<ThemeCssSafetyViolation> violations,
        ref int maxMotionDurationMs)
    {
        var properties = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match declaration in DeclarationExpression().Matches(declarations))
        {
            string property = declaration.Groups["property"].Value.Trim();
            string value = declaration.Groups["value"].Value.Trim();
            properties[property] = value;

            if (property.Equals("z-index", StringComparison.OrdinalIgnoreCase)
                && int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int zIndex)
                && Math.Abs(zIndex) > 100)
            {
                Add(violations, "z_index_budget_exceeded", path, $"z-index '{value}' exceeds the token budget.");
            }

            if (property is "filter" or "backdrop-filter"
                && BlurExpression().Matches(value).Cast<Match>().Any(static match =>
                    double.TryParse(
                        match.Groups["pixels"].Value,
                        NumberStyles.AllowDecimalPoint,
                        CultureInfo.InvariantCulture,
                        out double pixels)
                    && pixels > 16))
            {
                Add(violations, "filter_budget_exceeded", path, $"{property} blur exceeds 16px.");
            }

            if (property.StartsWith("animation", StringComparison.OrdinalIgnoreCase))
            {
                if (InfiniteExpression().IsMatch(value))
                {
                    Add(violations, "unbounded_animation_denied", path, "Infinite animation is not allowed.");
                }
                maxMotionDurationMs = Math.Max(maxMotionDurationMs, MaximumDurationMs(value));
            }

            if (property.StartsWith("transition", StringComparison.OrdinalIgnoreCase))
            {
                if (LayoutTransitionExpression().IsMatch(value))
                {
                    Add(
                        violations,
                        "layout_transition_denied",
                        path,
                        "Transitions cannot target all, top, left, width, or height.");
                }
                maxMotionDurationMs = Math.Max(maxMotionDurationMs, MaximumDurationMs(value));
            }
        }

        bool fixedPosition = properties.TryGetValue("position", out string? position)
            && position.Equals("fixed", StringComparison.OrdinalIgnoreCase);
        bool fullInset = properties.TryGetValue("inset", out string? inset)
            && ZeroLengthExpression().IsMatch(inset);
        bool fourEdges = new[] { "top", "right", "bottom", "left" }.All(
            property => properties.TryGetValue(property, out string? value)
                && ZeroLengthExpression().IsMatch(value));
        bool fullViewport = properties.Any(pair =>
            pair.Key is "width" or "height"
            && ViewportSizeExpression().IsMatch(pair.Value));
        if (fixedPosition && (fullInset || fourEdges || fullViewport))
        {
            Add(
                violations,
                "full_viewport_fixed_overlay_denied",
                path,
                "Full-viewport fixed overlays are not allowed.");
        }
    }

    private static bool HasAllowedScope(string selector, string themeId)
    {
        string escapedId = Regex.Escape(themeId);
        string root = $@"^:root\[data-theme=(?:\""|')?{escapedId}(?:\""|')?\](?:\[[^\]]+\])*(?::[a-z-]+(?:\([^)]*\))?)*$";
        if (Regex.IsMatch(selector, root, RegexOptions.CultureInvariant))
        {
            return true;
        }

        string prefix = $@"^\[data-theme=(?:\""|')?{escapedId}(?:\""|')?\]\s+";
        return s_allowedScopeSuffixes.Any(suffix =>
            Regex.IsMatch(
                selector,
                prefix + Regex.Escape(suffix) + @"(?:$|[\s>+~.:#\[])",
                RegexOptions.CultureInvariant));
    }

    private static string RemoveAllowedScopePrefix(string selector, string themeId)
    {
        string escapedId = Regex.Escape(themeId);
        string withoutRoot = Regex.Replace(
            selector,
            $@"^:root\[data-theme=(?:\""|')?{escapedId}(?:\""|')?\](?:\[[^\]]+\])*\s*",
            string.Empty,
            RegexOptions.CultureInvariant);
        return Regex.Replace(
            withoutRoot,
            $@"^\[data-theme=(?:\""|')?{escapedId}(?:\""|')?\]\s+(?:\.fsus-theme-scope|\.fsus-prose|\.fsus-code-block)\s*",
            string.Empty,
            RegexOptions.CultureInvariant);
    }

    private static int SelectorDepth(string selector)
    {
        string normalized = AttributeExpression().Replace(selector, "[attribute]");
        string[] parts = CombinatorExpression().Split(normalized.Trim())
            .Where(static part => !string.IsNullOrWhiteSpace(part))
            .ToArray();
        return Math.Max(1, parts.Length);
    }

    private static string ResolveAssetPath(string cssPath, string rawUrl)
    {
        string? directory = Path.GetDirectoryName(cssPath.Replace('/', Path.DirectorySeparatorChar));
        string combined = Path.GetFullPath(
            Path.Combine("/", directory ?? string.Empty, rawUrl.Replace('/', Path.DirectorySeparatorChar)));
        return combined.TrimStart(Path.DirectorySeparatorChar).Replace(Path.DirectorySeparatorChar, '/');
    }

    private static bool IsSafeRelativeUrl(string url)
        => !string.IsNullOrWhiteSpace(url)
            && !url.StartsWith("/", StringComparison.Ordinal)
            && !url.StartsWith("//", StringComparison.Ordinal)
            && !url.Contains('\\', StringComparison.Ordinal)
            && !url.Contains('#', StringComparison.Ordinal)
            && !url.Contains('?', StringComparison.Ordinal)
            && !Uri.TryCreate(url, UriKind.Absolute, out _);

    private static int MaximumDurationMs(string value)
    {
        int maximum = 0;
        foreach (Match match in DurationExpression().Matches(value))
        {
            if (!double.TryParse(
                match.Groups["value"].Value,
                NumberStyles.AllowDecimalPoint,
                CultureInfo.InvariantCulture,
                out double parsed))
            {
                continue;
            }

            double milliseconds = match.Groups["unit"].Value.Equals("s", StringComparison.OrdinalIgnoreCase)
                ? parsed * 1_000
                : parsed;
            maximum = Math.Max(maximum, (int)Math.Ceiling(milliseconds));
        }
        return maximum;
    }

    private static bool HasBalancedCss(string css)
    {
        var expectedClosers = new Stack<char>();
        char quote = '\0';
        bool escaped = false;
        foreach (char character in css)
        {
            if (quote != '\0')
            {
                if (escaped)
                {
                    escaped = false;
                }
                else if (character == '\\')
                {
                    escaped = true;
                }
                else if (character == quote)
                {
                    quote = '\0';
                }
                continue;
            }

            if (character is '\'' or '"')
            {
                quote = character;
                continue;
            }

            char closer = character switch
            {
                '{' => '}',
                '(' => ')',
                '[' => ']',
                _ => '\0'
            };
            if (closer != '\0')
            {
                expectedClosers.Push(closer);
                continue;
            }

            if ((character is '}' or ')' or ']')
                && (expectedClosers.Count == 0 || expectedClosers.Pop() != character))
            {
                return false;
            }
        }

        return quote == '\0' && expectedClosers.Count == 0;
    }

    private static void CheckBudget(
        List<ThemeCssSafetyViolation> violations,
        string code,
        long actual,
        long declared,
        long platformMaximum,
        bool allowZeroDeclared = false)
    {
        if (declared < (allowZeroDeclared ? 0 : 1)
            || declared > platformMaximum
            || actual > declared
            || actual > platformMaximum)
        {
            Add(
                violations,
                code,
                "manifest.json",
                $"Actual {actual}, declared {declared}, platform maximum {platformMaximum}.");
        }
    }

    private static void Add(
        List<ThemeCssSafetyViolation> violations,
        string code,
        string path,
        string detail)
        => violations.Add(new ThemeCssSafetyViolation(code, path, detail));

    private static IEnumerable<string> OptionalPaths(params string?[] paths)
        => paths.Where(static path => !string.IsNullOrWhiteSpace(path)).Select(static path => path!);

    [GeneratedRegex(@"/\*.*?\*/", RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex CssCommentExpression();

    [GeneratedRegex(@"@import\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ImportExpression();

    [GeneratedRegex(@"@(?!media\b|supports\b|layer\b)[a-z-]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UnsupportedAtRuleExpression();

    [GeneratedRegex(@"url\(\s*(?<url>[^)]*?)\s*\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex UrlExpression();

    [GeneratedRegex(@"(?<selector>[^{}]+)\{(?<body>[^{}]*)\}", RegexOptions.CultureInvariant)]
    private static partial Regex RuleBlockExpression();

    [GeneratedRegex(@"(?<property>--?[\w-]+|[a-zA-Z][\w-]*)\s*:\s*(?<value>[^;{}]+)", RegexOptions.CultureInvariant)]
    private static partial Regex DeclarationExpression();

    [GeneratedRegex(@"!important\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ImportantExpression();

    [GeneratedRegex(@"(?:^|[\s>+~,(])(?:div|span|body|html|\*)(?=$|[\s>+~.#:[,(])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BareElementSelectorExpression();

    [GeneratedRegex(@"\.el-[a-z0-9_-]+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ElementPlusSelectorExpression();

    [GeneratedRegex(@"blur\(\s*(?<pixels>\d+(?:\.\d+)?)px\s*\)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex BlurExpression();

    [GeneratedRegex(@"\binfinite\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex InfiniteExpression();

    [GeneratedRegex(@"(?:^|[,\s])(?:all|top|left|width|height)(?:$|[,\s])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LayoutTransitionExpression();

    [GeneratedRegex(@"^(?:0|0px)(?:\s+(?:0|0px)){0,3}$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ZeroLengthExpression();

    [GeneratedRegex(@"\b100(?:d|s|l)?v[wh]\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ViewportSizeExpression();

    [GeneratedRegex(@"(?<value>\d+(?:\.\d+)?)\s*(?<unit>ms|s)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DurationExpression();

    [GeneratedRegex(@"\[[^\]]*\]", RegexOptions.CultureInvariant)]
    private static partial Regex AttributeExpression();

    [GeneratedRegex(@"\s*(?:[>+~]|\s)\s*", RegexOptions.CultureInvariant)]
    private static partial Regex CombinatorExpression();
}
