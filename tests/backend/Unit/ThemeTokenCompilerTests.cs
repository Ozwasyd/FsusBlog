using FsusBlog.Server.Infrastructure.Themes;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ThemeTokenCompilerTests
{
    [Fact]
    public void Compile_EmitsVersionedScopedModeAndPreferenceVariables()
    {
        var compiler = new ThemeTokenCompiler();

        CompiledThemeTokens compiled = compiler.Compile(
            "fsusblog.theme.minimal-ink",
            TokenDocumentJson());

        Assert.Equal("fsusblog.theme.tokens.v1", compiled.SchemaVersion);
        Assert.Matches("^[0-9a-f]{64}$", compiled.ContentHash);
        Assert.Contains(
            """:root[data-theme="fsusblog.theme.minimal-ink"] {""",
            compiled.Css,
            StringComparison.Ordinal);
        Assert.Contains(
            "--fsus-color-page-bg: #ffffff;",
            compiled.Css,
            StringComparison.Ordinal);
        Assert.Contains(
            """:root[data-theme="fsusblog.theme.minimal-ink"][data-color-scheme="dark"] {""",
            compiled.Css,
            StringComparison.Ordinal);
        Assert.Contains(
            """:root[data-theme="fsusblog.theme.minimal-ink"][data-reduced-motion="true"] {""",
            compiled.Css,
            StringComparison.Ordinal);
        Assert.Contains("--fsus-motion-fast: 0ms;", compiled.Css, StringComparison.Ordinal);
        Assert.Contains(
            """:root[data-theme="fsusblog.theme.minimal-ink"][data-high-contrast="true"] {""",
            compiled.Css,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_RejectsMissingRequiredSemanticToken()
    {
        var compiler = new ThemeTokenCompiler();
        string json = TokenDocumentJson().Replace(
            """
                    "status.error.bg": "{color.red.500}"
            """,
            """
                    "status.error.missing": "{color.red.500}"
            """,
            StringComparison.Ordinal);

        ThemeTokenException exception = Assert.Throws<ThemeTokenException>(
            () => compiler.Compile("fsusblog.theme.minimal-ink", json));

        Assert.Equal("theme_token_required_semantic_missing", exception.ErrorCode);
        Assert.Contains("status.error.bg", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("fsusblog.theme.tokens.v0")]
    [InlineData("fsusblog.theme.tokens.v2")]
    public void Compile_RejectsUnsupportedSchemaVersion(string schemaVersion)
    {
        var compiler = new ThemeTokenCompiler();
        string json = TokenDocumentJson().Replace(
            "fsusblog.theme.tokens.v1",
            schemaVersion,
            StringComparison.Ordinal);

        ThemeTokenException exception = Assert.Throws<ThemeTokenException>(
            () => compiler.Compile("fsusblog.theme.minimal-ink", json));

        Assert.Equal("theme_token_schema_version_unsupported", exception.ErrorCode);
    }

    [Fact]
    public void Compile_RejectsMissingReferencesAndReferenceCycles()
    {
        var compiler = new ThemeTokenCompiler();
        string missingReference = TokenDocumentJson().Replace(
            """"surface.page": "{color.gray.50}"""",
            """"surface.page": "{color.missing.500}"""",
            StringComparison.Ordinal);
        string cycle = TokenDocumentJson()
            .Replace(
                """"color.gray.50": "#ffffff"""",
                """"color.gray.50": "{surface.page}"""",
                StringComparison.Ordinal);

        ThemeTokenException missing = Assert.Throws<ThemeTokenException>(
            () => compiler.Compile("fsusblog.theme.minimal-ink", missingReference));
        ThemeTokenException cyclic = Assert.Throws<ThemeTokenException>(
            () => compiler.Compile("fsusblog.theme.minimal-ink", cycle));

        Assert.Equal("theme_token_reference_missing", missing.ErrorCode);
        Assert.Equal("theme_token_reference_cycle", cyclic.ErrorCode);
    }

    private static string TokenDocumentJson() =>
        """
        {
          "schema": "fsusblog.theme.tokens.v1",
          "defaultMode": "light",
          "modes": {
            "light": {
              "primitive": {
                "color.gray.50": "#ffffff",
                "color.gray.100": "#f8fafc",
                "color.blue.500": "#2563eb",
                "color.red.500": "#dc2626",
                "radius.md": "0.75rem",
                "motion.fast": "120ms",
                "motion.panel": "180ms"
              },
              "semantic": {
                "surface.page": "{color.gray.50}",
                "surface.panel": "{color.gray.100}",
                "surface.elevated": "{color.gray.50}",
                "surface.overlay": "rgb(15 23 42 / 68%)",
                "text.primary": "#111827",
                "text.secondary": "#334155",
                "text.muted": "#64748b",
                "text.inverse": "#ffffff",
                "border.default": "#cbd5e1",
                "border.subtle": "#e2e8f0",
                "action.primary.bg": "{color.blue.500}",
                "action.primary.text": "#ffffff",
                "status.success.bg": "#15803d",
                "status.warning.bg": "#a16207",
                "status.error.bg": "{color.red.500}"
              },
              "component": {
                "button.primary.bg": "{action.primary.bg}",
                "card.bg": "{surface.panel}",
                "article.prose.text": "{text.primary}"
              },
              "context": {
                "public.home.hero.bg": "{surface.elevated}",
                "admin.sidebar.bg": "{surface.panel}",
                "console.panel.bg": "{surface.panel}"
              }
            },
            "dark": {
              "primitive": {
                "color.gray.50": "#0f172a",
                "color.gray.100": "#111827",
                "color.blue.500": "#60a5fa",
                "color.red.500": "#f87171",
                "radius.md": "0.75rem",
                "motion.fast": "120ms",
                "motion.panel": "180ms"
              },
              "semantic": {
                "surface.page": "{color.gray.50}",
                "surface.panel": "{color.gray.100}",
                "surface.elevated": "#1e293b",
                "surface.overlay": "rgb(2 6 23 / 76%)",
                "text.primary": "#f8fafc",
                "text.secondary": "#cbd5e1",
                "text.muted": "#94a3b8",
                "text.inverse": "#0f172a",
                "border.default": "#475569",
                "border.subtle": "#334155",
                "action.primary.bg": "{color.blue.500}",
                "action.primary.text": "#0f172a",
                "status.success.bg": "#22c55e",
                "status.warning.bg": "#eab308",
                "status.error.bg": "{color.red.500}"
              },
              "component": {
                "button.primary.bg": "{action.primary.bg}",
                "card.bg": "{surface.panel}",
                "article.prose.text": "{text.primary}"
              },
              "context": {
                "public.home.hero.bg": "{surface.elevated}",
                "admin.sidebar.bg": "{surface.panel}",
                "console.panel.bg": "{surface.panel}"
              }
            }
          },
          "variants": {
            "reducedMotion": {
              "primitive": {
                "motion.fast": "0ms",
                "motion.panel": "0ms"
              }
            },
            "highContrast": {
              "semantic": {
                "border.default": "CanvasText",
                "border.subtle": "CanvasText",
                "text.primary": "CanvasText",
                "surface.page": "Canvas"
              }
            }
          }
        }
        """;
}
