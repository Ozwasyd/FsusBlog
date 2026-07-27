using System.Globalization;

using FsusBlog.Shared.Contracts.Localization;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public enum LocaleResolutionSource : byte
{
    ExplicitCookie = 1,
    AcceptLanguage = 2,
    Default = 3
}

public sealed record LocaleResolutionInput(
    LocaleDescriptor? ExplicitCookieLocale,
    string? AcceptLanguage,
    LocaleDescriptor DefaultLocale);

public sealed record LocaleResolutionResult(
    LocaleDescriptor Locale,
    LocaleResolutionSource Source,
    string MatchedRange,
    string CatalogDigest);

public interface ILocaleResolver
{
    LocaleResolutionResult Resolve(LocaleResolutionInput input);
}

public sealed class LocaleResolver : ILocaleResolver
{
    public LocaleResolutionResult Resolve(LocaleResolutionInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(input.DefaultLocale);
        LocaleDescriptor defaultLocale = RequireCanonicalLocale(input.DefaultLocale, nameof(input.DefaultLocale));

        if (input.ExplicitCookieLocale is not null)
        {
            LocaleDescriptor explicitLocale = RequireCanonicalLocale(
                input.ExplicitCookieLocale,
                nameof(input.ExplicitCookieLocale));
            return CreateResult(
                explicitLocale,
                LocaleResolutionSource.ExplicitCookie,
                explicitLocale.Code);
        }

        IReadOnlyList<LanguageRange> ranges = ParseLanguageRanges(input.AcceptLanguage);
        HashSet<string> rejectedLocales = ranges
            .Where(static candidate => candidate.Quality == 0 && candidate.Value != "*")
            .Select(static candidate => TryResolveRange(candidate.Value, out LocaleDescriptor rejected)
                ? rejected.Code
                : string.Empty)
            .Where(static code => !string.IsNullOrEmpty(code))
            .ToHashSet(StringComparer.Ordinal);
        foreach (LanguageRange range in ranges)
        {
            if (range.Quality <= 0)
            {
                continue;
            }

            if (range.Value == "*")
            {
                LocaleDescriptor wildcardLocale = LocaleCatalog.Enabled
                    .FirstOrDefault(locale => !rejectedLocales.Contains(locale.Code))
                    ?? defaultLocale;
                return CreateResult(wildcardLocale, LocaleResolutionSource.AcceptLanguage, range.Value);
            }

            if (TryResolveRange(range.Value, out LocaleDescriptor descriptor)
                && !rejectedLocales.Contains(descriptor.Code))
            {
                return CreateResult(descriptor, LocaleResolutionSource.AcceptLanguage, range.Value);
            }
        }

        return CreateResult(defaultLocale, LocaleResolutionSource.Default, string.Empty);
    }

    private static LocaleDescriptor RequireCanonicalLocale(LocaleDescriptor locale, string parameterName)
    {
        if (!LocaleCatalog.TryParse(locale.Code, out LocaleDescriptor canonical)
            || !string.Equals(locale.Code, canonical.Code, StringComparison.Ordinal))
        {
            throw new ArgumentException("locale must be a canonical enabled catalog entry", parameterName);
        }

        return canonical;
    }

    private static LocaleResolutionResult CreateResult(
        LocaleDescriptor locale,
        LocaleResolutionSource source,
        string matchedRange)
        => new(locale, source, matchedRange, LocaleCatalog.Digest);

    private static bool TryResolveRange(string range, out LocaleDescriptor descriptor)
    {
        string candidate = range;
        while (true)
        {
            if (LocaleCatalog.TryParse(candidate, out descriptor))
            {
                return true;
            }

            int separator = candidate.LastIndexOf('-');
            if (separator <= 0)
            {
                descriptor = null!;
                return false;
            }

            candidate = candidate[..separator];
        }
    }

