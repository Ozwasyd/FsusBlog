namespace FsusBlog.V2.Contracts;

public sealed record AdminAppearancePackage(string Id, string Version, string Digest, bool Font);
public sealed record AdminAppearanceChange(long Revision, long HappenedUnixMs, string Actor, bool Rollback,
    string PreviousTheme, string PreviousFont, string Theme, string Font);
public sealed record AdminAppearanceHistoryPage(long NextBefore, IReadOnlyList<AdminAppearanceChange> Items);

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

    public static byte[] EncodeAdminAppearanceHistory(AdminAppearanceHistoryPage page, int limit)
    {
        if (limit is < 1 or > WireLimits.AdminAppearanceHistoryMaximumItems || page.Items.Count > limit || page.NextBefore < 0 ||
            page.NextBefore > 0 && (page.Items.Count != limit || page.NextBefore != page.Items[^1].Revision))
            throw new ProtocolException("Invalid appearance history page");

        var writer = new Writer();
        writer.I64(page.NextBefore);
        writer.I32(page.Items.Count);
        long? previous = null;
        foreach (var change in page.Items)
        {
            if (change.Revision <= 0 || previous is { } priorRevision && change.Revision >= priorRevision ||
                change.HappenedUnixMs is <= 0 or > 253402300799999 ||
                change.Actor.Length is < 1 or > 64 || change.Actor[0] is < 'a' or > 'z' ||
                !change.Actor.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '.' or '-') ||
                !AppearanceDigest(change.PreviousTheme) || !AppearanceDigest(change.PreviousFont) ||
                !AppearanceDigest(change.Theme) || !AppearanceDigest(change.Font) ||
                change.PreviousTheme == change.Theme && change.PreviousFont == change.Font)
                throw new ProtocolException("Invalid appearance history item");
            previous = change.Revision;
            writer.I64(change.Revision);
            writer.I64(change.HappenedUnixMs);
            writer.Text(change.Actor, WireLimits.NameBytes);
            writer.Bool(change.Rollback);
            writer.Text(change.PreviousTheme, WireLimits.AdminAppearanceDigestBytes);
            writer.Text(change.PreviousFont, WireLimits.AdminAppearanceDigestBytes);
            writer.Text(change.Theme, WireLimits.AdminAppearanceDigestBytes);
            writer.Text(change.Font, WireLimits.AdminAppearanceDigestBytes);
        }
        return Aeds.Encode(FrameType.AdminAppearanceHistory, writer.Written);
    }

    private static bool AppearanceDigest(string value) => value.Length == 0 || value.Length == WireLimits.AdminAppearanceDigestBytes &&
        value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
