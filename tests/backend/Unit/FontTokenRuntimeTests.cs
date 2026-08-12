using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Shared.Contracts.Fonts;

namespace FsusBlog.Server.Tests;

public sealed class FontTokenRuntimeTests
{
    [Fact]
    public void Schema_DefinesVersionedFamilyAndSemanticTokens()
    {
        Assert.Equal("1.0.0", FontTokenSchema.Version);
        Assert.Equal(
            [
                "font.family.ui",
                "font.family.prose",
                "font.family.code",
                "font.family.cjk",
                "font.family.emoji"
            ],
            FontTokenSchema.Family.All);
        Assert.Contains("font.weight.regular", FontTokenSchema.All);
        Assert.Contains("font.size.article", FontTokenSchema.All);
        Assert.Contains("font.lineHeight.code", FontTokenSchema.All);
        Assert.Contains("font.letterSpacing.prose", FontTokenSchema.All);
        Assert.Contains("typography.admin.table.family", FontTokenSchema.All);
    }

    [Theory]
    [InlineData("en-US", null, "Google Sans", "Noto Sans SC")]
    [InlineData("zh-CN", null, "Noto Sans SC", "Noto Sans TC")]
    [InlineData("zh-Hant", null, "Noto Sans TC", "Noto Sans SC")]
    [InlineData("ja-JP", null, "Noto Sans JP", "Noto Sans SC")]
    [InlineData("en-US", "Hant", "Noto Sans TC", "Noto Sans SC")]
    public async Task ResolveAsync_OrdersLocaleAndScriptFallbacks(
        string locale,
        string? script,
        string expectedFirst,
        string expectedSecond)
    {
        var runtime = new FontStackRuntime(new SnapshotFontRegistry(DefaultSnapshot()));

        FontTokenResolution resolution = await runtime.ResolveAsync(
            new FontStackResolutionRequest(FontActivation.DefaultScope, locale, script));

        string ui = resolution.FamilyStacks[FontTokenSchema.Family.Ui];
        Assert.True(
            ui.IndexOf(expectedFirst, StringComparison.Ordinal)
            < ui.IndexOf(expectedSecond, StringComparison.Ordinal));
        Assert.Contains("system-ui", ui, StringComparison.Ordinal);
        Assert.Contains("ui-monospace", resolution.FamilyStacks[FontTokenSchema.Family.Code], StringComparison.Ordinal);
        Assert.Contains("Apple Color Emoji", resolution.FamilyStacks[FontTokenSchema.Family.Emoji], StringComparison.Ordinal);
    }

    [Fact]
    public async Task ResolveAsync_CompilesStableCssVariablesAndThemeReferences()
    {
        var runtime = new FontStackRuntime(new SnapshotFontRegistry(DefaultSnapshot()));
        var preferences = new FontThemeTypographyPreferences(new Dictionary<string, string>
        {
            [FontTokenSchema.Typography.BodyFamily] = FontTokenSchema.Family.Prose,
            [FontTokenSchema.Typography.HeadingFamily] = FontTokenSchema.Family.Ui
        });

        FontTokenResolution resolution = await runtime.ResolveAsync(
            new FontStackResolutionRequest("missing-scope", "zh-HK", null, preferences));

        Assert.True(resolution.UsedSafeFallback);
        Assert.Equal(
            FontTokenSchema.Family.Prose,
            resolution.SemanticReferences[FontTokenSchema.Typography.BodyFamily]);
        Assert.Contains("--fsus-font-ui:", resolution.CssVariables, StringComparison.Ordinal);
        Assert.Contains("--fsus-font-prose:", resolution.CssVariables, StringComparison.Ordinal);
        Assert.Contains("--fsus-font-code:", resolution.CssVariables, StringComparison.Ordinal);
        Assert.Contains("--fsus-font-cjk:", resolution.CssVariables, StringComparison.Ordinal);
        Assert.Contains("--fsus-font-emoji:", resolution.CssVariables, StringComparison.Ordinal);
        Assert.Contains(
            "--fsus-typography-body-family: var(--fsus-font-prose);",
            resolution.CssVariables,
            StringComparison.Ordinal);
        Assert.Equal(FontTokenSchema.All.Count, resolution.TokenValues.Count);
        Assert.All(FontTokenSchema.All, token => Assert.Contains(token, resolution.TokenValues.Keys));
    }

