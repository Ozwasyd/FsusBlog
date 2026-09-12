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
            Dark = "#121214,#F0F0F4,#71717A,#4B79CC,#27272A,#1A1A1E",
            BodyStack = "Google Sans,Noto Sans SC,sans-serif",
            CodeStack = "JetBrains Mono,monospace"
        },
        RequiredFonts
    });

    internal static bool IsFont(DocumentExportAsset asset)
        => asset.Role == "font";
}
