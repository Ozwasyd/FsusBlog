namespace FsusBlog.V2.Contracts;

public sealed record SiteSessionRow(string Id, long ExpiresAt, bool Current, int Method, bool Mfa);
public sealed record SiteSessionList(IReadOnlyList<SiteSessionRow> Sessions, bool HasMore);

public static partial class Wire
{
    public static byte[] EncodeSiteSessions(SiteSessionList value)
    {
        if (value.Sessions.Count is < 1 or > WireLimits.SiteSessionListSize || !value.Sessions[0].Current ||
            value.Sessions.Skip(1).Any(row => row.Current)) throw new ProtocolException("Invalid site session list.");
        var writer = new Writer();
        writer.Bool(value.HasMore);
        writer.I32(value.Sessions.Count);
        foreach (var row in value.Sessions)
        {
            if (!ValidSiteSessionId(row.Id) || row.ExpiresAt <= 0 || row.Method is < 1 or > 2 || (row.Method == 1 && row.Mfa))
                throw new ProtocolException("Invalid site session row.");
            writer.Text(row.Id, WireLimits.SiteSessionIdBytes);
            writer.I64(row.ExpiresAt);
            writer.Bool(row.Current);
            writer.I32(row.Method);
            writer.Bool(row.Mfa);
        }
        return Aeds.Encode(FrameType.SiteSessionList, writer.Written);
    }

    public static bool ValidSiteSessionId(string? value) =>
        value is { Length: WireLimits.SiteSessionIdBytes } && value.All(char.IsAsciiHexDigitLower);
}
