namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static void Validate(AdminSitePages value)
    {
        if (value.ConfiguredMask is < 0 or > 15)
            throw new ProtocolException("Invalid site page configuration states");
    }

    private static void Validate(AdminSitePageRevision value) =>
        ValidatePageEditor(value.Slug, value.Revision, value.Digest, value.Markdown);

    private static void Validate(AdminSitePagePublish value) =>
        ValidatePageEditor(value.Slug, value.ExpectedRevision, value.ExpectedDigest, value.Markdown);

    private static void ValidatePageEditor(string slug, long revision, string digest, string markdown)
    {
        if (slug is not ("about" or "privacy" or "guidelines" or "copyright") ||
            revision < 0 || digest.Length != WireLimits.AdminSitePageDigestBytes ||
            !digest.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f') ||
            markdown.Length > WireLimits.PageContentChars || markdown.Contains('\0'))
            throw new ProtocolException("Invalid site page revision or content");
    }
}
