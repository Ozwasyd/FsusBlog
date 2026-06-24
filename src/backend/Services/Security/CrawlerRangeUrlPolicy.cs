namespace FsusBlog.Server.Services.Security;

internal static class CrawlerRangeUrlPolicy
{
    private static readonly HashSet<string> AllowedHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "developers.google.com",
        "www.bing.com"
    };

    internal static Uri ResolveOrThrow(string? configured, Uri fallback, string settingName)
    {
        if (string.IsNullOrWhiteSpace(configured))
        {
            return fallback;
        }

        if (!Uri.TryCreate(configured, UriKind.Absolute, out Uri? uri))
        {
            throw new InvalidOperationException($"{settingName} must be an absolute HTTPS URL hosted by developers.google.com or www.bing.com.");
        }

        string? error = Validate(uri);
        if (error is not null)
        {
            throw new InvalidOperationException($"{settingName} is not allowed: {error}.");
        }

        return uri;
    }

    internal static string NormalizeOrThrow(string? configured, string fallback, string settingName)
    {
        if (!Uri.TryCreate(fallback, UriKind.Absolute, out Uri? fallbackUri))
        {
            throw new InvalidOperationException($"{settingName} fallback URL is invalid.");
        }

        try
        {
            return ResolveOrThrow(configured, fallbackUri, settingName).ToString();
        }
        catch (InvalidOperationException ex)
        {
            throw new ArgumentException(ex.Message, settingName, ex);
        }
    }

    internal static bool TryValidateConfiguredUrl(string? configured, out string error)
    {
        error = string.Empty;
        if (string.IsNullOrWhiteSpace(configured))
        {
            return true;
        }

        if (!Uri.TryCreate(configured, UriKind.Absolute, out Uri? uri))
        {
            error = "must be an absolute HTTPS URL hosted by developers.google.com or www.bing.com";
            return false;
        }

        string? validationError = Validate(uri);
        if (validationError is null)
        {
            return true;
        }

        error = validationError;
        return false;
    }

    private static string? Validate(Uri uri)
    {
        if (uri.Scheme != Uri.UriSchemeHttps)
        {
            return "scheme must be https";
        }

        if (!uri.IsDefaultPort && uri.Port != 443)
        {
            return "port must be the default HTTPS port";
        }

        return AllowedHosts.Contains(uri.Host)
            ? null
            : "host must be developers.google.com or www.bing.com";
    }
}
