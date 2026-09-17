using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Converts presentation-only Markdown/public URL references into the typed
/// AssetId values consumed by the reference ledger.
/// </summary>
internal sealed class ArticleAssetReferenceWriteBoundary(ISqlSugarClient db)
{
    private readonly PublicAssetUrlCodec _urlCodec = new();

    internal async Task<ArticleAssetReferenceWrite[]> ResolveAsync(
        string? markdownContent,
        string? coverImageUrl,
        CancellationToken cancellationToken = default)
    {
        var requested = new Dictionary<string, RequestedReference>(StringComparer.Ordinal);
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdownContent ?? string.Empty))
        {
            Add(reference.Url, reference.AltText, CountOccurrences(markdownContent, reference.Url));
        }

        Add(coverImageUrl, null, 1);
        if (requested.Count == 0)
        {
            return [];
        }

        string[] storageKeys = [.. requested.Keys.Order(StringComparer.Ordinal)];
        List<ContentAsset> assets = await db.Queryable<ContentAsset>()
            .Where(asset => storageKeys.Contains(asset.StorageKey))
            .ToListAsync(cancellationToken);
        Dictionary<string, ContentAsset> byKey = assets.ToDictionary(static asset => asset.StorageKey, StringComparer.Ordinal);
        string[] missing = [.. storageKeys.Where(key => !byKey.ContainsKey(key))];
        if (missing.Length > 0)
        {
            throw new InvalidOperationException("content_asset_reference_missing_asset:" + string.Join(',', missing));
        }

        var writes = new List<ArticleAssetReferenceWrite>(requested.Count);
        foreach ((string storageKey, RequestedReference reference) in requested.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            ContentAsset asset = byKey[storageKey];
            if (!ContentAssetStates.IsValid(asset.State))
            {
                throw new InvalidOperationException($"content_asset_not_active:{asset.AssetId}:{asset.State}");
            }

            writes.Add(new ArticleAssetReferenceWrite(
                AssetId.FromGuid(asset.AssetId),
                reference.Count,
                reference.AltText));
        }

        return [.. writes.OrderBy(static write => write.AssetId.ToString(), StringComparer.Ordinal)];

        void Add(string? publicUrl, string? altText, int count)
        {
            if (string.IsNullOrWhiteSpace(publicUrl) || count <= 0)
            {
                return;
            }

            if (!_urlCodec.TryGetStorageKey(publicUrl, out AssetStorageKey storageKey))
            {
                if (publicUrl.StartsWith(PublicAssetUrlCodec.RoutePrefix, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException($"content_asset_public_url_invalid:{publicUrl}");
                }

                return;
            }

            if (requested.TryGetValue(storageKey.Value, out RequestedReference? current))
            {
                string? normalizedAltText = NormalizeAltText(altText);
                string? deterministicAltText = new[] { current.AltText, normalizedAltText }
                    .Where(static value => value is not null)
                    .Order(StringComparer.Ordinal)
                    .FirstOrDefault();
                requested[storageKey.Value] = current with
                {
                    Count = checked(current.Count + count),
                    AltText = deterministicAltText
                };
            }
            else
            {
                requested[storageKey.Value] = new RequestedReference(count, NormalizeAltText(altText));
            }
        }
    }

    internal static string[] ExtractPublicAssetUrls(string? markdownContent, string? coverImageUrl)
    {
        var urls = new HashSet<string>(StringComparer.Ordinal);
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdownContent ?? string.Empty))
        {
            urls.Add(reference.Url);
        }

        if (!string.IsNullOrWhiteSpace(coverImageUrl)
            && coverImageUrl.StartsWith(PublicAssetUrlCodec.RoutePrefix, StringComparison.Ordinal))
        {
            urls.Add(coverImageUrl);
        }

        return [.. urls.Order(StringComparer.Ordinal)];
    }

    private static string? NormalizeAltText(string? value)
    {
        string? normalized = value?.Trim();
        return string.IsNullOrEmpty(normalized) ? null : normalized[..Math.Min(normalized.Length, 256)];
    }

    private static int CountOccurrences(string? source, string value)
    {
        int count = 0;
        int offset = 0;
        while (!string.IsNullOrEmpty(source)
            && offset < source.Length
            && source.IndexOf(value, offset, StringComparison.Ordinal) is int index
            && index >= 0)
        {
            count++;
            offset = index + value.Length;
        }

        return count;
    }

    private sealed record RequestedReference(int Count, string? AltText);
}

internal sealed record ArticleAssetReferenceWrite(
    AssetId AssetId,
    int ReferenceCount,
    string? AltText);
