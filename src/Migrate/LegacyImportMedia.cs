using System.Data.Common;
using System.Security.Cryptography;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyMediaAssets = "content_asset";
    private const string LegacyMediaReferences = "content_asset_reference";

    private sealed record LegacyImportMediaInput(string Path, string Sha256);
    private sealed record LegacyImportMediaSeal(string ManifestSha256, Guid SourceSiteId, string SourceDatabaseSha256,
        string TargetDatabaseSha256);
    private sealed record LegacyImportMediaSource(string Cluster, LegacyProjection[] Projections);

    private static readonly CandidateTable LegacyMediaAssetShadow = Candidate("shadow_content_asset", 1, "id COLLATE BINARY", """
        id:text storage_class:text storage_key:text media_type:text extension:text byte_length sha256:text width height
        owner_admin_principal_id target_owner_id:text state:text created_at_utc:text updated_at_utc:text
        """, nonNull: ["id", "storage_class", "storage_key", "media_type", "extension", "byte_length", "sha256",
            "owner_admin_principal_id", "target_owner_id", "state", "created_at_utc", "updated_at_utc"]);
    private static readonly CandidateTable LegacyMediaReferenceShadow = Candidate("shadow_content_asset_reference", 1,
        "asset_id COLLATE BINARY, source_kind COLLATE BINARY, source_id", """
        asset_id:text source_kind:text source_id article_id revision reference_count alt_text:text updated_at_utc:text
        """, nonNull: ["asset_id", "source_kind", "source_id", "article_id", "revision", "reference_count", "updated_at_utc"]);

    private static LegacyImportMediaSeal LegacyImportMediaBinding(LegacyImportMediaInput input, LegacyMediaManifest manifest) =>
        new(input.Sha256, manifest.Review.SourceSiteId, manifest.Review.SourceDatabaseSha256, manifest.Review.TargetDatabaseSha256);

    private static async Task<LegacyMediaManifest?> ReadLegacyImportMediaAsync(LegacyImportMediaInput? input,
        ImportPlan? approved, CancellationToken ct)
    {
        if (input is null && approved?.Media is null) return null;
        if (input is null || approved is not null && approved.Media?.ManifestSha256 != input.Sha256)
            throw new InvalidOperationException("Supply the original joined media package and the approved manifest SHA-256.");
        var package = await VerifyLegacyMediaPackageAsync(input.Path, input.Sha256, ct);
        if (package.Review.Provider != "postgres" || package.Files.Any(file => file.StorageClass != "private" || file.Bytes <= 0) ||
            package.References.Any(reference => reference.SourceKind != "revision") ||
            !package.Files.Select(file => file.AssetId).ToHashSet().SetEquals(package.References.Select(reference => reference.AssetId)))
            throw new InvalidOperationException("Joined legacy staging supports only referenced, nonempty private media in PostgreSQL.");
        if (approved is not null && (approved.Media != LegacyImportMediaBinding(input, package) ||
            approved.TargetSiteId != package.Review.TargetSiteId || approved.SchemaSha256 != package.Review.TargetSchemaSha256 ||
            approved.SourceAdminIdentitySha256 != package.Review.SourceAdminIdentitySha256))
            throw new InvalidOperationException("The joined media package disagrees with the original import plan.");
        return package;
    }

    private static async Task<LegacyImportMediaSource> ReadLegacyImportMediaSourceAsync(LegacyMediaManifest package,
        LegacySource source, DbTransaction tx, LegacyPostgresSourceSeal? seal, LegacyTable[] catalog,
        Dictionary<string, LegacyTable> tables, LegacyTable principals, CancellationToken ct)
    {
        if (tx is not NpgsqlTransaction postgres || seal?.Provenance != PostgresClusterProvenance ||
            source.Schema != package.Review.SourceSchema)
            throw new InvalidOperationException("Joined media requires the reviewed PostgreSQL source cluster, database and schema.");
        var cluster = await ReadLegacyPostgresClusterAsync(postgres.Connection!, postgres, ct);
        if (await FingerprintLegacyPostgresDatabaseAsync(postgres.Connection!, postgres, cluster, ct) != package.Review.SourceDatabaseSha256 ||
            await FingerprintLegacyPrincipalsAsync(source, tx, principals, null, ct) != package.Review.SourceAdminIdentitySha256)
            throw new InvalidOperationException("The joined media package does not belong to the sealed source database and principals.");

        var assetTable = RequireMediaTable(LegacyMediaAssets, AssetColumns);
        var referenceTable = RequireMediaTable(LegacyMediaReferences, AssetReferenceColumns);
        var assets = await ReadAssetMetadataAsync(source, tx, assetTable, ct);
        if (assets.Length != package.Files.Length || assets.Any(asset => asset.Owner is not > 0 || asset.StorageClass != "private" ||
            CheckAssetMetadata(asset) is not null) ||
            !assets.Select(asset => asset.Owner!.Value).ToHashSet().SetEquals(package.Review.Owners.Select(owner => owner.SourceAdminPrincipalId)))
            throw new InvalidOperationException("The original private media set differs from its verified package.");
        using var metadata = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var column in AssetColumns) AppendLegacyValue(metadata, column);
        foreach (var asset in assets) AppendAssetMetadata(metadata, asset);
        var metadataSha256 = FinishSourceSeal(metadata);
        if (metadataSha256 != package.Review.AssetMetadataSha256 || !LegacyMediaObjects(assets, package.Review.Owners).SequenceEqual(package.Files))
            throw new InvalidOperationException("The original private media metadata differs from its verified package.");
        var references = await VerifyAssetReferencesAsync(source, tx, referenceTable, tables[Article], tables[Revision],
            assets.ToDictionary(asset => asset.Id), _ => throw new InvalidOperationException("The original private media references are unsupported."), ct);
        if (references.Total != package.References.Length || references.Sha256 != package.Review.ReferenceSha256 ||
            !references.Bindings.SequenceEqual(package.References))
            throw new InvalidOperationException("The original private media references differ from their verified package.");
        return new(cluster, [new(LegacyMediaAssets, assets.Length, metadataSha256),
            new(LegacyMediaReferences, references.Total, references.Sha256)]);

        LegacyTable RequireMediaTable(string name, string[] fields) =>
            catalog.SingleOrDefault(table => table.Name == name) is { } candidate && source.IsSnapshotTable(candidate.Kind) &&
            candidate.Columns.Select(column => column.Name).ToHashSet(StringComparer.Ordinal).SetEquals(fields)
                ? candidate : throw new InvalidOperationException($"The joined media source relation differs: {name}.");
    }

    private static async Task CheckLegacyImportMediaTargetAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        LegacyImportMediaSeal media, string? sourceCluster, CancellationToken ct)
    {
        var cluster = await ReadLegacyPostgresClusterAsync(target, tx, ct);
        if (sourceCluster == cluster || await FingerprintLegacyPostgresDatabaseAsync(target, tx, cluster, ct) != media.TargetDatabaseSha256)
            throw new InvalidOperationException("The joined media package does not belong to this independent candidate database.");
    }

    private static CandidateTable[] LegacyImportMediaDefinitions(ImportPlan plan)
    {
        var assets = plan.SourceProjections.Where(value => value.Table == LegacyMediaAssets).ToArray();
        var references = plan.SourceProjections.Where(value => value.Table == LegacyMediaReferences).ToArray();
        var targets = plan.ExpectedTables.Where(value => value.Table == LegacyMediaAssetShadow.Name ||
            value.Table == LegacyMediaReferenceShadow.Name).ToArray();
        if (plan.Media is null && assets.Length == 0 && references.Length == 0 && targets.Length == 0) return [];
        if (plan.Media is not { } media || plan.Provider != "postgres" || plan.SourceSeal?.Provenance != PostgresClusterProvenance ||
            !IsSha256(media.ManifestSha256) || !IsSha256(media.SourceDatabaseSha256) || !IsSha256(media.TargetDatabaseSha256) ||
            media.SourceSiteId == Guid.Empty || media.SourceSiteId == plan.TargetSiteId ||
            assets is not [var asset] || asset.Rows is < 1 or > LegacyAssetLimit || !IsSha256(asset.Sha256) ||
            references is not [var reference] || reference.Rows < asset.Rows || reference.Rows > LegacyAssetReferenceLimit ||
            !IsSha256(reference.Sha256) || targets.Length != 2 ||
            !targets.Any(row => row.Table == LegacyMediaAssetShadow.Name && row.Rows == asset.Rows && IsSha256(row.Sha256)) ||
            !targets.Any(row => row.Table == LegacyMediaReferenceShadow.Name && row.Rows == reference.Rows && IsSha256(row.Sha256)))
            throw new InvalidOperationException("The joined media staging plan is incomplete.");
        return [LegacyMediaAssetShadow, LegacyMediaReferenceShadow];
    }

    private static async Task<ShadowCount[]> StageLegacyImportMediaShadowAsync(LegacyShadow shadow, LegacyMediaManifest package,
        CancellationToken ct)
    {
        var assets = package.Files.ToDictionary(file => file.AssetId);
        await using var tx = shadow.Database.BeginTransaction();
        await using var find = CreateLegacyCommand(tx, """
            SELECT r.revision FROM shadow_revision r JOIN shadow_article a ON a.id=r.article_id
            WHERE r.source_revision_id=@source AND a.id=@article AND r.source_admin_id=@owner AND a.legacy_admin_id=@owner
              AND a.owner_id=@user AND NOT EXISTS (SELECT 1 FROM shadow_publication p WHERE p.source_revision_id=r.source_revision_id)
            """);
        foreach (var name in new[] { "source", "article", "owner", "user" })
        {
            var parameter = find.CreateParameter();
            parameter.ParameterName = name;
            find.Parameters.Add(parameter);
        }
        var joined = new List<object?[]>(package.References.Length);
        foreach (var reference in package.References.OrderBy(item => item.AssetId).ThenBy(item => item.SourceId))
        {
            var asset = assets[reference.AssetId];
            find.Parameters[0].Value = reference.SourceId;
            find.Parameters[1].Value = reference.ArticleId;
            find.Parameters[2].Value = asset.SourceOwnerId!.Value;
            find.Parameters[3].Value = asset.TargetOwnerId!.Value.ToString("D");
            if (await find.ExecuteScalarAsync(ct) is not long revision || revision <= 0)
                throw new InvalidOperationException("The reviewed media owner and unpublished source revision do not match the staged article.");
            joined.Add([asset.AssetId.ToString("D"), reference.SourceKind, reference.SourceId, reference.ArticleId, revision,
                reference.ReferenceCount, reference.AltText, reference.UpdatedAtUtc]);
        }
        var sourceRows = package.Files.OrderBy(file => file.AssetId).Select(file => (object?[])
        [file.AssetId.ToString("D"), file.StorageClass, file.StorageKey, file.MediaType, file.Extension, file.Bytes, file.Sha256,
            file.Width, file.Height, file.SourceOwnerId, file.TargetOwnerId!.Value.ToString("D"), "active", file.CreatedAtUtc, file.UpdatedAtUtc]);
        var measuredAssets = await WriteLegacyImportMediaShadowAsync(tx, LegacyMediaAssetShadow, sourceRows, ct);
        var measuredReferences = await WriteLegacyImportMediaShadowAsync(tx, LegacyMediaReferenceShadow, joined, ct);
        await tx.CommitAsync(ct);
        return [measuredAssets, measuredReferences];
    }

    private static async Task<ShadowCount> WriteLegacyImportMediaShadowAsync(DbTransaction tx, CandidateTable table,
        IEnumerable<object?[]> sourceRows, CancellationToken ct)
    {
        var names = table.Columns.Select(column => column.Name);
        using var expected = LegacyShadowDigest(table.Name, names);
        var count = await WriteLegacyShadowRowsAsync(tx, table,
            $"CREATE TABLE {table.Name} ({LegacyShadowColumns(table, ", ")}, PRIMARY KEY ({table.Key})) STRICT", sourceRows, ct, expected);
        using var observed = LegacyShadowDigest(table.Name, names);
        var observedCount = await ReadLegacyShadowDigestAsync(tx, table, observed, ct);
        var sha256 = FinishSourceSeal(observed);
        if (observedCount != count || sha256 != FinishSourceSeal(expected))
            throw new InvalidOperationException("The joined media shadow differs from the measured source and ownership.");
        return new(table.Name, count, sha256);
    }
}
