using System.Data.Common;
using System.Text.Json;

internal static partial class Migration
{
    private sealed record LegacyImportCoverInput(string Package, string PackageSha256, string Proof, string ProofSha256);
    private sealed record LegacyImportCoverSeal(int Version, string ProofSha256, string MappingSha256, LegacyImportMediaSeal Media);
    private sealed record LegacyImportCoverEvidence(LegacyImportCoverSeal Seal, LegacyMediaManifest Package,
        LegacyCoverCandidate[] Rows, LegacyProjection[] Projections, string SourceCluster);
    private static readonly CandidateTable LegacyCoverShadow = Candidate("shadow_cover_mapping", 1,
        "source_kind COLLATE BINARY, article_id, source_id", """
        source_kind:text article_id source_id source_revision_id revision mapping_json:text
        """, nonNull: ["source_kind", "article_id", "source_id", "source_revision_id", "revision", "mapping_json"]);

    private static async Task<LegacyImportCoverEvidence> ReadLegacyImportCoversAsync(LegacyImportCoverInput input,
        LegacyMediaManifest package, (OwnerMap Map, string Digest) owners, LegacySource source, DbTransaction tx,
        CancellationToken ct)
    {
        if (package.Review.Provider != "postgres") throw new InvalidOperationException("Cover staging requires a PostgreSQL package.");
        var original = await ReadLegacyCoverProofFileAsync(input.Proof, input.ProofSha256, ct);
        using var document = JsonDocument.Parse(original);
        var projections = document.RootElement.GetProperty("sourceProjections").Deserialize<LegacyProjection[]>(OwnerMapJson)
            ?? throw new InvalidOperationException("Cover proof projections are unavailable.");
        var revisions = projections.Single(row => row.Table == Revision).Sha256 ?? throw new InvalidOperationException("Missing revision digest.");
        var publications = projections.Single(row => row.Table == Publication).Sha256 ?? throw new InvalidOperationException("Missing publication digest.");
        var fresh = await ReadLegacyCoverProofAsync(package, input.PackageSha256, owners.Map, owners.Digest,
            revisions, publications, source, tx, ct);
        if (fresh + Environment.NewLine != original)
            throw new InvalidOperationException("Cover proof no longer matches the exact source snapshot, owners or package.");
        var rows = document.RootElement.GetProperty("candidates").Deserialize<LegacyCoverCandidate[]>(OwnerMapJson)
            ?? throw new InvalidOperationException("Cover mappings are unavailable.");
        // The first converter is cover-only. General/body references are not authorized by a cover witness.
        var coordinates = rows.Select(row => (row.AssetId, row.SourceKind, row.SourceId, row.ArticleId)).ToHashSet();
        if (rows.Length == 0 || coordinates.Count != rows.Length || package.Files.Any(file => file.StorageClass != "public") ||
            package.References.Length != rows.Length || package.References.Any(reference => reference.ReferenceCount != 1 ||
                !coordinates.Contains((reference.AssetId, reference.SourceKind, reference.SourceId, reference.ArticleId))) ||
            !package.Files.Select(file => file.AssetId).ToHashSet().SetEquals(rows.Select(row => row.AssetId)))
            throw new InvalidOperationException("Cover staging requires complete cover-only public assets and single-use exact references.");
        var seal = new LegacyImportCoverSeal(1, input.ProofSha256, DigestMediaDocument(rows),
            LegacyImportMediaBinding(new(input.Package, input.PackageSha256), package));
        var pg = (Npgsql.NpgsqlTransaction)tx;
        return new(seal, package, rows,
            [new(LegacyMediaAssets, package.Files.Length, package.Review.AssetMetadataSha256),
             new(LegacyMediaReferences, package.References.Length, package.Review.ReferenceSha256)],
            await ReadLegacyPostgresClusterAsync(pg.Connection!, pg, ct));
    }

    private static CandidateTable[] LegacyImportCoverDefinitions(ImportPlan plan)
    {
        ValidateLegacyImportCoverPlan(plan);
        return plan.Covers is null ? [] : [LegacyMediaAssetShadow, LegacyMediaReferenceShadow, LegacyCoverShadow];
    }

