using System.Text.RegularExpressions;
using static FsusBlog.V2.Core.Extensions.ExtensionManifestReader;
using static FsusBlog.V2.Core.Extensions.ExtensionPackageVerifier;

namespace FsusBlog.V2.Core.Extensions;

public sealed partial class AppearanceRegistry
{
    private const string LegacyThemeFormat = "fstheme-v1-palette";
    private const string Space = @"[ \t\r\n]*";
    private const string Root = ":root\\[data-theme=\"";
    private const string Dark = "\\[data-color-scheme=\"dark\"\\]";
    private const string Primary = "--fsus-color-action-primary";
    private const string Hover = Primary + "-hover";
    private const string Hex = "#[0-9A-Fa-f]{6}";

    private static Theme ReadLegacyTheme(byte[] archive, SignedArchiveTrust trust)
    {
        var package = LegacyThemeInspection.ReadVerified(archive, trust, default);
        var info = package.Report;
        if (!IsIdentifier(info.Id) || !IsVersion(info.Version) || info.Entries.Count != 5 ||
            info.StylePaths is not ["styles/theme.css", "styles/tokens.css"] || info.Assets.Count != 1 || info.Configuration.Count != 0 ||
            info.Modes is not ["light", "dark"] ||
            info.Supports is not { Public: true, Admin: false, Console: false, HighContrast: false, ReducedMotion: false, Rtl: false } ||
            package.MaximumSelectors < 2 || package.ThemeCss.Any(static character => character is not (' ' or '\t' or '\r' or '\n')) ||
            package.TokenCss.Length > 4096)
            throw Reject("appearance-fstheme-unsupported");

        var colors = LegacyAccentDeclarations().Match(package.TokenCss);
        if (!colors.Success || colors.Groups["theme"].Value != info.Id || colors.Groups["darkTheme"].Value != info.Id)
            throw Reject("appearance-fstheme-palette");
        var palette = new Palette(colors.Groups["lightAccent"].Value, colors.Groups["lightHover"].Value,
            colors.Groups["darkAccent"].Value, colors.Groups["darkHover"].Value);
        ValidatePalette(palette);
        return new(info.Id, info.Version, trust, palette);
    }

    [GeneratedRegex("\\A" + Space +
        Root + "(?<theme>[a-z0-9.-]{1,128})\"\\]" + Space + "\\{" + Space +
        Primary + ":" + Space + "(?<lightAccent>" + Hex + ")" + Space + ";" + Space +
        Hover + ":" + Space + "(?<lightHover>" + Hex + ")" + Space + ";" + Space + "\\}" + Space +
        Root + "(?<darkTheme>[a-z0-9.-]{1,128})\"\\]" + Dark + Space + "\\{" + Space +
        Primary + ":" + Space + "(?<darkAccent>" + Hex + ")" + Space + ";" + Space +
        Hover + ":" + Space + "(?<darkHover>" + Hex + ")" + Space + ";" + Space + "\\}" + Space + "\\z",
        RegexOptions.CultureInvariant)]
    private static partial Regex LegacyAccentDeclarations();
}
