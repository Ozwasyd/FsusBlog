namespace FsusBlog.Core.Mapping.Codecs;

public static class PodTimeCodec
{
    public static long ToUnixMs(DateTime value) => new DateTimeOffset(value.ToUniversalTime()).ToUnixTimeMilliseconds();

    public static DateTime FromUnixMs(long unixMs) => DateTimeOffset.FromUnixTimeMilliseconds(unixMs).UtcDateTime;
}