    private static void ValidateLegacyImportCoverPlan(ImportPlan plan)
    {
        if (plan.Covers is not { } cover) return;
        if (cover.Version != 1 || plan.Version != ImportPlanVersion || plan.Provider != "postgres" || plan.Media is not null ||
            plan.SourceSeal?.Provenance != PostgresClusterProvenance || !IsSha256(cover.ProofSha256) || !IsSha256(cover.MappingSha256) ||
            !IsSha256(cover.Media.ManifestSha256) || !IsSha256(cover.Media.SourceDatabaseSha256) ||
            !IsSha256(cover.Media.TargetDatabaseSha256) || cover.Media.SourceSiteId == Guid.Empty ||
            cover.Media.SourceSiteId == plan.TargetSiteId)
            throw new InvalidOperationException("The cover staging plan has an unsupported seal or scope.");
        foreach (var (source, target) in new[] { (LegacyMediaAssets, LegacyMediaAssetShadow.Name),
                     (LegacyMediaReferences, LegacyMediaReferenceShadow.Name) })
        {
            var inputs = plan.SourceProjections.Where(row => row.Table == source).ToArray();
            var outputs = plan.ExpectedTables.Where(row => row.Table == target).ToArray();
            if (inputs is not [var input] || outputs is not [var output] || input.Rows <= 0 || input.Rows != output.Rows ||
                !IsSha256(input.Sha256) || !IsSha256(output.Sha256))
                throw new InvalidOperationException("The cover staging plan lacks exact asset/reference projections.");
        }
        var mappings = plan.ExpectedTables.Where(row => row.Table == LegacyCoverShadow.Name).ToArray();
        if (mappings is not [var mapping] || mapping.Rows <= 0 || !IsSha256(mapping.Sha256) ||
            mapping.Rows != plan.ExpectedTables.Single(row => row.Table == LegacyMediaReferenceShadow.Name).Rows)
            throw new InvalidOperationException("The cover staging plan lacks complete mapping projections.");
    }

    private static async Task<ShadowCount[]> StageLegacyCoverShadowAsync(LegacyShadow shadow,
        LegacyImportCoverEvidence evidence, CancellationToken ct)
    {
        var package = evidence.Package;
        var rows = evidence.Rows.ToDictionary(row => (row.AssetId, row.SourceKind, row.SourceId));
        await using var tx = shadow.Database.BeginTransaction();
        var assets = package.Files.OrderBy(file => file.AssetId).Select(file => (object?[])
            [file.AssetId.ToString("D"), file.StorageClass, file.StorageKey, file.MediaType, file.Extension, file.Bytes,
             file.Sha256, file.Width, file.Height, file.SourceOwnerId, file.TargetOwnerId!.Value.ToString("D"),
             "active", file.CreatedAtUtc, file.UpdatedAtUtc]);
        var references = package.References.OrderBy(row => row.AssetId).ThenBy(row => row.SourceKind, StringComparer.Ordinal)
            .ThenBy(row => row.SourceId).Select(row => (object?[])
            [row.AssetId.ToString("D"), row.SourceKind, row.SourceId, row.ArticleId,
             rows[(row.AssetId, row.SourceKind, row.SourceId)].Revision, row.ReferenceCount, row.AltText, row.UpdatedAtUtc]);
        var mappings = evidence.Rows.OrderBy(row => row.SourceKind, StringComparer.Ordinal).ThenBy(row => row.ArticleId)
            .ThenBy(row => row.SourceId).Select(row => (object?[])
            [row.SourceKind, row.ArticleId, row.SourceId, row.SourceRevisionId, row.Revision, JsonSerializer.Serialize(row, Json)]);
        var results = new[] {
            await WriteLegacyImportMediaShadowAsync(tx, LegacyMediaAssetShadow, assets, ct),
            await WriteLegacyImportMediaShadowAsync(tx, LegacyMediaReferenceShadow, references, ct),
            await WriteLegacyImportMediaShadowAsync(tx, LegacyCoverShadow, mappings, ct)
        };
        await tx.CommitAsync(ct);
        return results;
    }
}
