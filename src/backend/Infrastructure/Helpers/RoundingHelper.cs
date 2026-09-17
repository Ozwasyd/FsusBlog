namespace FsusBlog.Server.Infrastructure.Helpers;

internal static class RoundingHelper
{
    internal static double Round2(double value)
        => Math.Round(value, 2, MidpointRounding.AwayFromZero);

    internal static double Round4(double value)
        => Math.Round(value, 4, MidpointRounding.AwayFromZero);

    internal static int RoundToInt(double value)
        => (int)Math.Round(value, MidpointRounding.AwayFromZero);
}
