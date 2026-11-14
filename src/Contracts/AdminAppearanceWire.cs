namespace FsusBlog.V2.Contracts;

public sealed record AdminAppearancePackage(string Id, string Version, string Digest, bool Font);

public static partial class Wire
{
    private static void Validate(AdminAppearanceState value)
    {
        if (value.Revision < 0 || !AppearanceDigest(value.Theme) || !AppearanceDigest(value.Font) ||
            !AppearanceDigest(value.PreviousTheme) || !AppearanceDigest(value.PreviousFont) ||
            (value.Revision == 0 && (value.CanRollback || value.PreviousTheme.Length != 0 || value.PreviousFont.Length != 0)))
            throw new ProtocolException("Invalid appearance activation state");
    }

    private static void Validate(AdminAppearanceCommand value)
    {
        if (value.ExpectedRevision < 0 || !AppearanceDigest(value.CurrentTheme) || !AppearanceDigest(value.CurrentFont) ||
            !AppearanceDigest(value.Theme) || !AppearanceDigest(value.Font))
            throw new ProtocolException("Invalid appearance activation command");
    }

    public static byte[] EncodeAdminAppearanceCatalog(IReadOnlyList<AdminAppearancePackage> packages)
    {
        if (packages.Count > WireLimits.AdminAppearanceMaximumItems)
            throw new ProtocolException("Invalid appearance catalog size");
        var writer = new Writer();
        writer.I32(packages.Count);
        foreach (var package in packages)
        {
            if (package.Digest.Length == 0 || !AppearanceDigest(package.Digest))
                throw new ProtocolException("Invalid appearance package digest");
            writer.Text(package.Id, WireLimits.AdminAppearanceIdBytes);
            writer.Text(package.Version, WireLimits.AdminAppearanceVersionBytes);
            writer.Text(package.Digest, WireLimits.AdminAppearanceDigestBytes);
            writer.Bool(package.Font);
        }
        return Aeds.Encode(FrameType.AdminAppearanceCatalog, writer.Written);
    }

    private static bool AppearanceDigest(string value) => value.Length == 0 || value.Length == WireLimits.AdminAppearanceDigestBytes &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
