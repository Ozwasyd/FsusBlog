using System.Data;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private const string DormantReceipt = "dormant_cover_projection";
    private sealed record DormantCoverReview(string Format, string PlanSha256, string BackupSha256, string RequestSha256,
        string PreparedSha256, string NormalizerSha256, string ConverterSha256, string ArticleSha256, string MediaRoot);

    private static Task<int> RunDormantCoverAsync(string[] args, CancellationToken token) =>
        RunBoundedLegacyOperationAsync(token, 8, "Dormant cover materialization exceeded its budget.",
            "The dormant candidate rejected the operation", async ct =>
    {
        if (args is not [var mode, var planPath, var planSha, var backupPath, var backupSha,
            var requestPath, var requestSha, var packagePath, var preparedPath, var preparedSha, var normalizerSha,
            var root, .. var approval] || mode is not ("dormant-plan" or "dormant-apply" or "dormant-verify") ||
            approval.Length != (mode == "dormant-plan" ? 0 : 2))
            throw new ArgumentException("Use dormant-plan|dormant-apply|dormant-verify PLAN SHA BACKUP SHA REQUEST SHA CUSTODY PREPARED SHA NORMALIZER_SHA PRIVATE_ROOT [APPROVAL SHA].");
        var portable = mode == "dormant-verify";
        var write = mode == "dormant-apply";
        var plan = await ReadImportPlanAsync(planPath, ct);
        if (plan.Covers is not { } cover || CanonicalImportPlanDigest(plan) != planSha || !plan.ReadyToStage ||
            plan.ReadyToApply || plan.Findings.Length != 0 || plan.SourceReference != LegacyReference ||
            plan.SchemaSha256 != Digest(await SchemaSqlAsync(ct)) || plan.BackupManifestSha256 != backupSha)
            throw new InvalidOperationException("The original approved cover plan is required.");
        var requestText = await ReadLegacyCoverProofFileAsync(requestPath, requestSha, ct);
        var request = JsonSerializer.Deserialize<LegacyCoverPreparationRequest>(requestText, LegacyMediaPreparation.Json)
            ?? throw new InvalidOperationException("Missing approved cover request.");
        var requestBytes = StrictUtf8.GetBytes(requestText);
        if (request.Format != LegacyCoverPreparationRequest.RequestFormat || request.PlanSha256 != planSha ||
            request.ProofSha256 != cover.ProofSha256 || request.CustodyManifestSha256 != cover.Media.ManifestSha256 ||
            request.SourceSiteId != cover.Media.SourceSiteId || request.TargetSiteId != plan.TargetSiteId ||
            !JsonSerializer.SerializeToUtf8Bytes(request, LegacyMediaPreparation.Json).AsSpan().SequenceEqual(requestBytes))
            throw new InvalidOperationException("The cover request differs from the original staging authority.");
        var package = await VerifyLegacyMediaPackageAsync(packagePath, cover.Media.ManifestSha256, ct);
        if (LegacyImportMediaBinding(new(packagePath, cover.Media.ManifestSha256), package) != cover.Media)
            throw new InvalidOperationException("The original custody package changed.");
        var payloads = new Dictionary<Guid, byte[]>();
        var images = await ReadPreparedLegacyMediaAssetsAsync(new(preparedPath, preparedSha, normalizerSha), request.Assets,
            requestBytes, LegacyCoverPreparationRequest.ResultFormat, ct, (image, bytes) => payloads.Add(image.AssetId, bytes),
            LegacyCoverPreparationRequest.MaxTotalBytes);
        if (request.Assets.Length is < 1 or > 32 || request.References.Length is < 1 or > 128 ||
            images.Assets.Any(image => image.Format is not (1 or 2)))
            throw new InvalidOperationException("Dormant covers require the bounded PNG/JPEG preparation profile.");
        var backup = await ReadLegacyImportBackupAsync(backupPath, backupSha, ct);
        await using var db = new NpgsqlConnection(ParseImportTarget().ConnectionString);
        await db.OpenAsync(ct);
        await RequireBackupDatabaseLockAsync(db, ct);
        await using var tx = await db.BeginTransactionAsync(write ? IsolationLevel.ReadCommitted : IsolationLevel.RepeatableRead, ct);
        if (!write) await ExecuteAsync(db, tx, "SET TRANSACTION READ ONLY", ct);
        await SetBackupRepresentationAsync(db, tx, ct);
        if (write)
        {
            await ExecuteAsync(db, tx, BootstrapLock, ct);
            foreach (var relation in await RelationsAsync(db, tx, ct))
                if (relation.Kind == "r") await ExecuteAsync(db, tx, $"LOCK TABLE \"{relation.Schema.Replace("\"", "\"\"")}\".\"{relation.Name.Replace("\"", "\"\"")}\" IN ACCESS EXCLUSIVE MODE", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireArticleSummary: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        if (!await CurrentSchema.HasPrivateMediaImportOriginAsync(db, tx, ct) ||
            await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct) != plan.TargetSiteId)
            throw new InvalidOperationException("Import-origin schema must precede the approved baseline and site.");
        await using (var gate = new NpgsqlCommand("SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')='' AND current_setting('session_replication_role')='origin' AND NOT pg_is_in_recovery() AND (SELECT version FROM public.v2_schema WHERE singleton)=-1", db, tx))
            if (await gate.ExecuteScalarAsync(ct) is not true) throw new InvalidOperationException("Only a dormant Unix-only candidate is allowed.");
        if (!portable)
        {
            if (await ReadTargetAsync(db, tx, ct) != plan.Target) throw new InvalidOperationException("The original physical candidate is required for planning or writing.");
            await CheckLegacyImportMediaTargetAsync(db, tx, cover.Media, null, ct);
        }
        var already = await HasRelation(db, tx, $"{ImportSchema}.{DormantReceipt}", ct);
        if (portable && !already) throw new InvalidOperationException("Portable verification requires a committed dormant receipt.");
        await VerifyCandidateHeaderAsync(db, plan, planSha, ct, tx);
        var definitions = CandidateDefinitions(plan);
        await AssertCandidateRelationsAsync(db, definitions, ct, tx, extraReceipt: already ? DormantReceipt : null);
        await VerifyCandidateMeasurementsAsync(db, tx, plan, definitions, ct);
        await RequireNoProjectionRowsAsync($"""
            SELECT 1 FROM {ImportSchema}.shadow_article WHERE source_status<>0 OR deleted<>0 OR
                current_publication_id IS NOT NULL OR current_public_revision_candidate IS NOT NULL OR last_publication_number<>0
                OR scheduled_publish_at IS NOT NULL OR pending_publication_at IS NOT NULL
            UNION ALL SELECT 1 FROM {ImportSchema}.shadow_publication
            UNION ALL SELECT 1 FROM {ImportSchema}.shadow_article_rights_policy
            UNION ALL SELECT 1 FROM {ImportSchema}.shadow_article_rights_snapshot
            UNION ALL SELECT 1 FROM {ImportSchema}.shadow_article_responsibility_snapshot
            """, "Dormant materialization supports only never-published, unscheduled drafts.", db, tx, ct);
        await VerifyLegacyProjectionFactsAsync(db, tx, false, ct);
        var (before, beforeMedia) = await ReadBackupSiteAsync(db, tx, ct, excludedSchema: ImportSchema);
        var business = backup.Site.Relations.Select(row => row.Name == "v2_schema" ? before.Single(item => item.Name == row.Name) : row).ToList();
        var candidateSha = DigestMediaDocument(new { planSha, backupSha, plan.TargetSiteId, plan.ExpectedTables, business });
        if (candidateSha != request.CandidateSha256) throw new InvalidOperationException("The prepared request does not bind the original baseline/checkpoints.");
        var mappings = new List<LegacyCoverCandidate>();
        await using (var command = new NpgsqlCommand($"SELECT mapping_json FROM {ImportSchema}.shadow_cover_mapping ORDER BY source_kind COLLATE \"C\",article_id,source_id", db, tx))
        await using (var rows = await command.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct)) mappings.Add(JsonSerializer.Deserialize<LegacyCoverCandidate>(rows.GetString(0), Json)!);
        var expectedReferences = mappings.OrderBy(row => row.AssetId).ThenBy(row => row.SourceKind, StringComparer.Ordinal)
            .ThenBy(row => row.ArticleId).ThenBy(row => row.SourceId).Select(row => new LegacyCoverPreparationReference(row.AssetId,
                row.SourceKind,row.ArticleId,row.SourceId,row.SourceRevisionId,row.Revision,row.SourceOwnerId,row.TargetOwnerId,row.Role)).ToArray();
        if (!expectedReferences.SequenceEqual(request.References) || mappings.Any(row => row.CurrentPublication || row.Role != "cover") ||
            mappings.GroupBy(row => (row.ArticleId,row.SourceRevisionId)).Any(group => group.Select(row => row.AssetId).Distinct().Count()!=1))
            throw new InvalidOperationException("Prepared covers differ from the original exact dormant mappings.");
        if (mappings.Any(row => row.SourceKind == "article" && !mappings.Any(revision => revision.SourceKind == "revision" &&
            revision.ArticleId == row.ArticleId && revision.SourceRevisionId == row.SourceRevisionId && revision.AssetId == row.AssetId)))
            throw new InvalidOperationException("An article-head cover lacks its exact saved revision cover.");
        var assets = package.Files.OrderBy(row => row.AssetId).Select(row => PreparationAsset(row)).ToArray();
        if (!assets.SequenceEqual(request.Assets)) throw new InvalidOperationException("Prepared ownership or asset metadata differs.");
        var projection = await BuildProjectionRelationsAsync(db, tx, ct);
        var articleFacts = new List<object>();
        foreach (var relation in projection)
        {
            await using var query = ProjectionQuery(db, tx, relation, $"SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY to_jsonb(v)::text COLLATE \"C\"),'[]')::text FROM ({relation.Query}) v");
            articleFacts.Add(new { relation.Name, sha256 = DigestMediaDocument((string)(await query.ExecuteScalarAsync(ct))!) });
        }
        var articleSha = DigestMediaDocument(articleFacts);
        using var executable = File.OpenRead(typeof(Migration).Assembly.Location);
        var converterSha = Convert.ToHexStringLower(await SHA256.HashDataAsync(executable, ct));
        var review = new DormantCoverReview("fsusblog.dormant-cover-materialization.v1",planSha,backupSha,requestSha,
            preparedSha,normalizerSha,converterSha,articleSha,root);
        var reviewBytes = JsonSerializer.SerializeToUtf8Bytes(review, OwnerMapJson);
        var reviewSha = Convert.ToHexStringLower(SHA256.HashData(reviewBytes));
        if (approval.Length != 0)
        {
            var text = await ReadLegacyCoverProofFileAsync(approval[0], approval[1], ct);
            var approved = JsonSerializer.Deserialize<DormantCoverReview>(text, OwnerMapJson);
            if (approved is null || (!portable && text != StrictUtf8.GetString(reviewBytes)) ||
                approved with { MediaRoot=root } != review)
                throw new InvalidOperationException("The dormant approval differs from its exact inputs, executable or destination.");
            if (portable) { review = approved; reviewSha = approval[1]; }
            else if (reviewSha != approval[1]) throw new InvalidOperationException("The dormant approval digest changed.");
        }
        var allProjection = projection.Concat(DormantMediaProjection(request,package,images,reviewSha,articleSha,preparedSha,normalizerSha)).ToArray();
        var touched = allProjection.Select(row => row.Name).Concat(ProjectionSequences.Select(row => row.Name)).ToHashSet();
        var baseline = business.ToDictionary(row => row.Name);
        if (before.Count != baseline.Count || backup.Site.PostgreSqlMajor != db.PostgreSqlVersion.Major.ToString() ||
            before.Any(row => !baseline.TryGetValue(row.Name,out var old) || row.Kind != old.Kind || ((!already || !touched.Contains(row.Name)) && row != old)) ||
            (!already && beforeMedia.Count != 0)) throw new InvalidOperationException("Dormant target differs from its exact baseline or permitted write set.");
        var forbidden = new List<string> { backupPath,packagePath,preparedPath,AppContext.BaseDirectory };
        foreach (var setting in new[] { "FSUSBLOG_WEB_DIST", "FSUSBLOG_PRIVATE_MEDIA_ROOT", "FSUSBLOG_PUBLIC_MEDIA_ROOT", "FSUSBLOG_APPEARANCE_ROOT" })
            if (Environment.GetEnvironmentVariable(setting) is { Length: > 0 } path) forbidden.Add(path);
        using var directory = new MediaObjectDirectory(root, LegacyMediaPreparation.MaxFileBytes, forbidden);
        var leaves = images.Assets.Select(row=>$"{row.AssetId:N}.media").ToHashSet();
        RequireLegacyMediaActivationRoot(root,leaves,allowExactFiles:write || already);
        foreach (var image in images.Assets)
            if (await directory.Read($"{image.AssetId:N}.media",image.Length,Convert.FromHexString(image.NormalizedSha256),ct) is null && already)
                throw new InvalidOperationException("Committed dormant bytes are missing; restore the approved database/file pair.");
        if (mode == "dormant-plan") { await tx.RollbackAsync(ct); await Console.OpenStandardOutput().WriteAsync(reviewBytes,ct); return 0; }
        if (!already) await InsertLegacyProjectionAsync(db,tx,allProjection,ct);
        await VerifyProjectionReadbackAsync(db,tx,allProjection,ct);
        var (after, afterMedia) = await ReadBackupSiteAsync(db,tx,ct,excludedSchema:ImportSchema);
        if (afterMedia.Count != images.Assets.Length) throw new InvalidOperationException("Unexpected dormant private media set.");
        var stateSha = DigestMediaDocument(new { after, afterMedia });
        if (already)
        {
            var shape = Candidate(DormantReceipt,1,"singleton","singleton approval_sha256:text state_sha256:text",nonNull:["singleton","approval_sha256","state_sha256"]);
            if (!await HasSavedViewKeysAsync(tx,ImportSchema,DormantReceipt,shape,[],ct)) throw new InvalidOperationException("Dormant receipt shape changed.");
            _ = await MeasureCandidateTableAsync(db,tx,shape,ct);
            await using (var exact = new NpgsqlCommand($"""
                SELECT NOT EXISTS (SELECT FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
                    WHERE a.attrelid='{ImportSchema}.{DormantReceipt}'::regclass AND a.attnum>0
                    AND (a.attidentity<>'' OR a.attgenerated<>'' OR d.oid IS NOT NULL))
                    AND NOT EXISTS (SELECT FROM pg_constraint WHERE conrelid='{ImportSchema}.{DormantReceipt}'::regclass AND contype NOT IN ('p','n'))
                    AND (SELECT count(*) FROM pg_index WHERE indrelid='{ImportSchema}.{DormantReceipt}'::regclass)=1
                """,db,tx))
                if (await exact.ExecuteScalarAsync(ct) is not true) throw new InvalidOperationException("Unexpected dormant receipt catalog state.");
            await using var receipt = new NpgsqlCommand($"SELECT singleton,approval_sha256,state_sha256 FROM {ImportSchema}.{DormantReceipt}",db,tx);
            await using var row = await receipt.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct) || row.GetInt64(0)!=1 || row.GetString(1)!=reviewSha || row.GetString(2)!=stateSha || await row.ReadAsync(ct))
                throw new InvalidOperationException("Dormant receipt or projected state changed.");
        }
        else
        {
            await ExecuteAsync(db,tx,$"CREATE TABLE {ImportSchema}.{DormantReceipt} (singleton bigint PRIMARY KEY,approval_sha256 text NOT NULL,state_sha256 text NOT NULL)",ct);
            await using var receipt = new NpgsqlCommand($"INSERT INTO {ImportSchema}.{DormantReceipt} VALUES (1,$1,$2)",db,tx);
            receipt.Parameters.AddWithValue(reviewSha); receipt.Parameters.AddWithValue(stateSha); await receipt.ExecuteNonQueryAsync(ct);
            foreach (var image in images.Assets)
                await directory.Materialize($"{image.AssetId:N}.media",payloads[image.AssetId],Convert.FromHexString(image.NormalizedSha256),ct);
            // Never delete established files if commit fails or its acknowledgment is lost. Exact retry resolves both states.
        }
        if (write) await tx.CommitAsync(ct); else await tx.RollbackAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new { approvalSha256=reviewSha,stateSha256=stateSha,result=portable?"verified":already?"revalidated":"materialized",serving=false },Json));
        return 0;
    });

    private static ProjectionRelation[] DormantMediaProjection(LegacyCoverPreparationRequest request, LegacyMediaManifest package,
        LegacyMediaPreparationResult prepared,string approvalSha,string articleSha,string preparedSha,string normalizerSha)
    {
        var originals=package.Files.ToDictionary(row=>row.AssetId);
        var payload=JsonSerializer.Serialize(prepared.Assets.Select((image,index)=>new { asset=image.AssetId,owner=request.Assets[index].TargetOwnerId,
            oldowner=request.Assets[index].SourceOwnerId,raw=request.Assets[index].RawSha256,hash=image.NormalizedSha256,
            format=image.Format,length=image.Length,width=image.Width,height=image.Height,created=originals[image.AssetId].CreatedAtUtc,
            name=$"{image.AssetId:N}.{(image.Format==1?"png":"jpg")}" }),Json);
        const string rows="jsonb_to_recordset(@payload) AS x(asset uuid,owner uuid,oldowner bigint,raw text,hash text,format smallint,length integer,width integer,height integer,created timestamptz,name text)";
        string Hex(string s)=>$"decode('{s}','hex')";
        var refs=JsonSerializer.Serialize(request.References.Where(row=>row.SourceKind=="revision").Select(row=>new {article=row.ArticleId,revision=row.Revision,asset=row.AssetId,source=row.SourceRevisionId,alt=package.References.Single(reference=>reference.AssetId==row.AssetId && reference.SourceKind=="revision" && reference.SourceId==row.SourceRevisionId).AltText}),Json);
        const string links="jsonb_to_recordset(@payload) AS x(article integer,revision bigint,asset uuid,source bigint,alt text)";
        return [
            new("private_media_import","asset_id,owner_id,source_site_id,target_site_id,source_owner_id,activation_sha256,plan_sha256,projection_sha256,custody_manifest_sha256,request_sha256,prepared_manifest_sha256,normalizer_sha256,raw_sha256",
                $"SELECT asset,owner,'{request.SourceSiteId}'::uuid,'{request.TargetSiteId}'::uuid,oldowner,{Hex(approvalSha)},{Hex(request.PlanSha256)},{Hex(articleSha)},{Hex(request.CustodyManifestSha256)},{Hex(Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(request,LegacyMediaPreparation.Json))))},{Hex(preparedSha)},{Hex(normalizerSha)},decode(raw,'hex') FROM {rows}",Payload:payload),
            new("private_media","id,owner_id,content_hash,name,format,length,width,height,phase,created_at,import_origin_id",$"SELECT asset,owner,decode(hash,'hex'),name,format,length,width,height,1,created,asset FROM {rows}",Payload:payload),
            new("article_revision_media","article_id,revision,asset_id",$"SELECT article,revision,asset FROM {links}",Payload:refs),
            new("article_revision_media_import","article_id,revision,asset_id,source_revision_id,reference_count,alt_text",$"SELECT article,revision,asset,source,1,alt FROM {links}",Payload:refs),
            new("article_revision_cover","article_id,revision,asset_id",$"SELECT article,revision,asset FROM {links}",Payload:refs)
        ];
    }
}
