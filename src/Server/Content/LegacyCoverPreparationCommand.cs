using System.Text.Json;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Content;

internal static partial class LegacyMediaPreparationCommand
{
    private static void ValidateCoverRequest(LegacyCoverPreparationRequest? request, byte[] bytes)
    {
        if (request is null || request.Format != LegacyCoverPreparationRequest.RequestFormat ||
            !IsHash(request.PlanSha256) || !IsHash(request.CandidateSha256) || !IsHash(request.ProofSha256) ||
            !IsHash(request.CustodyManifestSha256) || request.SourceSiteId == Guid.Empty ||
            request.TargetSiteId == Guid.Empty || request.SourceSiteId == request.TargetSiteId ||
            request.Assets is not { Length: >= 1 and <= LegacyCoverPreparationRequest.MaxAssets } ||
            request.References is not { Length: >= 1 and <= LegacyCoverPreparationRequest.MaxReferences })
            throw new InvalidOperationException("The reviewed cover request has an invalid format or bounds.");
        if (request.Assets.Any(asset => asset is null || asset.AssetId == Guid.Empty || !IsHash(asset.RawSha256) ||
            asset.RawBytes is < 1 or > MediaImage.MaxBytes || asset.Width is < 1 or > 8192 ||
            asset.Height is < 1 or > 8192 || (long)asset.Width * asset.Height > 16 * 1024 * 1024 ||
            asset.SourceOwnerId <= 0 || asset.TargetOwnerId == Guid.Empty ||
            asset.MediaType is not ("image/png" or "image/jpeg") ||
            asset.Extension is not (".png" or ".jpg" or ".jpeg")) ||
            request.Assets.Sum(asset => (long)asset.RawBytes) > LegacyCoverPreparationRequest.MaxTotalBytes ||
            request.Assets.Select(asset => asset.AssetId).Distinct().Count() != request.Assets.Length ||
            !request.Assets.SequenceEqual(request.Assets.OrderBy(asset => asset.AssetId)))
            throw new InvalidOperationException("Cover preparation requires bounded, owned PNG/JPEG images.");
        var assets = request.Assets.ToDictionary(asset => asset.AssetId);
        if (request.References.Any(reference => reference is null || reference.ArticleId <= 0 ||
            reference.SourceRevisionId <= 0 || reference.Revision <= 0 || reference.Role != "cover" ||
            reference.SourceKind is not ("article" or "revision") ||
            reference.SourceId != (reference.SourceKind == "article" ? reference.ArticleId : reference.SourceRevisionId) ||
            !assets.TryGetValue(reference.AssetId, out var asset) || reference.SourceOwnerId != asset.SourceOwnerId ||
            reference.TargetOwnerId != asset.TargetOwnerId) ||
            !assets.Keys.ToHashSet().SetEquals(request.References.Select(reference => reference.AssetId)) ||
            request.References.Select(reference => (reference.SourceKind, reference.ArticleId, reference.SourceId)).Distinct().Count() != request.References.Length ||
            request.References.GroupBy(reference => (reference.ArticleId, reference.SourceRevisionId)).Any(group => group.Select(row => row.AssetId).Distinct().Count() != 1) ||
            !request.References.SequenceEqual(request.References.OrderBy(row => row.AssetId).ThenBy(row => row.SourceKind, StringComparer.Ordinal)
                .ThenBy(row => row.ArticleId).ThenBy(row => row.SourceId)) ||
            !JsonSerializer.SerializeToUtf8Bytes(request, LegacyMediaPreparation.Json).AsSpan().SequenceEqual(bytes))
            throw new InvalidOperationException("The reviewed cover coordinates, ownership or canonical bytes differ.");
    }

    private static void ValidateCoverCustody(LegacyCoverPreparationRequest request, byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 12, AllowDuplicateProperties = false });
        var manifest = document.RootElement;
        ValidateCustodyAssets(manifest, request.Assets, request.SourceSiteId, request.TargetSiteId, request.References.Length, "public");
        var expected = request.References.ToDictionary(row => (row.AssetId, row.SourceKind, row.SourceId, row.ArticleId));
        foreach (var row in manifest.GetProperty("references").EnumerateArray())
            if (row.GetProperty("referenceCount").GetInt32() != 1 || !expected.Remove((row.GetProperty("assetId").GetGuid(),
                row.GetProperty("sourceKind").GetString()!, row.GetProperty("sourceId").GetInt64(), row.GetProperty("articleId").GetInt32())))
                throw new InvalidOperationException("Cover preparation requires exact single-use custody references.");
        if (expected.Count != 0) throw new InvalidOperationException("Cover preparation references are incomplete.");
    }
}
