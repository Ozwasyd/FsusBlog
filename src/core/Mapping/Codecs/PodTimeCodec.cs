namespace FsusBlog.Core.Mapping.Codecs;

public static class PodTimeCodec
{
    public static long ToUnixMs(DateTime value)
    {
        DateTime utc = value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

        return new DateTimeOffset(utc).ToUnixTimeMilliseconds();
    }

    public static DateTime FromUnixMs(long unixMs) => DateTimeOffset.FromUnixTimeMilliseconds(unixMs).UtcDateTime;
}
