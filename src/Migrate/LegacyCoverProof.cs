using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;

internal static partial class Migration
{
    private sealed record LegacyCoverCandidate(string SourceKind, int ArticleId, long SourceId, long SourceRevisionId, long Revision,
        string SourceUrlSha256, Guid AssetId, string AssetSha256, long SourceOwnerId, Guid TargetOwnerId,
        string Role, bool CurrentEdit, bool CurrentPublication);

    private static Task<int> RunLegacyCoverProofAsync(string packagePath, string packageSha, string ownerPath,
        string ownerSha, string revisionSha, string publicationSha, CancellationToken token) => RunBoundedLegacyOperationAsync(token, 8,
        "The legacy cover proof exceeded its run budget.", "The legacy cover source rejected the read", async ct =>
    {
        // This is a new read-only witness. Neither existing import plans nor media manifests gain authority.
        var media = await VerifyLegacyMediaPackageAsync(packagePath, packageSha, ct);
        if (media.Review.Provider != "postgres" || !IsSha256(ownerSha) || !IsSha256(revisionSha) || !IsSha256(publicationSha))
            throw new InvalidOperationException("Cover proof requires PostgreSQL media and the reviewed owner-map SHA-256.");
        var (map, observedOwnerSha) = await ReadLegacyOwnerMapAsync(ownerPath, ct);
        if (observedOwnerSha != ownerSha || map.Owners is null)
            throw new InvalidOperationException("The cover owner map differs from its reviewed SHA-256.");
        var owners = ValidateOwnerMap(map.Owners);
        var source = ParseLegacySource("postgres");
        await using var db = source.Connection;
        await db.OpenAsync(ct);
        await using var tx = await BeginLegacyReadAsync(db, ct);
        var pg = (NpgsqlTransaction)tx;
        var cluster = await ReadLegacyPostgresClusterAsync(pg.Connection!, pg, ct);
        if (source.Schema != media.Review.SourceSchema ||
            await FingerprintLegacyPostgresDatabaseAsync(pg.Connection!, pg, cluster, ct) != media.Review.SourceDatabaseSha256)
            throw new InvalidOperationException("The cover source differs from the sealed media database.");
        var catalog = await ReadLegacyCatalogAsync(source, tx, ct);
        var (tables, blockers) = SelectLegacyTables(source, catalog);
        if (blockers.Count != 0) throw new InvalidOperationException("The cover source catalog is incomplete.");
        var audit = await AuditLegacyAsync(source, tx, tables, true, ct);
        var principal = FindLegacyImportPrincipal(source, catalog)
            ?? throw new InvalidOperationException("The cover source principal authority is unavailable.");
        var principalSha = await FingerprintLegacyPrincipalsAsync(source, tx, principal, owners.Values, ct);
        var articles = audit.Projections.Single(row => row.Table == Article);
        if (audit.Projections.Single(row => row.Table == Revision).Sha256 != revisionSha ||
            audit.Projections.Single(row => row.Table == Publication).Sha256 != publicationSha)
            throw new InvalidOperationException("The cover revision or publication projection differs from its reviewed SHA-256.");
        if (audit.Issues.Count != 0 || articles.Rows != owners.Count || articles.Sha256 != map.SourceArticleSha256 ||
            principalSha != map.SourceAdminIdentitySha256 || principalSha != media.Review.SourceAdminIdentitySha256)
            throw new InvalidOperationException("The cover source or reviewed ownership differs from its audited projection.");
        LegacyTable Relation(string name, string[] columns) => catalog.SingleOrDefault(row => row.Name == name) is { } table &&
            source.IsSnapshotTable(table.Kind) && table.Columns.Select(column => column.Name).ToHashSet(StringComparer.Ordinal).SetEquals(columns)
            ? table : throw new InvalidOperationException("The cover asset catalog differs from its sealed shape.");
        var assets = await ReadAssetMetadataAsync(source, tx, Relation(LegacyMediaAssets, AssetColumns), ct);
        using var metadata = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var column in AssetColumns) AppendLegacyValue(metadata, column);
        foreach (var asset in assets) AppendAssetMetadata(metadata, asset);
        if (assets.Length != media.Files.Length || assets.Any(asset => CheckAssetMetadata(asset) is not null || asset.Digest is null) ||
            FinishSourceSeal(metadata) != media.Review.AssetMetadataSha256 ||
            !LegacyMediaObjects(assets, media.Review.Owners).SequenceEqual(media.Files))
            throw new InvalidOperationException("The cover asset metadata differs from the sealed package.");
        var references = await VerifyAssetReferencesAsync(source, tx, Relation(LegacyMediaReferences, AssetReferenceColumns),
            tables[Article], tables[Revision], assets.ToDictionary(asset => asset.Id),
            _ => throw new InvalidOperationException("The cover source has unsupported asset references."), ct);
        if (references.Sha256 != media.Review.ReferenceSha256 || !references.Bindings.SequenceEqual(media.References))
            throw new InvalidOperationException("The cover references differ from the sealed package.");
        var byKey = media.Files.ToDictionary(asset => asset.StorageKey, StringComparer.Ordinal);
        var refs = media.References.ToDictionary(reference => (reference.AssetId, reference.SourceKind, reference.SourceId));
        string T(string name) => source.Table(tables[name]);
        string F(string name, string alias, string field) => alias + "." + source.Field(tables[name], field);
        var result = new List<LegacyCoverCandidate>();
        // Raw URLs are read only in memory. A role comes from the exact cover field, never the aggregate reference count.
        foreach (var kind in new[] { "article", "revision" })
        {
            var isArticle = kind == "article";
            var cover = F(isArticle ? Article : Revision, isArticle ? "a" : "r", isArticle ? "coverimageurl" : "cover_image_url");
            await using var query = CreateLegacyCommand(tx, $"""
                SELECT {F(Article,"a","id")}, {F(Revision,"r","id")}, {F(Revision,"r","revision_no")},
                    {F(Revision,"r","created_by_admin_principal_id")}, {cover},
                    {F(Revision,"r","id")} = {F(Article,"a","current_revision_id")},
                    {F(Revision,"r","id")} = {F(Publication,"p","article_revision_id")}
                FROM {T(Article)} a JOIN {T(Revision)} r ON {F(Revision,"r","article_id")} = {F(Article,"a","id")}
                    {(isArticle ? $"AND {F(Revision,"r","id")} = {F(Article,"a","current_revision_id")}" : "")}
                LEFT JOIN {T(Publication)} p ON {F(Publication,"p","id")} = {F(Article,"a","current_publication_id")}
                    AND {F(Publication,"p","article_id")} = {F(Article,"a","id")}
                WHERE TRIM({cover}) <> '' ORDER BY {F(Article,"a","id")}, {F(Revision,"r","id")}
                LIMIT {LegacyAssetReferenceLimit + 1}
                """);
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                if (result.Count == LegacyAssetReferenceLimit) throw new InvalidOperationException("The cover proof exceeds its row budget.");
                var articleId = checked((int)AssetInteger(rows.GetValue(0)));
                var revisionId = AssetInteger(rows.GetValue(1));
                var url = rows.GetString(4);
                const string prefix = "/uploads/";
                if (!url.StartsWith(prefix, StringComparison.Ordinal) || !IsLegacyAssetKey(url[prefix.Length..]) ||
                    !byKey.TryGetValue(url[prefix.Length..], out var asset) || asset.StorageClass != "public" || asset.Bytes < 1 ||
                    !owners.TryGetValue(articleId, out var owner) || asset.SourceOwnerId != owner.LegacyAdminId ||
                    asset.TargetOwnerId != owner.V2UserId || AssetInteger(rows.GetValue(3)) != owner.LegacyAdminId ||
                    !refs.ContainsKey((asset.AssetId, kind, isArticle ? articleId : revisionId)))
                    throw new InvalidOperationException("A cover lacks an exact public managed-key, reference and reviewed owner binding.");
                result.Add(new(kind, articleId, isArticle ? articleId : revisionId, revisionId, AssetInteger(rows.GetValue(2)),
                    Convert.ToHexStringLower(SHA256.HashData(StrictUtf8.GetBytes(url))), asset.AssetId, asset.Sha256,
                    owner.LegacyAdminId, owner.V2UserId, "cover", rows.GetBoolean(5), !rows.IsDBNull(6) && rows.GetBoolean(6)));
            }
        }
        await tx.RollbackAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            format = "fsusblog-legacy-cover-proof-v1", sourceReference = LegacyReference,
            mediaManifestSha256 = packageSha, ownerMapSha256 = ownerSha, media.Review.SourceSiteId,
            media.Review.TargetSiteId, media.Review.SourceDatabaseSha256, sourceProjections = audit.Projections,
            media.Review.AssetMetadataSha256, media.Review.ReferenceSha256, candidates = result,
            readyToApply = false, readyToStage = false,
            remaining = new[] { "candidate admission, cover activation and publication remain unavailable",
                "external, absolute, private and local-alias cover mapping remain unsupported" }
        }, Json));
        return 0;
    });
}
