namespace FsusBlog.Server.Contracts.Assets;

/// <summary>
/// The single public-URL boundary for content assets. URLs are display
/// representations only and must never become database primary keys, cleanup
/// keys, or filesystem locators. The codec encodes an
/// <see cref="AssetRecord"/> into a public URL whose path directly carries the
/// normalized <see cref="AssetStorageKey"/>, and decodes that path back without
/// any database lookup.
/// </summary>
public sealed class PublicAssetUrlCodec
{
    public const string RoutePrefix = "/uploads/";

    public Uri ToPublicUrl(AssetRecord record, Uri publicBase)
    {
        ArgumentNullException.ThrowIfNull(record);
        if (!string.Equals(record.StorageClass, "public", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Only public content assets can be encoded as public URLs.");
        }

        if (!IsHttpBase(publicBase))
        {
            throw new ArgumentException(
                "Public asset base must be an absolute http(s) URL without query, fragment, or user info.",
                nameof(publicBase));
        }

        string url = publicBase.GetLeftPart(UriPartial.Authority)
            + RoutePrefix
            + record.StorageKey.Value;
        return new Uri(url, UriKind.Absolute);
    }

    public string ToPublicPath(AssetStorageKey storageKey)
        => RoutePrefix + storageKey.Value;

    public bool TryGetStorageKey(string? publicUrl, out AssetStorageKey storageKey)
    {
        storageKey = default;
        if (string.IsNullOrWhiteSpace(publicUrl))
        {
            return false;
        }

        string candidate = publicUrl.Trim();
        if (candidate.IndexOfAny(['?', '#', '\0', '\\']) >= 0
            || !candidate.StartsWith(RoutePrefix, StringComparison.Ordinal)
            || candidate.IndexOf('%') >= 0)
        {
            return false;
        }

        return AssetStorageKey.TryParse(candidate[RoutePrefix.Length..], out storageKey);
    }

    public bool TryGetStorageKey(Uri url, Uri expectedBase, out AssetStorageKey storageKey)
    {
        storageKey = default;
        if (!IsHttpBase(expectedBase)
            || !url.IsAbsoluteUri
            || (url.Scheme != Uri.UriSchemeHttp && url.Scheme != Uri.UriSchemeHttps)
            || url.Query.Length > 0
            || url.Fragment.Length > 0
            || url.UserInfo.Length > 0)
        {
            return false;
        }

        if (!string.Equals(
            url.GetLeftPart(UriPartial.Authority),
            expectedBase.GetLeftPart(UriPartial.Authority),
            StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!TryGetOriginalPath(url, out string path)
            || !path.StartsWith(RoutePrefix, StringComparison.Ordinal))
        {
            return false;
        }

        return AssetStorageKey.TryParse(path[RoutePrefix.Length..], out storageKey);
    }

    private static bool TryGetOriginalPath(Uri value, out string path)
    {
        path = string.Empty;
        string original = value.OriginalString;
        if (original.IndexOfAny(['?', '#', '%', '\0', '\\']) >= 0)
        {
            return false;
        }

        int schemeSeparator = original.IndexOf("://", StringComparison.Ordinal);
        if (schemeSeparator < 0)
        {
            return false;
        }

        int pathStart = original.IndexOf('/', schemeSeparator + 3);
        path = pathStart < 0 ? "/" : original[pathStart..];
        return true;
    }

    private static bool IsHttpBase(Uri value)
        => value.IsAbsoluteUri
            && (value.Scheme == Uri.UriSchemeHttp || value.Scheme == Uri.UriSchemeHttps)
            && value.Query.Length == 0
            && value.Fragment.Length == 0
            && value.UserInfo.Length == 0;
}
