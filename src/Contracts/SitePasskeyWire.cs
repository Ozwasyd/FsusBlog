namespace FsusBlog.V2.Contracts;

public sealed record SitePasskeyRow(long CreatedAt, long? LastUsedAt, bool BackupEligible, bool BackedUp, bool Current);

public static partial class Wire
{
    private const long MaxSitePasskeyTimestamp = 253402300799999; // UTC DateTimeOffset.MaxValue in Unix milliseconds.

    public static byte[] EncodeSitePasskeys(IReadOnlyList<SitePasskeyRow> rows)
    {
        if (rows.Count is < 1 or > WireLimits.SitePasskeyListSize || !rows[0].Current || rows.Skip(1).Any(row => row.Current))
            throw new ProtocolException("Invalid site Passkey list.");

        var writer = new Writer();
        writer.I32(rows.Count);
        foreach (var row in rows)
        {
            if (row.CreatedAt is <= 0 or > MaxSitePasskeyTimestamp ||
                row.LastUsedAt is <= 0 or > MaxSitePasskeyTimestamp || (row.BackedUp && !row.BackupEligible))
                throw new ProtocolException("Invalid site Passkey row.");

            writer.I64(row.CreatedAt);
            writer.I64(row.LastUsedAt ?? 0);
            writer.Bool(row.BackupEligible);
            writer.Bool(row.BackedUp);
            writer.Bool(row.Current);
        }
        return Aeds.Encode(FrameType.SitePasskeys, writer.Written);
    }
}
