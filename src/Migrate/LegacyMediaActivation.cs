using System.Data;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;
using NpgsqlTypes;

internal static partial class Migration
{
    private const string LegacyMediaActivationFormat = "fsusblog.legacy-private-media-activation.v1";
    private const string LegacyMediaBatchActivationFormat = "fsusblog.legacy-private-media-activation.v2";
    private const int MaxActivationAssets = 32;
    private const int MaxActivationReferences = 128;
    private const int MaxActivationBytes = 64 * 1024 * 1024;
    private const string LegacyMediaActivationVariable = "FSUSBLOG_MEDIA_ACTIVATION_DB";
    private const string LegacyMediaRuntimePrefix = "fsusv2_import_runtime_";
    private static readonly string[] ActivatedMediaRelations =
        ["private_media", "private_media_import", "article_revision_media", "article_revision_media_import"];

    private sealed record LegacyMediaActivationInput(string Root, Guid Site, string Backup, string BackupSha256,
        string? Approval, string? ApprovalSha256);

    private sealed record LegacyMediaActivationPlan(string Format, string LegacyPlanSha256, string ProjectionSha256,
        string CustodyManifestSha256, string RequestSha256, string PreparedManifestSha256, string NormalizerSha256,
        Guid SourceSiteId, Guid QuarantineSiteId, Guid DestinationSiteId, DatabaseTarget Database, string Cluster,
        string MediaRoot, string BackupManifestSha256, string ArticleSha256, DateTimeOffset CreatedAtUtc,
        LegacyMediaPreparationAsset Source, LegacyMediaPreparedAsset Image, LegacyMediaPreparationReference Reference);

    private sealed record LegacyMediaActivationAsset(LegacyMediaPreparationAsset Source, LegacyMediaPreparedAsset Image,
        DateTimeOffset CreatedAtUtc)
    {
        internal string Leaf() => $"{Source.AssetId:N}.media";
    }

    private sealed record LegacyMediaArticleWitness(string Sha256, bool Current);
    private sealed record LegacyMediaActivationReference(LegacyMediaPreparationReference Reference, LegacyMediaArticleWitness Article);
    private sealed record LegacyMediaActivationBatch(string Format, string LegacyPlanSha256, string ProjectionSha256,
        string CustodyManifestSha256, string RequestSha256, string PreparedManifestSha256, string NormalizerSha256,
        Guid SourceSiteId, Guid QuarantineSiteId, Guid DestinationSiteId, DatabaseTarget Database, string Cluster,
        string MediaRoot, string BackupManifestSha256, LegacyMediaActivationAsset[] Assets, LegacyMediaActivationReference[] References);

