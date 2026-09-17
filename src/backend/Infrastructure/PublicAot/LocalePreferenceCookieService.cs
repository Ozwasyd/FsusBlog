using FsusBlog.Shared.Contracts.Localization;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface ILocalePreferenceCookieService
{
    LocaleDescriptor? Read(HttpContext context);
    void SetFixed(HttpContext context, LocaleDescriptor locale);
    void Clear(HttpContext context);
}

/// <summary>
/// Device-level explicit locale preference cookie shared with Public AOT (#1705).
/// Value is only a canonical catalog code; never account id or Accept-Language raw text.
/// </summary>
public sealed class LocalePreferenceCookieService(
    IConfiguration configuration,
    IWebHostEnvironment environment) : ILocalePreferenceCookieService
{
    /// <summary>Canonical cookie name established by public AOT locale negotiation.</summary>
    public const string CookieName = "fsusblog.locale";

    private static readonly TimeSpan s_lifetime = TimeSpan.FromDays(365);
    private readonly bool _secure =
        !environment.IsDevelopment()
        || !configuration.GetValue<bool>("AuthCookies:AllowInsecureTransportCookies");

    public LocaleDescriptor? Read(HttpContext context)
        => TryRead(context, out LocaleDescriptor locale) ? locale : null;

    public void SetFixed(HttpContext context, LocaleDescriptor locale)
    {
        ArgumentNullException.ThrowIfNull(locale);
        if (!LocaleCatalog.TryParse(locale.Code, out LocaleDescriptor canonical)
            || !string.Equals(locale.Code, canonical.Code, StringComparison.Ordinal))
        {
            throw new ArgumentException("locale must be a canonical enabled catalog entry", nameof(locale));
        }

        context.Response.Cookies.Append(
            CookieName,
            canonical.Code,
            CreateOptions(_secure, DateTimeOffset.UtcNow.Add(s_lifetime)));
    }

    public void Clear(HttpContext context)
    {
        // Clear both secure and insecure variants so auto mode never leaves a stale device fixed cookie.
        context.Response.Cookies.Delete(CookieName, CreateOptions(secure: false, expires: null));
        context.Response.Cookies.Delete(CookieName, CreateOptions(secure: true, expires: null));
    }

    internal static bool TryRead(HttpContext context, out LocaleDescriptor locale)
    {
        if (context.Request.Cookies.TryGetValue(CookieName, out string? raw)
            && !string.IsNullOrWhiteSpace(raw)
            && LocaleCatalog.TryParse(raw, out LocaleDescriptor parsed)
            && string.Equals(raw, parsed.Code, StringComparison.Ordinal))
        {
            locale = parsed;
            return true;
        }

        locale = null!;
        return false;
    }

    internal static bool IsLocalePreferenceCookieName(string name)
        => string.Equals(name, CookieName, StringComparison.Ordinal);

    private static CookieOptions CreateOptions(bool secure, DateTimeOffset? expires)
        => new()
        {
            HttpOnly = true,
            Secure = secure,
            SameSite = SameSiteMode.Lax,
            Path = "/",
            Expires = expires,
            IsEssential = true
        };
}
