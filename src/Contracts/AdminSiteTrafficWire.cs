using System.Globalization;

namespace FsusBlog.V2.Contracts;

public sealed record SiteTrafficDay(string Date, long Views);
public sealed record SiteTrafficRegion(string Region, long Views);
public sealed record AdminSiteTraffic(bool Enabled, bool RegionsConfigured, IReadOnlyList<SiteTrafficDay> Days,
    IReadOnlyList<SiteTrafficRegion> Regions);

public static partial class Wire
{
    public static byte[] EncodeAdminSiteTraffic(AdminSiteTraffic value)
    {
        const long maxSafeInteger = 9_007_199_254_740_991;
        if (value.Days.Count > 30 || value.Regions.Count > 30 ||
            (!value.Enabled && (value.RegionsConfigured || value.Days.Count != 0)) ||
            (!value.RegionsConfigured && value.Regions.Count != 0))
            throw new ProtocolException("Invalid site traffic snapshot.");
        var writer = new Writer();
        writer.Bool(value.Enabled);
        writer.Bool(value.RegionsConfigured);
        writer.I32(value.Days.Count);
        string? previous = null;
        foreach (var day in value.Days)
        {
            if (!DateOnly.TryParseExact(day.Date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _) ||
                day.Views is < 0 or > maxSafeInteger || previous is not null && string.CompareOrdinal(previous, day.Date) >= 0)
                throw new ProtocolException("Invalid site traffic day.");
            writer.Text(day.Date, 10);
            writer.I64(day.Views);
            previous = day.Date;
        }
        writer.I32(value.Regions.Count);
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var region in value.Regions)
        {
            if (!IsSiteTrafficRegion(region.Region) || region.Views is <= 0 or > maxSafeInteger || !keys.Add(region.Region))
                throw new ProtocolException("Invalid site traffic region.");
            writer.Text(region.Region, 7);
            writer.I64(region.Views);
        }
        return Aeds.Encode(FrameType.AdminSiteTraffic, writer.Written);
    }

    public static bool IsSiteTrafficRegion(string value) =>
        value == "unknown" || value.Length is 2 or >= 4 and <= 6 &&
        char.IsAsciiLetterUpper(value[0]) && char.IsAsciiLetterUpper(value[1]) &&
        (value.Length == 2 || value[2] == '-' && value[3..].All(c => char.IsAsciiLetterUpper(c) || char.IsAsciiDigit(c)));
}
