using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicOriginPolicy
{
    public static string Resolve(
        string? configuredBaseUrl,
        string? storedBaseUrl,
        string? artifactBaseUrl = null)
    {
        string? configured = NormalizeOrNull(configuredBaseUrl);
        string? stored = NormalizeOrNull(storedBaseUrl);
        string? artifact = NormalizeOrNull(artifactBaseUrl);

        string authoritative = configured
            ?? FirstNonDefault(stored, artifact)
            ?? stored
            ?? artifact
            ?? PublicSiteIdentityDefaults.SiteBaseUrl;

        EnsureCompatible(authoritative, stored, "stored SEO base URL");
        EnsureCompatible(authoritative, artifact, "public artifact base URL");
        return authoritative;
    }

    public static string? NormalizeOrNull(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string trimmed = value.Trim().TrimEnd('/');
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out Uri? uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment)
            || (uri.AbsolutePath.Length > 0 && uri.AbsolutePath != "/"))
        {
            throw new InvalidOperationException("public_origin_invalid: public origin must be an absolute HTTP(S) origin without credentials, path, query, or fragment");
        }

        return uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
    }

    private static string? FirstNonDefault(params string?[] values)
        => values.FirstOrDefault(static value => value is not null && !IsProjectDefault(value));

    private static void EnsureCompatible(string authoritative, string? candidate, string source)
    {
        if (candidate is null
            || IsProjectDefault(candidate)
            || string.Equals(authoritative, candidate, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        throw new InvalidOperationException(
            $"public_origin_conflict: {source} '{candidate}' does not match authoritative origin '{authoritative}'");
    }

    private static bool IsProjectDefault(string value)
        => string.Equals(value, PublicSiteIdentityDefaults.SiteBaseUrl, StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "https://blog.fsus.blog", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "https://example.com", StringComparison.OrdinalIgnoreCase);
}
