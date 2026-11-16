using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using Npgsql;

internal static partial class Migration
{
    private sealed record PreparedLegacyMediaInput(string Package, string ManifestSha256, string NormalizerSha256);

    private static async Task<LegacyMediaPreparationRequest> BuildLegacyMediaPreparationRequestAsync(NpgsqlConnection target,
        NpgsqlTransaction tx, ImportPlan plan, string planSha256, string projectionSha256, LegacyMediaManifest media, CancellationToken ct)
    {
        var assets = media.Files.OrderBy(asset => asset.AssetId).Select(asset =>
        {
            if (asset.Bytes is < 1 or > LegacyMediaPreparation.MaxFileBytes || asset.Width is not (> 0 and <= 8192) ||
                asset.Height is not (> 0 and <= 8192) || asset.Width * asset.Height > 16L * 1024 * 1024 ||
                asset.SourceOwnerId is not > 0 || asset.TargetOwnerId is null ||
                asset.MediaType is not ("image/png" or "image/jpeg" or "image/webp"))
                throw new InvalidOperationException("Preparation requires supported private images with source dimensions and reviewed owners.");
            return new LegacyMediaPreparationAsset(asset.AssetId, asset.Sha256, checked((int)asset.Bytes),
                checked((int)asset.Width.Value), checked((int)asset.Height.Value), asset.MediaType, asset.Extension,
                asset.SourceOwnerId.Value, asset.TargetOwnerId.Value);
        }).ToArray();
        var expected = media.References.ToDictionary(reference => (reference.AssetId, reference.SourceId));
        var references = new List<LegacyMediaPreparationReference>(expected.Count);
        // Bind each global v1 revision and reviewed owner to its current-table key. Several retained private
        // revisions can reference the same asset. The original reference count and alt text remain part of the request.
        await using var command = new NpgsqlCommand($"""
            SELECT r.asset_id,r.article_id,r.source_id,r.revision,r.reference_count,r.alt_text
            FROM {ImportSchema}.shadow_content_asset_reference r
            JOIN {ImportSchema}.shadow_content_asset s ON s.id=r.asset_id
            JOIN public.article a ON a.id=r.article_id AND a.owner_id::text=s.target_owner_id
            JOIN public.article_revision v ON v.article_id=a.id AND v.revision=r.revision
            WHERE r.source_kind='revision'
            ORDER BY r.asset_id COLLATE "C",r.article_id,r.source_id
            """, target, tx);
        await using var rows = await command.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            var asset = Guid.ParseExact(rows.GetString(0), "D");
            var article = checked((int)rows.GetInt64(1));
            var sourceRevision = rows.GetInt64(2);
            var revision = rows.GetInt64(3);
            var count = checked((int)rows.GetInt64(4));
            var alt = rows.IsDBNull(5) ? null : rows.GetString(5);
            if (!expected.Remove((asset, sourceRevision), out var reference) || reference.ArticleId != article ||
                reference.ReferenceCount != count || reference.AltText != alt)
                throw new InvalidOperationException("The legacy attachment preparation references differ from the sealed custody package.");
            references.Add(new(asset, article, sourceRevision, revision, count, alt));
        }
        if (expected.Count != 0)
            throw new InvalidOperationException("The legacy attachment preparation references differ from the sealed custody package.");
        return new(LegacyMediaPreparation.RequestFormat, planSha256, projectionSha256, plan.Media!.ManifestSha256,
            plan.Media.SourceSiteId, plan.TargetSiteId, assets, references.ToArray());
    }

    private static async Task<LegacyMediaPreparationResult> ReadPreparedLegacyMediaAsync(PreparedLegacyMediaInput approved,
        LegacyMediaPreparationRequest request, byte[] requestBytes, CancellationToken ct, Action<LegacyMediaPreparedAsset, byte[]>? readImage = null)
        => await ReadPreparedLegacyMediaAssetsAsync(approved, request.Assets, requestBytes,
            LegacyMediaPreparation.ResultFormat, ct, readImage);

    private static async Task<LegacyMediaPreparationResult> ReadPreparedLegacyMediaAssetsAsync(PreparedLegacyMediaInput approved,
        LegacyMediaPreparationAsset[] assets, byte[] requestBytes, string resultFormat, CancellationToken ct,
        Action<LegacyMediaPreparedAsset, byte[]>? readImage = null, long maxTotalBytes = LegacyMediaPreparation.MaxTotalBytes)
    {
        if (!IsSha256(approved.ManifestSha256) || !IsSha256(approved.NormalizerSha256))
            throw new ArgumentException("Supply the independently recorded prepared manifest and normalizer SHA-256 values.");
        var requestSha256 = Convert.ToHexStringLower(SHA256.HashData(requestBytes));
        using var package = OpenLegacyMediaPackage(approved.Package);
        var manifestBytes = await package.ReadManifestAsync(approved.ManifestSha256, ct);
        var result = JsonSerializer.Deserialize<LegacyMediaPreparationResult>(manifestBytes, LegacyMediaPreparation.Json);
        if (result is null || result.Format != resultFormat || result.RequestSha256 != requestSha256 ||
            result.NormalizerSha256 != approved.NormalizerSha256 || result.Assets?.Length != assets.Length)
            throw new InvalidOperationException("The prepared media does not match its approved request and normalizer.");
        package.RequireExactFiles(assets.Select(asset => asset.AssetId));

        long total = 0;
        for (var index = 0; index < assets.Length; index++)
        {
            var input = assets[index];
            var output = result.Assets[index];
            var expectedFormat = input.MediaType switch { "image/png" => 1, "image/jpeg" => 2, "image/webp" => 3, _ => 0 };
            if (output is null || output.AssetId != input.AssetId || output.RawSha256 != input.RawSha256 ||
                output.Width != input.Width || output.Height != input.Height || output.Format != expectedFormat ||
                !IsSha256(output.NormalizedSha256) || output.Length is < 1 or > LegacyMediaPreparation.MaxFileBytes)
                throw new InvalidOperationException("Prepared media metadata differs from the reviewed source image.");
            total += output.Length;
            if (total > maxTotalBytes)
                throw new InvalidOperationException("Prepared media exceeds its verification byte budget.");
            await using var inputFile = package.OpenPayload(output.AssetId);
            if (inputFile.Length != output.Length)
                throw new InvalidOperationException("A prepared media payload differs from its sealed image metadata.");
            var encoded = new byte[output.Length];
            await inputFile.ReadExactlyAsync(encoded, ct);
            if (inputFile.ReadByte() != -1 || Convert.ToHexStringLower(SHA256.HashData(encoded)) != output.NormalizedSha256 ||
                !PublishedArticleImage.MatchesFormat(encoded, output.Format))
                throw new InvalidOperationException("A prepared media payload differs from its sealed image metadata.");
            readImage?.Invoke(output, encoded);
        }
        package.RequireExactFiles(assets.Select(asset => asset.AssetId));
        return result;
    }

    private static async Task VerifyPreparedLegacyMediaAsync(PreparedLegacyMediaInput approved,
        LegacyMediaPreparationRequest request, byte[] requestBytes, CancellationToken ct)
    {
        var result = await ReadPreparedLegacyMediaAsync(approved, request, requestBytes, ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            origin = LegacyMediaPreparation.ResultFormat,
            result.RequestSha256,
            preparedManifestSha256 = approved.ManifestSha256,
            normalizerSha256 = approved.NormalizerSha256,
            planSha256 = request.PlanSha256,
            projectionSha256 = request.ProjectionSha256,
            files = request.Assets.Length,
            references = request.References.Length,
            readyToApply = false
        }, Json));
    }
}
