using System.Globalization;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotUtcTime
{
    internal static DateTime Normalize(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    internal static DateTimeOffset ToOffset(DateTime value)
        => new(Normalize(value));

    internal static string Format(DateTime value)
        => Normalize(value).ToString("O", CultureInfo.InvariantCulture);

    internal static string Format(DateTimeOffset value)
        => value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
}
