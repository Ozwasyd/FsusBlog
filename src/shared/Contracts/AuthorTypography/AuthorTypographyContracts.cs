namespace FsusBlog.Shared.Contracts.AuthorTypography;

/// <summary>Closed author-only profile IDs. This catalog owns IDs, not CSS or font assets.</summary>
public static class AuthorTypographyCatalog
{
    public const int Version = 1;
    public const string Schema = "fsusblog.author-typography-profile.v1";

    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Dimensions
    {
        get;
    } =
        new System.Collections.ObjectModel.ReadOnlyDictionary<string, IReadOnlyList<string>>(
            new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
            {
                ["fontFamily"] = Array.AsReadOnly(new[] { "system-sans", "reading-serif", "cjk-sans" }),
                ["fontSize"] = Array.AsReadOnly(new[] { "compact", "standard", "large" }),
                ["lineHeight"] = Array.AsReadOnly(new[] { "compact", "standard", "relaxed" }),
                ["canvasWidth"] = Array.AsReadOnly(new[] { "narrow", "standard", "wide" }),
                ["paragraphSpacing"] = Array.AsReadOnly(new[] { "compact", "standard", "relaxed" })
            });
}

/// <summary>
/// Only authoring profile IDs cross this boundary. Document, mode, selection, CSS and font
/// assets are deliberately absent. Storage and public AEDS transport remain separate owners.
/// </summary>
public sealed record AuthorTypographyProfile(
    int SchemaVersion,
    string FontFamily,
    string FontSize,
    string LineHeight,
    string CanvasWidth,
    string ParagraphSpacing);

/// <summary>Account and site coordinate supplied by the authenticated server context.</summary>
public sealed record AuthorTypographyScope(int AccountId, string SiteIdentity);

/// <summary>
/// A server observation, not a client store. Revision zero denotes absence; stored rows
/// must use positive revisions. The digest binds scope and profile IDs without article data.
/// </summary>
public sealed record AuthorTypographySnapshot(
    AuthorTypographyScope Scope,
    long Revision,
    AuthorTypographyProfile Profile,
    string ContentDigest);

/// <summary>Finite contract refusal reasons; none implies persistence or runtime acceptance.</summary>
public enum AuthorTypographyContractStatus : byte
{
    Valid = 1,
    InvalidProfile = 2,
    InvalidScope = 3,
    ScopeMismatch = 4,
    InvalidRevision = 5,
    DigestMismatch = 6
}
