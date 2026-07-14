using System.Globalization;
using System.Text;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Spa;

internal readonly record struct PublicSearchRequestResolution(
    bool IsBadRequest,
    string? RedirectLocation)
{
    public bool RequiresRedirect => !string.IsNullOrEmpty(RedirectLocation);

    public static PublicSearchRequestResolution Accept { get; } = new(false, null);

    public static PublicSearchRequestResolution BadRequest { get; } = new(true, null);
}

internal static class PublicSearchRequestPolicy
{
    private const string QueryKey = "q";
    private const string SortKey = "sort";
    private const string PageKey = "page";

    public static bool IsSearchPath(PathString path)
        => string.Equals(path.Value, PublicRouteIdentityRegistry.SearchPath, StringComparison.OrdinalIgnoreCase)
            || string.Equals(path.Value, PublicRouteIdentityRegistry.SearchPath + "/", StringComparison.OrdinalIgnoreCase);

    public static PublicSearchRequestResolution Resolve(HttpRequest request)
    {
        string rawQuery = request.QueryString.Value ?? string.Empty;
        if (rawQuery.Length > PublicSearchRoutePolicy.MaxQueryStringChars)
        {
            return PublicSearchRequestResolution.BadRequest;
        }

        IQueryCollection query = request.Query;
        string rawKeyword = FirstValue(query[QueryKey]);
        if (!TryNormalizeKeyword(rawKeyword, out string keyword))
        {
            return PublicSearchRequestResolution.BadRequest;
        }

        var canonicalQuery = new List<KeyValuePair<string, string?>>(3);
        if (keyword.Length > 0)
        {
            canonicalQuery.Add(new KeyValuePair<string, string?>(QueryKey, keyword));

            string sort = FirstValue(query[SortKey]).Trim().ToLowerInvariant();
            if (sort is PublicSearchRoutePolicy.LatestSort or PublicSearchRoutePolicy.HotSort)
            {
                canonicalQuery.Add(new KeyValuePair<string, string?>(SortKey, sort));
            }

            string rawPage = FirstValue(query[PageKey]).Trim();
            if (TryParsePage(rawPage, out int page) && page > 1)
            {
                canonicalQuery.Add(new KeyValuePair<string, string?>(PageKey, page.ToString(CultureInfo.InvariantCulture)));
            }
        }

        string canonicalQueryString = QueryString.Create(canonicalQuery).Value ?? string.Empty;
        bool canonicalPath = string.Equals(
            request.Path.Value,
            PublicRouteIdentityRegistry.SearchPath,
            StringComparison.Ordinal);
        bool canonicalKeys = query.Keys.All(static key => key is QueryKey or SortKey or PageKey);
        bool singleValues = query.All(static pair => pair.Value.Count <= 1);
        if (canonicalPath
            && canonicalKeys
            && singleValues
            && string.Equals(rawQuery, canonicalQueryString, StringComparison.Ordinal))
        {
            return PublicSearchRequestResolution.Accept;
        }

        string location = string.Concat(
            request.PathBase.Value,
            PublicRouteIdentityRegistry.SearchPath,
            canonicalQueryString);
        return new PublicSearchRequestResolution(false, location);
    }

    internal static bool TryNormalizeKeyword(string value, out string normalized)
    {
        normalized = string.Empty;
        if (string.IsNullOrWhiteSpace(value))
        {
            return true;
        }

        string formC;
        try
        {
            formC = value.Normalize(NormalizationForm.FormC);
        }
        catch (ArgumentException)
        {
            return false;
        }

        var builder = new StringBuilder(Math.Min(formC.Length, PublicSearchRoutePolicy.MaxKeywordChars));
        bool pendingSpace = false;
        foreach (char character in formC)
        {
            if (char.IsWhiteSpace(character))
            {
                pendingSpace = builder.Length > 0;
                continue;
            }

            if (char.IsControl(character))
            {
                return false;
            }

            if (pendingSpace)
            {
                builder.Append(' ');
                pendingSpace = false;
            }

            builder.Append(character);
            if (builder.Length > PublicSearchRoutePolicy.MaxKeywordChars)
            {
                return false;
            }
        }

        normalized = builder.ToString();
        return true;
    }

    private static bool TryParsePage(string value, out int page)
    {
        page = 1;
        if (value.Length == 0)
        {
            return true;
        }

        return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out page)
            && page >= 1
            && page <= PublicSearchRoutePolicy.MaxPage;
    }

    private static string FirstValue(StringValues values)
        => values.Count == 0 ? string.Empty : values[0] ?? string.Empty;
}