    private static async Task RunLegacyMediaActivationAsync(NpgsqlConnection quarantine, NpgsqlTransaction quarantineTx,
        ImportPlan import, string quarantineBackup, LegacyImportMediaInput custody, LegacyMediaManifest media,
        PreparedLegacyMediaInput prepared, LegacyMediaActivationInput activation, LegacyMediaPreparationRequest request,
        byte[] requestBytes, CancellationToken ct)
    {
        if (request.Assets.Length is < 1 or > MaxActivationAssets || request.References.Length is < 1 or > MaxActivationReferences ||
            request.Assets.Any(asset => asset.MediaType != "image/png") ||
            request.References.Any(reference => reference.ReferenceCount != 1) ||
            request.References.GroupBy(reference => (reference.ArticleId, reference.Revision))
                .Any(revision => revision.Count() > ArticlePublishImages.Maximum))
            throw new InvalidOperationException("Activation requires a bounded batch of reviewed PNGs and exact private revision references.");
        if (activation.Site == request.SourceSiteId || activation.Site == request.TargetSiteId)
            throw new InvalidOperationException("The runtime destination must have its own reviewed site identity.");
        var approvalSha = await ReadLegacyMediaActivationApprovalAsync(activation, ct);
        var preActivation = await ReadLegacyImportBackupAsync(activation.Backup, activation.BackupSha256, ct);
        var bytes = new Dictionary<Guid, byte[]>(request.Assets.Length);
        long totalBytes = 0;
        var result = await ReadPreparedLegacyMediaAsync(prepared, request, requestBytes, ct, (image, encoded) =>
        {
            totalBytes += encoded.Length;
            if (totalBytes > MaxActivationBytes)
                throw new InvalidOperationException("The prepared legacy activation batch exceeds its 64 MiB byte bound.");
            bytes.Add(image.AssetId, encoded);
        });
        var original = media.Files.ToDictionary(asset => asset.AssetId);
        var assets = request.Assets.Zip(result.Assets, (source, image) => new LegacyMediaActivationAsset(source, image,
            DateTimeOffset.ParseExact(original[source.AssetId].CreatedAtUtc, "O", CultureInfo.InvariantCulture))).ToArray();
        var owners = assets.ToDictionary(asset => asset.Source.AssetId, asset => asset.Source.TargetOwnerId);
        var references = new List<LegacyMediaActivationReference>(request.References.Length);
        foreach (var reference in request.References)
        {
            var witness = await ReadLegacyMediaActivationArticleAsync(quarantine, quarantineTx, owners[reference.AssetId], reference, ct);
            references.Add(new(reference, witness));
        }
        var settings = ParseLegacyMediaActivationDatabase();
        await using var destination = new NpgsqlConnection(settings.ConnectionString);
        await destination.OpenAsync(ct);
        await RequireBackupDatabaseLockAsync(destination, ct);
        await using var tx = await destination.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        if (approvalSha is null) await ExecuteAsync(destination, tx, "SET TRANSACTION READ ONLY", ct);
        await ExecuteAsync(destination, tx, "SET LOCAL search_path=pg_catalog", ct);
        await SetBackupRepresentationAsync(destination, tx, ct);
        await VerifyLegacyMediaRuntimeDestinationAsync(destination, tx, activation.Site, ct);
        var identity = await ReadTargetAsync(destination, tx, ct);
        if (identity == import.Target)
            throw new InvalidOperationException("An isolated legacy candidate cannot be the activation destination.");
        var cluster = await ReadLegacyPostgresClusterAsync(destination, tx, ct);
        foreach (var (reference, witness) in references)
            if (witness != await ReadLegacyMediaActivationArticleAsync(destination, tx, owners[reference.AssetId], reference, ct))
                throw new InvalidOperationException("The approved runtime copy does not match the original private article and revision.");

        var separate = new List<string> { quarantineBackup, custody.Path, prepared.Package, activation.Backup };
        if (activation.Approval is { } approval) separate.Add(Path.GetDirectoryName(approval)!);
        foreach (var setting in new[] { "FSUSBLOG_WEB_DIST", "FSUSBLOG_PUBLIC_MEDIA_ROOT", "FSUSBLOG_APPEARANCE_ROOT" })
            if (Environment.GetEnvironmentVariable(setting) is { Length: > 0 } path) separate.Add(path);
        RequireLegacyMediaPath(activation.Root);
        using var directory = new MediaObjectDirectory(activation.Root, LegacyMediaPreparation.MaxFileBytes, separate);
        var plan = new LegacyMediaActivationBatch(LegacyMediaBatchActivationFormat, request.PlanSha256, request.ProjectionSha256,
            request.CustodyManifestSha256, result.RequestSha256, prepared.ManifestSha256, result.NormalizerSha256,
            request.SourceSiteId, request.TargetSiteId, activation.Site, identity, cluster, directory.Root,
            activation.BackupSha256, assets, references.ToArray());
        // Keep the exact predecessor bytes for already approved one-file/current-draft operations.
        var single = assets is [var one] && references is [{ Article.Current: true } link]
            ? new LegacyMediaActivationPlan(LegacyMediaActivationFormat, plan.LegacyPlanSha256, plan.ProjectionSha256,
                plan.CustodyManifestSha256, plan.RequestSha256, plan.PreparedManifestSha256, plan.NormalizerSha256,
                plan.SourceSiteId, plan.QuarantineSiteId, plan.DestinationSiteId, plan.Database, plan.Cluster,
                plan.MediaRoot, plan.BackupManifestSha256, link.Article.Sha256, one.CreatedAtUtc, one.Source, one.Image, link.Reference)
            : null;
        var planBytes = single is not null ? JsonSerializer.SerializeToUtf8Bytes(single, OwnerMapJson) :
            JsonSerializer.SerializeToUtf8Bytes(plan, OwnerMapJson);
        if (planBytes.Length > 256_000) throw new InvalidOperationException("The activation plan exceeds its approval byte bound.");
        var activationSha = Convert.ToHexStringLower(SHA256.HashData(planBytes));
        if (approvalSha is not null && approvalSha != activationSha)
            throw new InvalidOperationException("The approved activation plan differs from the artifact, runtime database, site or media root.");

        var already = await VerifyLegacyMediaRuntimeBackupAsync(destination, tx, preActivation, plan, activationSha, approvalSha is not null, ct);
        var leaves = assets.Select(asset => asset.Leaf()).ToHashSet(StringComparer.Ordinal);
        RequireLegacyMediaActivationRoot(directory.Root, leaves, approvalSha is not null);
        await VerifyLegacyMediaActivationFilesAsync(directory, assets, requireAll: already, ct);
        if (approvalSha is null)
        {
            await tx.RollbackAsync(ct);
            await Console.OpenStandardOutput().WriteAsync(planBytes, ct);
            return;
        }
        if (!already)
        {
            foreach (var asset in assets)
            {
                await using var insert = LegacyMediaActivationCommand(destination, tx, plan, activationSha, asset, """
                    INSERT INTO public.private_media_import (asset_id,owner_id,source_site_id,target_site_id,source_owner_id,
                        activation_sha256,plan_sha256,projection_sha256,custody_manifest_sha256,request_sha256,
                        prepared_manifest_sha256,normalizer_sha256,raw_sha256)
                    VALUES (@asset,@owner,@source_site,@site,@old_owner,@approval,@plan,@projection,@custody,@request,@prepared,@normalizer,@raw);
                    INSERT INTO public.private_media (id,owner_id,content_hash,name,format,length,width,height,phase,created_at,import_origin_id)
                    VALUES (@asset,@owner,@content,@name,1,@bytes,@width,@height,1,@created,@asset);
                    """);
                await insert.ExecuteNonQueryAsync(ct);
            }
            foreach (var (reference, _) in references)
            {
                await using var insert = new NpgsqlCommand("""
                    INSERT INTO public.article_revision_media (article_id,revision,asset_id) VALUES (@article,@revision,@asset);
                    INSERT INTO public.article_revision_media_import (article_id,revision,asset_id,source_revision_id,reference_count,alt_text)
                    VALUES (@article,@revision,@asset,@source_revision,@reference_count,@alt);
                    """, destination, tx);
                insert.Parameters.AddWithValue("asset", reference.AssetId);
                BindLegacyMediaActivationReference(insert, reference);
                await insert.ExecuteNonQueryAsync(ct);
            }
            await ExecuteAsync(destination, tx, "SET CONSTRAINTS ALL IMMEDIATE", ct);
            if (!await MatchesLegacyMediaActivationAsync(destination, tx, plan, activationSha, ct))
                throw new InvalidOperationException("Imported runtime media failed independent database readback.");
            // A lost commit acknowledgement can leave approved files already present while the DB is empty or complete.
            // Keep exact files on an indeterminate commit. The same approval rechecks every row and file before continuing.
            foreach (var asset in assets)
                await directory.Materialize(asset.Leaf(), bytes[asset.Source.AssetId], Convert.FromHexString(asset.Image.NormalizedSha256), ct);
            await VerifyLegacyMediaActivationFilesAsync(directory, assets, requireAll: true, ct);
        }
        RequireLegacyMediaActivationRoot(directory.Root, leaves, allowExactFiles: true);
        await tx.CommitAsync(ct);
        var status = already ? "revalidated" : "activated";
        if (single is not null)
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                activationSha256 = activationSha, assetId = single.Source.AssetId, articleId = single.Reference.ArticleId,
                single.Reference.Revision, targetSiteId = activation.Site, result = status, legacyCandidateServing = false
            }, Json));
        else
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                activationSha256 = activationSha, assets = assets.Length, references = references.Count,
                targetSiteId = activation.Site, result = status, legacyCandidateServing = false
            }, Json));
    }

    private static async Task<string?> ReadLegacyMediaActivationApprovalAsync(LegacyMediaActivationInput activation, CancellationToken ct)
    {
        if (activation.Approval is null) return null;
        if (!IsSha256(activation.ApprovalSha256)) throw new ArgumentException("Supply an independently approved activation SHA-256.");
        await using var input = OpenLegacyMediaReviewFile(activation.Approval);
        if (input.Length is < 1 or > 256_000 ||
            Convert.ToHexStringLower(await SHA256.HashDataAsync(input, ct)) != activation.ApprovalSha256)
            throw new InvalidOperationException("The legacy media activation approval file differs from its recorded SHA-256.");
        return activation.ApprovalSha256;
    }

    private static NpgsqlConnectionStringBuilder ParseLegacyMediaActivationDatabase()
    {
        var dsn = Environment.GetEnvironmentVariable(LegacyMediaActivationVariable);
        if (string.IsNullOrWhiteSpace(dsn)) throw new ArgumentException($"Set {LegacyMediaActivationVariable} to the independent runtime copy.");
        var settings = new NpgsqlConnectionStringBuilder(dsn) { Pooling = false, Enlist = false, Multiplexing = false, CommandTimeout = 30 };
        if (settings.Database is not { } name || !name.StartsWith(LegacyMediaRuntimePrefix, StringComparison.Ordinal) ||
            name.Length <= LegacyMediaRuntimePrefix.Length || name.Length > 63 || name.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '_') ||
            settings.Host is not { } host || host.Contains(',') || !Path.IsPathFullyQualified(host))
            throw new ArgumentException("Use a local Unix socket and a separately authorized fsusv2_import_runtime_* database.");
        RequireLegacyMediaPath(host);
        using var directory = OpenImportBackupDirectory(host);
        RequireLegacyMediaNode(directory, LegacyMediaDirectory, LegacyMediaPrivate);
        return settings;
    }

    private static async Task VerifyLegacyMediaRuntimeDestinationAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid site, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')=''
                AND current_setting('session_replication_role')='origin' AND NOT pg_is_in_recovery()
                AND to_regnamespace('fsus_legacy_candidate') IS NULL AND
                (SELECT version FROM public.v2_schema WHERE singleton)=$1
            """, db, tx);
        command.Parameters.AddWithValue(CurrentSchema.Version);
        if (await command.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("Activation needs a current independent runtime database with no TCP listener.");
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        if (await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct) != site ||
            !await CurrentSchema.HasPrivateMediaImportOriginAsync(db, tx, ct))
            throw new InvalidOperationException("The approved runtime site or imported-media schema differs.");
        await VerifyActivePublicationsAsync(db, tx, ct);
        await VerifyPublicationHistoryAsync(db, tx, ct);
    }

    private static async Task<LegacyMediaArticleWitness> ReadLegacyMediaActivationArticleAsync(NpgsqlConnection db,
        NpgsqlTransaction tx, Guid owner, LegacyMediaPreparationReference reference, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT jsonb_build_array(to_jsonb(a),to_jsonb(r),to_jsonb(p),
                (SELECT jsonb_agg(h ORDER BY h.event_no) FROM public.article_publication_history h WHERE h.article_id=a.id))::text,
                a.revision=r.revision
            FROM public.article a JOIN public.blog_user u ON u.id=a.owner_id
            JOIN public.article_revision r ON r.article_id=a.id AND r.revision=$2
            LEFT JOIN public.article_publication p ON p.article_id=a.id
            WHERE a.id=$1 AND u.id=$3 AND u.enabled AND u.can_author AND NOT a.deleted
                AND a.published_revision IS DISTINCT FROM r.revision AND p.revision IS DISTINCT FROM r.revision
                AND NOT EXISTS (SELECT FROM public.article_publication_rights x WHERE (x.article_id,x.revision)=(a.id,r.revision))
                AND (SELECT h.kind='retract' AND h.reason='administrator-rollback-archived'
                     FROM public.article_publication_history h WHERE h.article_id=a.id ORDER BY h.event_no DESC LIMIT 1) IS NOT true
            """, db, tx);
        command.Parameters.AddWithValue(reference.ArticleId);
        command.Parameters.AddWithValue(reference.Revision);
        command.Parameters.AddWithValue(owner);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new InvalidOperationException("Each reviewed attachment must refer to its owner's exact unpublished revision.");
        return new(DigestMediaDocument(row.GetString(0)), row.GetBoolean(1));
    }

    private static async Task<bool> VerifyLegacyMediaRuntimeBackupAsync(NpgsqlConnection db, NpgsqlTransaction tx, ImportBackup backup,
        LegacyMediaActivationBatch plan, string approvalSha, bool hasApproval, CancellationToken ct)
    {
        var (relations, media) = await ReadBackupSiteAsync(db, tx, ct);
        var previous = backup.Site.Relations.ToDictionary(relation => relation.Name, StringComparer.Ordinal);
        bool already = media.Count != 0;
        long ExpectedRows(string relation) => !already ? 0 : relation.StartsWith("private_media", StringComparison.Ordinal)
            ? plan.Assets.Length : plan.References.Length;
        if (db.PostgreSqlVersion.Major.ToString(CultureInfo.InvariantCulture) != backup.Site.PostgreSqlMajor ||
            relations.Count != previous.Count || relations.Count(item => ActivatedMediaRelations.Contains(item.Name, StringComparer.Ordinal)) != ActivatedMediaRelations.Length ||
            relations.Any(item => !previous.TryGetValue(item.Name, out var prior) ||
                (ActivatedMediaRelations.Contains(item.Name, StringComparer.Ordinal) ? prior.Kind != "r" || prior.Rows != 0 ||
                    item.Kind != "r" || item.Rows != ExpectedRows(item.Name) || !already && item != prior : item != prior)) ||
            already && (!hasApproval || !media.ToHashSet().SetEquals(plan.Assets.Select(asset =>
                new BackupMedia(asset.Source.AssetId.ToString("N"), asset.Image.Length, asset.Image.NormalizedSha256))) ||
                !await MatchesLegacyMediaActivationAsync(db, tx, plan, approvalSha, ct)))
            throw new InvalidOperationException("Runtime database does not match the reviewed pre-activation backup or this exact committed media activation.");
        return already;
    }

    private static void RequireLegacyMediaActivationRoot(string path, HashSet<string> approved, bool allowExactFiles)
    {
        using var root = OpenImportBackupDirectory(path);
        foreach (var name in EnumerateLegacyMediaLeaves(root))
        {
            if (!allowExactFiles || !approved.Contains(name))
                throw new InvalidOperationException("The approved runtime media root contains unexpected files. Recover the reviewed backup pair before continuing.");
            using var leaf = OpenLegacyMediaFile(root, name);
        }
    }

    private static async Task VerifyLegacyMediaActivationFilesAsync(MediaObjectDirectory directory,
        LegacyMediaActivationAsset[] assets, bool requireAll, CancellationToken ct)
    {
        foreach (var asset in assets)
            if (await directory.Read(asset.Leaf(), asset.Image.Length, Convert.FromHexString(asset.Image.NormalizedSha256), ct) is null && requireAll)
                throw new InvalidOperationException("A committed imported media file is missing. Restore the approved database and media pair.");
    }

    private static async Task<bool> MatchesLegacyMediaActivationAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyMediaActivationBatch plan, string approvalSha, CancellationToken ct)
    {
        var assets = plan.Assets.ToDictionary(asset => asset.Source.AssetId);
        foreach (var (reference, _) in plan.References)
        {
            await using var command = LegacyMediaActivationCommand(db, tx, plan, approvalSha, assets[reference.AssetId], """
                SELECT EXISTS (SELECT FROM public.private_media m JOIN public.private_media_import i ON i.asset_id=m.import_origin_id
                    JOIN public.article_revision_media_import r ON r.asset_id=i.asset_id
                    JOIN public.article_revision_media a ON (a.article_id,a.revision,a.asset_id)=(r.article_id,r.revision,r.asset_id)
                    WHERE m.id=@asset AND m.owner_id=@owner AND m.command_id IS NULL AND m.request_hash IS NULL
                        AND m.content_hash=@content AND m.name=@name AND m.format=1 AND m.length=@bytes AND m.width=@width
                        AND m.height=@height AND m.phase=1 AND m.created_at=@created
                        AND i.owner_id=@owner AND i.source_site_id=@source_site AND i.target_site_id=@site AND i.source_owner_id=@old_owner
                        AND i.activation_sha256=@approval AND i.plan_sha256=@plan AND i.projection_sha256=@projection
                        AND i.custody_manifest_sha256=@custody AND i.request_sha256=@request AND i.prepared_manifest_sha256=@prepared
                        AND i.normalizer_sha256=@normalizer AND i.raw_sha256=@raw
                        AND r.article_id=@article AND r.revision=@revision AND r.source_revision_id=@source_revision
                        AND r.reference_count=@reference_count AND r.alt_text IS NOT DISTINCT FROM @alt)
                """);
            BindLegacyMediaActivationReference(command, reference);
            if (await command.ExecuteScalarAsync(ct) is not true) return false;
        }
        return true;
    }

    private static NpgsqlCommand LegacyMediaActivationCommand(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyMediaActivationBatch plan, string approvalSha, LegacyMediaActivationAsset asset, string sql)
    {
        var command = new NpgsqlCommand(sql, db, tx);
        command.Parameters.AddWithValue("asset", asset.Source.AssetId);
        command.Parameters.AddWithValue("owner", asset.Source.TargetOwnerId);
        command.Parameters.AddWithValue("source_site", plan.SourceSiteId);
        command.Parameters.AddWithValue("site", plan.DestinationSiteId);
        command.Parameters.AddWithValue("old_owner", asset.Source.SourceOwnerId);
        command.Parameters.AddWithValue("approval", Convert.FromHexString(approvalSha));
        command.Parameters.AddWithValue("plan", Convert.FromHexString(plan.LegacyPlanSha256));
        command.Parameters.AddWithValue("projection", Convert.FromHexString(plan.ProjectionSha256));
        command.Parameters.AddWithValue("custody", Convert.FromHexString(plan.CustodyManifestSha256));
        command.Parameters.AddWithValue("request", Convert.FromHexString(plan.RequestSha256));
        command.Parameters.AddWithValue("prepared", Convert.FromHexString(plan.PreparedManifestSha256));
        command.Parameters.AddWithValue("normalizer", Convert.FromHexString(plan.NormalizerSha256));
        command.Parameters.AddWithValue("raw", Convert.FromHexString(asset.Source.RawSha256));
        command.Parameters.AddWithValue("content", Convert.FromHexString(asset.Image.NormalizedSha256));
        command.Parameters.AddWithValue("name", $"{asset.Source.AssetId:N}.png");
        command.Parameters.AddWithValue("bytes", asset.Image.Length);
        command.Parameters.AddWithValue("width", asset.Image.Width);
        command.Parameters.AddWithValue("height", asset.Image.Height);
        command.Parameters.AddWithValue("created", asset.CreatedAtUtc);
        return command;
    }

    private static void BindLegacyMediaActivationReference(NpgsqlCommand command, LegacyMediaPreparationReference reference)
    {
        command.Parameters.AddWithValue("article", reference.ArticleId);
        command.Parameters.AddWithValue("revision", reference.Revision);
        command.Parameters.AddWithValue("source_revision", reference.SourceRevisionId);
        command.Parameters.AddWithValue("reference_count", reference.ReferenceCount);
        command.Parameters.AddWithValue("alt", NpgsqlDbType.Text, (object?)reference.AltText ?? DBNull.Value);
    }

    private static async Task InitializePrivateMediaImportOriginAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true);
        if (!await CurrentSchema.HasPrivateMediaImportOriginAsync(db, tx, ct))
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("FsusBlogV2.OptionalSchema.private-media-import-origin.sql")
                ?? throw new InvalidOperationException("The private-media imported-origin schema is unavailable.");
            using var sql = new StreamReader(stream);
            await ExecuteAsync(db, tx, await sql.ReadToEndAsync(ct), ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true);
        }
        if (!await CurrentSchema.HasPrivateMediaImportOriginAsync(db, tx, ct))
            throw new InvalidOperationException("The exact private-media imported-origin schema is unavailable.");
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified private-media imported-origin schema.");
    }
}
