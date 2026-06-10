namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class OpenApiExportMode
{
    public static bool IsEnabled(IConfiguration? configuration = null)
    {
        string? configured = configuration?["FSUSBLOG_OPENAPI_EXPORT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_OPENAPI_EXPORT");

        return string.Equals(configured, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(configured, "true", StringComparison.OrdinalIgnoreCase);
    }
}
