using System.Globalization;

namespace FsusBlog.Server.Infrastructure.Cache;

internal static class TaxonomyExactMetadataCache
{
    internal const string CategoryKind = "category";
    internal const string TagKind = "tag";

    internal static string ForCategory(int id)
        => string.Create(CultureInfo.InvariantCulture, $"category:{id}");

    internal static string ForTag(int id)
        => string.Create(CultureInfo.InvariantCulture, $"tag:{id}");
}