    private static IReadOnlyList<LanguageRange> ParseLanguageRanges(string? header)
    {
        if (string.IsNullOrWhiteSpace(header))
        {
            return [];
        }

        Dictionary<string, LanguageRange> distinct = new(StringComparer.OrdinalIgnoreCase);
        string[] segments = header.Split(',');
        for (int order = 0; order < segments.Length; order++)
        {
            if (!TryParseLanguageRange(segments[order], order, out LanguageRange range))
            {
                continue;
            }

            if (!distinct.TryGetValue(range.Value, out LanguageRange existing)
                || range.Quality > existing.Quality)
            {
                distinct[range.Value] = range with
                {
                    Order = existing == default ? order : existing.Order
                };
            }
        }

        return distinct.Values
            .OrderByDescending(static range => range.Quality)
            .ThenBy(static range => range.Order)
            .ToArray();
    }

    private static bool TryParseLanguageRange(string segment, int order, out LanguageRange range)
    {
        range = default;
        string[] parts = segment.Split(';');
        string value = parts[0].Trim();
        if (!IsValidLanguageRange(value))
        {
            return false;
        }

        double quality = 1;
        bool qualitySeen = false;
        for (int index = 1; index < parts.Length; index++)
        {
            string parameter = parts[index].Trim();
            int separator = parameter.IndexOf('=');
            if (separator <= 0
                || !string.Equals(parameter[..separator].Trim(), "q", StringComparison.OrdinalIgnoreCase)
                || qualitySeen
                || !TryParseQuality(parameter[(separator + 1)..].Trim(), out quality))
            {
                return false;
            }

            qualitySeen = true;
        }

        range = new LanguageRange(value, quality, order);
        return true;
    }

    private static bool IsValidLanguageRange(string value)
    {
        if (value == "*")
        {
            return true;
        }

        if (value.Length is < 1 or > 63)
        {
            return false;
        }

        string[] subtags = value.Split('-');
        return subtags.Length > 0
            && subtags.All(static subtag =>
                subtag.Length is >= 1 and <= 8
                && subtag.All(char.IsAsciiLetterOrDigit));
    }

    private static bool TryParseQuality(string value, out double quality)
    {
        quality = 0;
        if (value.Length is < 1 or > 5
            || value[0] is not ('0' or '1')
            || value.Length > 1 && value[1] != '.')
        {
            return false;
        }

        for (int index = 2; index < value.Length; index++)
        {
            if (!char.IsAsciiDigit(value[index])
                || value[0] == '1' && value[index] != '0')
            {
                return false;
            }
        }

        return double.TryParse(value, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out quality)
            && quality is >= 0 and <= 1;
    }

    private readonly record struct LanguageRange(string Value, double Quality, int Order);
}

internal static class PublicLocaleRequest
{
    private static readonly object s_resolutionKey = new();

    internal static LocaleResolutionResult Resolve(HttpContext context, ILocaleResolver resolver)
    {
        if (context.Items.TryGetValue(s_resolutionKey, out object? cached)
            && cached is LocaleResolutionResult result)
        {
            return result;
        }

        LocaleDescriptor? explicitLocale =
            LocalePreferenceCookieService.TryRead(context, out LocaleDescriptor parsedCookie)
                ? parsedCookie
                : null;

        result = resolver.Resolve(new LocaleResolutionInput(
            explicitLocale,
            context.Request.Headers.AcceptLanguage.ToString(),
            LocaleCatalog.Default));
        context.Items[s_resolutionKey] = result;
        return result;
    }
}

internal static class PublicLocaleCacheIdentity
{
    private const string Marker = ":locale:";

    internal static string Build(string routeKey, LocaleDescriptor locale)
        => string.Concat(routeKey, Marker, locale.Code);

    internal static bool TryParse(string value, out string routeKey, out LocaleDescriptor locale)
    {
        int marker = value.LastIndexOf(Marker, StringComparison.Ordinal);
        if (marker <= 0
            || !LocaleCatalog.TryParse(value[(marker + Marker.Length)..], out locale)
            || !string.Equals(
                value[(marker + Marker.Length)..],
                locale.Code,
                StringComparison.Ordinal))
        {
            routeKey = string.Empty;
            locale = null!;
            return false;
        }

        routeKey = value[..marker];
        return !string.IsNullOrWhiteSpace(routeKey);
    }
}
