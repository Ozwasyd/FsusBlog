using System.Globalization;

using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicRouteIdentity
{
    private static readonly string s_articlePathPrefix = PublicRouteIdentityRegistry.ArticlePathPrefix;
    private static readonly string s_categoryPathPrefix = PublicRouteIdentityRegistry.CategoryPathPrefix;
    private static readonly string s_tagPathPrefix = PublicRouteIdentityRegistry.TagPathPrefix;
    private static readonly string s_articleRoutePrefix = string.Concat(PublicRouteIdentityRegistry.ArticleBucket, ":");
    private static readonly string s_categoryRoutePrefix = string.Concat(PublicRouteIdentityRegistry.CategoryBucket, ":");
    private static readonly string s_tagRoutePrefix = string.Concat(PublicRouteIdentityRegistry.TagBucket, ":");
    private static readonly string s_tagNameRoutePrefix = string.Concat(PublicRouteIdentityRegistry.TagNameBucket, ":");
    private const string PageRouteMarker = ":page:";

    internal static bool TryResolveKind(PathString path, out PublicPageKind kind)
    {
        kind = PublicPageKind.Unknown;

        string? value = path.Value;
        if (string.IsNullOrEmpty(value))
        {
            kind = PublicPageKind.Home;
            return true;
        }

        ReadOnlySpan<char> normalizedPath = value.AsSpan();
        if (normalizedPath.IsEmpty || normalizedPath.SequenceEqual("/"))
        {
            kind = PublicPageKind.Home;
            return true;
        }

        if (TryMatchPositiveIdPath(normalizedPath, s_articlePathPrefix, out _))
        {
            kind = PublicPageKind.ArticleDetail;
            return true;
        }

        if (TryMatchPositiveIdPath(normalizedPath, s_categoryPathPrefix, out _) ||
            TryMatchTagPath(normalizedPath))
        {
            kind = PublicPageKind.Filter;
            return true;
        }

        if (PublicAotPageCatalog.TryGetByStaticPath(normalizedPath, out PublicAotPageDescriptor descriptor))
        {
            kind = descriptor.Kind;
            return true;
        }

        return false;
    }

    internal static string BuildRouteKey(HttpContext context, PublicPageKind kind)
    {
        string path = context.Request.Path.Value ?? string.Empty;
        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(kind);

        if (!string.IsNullOrWhiteSpace(descriptor.FixedRouteKey))
        {
            return descriptor.FixedRouteKey;
        }

        return kind switch
        {
            PublicPageKind.ArticleDetail when TryResolvePathId(context, s_articlePathPrefix, out int id) => BuildArticleRouteKey(id),
            PublicPageKind.Filter => BuildFilterRouteKey(context, path),
            _ => path
        };
    }

    internal static string NormalizeRouteKey(PublicPageId pageId, string routeKey, int? articleId)
    {
        string resolved = (routeKey ?? string.Empty).Trim();
        if (articleId is > 0)
        {
            resolved = resolved.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
        }

        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(pageId);
        if (string.IsNullOrWhiteSpace(descriptor.FixedRouteKey))
        {
            return resolved;
        }

        return SupportsPagination(pageId)
            ? BuildPaginatedRouteKey(descriptor.FixedRouteKey, ParsePageRouteKey(resolved))
            : descriptor.FixedRouteKey;
    }

    internal static string BuildCanonicalPath(PublicPageId pageId, string routeKey, int? articleId)
    {
        if (PublicAotPageCatalog.TryGet(pageId, out PublicAotPageDescriptor? descriptor) &&
            !string.IsNullOrWhiteSpace(descriptor.CanonicalFixedPath))
        {
            return descriptor.CanonicalFixedPath;
        }

        return pageId switch
        {
            PublicPageId.ArticleDetail => BuildCanonicalArticlePath(routeKey, articleId),
            PublicPageId.Filter => BuildCanonicalFilterPath(routeKey),
            _ => "/"
        };
    }

    internal static bool SupportsPagination(PublicPageId pageId)
        => pageId is PublicPageId.Home or PublicPageId.Filter;

    internal static string BuildPaginatedRouteKey(string routeKey, int page)
    {
        string baseRouteKey = StripPagination(routeKey);
        return page <= 1
            ? baseRouteKey
            : string.Concat(baseRouteKey, PageRouteMarker, page.ToString(CultureInfo.InvariantCulture));
    }

    internal static int ParsePageRouteKey(string routeKey)
    {
        string normalized = (routeKey ?? string.Empty).Trim();
        int markerIndex = normalized.LastIndexOf(PageRouteMarker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex <= 0)
        {
            return 1;
        }

        return int.TryParse(normalized.AsSpan(markerIndex + PageRouteMarker.Length), NumberStyles.None, CultureInfo.InvariantCulture, out int page)
            && page > 1
                ? page
                : 1;
    }

    internal static string StripPagination(string routeKey)
    {
        string normalized = (routeKey ?? string.Empty).Trim();
        int markerIndex = normalized.LastIndexOf(PageRouteMarker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex <= 0)
        {
            return normalized;
        }

        return int.TryParse(normalized.AsSpan(markerIndex + PageRouteMarker.Length), NumberStyles.None, CultureInfo.InvariantCulture, out int page)
            && page > 1
                ? normalized[..markerIndex]
                : normalized;
    }

    internal static string BuildPaginationQueryString(int page)
        => page <= 1
            ? string.Empty
            : string.Concat("?page=", page.ToString(CultureInfo.InvariantCulture));

    internal static string? ResolveRouteBucket(PublicPageId pageId, string routeKey)
    {
        if (string.IsNullOrEmpty(routeKey))
        {
            return null;
        }

        int separatorIndex = routeKey.IndexOf(':');
        if (separatorIndex <= 0)
        {
            return null;
        }

        string bucket = routeKey[..separatorIndex];
        return pageId switch
        {
            PublicPageId.ArticleDetail when string.Equals(bucket, PublicRouteIdentityRegistry.ArticleBucket, StringComparison.Ordinal) => bucket,
            PublicPageId.Filter when string.Equals(bucket, PublicRouteIdentityRegistry.CategoryBucket, StringComparison.Ordinal) => bucket,
            PublicPageId.Filter when string.Equals(bucket, PublicRouteIdentityRegistry.TagBucket, StringComparison.Ordinal) => bucket,
            PublicPageId.Filter when string.Equals(bucket, PublicRouteIdentityRegistry.TagNameBucket, StringComparison.Ordinal) => bucket,
            _ => null
        };
    }

    internal static string BuildArticleRouteKey(int articleId)
        => string.Concat(PublicRouteIdentityRegistry.ArticleBucket, ":", Math.Max(0, articleId));

    internal static int ParseArticleRouteKey(string routeKey)
        => ResolveId((routeKey ?? string.Empty).Trim(), s_articleRoutePrefix);

    internal static string BuildCategoryRouteKey(int categoryId)
        => string.Concat(PublicRouteIdentityRegistry.CategoryBucket, ":", Math.Max(0, categoryId));

    internal static string BuildTagIdRouteKey(int tagId)
        => string.Concat(PublicRouteIdentityRegistry.TagBucket, ":", Math.Max(0, tagId));

    internal static string BuildTagPath(int tagId)
        => string.Concat(s_tagPathPrefix, Math.Max(0, tagId));

    internal static string BuildTagNameRouteKey(string tagName)
        => string.Concat(
            PublicRouteIdentityRegistry.TagNameBucket,
            ":",
            PublicTagUrlIdentity.NormalizeDisplayName(Uri.UnescapeDataString(tagName)));

    internal static string BuildCategoryPath(int categoryId)
        => string.Concat(s_categoryPathPrefix, Math.Max(0, categoryId));

    internal static ParsedFilterRouteIdentity ParseFilterRouteKey(string routeKey)
    {
        string normalizedRouteKey = StripPagination(routeKey);

        if (normalizedRouteKey.StartsWith(s_categoryRoutePrefix, StringComparison.OrdinalIgnoreCase))
        {
            int categoryId = ResolveId(normalizedRouteKey, s_categoryRoutePrefix);
            return new ParsedFilterRouteIdentity(
                FilterType: "category",
                FilterKey: BuildCategoryRouteKey(categoryId),
                FilterId: categoryId,
                FilterName: null,
                CategoryId: categoryId,
                TagId: null);
        }

        if (normalizedRouteKey.StartsWith(s_tagRoutePrefix, StringComparison.OrdinalIgnoreCase))
        {
            int tagId = ResolveId(normalizedRouteKey, s_tagRoutePrefix);
            return new ParsedFilterRouteIdentity(
                FilterType: "tag",
                FilterKey: BuildTagIdRouteKey(tagId),
                FilterId: tagId,
                FilterName: null,
                CategoryId: null,
                TagId: tagId);
        }

        if (normalizedRouteKey.StartsWith(s_tagNameRoutePrefix, StringComparison.OrdinalIgnoreCase))
        {
            string tagName = Uri.UnescapeDataString(normalizedRouteKey[s_tagNameRoutePrefix.Length..]).Trim();
            return new ParsedFilterRouteIdentity(
                FilterType: "tag",
                FilterKey: BuildTagNameRouteKey(tagName),
                FilterId: 0,
                FilterName: tagName,
                CategoryId: null,
                TagId: null);
        }

        return new ParsedFilterRouteIdentity(
            FilterType: "search",
            FilterKey: normalizedRouteKey,
            FilterId: 0,
            FilterName: null,
            CategoryId: null,
            TagId: null);
    }

    private static string BuildFilterRouteKey(HttpContext context, string path)
    {
        if (path.StartsWith(s_categoryPathPrefix, StringComparison.OrdinalIgnoreCase) &&
            TryResolvePathId(context, s_categoryPathPrefix, out int categoryId))
        {
            return BuildCategoryRouteKey(categoryId);
        }

        if (path.StartsWith(s_tagPathPrefix, StringComparison.OrdinalIgnoreCase))
        {
            string segment = GetRouteSegment(context, s_tagPathPrefix);
            string decodedSegment = Uri.UnescapeDataString(segment);
            if (int.TryParse(decodedSegment, out int tagId) && tagId > 0)
            {
                return BuildTagIdRouteKey(tagId);
            }

            if (!string.IsNullOrWhiteSpace(segment))
            {
                return BuildTagNameRouteKey(segment);
            }
        }

        return $"filter:{NormalizeKeyPart(path)}";
    }

    private static string BuildCanonicalArticlePath(string routeKey, int? articleId)
    {
        int resolvedArticleId = articleId is > 0 ? articleId.Value : ParseArticleRouteKey(routeKey);
        return resolvedArticleId > 0
            ? string.Concat(s_articlePathPrefix, resolvedArticleId)
            : "/";
    }

    private static string BuildCanonicalFilterPath(string routeKey)
    {
        routeKey = StripPagination(routeKey);
        if (routeKey.StartsWith(s_categoryRoutePrefix, StringComparison.OrdinalIgnoreCase))
        {
            return string.Concat(s_categoryPathPrefix, routeKey[s_categoryRoutePrefix.Length..]);
        }

        if (routeKey.StartsWith(s_tagRoutePrefix, StringComparison.OrdinalIgnoreCase))
        {
            return string.Concat(s_tagPathPrefix, routeKey[s_tagRoutePrefix.Length..]);
        }

        if (routeKey.StartsWith(s_tagNameRoutePrefix, StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        return "/";
    }

    private static int ResolveId(string routeKey, string prefix)
        => routeKey.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
           int.TryParse(routeKey[prefix.Length..], out int id)
            ? Math.Max(0, id)
            : 0;

    private static string NormalizeKeyPart(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "empty";
        }

        return value.Trim()
            .Replace(':', '_')
            .Replace('/', '_')
            .Replace('?', '_')
            .Replace('&', '_')
            .Replace('=', '_');
    }

    private static bool TryResolvePathId(HttpContext context, string prefix, out int id)
    {
        id = 0;
        if (int.TryParse(context.Request.RouteValues["id"]?.ToString(), out id) && id > 0)
        {
            return true;
        }

        return TryMatchPositiveIdPath(context.Request.Path.Value.AsSpan(), prefix, out id);
    }

    private static string GetRouteSegment(HttpContext context, string prefix)
    {
        string routeValue = context.Request.RouteValues["id"]?.ToString() ?? string.Empty;
        if (!string.IsNullOrWhiteSpace(routeValue))
        {
            return routeValue.Trim();
        }

        string path = context.Request.Path.Value ?? string.Empty;
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return string.Empty;
        }

        ReadOnlySpan<char> segment = path.AsSpan(prefix.Length);
        while (segment.Length > 1 && segment[^1] == '/')
        {
            segment = segment[..^1];
        }

        return segment.ToString();
    }

    private static bool TryMatchPositiveIdPath(ReadOnlySpan<char> path, string prefix, out int id)
    {
        id = 0;
        if (!path.StartsWith(prefix.AsSpan(), StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        ReadOnlySpan<char> segment = path[prefix.Length..];
        return !segment.IsEmpty
            && segment.IndexOf('/') < 0
            && int.TryParse(segment, out id)
            && id > 0;
    }

    private static bool TryMatchTagPath(ReadOnlySpan<char> path)
    {
        if (!path.StartsWith(s_tagPathPrefix.AsSpan(), StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        ReadOnlySpan<char> rawSegment = path[s_tagPathPrefix.Length..];
        while (rawSegment.Length > 1 && rawSegment[^1] == '/')
        {
            rawSegment = rawSegment[..^1];
        }

        if (rawSegment.IsEmpty || rawSegment.Length > 512 || rawSegment.IndexOf('/') >= 0 || !HasValidPercentEncoding(rawSegment))
        {
            return false;
        }

        string decoded;
        try
        {
            decoded = Uri.UnescapeDataString(rawSegment.ToString());
        }
        catch (UriFormatException)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(decoded)
            || decoded.Length > 128
            || !string.Equals(decoded, decoded.Trim(), StringComparison.Ordinal)
            || decoded.IndexOfAny(['/', '\\']) >= 0
            || decoded.Any(static ch => char.IsControl(ch)))
        {
            return false;
        }

        if (int.TryParse(decoded, out int numericId))
        {
            return numericId > 0;
        }

        return decoded[0] is not '+' and not '-';
    }

    private static bool HasValidPercentEncoding(ReadOnlySpan<char> value)
    {
        for (int index = 0; index < value.Length; index++)
        {
            if (value[index] != '%')
            {
                continue;
            }

            if (index + 2 >= value.Length || !IsHex(value[index + 1]) || !IsHex(value[index + 2]))
            {
                return false;
            }

            index += 2;
        }

        return true;
    }

    private static bool IsHex(char value)
        => value is >= '0' and <= '9'
            or >= 'a' and <= 'f'
            or >= 'A' and <= 'F';

    internal readonly record struct ParsedFilterRouteIdentity(
        string FilterType,
        string FilterKey,
        int FilterId,
        string? FilterName,
        int? CategoryId,
        int? TagId);
}
