using System.Collections.ObjectModel;
using System.Globalization;
using System.Text;

namespace FsusBlog.Server.Services.DocumentExport;

public sealed record DocumentExportRequiredFont(
    string Family,
    int Weight,
    string Style);

/// <summary>
/// Frozen standalone-reading projection of the active local FsusUI authorities.
/// It deliberately copies resolved public values into the export artifact: the
/// artifact has no package, browser, network, or host-font dependency at open time.
/// </summary>
public static class DocumentExportReadingStyleAuthority
{
    public const string AuthorityId = "fsusui-reading-document-export-v1";
    public const string FsusUiRevision = "5a4a1fc6616ed330cf5e9035ddff603532d7be25";
    public const string FsusUiTokenSourceDigest = "sha256:5ddb82979d0ef3a574f653ac185e57fa162a11624b5fd58ec2ce3ce48e5fe5c2";
    public const string FsusUiTypographySourceDigest = "sha256:883c8f21558a82a727454dfb9b028cac87806c43ac91fcea49b88cd1d5fc6d4d";
    public const string BlogReadingContractDigest = "sha256:a9f83475211ac05179acb75e052a50a9493c51669748aac995a44e0a09646b6a";
    public const string LayoutProfile = "document-reading-v1";
    public const string LightThemeProfile = "light-v1";
    public const string DarkThemeProfile = "dark-v1";

    public static readonly IReadOnlyList<DocumentExportRequiredFont> RequiredFonts =
        new ReadOnlyCollection<DocumentExportRequiredFont>(
        [
            new("Google Sans", 400, "normal"),
            new("Google Sans", 500, "normal"),
            new("Google Sans", 700, "normal"),
            new("Noto Sans SC", 400, "normal"),
            new("Noto Sans SC", 500, "normal"),
            new("Noto Sans SC", 700, "normal"),
            new("JetBrains Mono", 400, "normal")
        ]);

    public static readonly string AuthorityDigest = DocumentExportDigest.Compute(new
    {
        AuthorityId,
        FsusUiRevision,
        FsusUiTokenSourceDigest,
        FsusUiTypographySourceDigest,
        BlogReadingContractDigest,
        LayoutProfile,
        Themes = new[] { LightThemeProfile, DarkThemeProfile },
        Projection = new
        {
            Body = "16px/400/1.8",
            Heading1 = "24px/1.35",
            Heading2Through6 = "20px/1.4",
            ReadingWidth = "72ch",
            Light = "#FFFFFF,#0F0F11,#71717A,#2A599C,#E4E4E7,#F7F7F8",
            Dark = "#09090B,#F0F0F4,#A1A1AA,#4B79CC,#27272A,#1A1A1E",
            BodyStack = "Google Sans,Noto Sans SC,sans-serif",
            CodeStack = "JetBrains Mono,monospace"
        },
        RequiredFonts
    });

    internal static byte[] BuildStyleBytes(
        IReadOnlyList<DocumentExportAsset> assets,
        string themeProfile,
        long maximumBytes)
    {
        using var output = new DocumentExportBoundedMemoryStream(
            maximumBytes,
            "Embedded reading style exceeds the document output budget.",
            "output-budget");
        using var style = new StreamWriter(output, new UTF8Encoding(false, true), leaveOpen: true);
        foreach (DocumentExportRequiredFont required in RequiredFonts)
        {
            DocumentExportAsset font = assets.Single(asset => IsFont(asset)
                && asset.FontFamily == required.Family
                && asset.FontWeight == required.Weight
                && asset.FontStyle == required.Style);
            style.Write("@font-face{font-family:'");
            style.Write(CssString(font.FontFamily));
            style.Write("';font-style:");
            style.Write(font.FontStyle);
            style.Write(";font-weight:");
            style.Write(font.FontWeight.ToString(CultureInfo.InvariantCulture));
            style.Write(";font-display:block;src:url(data:");
            style.Write(font.MediaType);
            style.Write(";base64,");
            style.Write(Convert.ToBase64String(font.Bytes.AsSpan()));
            style.Write(") format('woff2')}");
        }

        bool dark = themeProfile == DarkThemeProfile;
        style.Write(dark
            ? ":root{color-scheme:dark;--reading-bg:#09090B;--reading-fg:#F0F0F4;--reading-muted:#A1A1AA;--reading-link:#4B79CC;--reading-border:#27272A;--reading-code:#1A1A1E}"
            : ":root{color-scheme:light;--reading-bg:#FFFFFF;--reading-fg:#0F0F11;--reading-muted:#71717A;--reading-link:#2A599C;--reading-border:#E4E4E7;--reading-code:#F7F7F8}");
        style.Write("html{background:var(--reading-bg);color:var(--reading-fg)}body{margin:0;font-family:'Google Sans','Noto Sans SC',sans-serif;font-size:16px;font-weight:400;line-height:1.8;background:var(--reading-bg);color:var(--reading-fg)}");
        style.Write("main{box-sizing:border-box;max-width:72ch;margin:auto;padding:3rem 1.25rem}h1{font-size:24px;line-height:1.35}h2,h3,h4,h5,h6{font-size:20px;line-height:1.4}pre,code,kbd,samp{font-family:'JetBrains Mono',monospace}");
        style.Write("img,svg{max-width:100%;height:auto}pre{overflow:auto;padding:1rem;background:var(--reading-code);border-radius:.5rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--reading-border);padding:.5rem;text-align:start}a{color:var(--reading-link)}figure{margin:1.5rem 0}figcaption{color:var(--reading-muted);font-size:.9em}");
        style.Write("@media(max-width:480px){main{padding:1.5rem 1rem}}@media print{main{max-width:none;padding:0}a{color:inherit}}");
        style.Flush();
        return output.ToArray();
    }

    internal static bool IsFont(DocumentExportAsset asset)
        => asset.Role == "font";

    private static string CssString(string value)
        => value.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("'", "\\'", StringComparison.Ordinal);
}