    [Fact]
    public async Task ResolveAsync_RejectsRawThemeFamilyAndFallsBackFromWrongCategory()
    {
        FontRegistrySnapshot snapshot = DefaultSnapshot() with
        {
            Fonts =
            [
                .. FontBuiltIns.All,
                Entry("custom.code", "Unsafe Code", FontCategories.CodeMono)
            ],
            Activations =
            [
                new FontActivation(
                    FontActivation.DefaultScope,
                    "custom.code",
                    FontBuiltIns.ProseSans.Id,
                    FontBuiltIns.CodeMono.Id,
                    FontBuiltIns.CjkSans.Id,
                    FontBuiltIns.Emoji.Id,
                    7,
                    DateTimeOffset.UnixEpoch)
            ]
        };
        var runtime = new FontStackRuntime(new SnapshotFontRegistry(snapshot));

        FontTokenResolution safe = await runtime.ResolveAsync(
            new FontStackResolutionRequest(FontActivation.DefaultScope, "en-US"));

        Assert.True(safe.UsedSafeFallback);
        Assert.StartsWith("\"Google Sans\"", safe.FamilyStacks[FontTokenSchema.Family.Ui], StringComparison.Ordinal);

        var rawTheme = new FontThemeTypographyPreferences(new Dictionary<string, string>
        {
            [FontTokenSchema.Typography.BodyFamily] = "\"Arbitrary Sans\", sans-serif"
        });
        FontTokenException error = await Assert.ThrowsAsync<FontTokenException>(
            () => runtime.ResolveAsync(
                new FontStackResolutionRequest(FontActivation.DefaultScope, "en-US", Theme: rawTheme)));
        Assert.Equal("font_theme_reference_invalid", error.Code);
    }

    [Fact]
    public async Task ResolveAsync_UsesEnabledRoleSelectionsAndKeepsPlatformEmojiFirst()
    {
        FontRegistrySnapshot snapshot = DefaultSnapshot() with
        {
            Fonts =
            [
                .. FontBuiltIns.All,
                Entry("custom.ui", "Fixture UI", FontCategories.UiSans),
                Entry("custom.emoji", "Fixture Emoji", FontCategories.Emoji)
            ],
            Activations =
            [
                new FontActivation(
                    FontActivation.DefaultScope,
                    "custom.ui",
                    FontBuiltIns.ProseSans.Id,
                    FontBuiltIns.CodeMono.Id,
                    FontBuiltIns.CjkSans.Id,
                    "custom.emoji",
                    8,
                    DateTimeOffset.UnixEpoch)
            ]
        };
        var runtime = new FontStackRuntime(new SnapshotFontRegistry(snapshot));

        FontTokenResolution result = await runtime.ResolveAsync(
            new FontStackResolutionRequest(FontActivation.DefaultScope, "en-US"));

        Assert.False(result.UsedSafeFallback);
        Assert.StartsWith(
            "\"Fixture UI\", \"Noto Sans SC\"",
            result.FamilyStacks[FontTokenSchema.Family.Ui],
            StringComparison.Ordinal);
        string emoji = result.FamilyStacks[FontTokenSchema.Family.Emoji];
        Assert.True(
            emoji.IndexOf("Apple Color Emoji", StringComparison.Ordinal)
            < emoji.IndexOf("Fixture Emoji", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ResolveAsync_RejectsCssUnsafeInstalledFamilyAtRuntimeBoundary()
    {
        FontRegistrySnapshot snapshot = DefaultSnapshot() with
        {
            Fonts =
            [
                .. FontBuiltIns.All,
                Entry("custom.unsafe", "Unsafe; color: red", FontCategories.UiSans)
            ],
            Activations =
            [
                new FontActivation(
                    FontActivation.DefaultScope,
                    "custom.unsafe",
                    FontBuiltIns.ProseSans.Id,
                    FontBuiltIns.CodeMono.Id,
                    FontBuiltIns.CjkSans.Id,
                    FontBuiltIns.Emoji.Id,
                    9,
                    DateTimeOffset.UnixEpoch)
            ]
        };
        var runtime = new FontStackRuntime(new SnapshotFontRegistry(snapshot));

        FontTokenResolution result = await runtime.ResolveAsync(
            new FontStackResolutionRequest(FontActivation.DefaultScope, "en-US"));

        Assert.True(result.UsedSafeFallback);
        Assert.DoesNotContain("color:", result.CssVariables, StringComparison.Ordinal);
        Assert.StartsWith(
            "\"Google Sans\"",
            result.FamilyStacks[FontTokenSchema.Family.Ui],
            StringComparison.Ordinal);
    }

    private static FontRegistrySnapshot DefaultSnapshot()
        => new(FontBuiltIns.All, []);

    private static FontRegistryEntry Entry(string id, string family, string category)
        => new(
            id,
            id,
            family,
            category,
            "1.0.0",
            "{}",
            string.Empty,
            "{}",
            FontInstallStates.Installed,
            Enabled: true,
            BuiltIn: false,
            DateTimeOffset.UnixEpoch,
            DateTimeOffset.UnixEpoch,
            []);

    private sealed class SnapshotFontRegistry(FontRegistrySnapshot snapshot) : IFontRegistry
    {
        public Task<FontRegistrySnapshot> ReadAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(snapshot);

        public Task<FontRegistryEntry> InstallAsync(
            ValidatedFontPackage package,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<FontRegistryEntry> SetEnabledAsync(
            string id,
            bool enabled,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<FontRegistryPreview> PreviewAsync(
            string id,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<FontActivation> ActivateAsync(
            string scope,
            FontActivationSelection selection,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task DeleteAsync(
            string id,
            FontActivationSelection? replacement = null,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }
}
