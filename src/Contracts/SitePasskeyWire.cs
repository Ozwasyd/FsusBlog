namespace FsusBlog.V2.Contracts;

public sealed record SitePasskeyRow(long CreatedAt, long? LastUsedAt, bool BackupEligible, bool BackedUp, bool Current);
public sealed record SitePasskeyManagedRow(string Reference, long Revision, string Name, SitePasskeyRow Metadata);
public sealed record SitePasskeyRename(string Reference, long ExpectedRevision, string Name);

public static partial class Wire
{
    private const long MaxSitePasskeyTimestamp = 253402300799999; // UTC DateTimeOffset.MaxValue in Unix milliseconds.

    public static byte[] EncodeSitePasskeys(IReadOnlyList<SitePasskeyRow> rows)
    {
        if (rows.Count is < 1 or > WireLimits.SitePasskeyListSize)
            throw new ProtocolException("Invalid site Passkey list.");

        var writer = new Writer();
        writer.I32(rows.Count);
        for (var index = 0; index < rows.Count; index++)
            WriteSitePasskeyRow(writer, rows[index], current: index == 0);
        return Aeds.Encode(FrameType.SitePasskeys, writer.Written);
    }

    public static byte[] EncodeSitePasskeyManagement(IReadOnlyList<SitePasskeyManagedRow> rows)
    {
        if (rows.Count is < 1 or > WireLimits.SitePasskeyListSize)
            throw new ProtocolException("Invalid site Passkey list.");

        var writer = new Writer();
        writer.I32(rows.Count);
        var references = new HashSet<string>(StringComparer.Ordinal);
        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index];
            if (!ValidSitePasskeyReference(row.Reference) || !references.Add(row.Reference) || row.Revision < 0 ||
                (row.Revision == 0 ? row.Name.Length != 0 : !ValidSitePasskeyName(row.Name) || row.Name != row.Name.Trim() || row.Name.Any(char.IsControl)))
                throw new ProtocolException("Invalid managed site Passkey row.");

            writer.FixedBytes(Convert.FromHexString(row.Reference));
            writer.I64(row.Revision);
            writer.Text(row.Name, WireLimits.SitePasskeyNameBytes);
            WriteSitePasskeyRow(writer, row.Metadata, current: index == 0);
        }
        return Aeds.Encode(FrameType.SitePasskeyManagement, writer.Written);
    }

    public static byte[] EncodeSitePasskeyRename(SitePasskeyRename value)
    {
        ValidateSitePasskeyRename(value);
        var writer = new Writer();
        writer.FixedBytes(Convert.FromHexString(value.Reference));
        writer.I64(value.ExpectedRevision);
        writer.Text(value.Name, WireLimits.SitePasskeyNameBytes);
        return Aeds.Encode(FrameType.SitePasskeyRename, writer.Written);
    }

    public static SitePasskeyRename DecodeSitePasskeyRename(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.SitePasskeyRename));
        var value = new SitePasskeyRename(Convert.ToHexStringLower(reader.FixedBytes(WireLimits.SitePasskeyReferenceBytes)),
            reader.I64(), reader.Text(WireLimits.SitePasskeyNameBytes));
        reader.Finish();
        ValidateSitePasskeyRename(value);
        return value;
    }

    public static bool ValidSitePasskeyReference(string? value) =>
        value is { Length: WireLimits.SitePasskeyReferenceBytes * 2 } && value.All(char.IsAsciiHexDigitLower);

    private static bool ValidSitePasskeyName(string value) =>
        value.Length <= WireLimits.SitePasskeyNameChars && !string.IsNullOrWhiteSpace(value);

    private static void ValidateSitePasskeyRename(SitePasskeyRename value)
    {
        if (!ValidSitePasskeyReference(value.Reference) || value.ExpectedRevision < 0 || !ValidSitePasskeyName(value.Name))
            throw new ProtocolException("Invalid site Passkey rename.");
    }

    private static void WriteSitePasskeyRow(Writer writer, SitePasskeyRow row, bool current)
    {
        if (row.CreatedAt is <= 0 or > MaxSitePasskeyTimestamp || row.LastUsedAt is <= 0 or > MaxSitePasskeyTimestamp ||
            (row.BackedUp && !row.BackupEligible) || row.Current != current)
            throw new ProtocolException("Invalid site Passkey row.");

        writer.I64(row.CreatedAt);
        writer.I64(row.LastUsedAt ?? 0);
        writer.Bool(row.BackupEligible);
        writer.Bool(row.BackedUp);
        writer.Bool(row.Current);
    }
}
