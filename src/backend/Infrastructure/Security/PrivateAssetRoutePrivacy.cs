namespace FsusBlog.Server.Infrastructure.Security;

internal static class PrivateAssetRoutePrivacy
{
    internal const string ExternalPrefix = "/assets/private/";
    internal const string RedactedPath = "/assets/private/{ticket}";

    public static string RedactPath(PathString path)
        => IsPrivateAssetRoute(path)
            ? RedactedPath
            : path.Value ?? string.Empty;

    public static bool IsPrivateAssetRoute(PathString path)
        => path.Value?.StartsWith(ExternalPrefix, StringComparison.OrdinalIgnoreCase) == true;
}
