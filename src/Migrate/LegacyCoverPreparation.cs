using System.Text.Json;
using FsusBlog.V2.Contracts;
using Npgsql;
using FsusBlogV2.Storage;

internal static partial class Migration
{
    private static Task<int> RunLegacyCoverPreparationAsync(string[] args, CancellationToken token) =>
        RunBoundedLegacyOperationAsync(token, 8, "Cover preparation verification exceeded its run budget.",
            "The cover preparation candidate rejected the read", async ct =>
    {
        if (args is not [var mode, var planPath, var planSha, var backupPath, var backupSha, var packagePath,
                var packageSha, var proofPath, var proofSha, .. var prepared] ||
            mode is not ("prepare-request" or "prepare-verify") || prepared.Length != (mode == "prepare-request" ? 0 : 3))
            throw new ArgumentException("Use covers prepare-request|prepare-verify PLAN SHA BACKUP SHA PACKAGE SHA PROOF SHA [PREPARED SHA NORMALIZER_SHA].");
        var plan = await ReadImportPlanAsync(planPath, ct);
        if (plan.Covers is not { } seal || !IsSha256(planSha) || CanonicalImportPlanDigest(plan) != planSha ||
            !plan.ReadyToStage || plan.ReadyToApply || plan.Findings.Length != 0 || plan.SourceReference != LegacyReference ||
            plan.SchemaVersion != CurrentSchema.Version || plan.SchemaSha256 != Digest(await SchemaSqlAsync(ct)) ||
            plan.BackupManifestSha256 != backupSha || seal.ProofSha256 != proofSha || seal.Media.ManifestSha256 != packageSha)
            throw new InvalidOperationException("Supply the original approved cover staging plan and custody evidence.");
        var package = await VerifyLegacyMediaPackageAsync(packagePath, packageSha, ct);
        if (seal.Media != LegacyImportMediaBinding(new(packagePath, packageSha), package) ||
            package.Review.TargetSiteId != plan.TargetSiteId || package.Review.TargetSchemaSha256 != plan.SchemaSha256 ||
            package.Review.SourceAdminIdentitySha256 != plan.SourceAdminIdentitySha256)
            throw new InvalidOperationException("Cover package identity differs from the approved staging plan.");
        using var proof = JsonDocument.Parse(await ReadLegacyCoverProofFileAsync(proofPath, proofSha, ct));
        var mappings = proof.RootElement.GetProperty("candidates").Deserialize<LegacyCoverCandidate[]>(OwnerMapJson)
            ?? throw new InvalidOperationException("Missing approved cover coordinates.");
        if (DigestMediaDocument(mappings) != seal.MappingSha256 || mappings.Length is < 1 or > LegacyCoverPreparationRequest.MaxReferences ||
            package.Files.Length is < 1 or > LegacyCoverPreparationRequest.MaxAssets ||
            package.Files.Sum(file => file.Bytes) > LegacyCoverPreparationRequest.MaxTotalBytes)
            throw new InvalidOperationException("Cover preparation exceeds its approved mapping or byte bounds.");
        var assets = package.Files.OrderBy(file => file.AssetId).Select(file =>
        {
            if (file.StorageClass != "public" || file.Bytes is < 1 or > LegacyMediaPreparation.MaxFileBytes ||
                file.Width is not (> 0 and <= 8192) || file.Height is not (> 0 and <= 8192) ||
                file.Width * file.Height > 16L * 1024 * 1024 || file.SourceOwnerId is not > 0 || file.TargetOwnerId is null ||
                file.MediaType is not ("image/png" or "image/jpeg") || file.Extension is not (".png" or ".jpg" or ".jpeg"))
                throw new InvalidOperationException("Cover preparation requires bounded, owned PNG/JPEG source images.");
            return new LegacyMediaPreparationAsset(file.AssetId, file.Sha256, checked((int)file.Bytes),
                checked((int)file.Width.Value), checked((int)file.Height.Value), file.MediaType, file.Extension,
                file.SourceOwnerId.Value, file.TargetOwnerId.Value);
        }).ToArray();
        var references = mappings.OrderBy(row => row.AssetId).ThenBy(row => row.SourceKind, StringComparer.Ordinal)
            .ThenBy(row => row.ArticleId).ThenBy(row => row.SourceId).Select(row => new LegacyCoverPreparationReference(row.AssetId,
                row.SourceKind, row.ArticleId, row.SourceId, row.SourceRevisionId, row.Revision, row.SourceOwnerId, row.TargetOwnerId, row.Role)).ToArray();
        if (references.GroupBy(row => (row.ArticleId, row.SourceRevisionId)).Any(group => group.Select(row => row.AssetId).Distinct().Count() != 1))
            throw new InvalidOperationException("The article head and revision cover disagree.");
        var backup = await ReadLegacyImportBackupAsync(backupPath, backupSha, ct);
        await using var db = new NpgsqlConnection(ParseImportTarget().ConnectionString);
        await db.OpenAsync(ct);
        await RequireBackupDatabaseLockAsync(db, ct);
        await using var tx = await BeginReadOnlyAsync(db, ct);
        await SetBackupRepresentationAsync(db, tx, ct);
        if (await VerifyProjectionCandidateAsync(db, tx, plan, planSha, CandidateDefinitions(plan), false, ct))
            throw new InvalidOperationException("Cover preparation requires the original unprojected candidate.");
        await CheckLegacyImportMediaTargetAsync(db, tx, seal.Media, null, ct);
        var (business, media) = await ReadBackupSiteAsync(db, tx, ct, excludedSchema: ImportSchema);
        var baseline = backup.Site.Relations.ToDictionary(row => row.Name, StringComparer.Ordinal);
        if (media.Count != 0 || business.Count != baseline.Count ||
            backup.Site.PostgreSqlMajor != db.PostgreSqlVersion.Major.ToString(System.Globalization.CultureInfo.InvariantCulture) ||
            business.Any(row => !baseline.TryGetValue(row.Name, out var old) ||
                (row.Name == "v2_schema" ? row.Rows != old.Rows || row.Kind != old.Kind : row != old)))
            throw new InvalidOperationException("The dormant cover candidate differs from its original public baseline.");
        await using (var command = new NpgsqlCommand($"SELECT mapping_json FROM {ImportSchema}.shadow_cover_mapping ORDER BY source_kind COLLATE \"C\",article_id,source_id", db, tx))
        await using (var rows = await command.ExecuteReaderAsync(ct))
        {
            foreach (var mapping in mappings.OrderBy(row => row.SourceKind, StringComparer.Ordinal).ThenBy(row => row.ArticleId).ThenBy(row => row.SourceId))
                if (!await rows.ReadAsync(ct) || rows.GetString(0) != JsonSerializer.Serialize(mapping, Json))
                    throw new InvalidOperationException("The candidate cover rows differ from the approved witness.");
            if (await rows.ReadAsync(ct)) throw new InvalidOperationException("Unexpected candidate cover rows.");
        }
        var candidateSha = DigestMediaDocument(new { planSha, backupSha, plan.TargetSiteId, plan.ExpectedTables, business });
        var request = new LegacyCoverPreparationRequest(LegacyCoverPreparationRequest.RequestFormat, planSha, candidateSha,
            proofSha, packageSha, seal.Media.SourceSiteId, plan.TargetSiteId, assets, references);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(request, LegacyMediaPreparation.Json);
        await tx.RollbackAsync(ct);
        if (mode == "prepare-request") await Console.OpenStandardOutput().WriteAsync(bytes, ct);
        else
        {
            var result = await ReadPreparedLegacyMediaAssetsAsync(new(prepared[0], prepared[1], prepared[2]), assets, bytes,
                LegacyCoverPreparationRequest.ResultFormat, ct, maxTotalBytes: LegacyCoverPreparationRequest.MaxTotalBytes);
            Console.WriteLine(JsonSerializer.Serialize(new { format = LegacyCoverPreparationRequest.ResultFormat,
                result.RequestSha256, candidateSha256 = candidateSha, preparedManifestSha256 = prepared[1],
                result.NormalizerSha256, assets = result.Assets.Length, readyToApply = false, serving = false }, Json));
        }
        return 0;
    });
}
