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

    private static async Task RunLegacyMediaActivationAsync(NpgsqlConnection quarantine, NpgsqlTransaction quarantineTx,
        ImportPlan import, string quarantineBackup, LegacyImportMediaInput custody, LegacyMediaManifest media,
        PreparedLegacyMediaInput prepared, LegacyMediaActivationInput activation, LegacyMediaPreparationRequest request,
        byte[] requestBytes, CancellationToken ct)
    {
        if (request.Assets is not [var source] || request.References is not [var reference] ||
            source.AssetId != reference.AssetId || reference.ReferenceCount != 1 || source.MediaType != "image/png")
            throw new InvalidOperationException("Activation currently requires one reviewed private PNG with one exact revision reference.");
        if (activation.Site == request.SourceSiteId || activation.Site == request.TargetSiteId)
            throw new InvalidOperationException("The runtime destination must have its own reviewed site identity.");
        var approvalSha = await ReadLegacyMediaActivationApprovalAsync(activation, ct);
        var preActivation = await ReadLegacyImportBackupAsync(activation.Backup, activation.BackupSha256, ct);
        byte[]? encoded = null;
        var result = await ReadPreparedLegacyMediaAsync(prepared, request, requestBytes, ct, bytes => encoded = bytes);
        var image = result.Assets.Single();
        var created = DateTimeOffset.ParseExact(media.Files.Single().CreatedAtUtc, "O", CultureInfo.InvariantCulture);
        if (created.Offset != TimeSpan.Zero || encoded is null)
            throw new InvalidOperationException("The original private media timestamp or prepared image is unavailable.");
        var article = await ReadLegacyMediaActivationArticleAsync(quarantine, quarantineTx, source.TargetOwnerId, reference, ct);
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
        if (article != await ReadLegacyMediaActivationArticleAsync(destination, tx, source.TargetOwnerId, reference, ct))
            throw new InvalidOperationException("The approved runtime copy does not match the original private article and revision.");

        var separate = new List<string> { quarantineBackup, custody.Path, prepared.Package, activation.Backup };
        if (activation.Approval is { } approval) separate.Add(Path.GetDirectoryName(approval)!);
        foreach (var setting in new[] { "FSUSBLOG_WEB_DIST", "FSUSBLOG_PUBLIC_MEDIA_ROOT", "FSUSBLOG_APPEARANCE_ROOT" })
            if (Environment.GetEnvironmentVariable(setting) is { Length: > 0 } path) separate.Add(path);
        RequireLegacyMediaPath(activation.Root);
        using var directory = new MediaObjectDirectory(activation.Root, LegacyMediaPreparation.MaxFileBytes, separate);
        var plan = new LegacyMediaActivationPlan(LegacyMediaActivationFormat, request.PlanSha256, request.ProjectionSha256,
            request.CustodyManifestSha256, result.RequestSha256, prepared.ManifestSha256, result.NormalizerSha256,
            request.SourceSiteId, request.TargetSiteId, activation.Site, identity, cluster, directory.Root,
            activation.BackupSha256, article, created, source, image, reference);
        var planBytes = JsonSerializer.SerializeToUtf8Bytes(plan, OwnerMapJson);
        var activationSha = Convert.ToHexStringLower(SHA256.HashData(planBytes));
        if (approvalSha is not null && approvalSha != activationSha)
            throw new InvalidOperationException("The approved activation plan differs from the artifact, runtime database, site or media root.");

        var already = await VerifyLegacyMediaRuntimeBackupAsync(destination, tx, preActivation, plan, activationSha, approvalSha is not null, ct);
        var leaf = $"{source.AssetId:N}.media";
        var hash = Convert.FromHexString(image.NormalizedSha256);
        RequireLegacyMediaActivationRoot(directory.Root, leaf, approvalSha is not null);
        var existing = await directory.Read(leaf, image.Length, hash, ct);
        if (already && existing is null)
            throw new InvalidOperationException("The committed imported media file is missing. Restore the approved database and media pair.");
        if (approvalSha is null)
        {
            await tx.RollbackAsync(ct);
            await Console.OpenStandardOutput().WriteAsync(planBytes, ct);
            return;
        }
        if (!already)
        {
            await using var insert = LegacyMediaActivationCommand(destination, tx, plan, activationSha, """
                INSERT INTO public.private_media_import (asset_id,owner_id,source_site_id,target_site_id,source_owner_id,
                    activation_sha256,plan_sha256,projection_sha256,custody_manifest_sha256,request_sha256,
                    prepared_manifest_sha256,normalizer_sha256,raw_sha256)
                VALUES (@asset,@owner,@source_site,@site,@old_owner,@approval,@plan,@projection,@custody,@request,@prepared,@normalizer,@raw);
                INSERT INTO public.private_media (id,owner_id,content_hash,name,format,length,width,height,phase,created_at,import_origin_id)
                VALUES (@asset,@owner,@content,@name,1,@bytes,@width,@height,1,@created,@asset);
                INSERT INTO public.article_revision_media (article_id,revision,asset_id) VALUES (@article,@revision,@asset);
                INSERT INTO public.article_revision_media_import (article_id,revision,asset_id,source_revision_id,reference_count,alt_text)
                VALUES (@article,@revision,@asset,@source_revision,@reference_count,@alt);
                SET CONSTRAINTS ALL IMMEDIATE;
                """);
            await insert.ExecuteNonQueryAsync(ct);
            if (!await MatchesLegacyMediaActivationAsync(destination, tx, plan, activationSha, ct))
                throw new InvalidOperationException("Imported runtime media failed independent database readback.");
            // A lost commit acknowledgement can leave this exact file with zero or one committed job.
            // Do not unlink a file on an indeterminate commit. The same approval rechecks both sides.
            await directory.Materialize(leaf, encoded, hash, ct);
            if (await directory.Read(leaf, image.Length, hash, ct) is null)
                throw new IOException("The staged private media file failed durable readback.");
        }
        RequireLegacyMediaActivationRoot(directory.Root, leaf, allowExactFile: true);
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            activationSha256 = activationSha, assetId = source.AssetId, articleId = reference.ArticleId, reference.Revision,
            targetSiteId = activation.Site, result = already ? "revalidated" : "activated", legacyCandidateServing = false
        }, Json));
    }

    private static async Task<string?> ReadLegacyMediaActivationApprovalAsync(LegacyMediaActivationInput activation, CancellationToken ct)
    {
        if (activation.Approval is null) return null;
        if (!IsSha256(activation.ApprovalSha256)) throw new ArgumentException("Supply an independently approved activation SHA-256.");
        await using var input = OpenLegacyMediaReviewFile(activation.Approval);
        if (input.Length is < 1 or > 32_768 ||
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

    private static async Task<string> ReadLegacyMediaActivationArticleAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, LegacyMediaPreparationReference reference, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            SELECT jsonb_build_array(to_jsonb(a),to_jsonb(r),to_jsonb(p),
                (SELECT jsonb_agg(h ORDER BY h.event_no) FROM public.article_publication_history h WHERE h.article_id=a.id))::text
            FROM public.article a JOIN public.blog_user u ON u.id=a.owner_id
            JOIN public.article_revision r ON r.article_id=a.id AND r.revision=a.revision
            LEFT JOIN public.article_publication p ON p.article_id=a.id
            WHERE a.id=$1 AND a.revision=$2 AND u.id=$3 AND u.enabled AND u.can_author
                AND NOT a.deleted AND a.published_revision IS DISTINCT FROM a.revision
                AND p.revision IS DISTINCT FROM a.revision
                AND (SELECT h.kind='retract' AND h.reason='administrator-rollback-archived'
                     FROM public.article_publication_history h WHERE h.article_id=a.id ORDER BY h.event_no DESC LIMIT 1) IS NOT true
            """, db, tx);
        command.Parameters.AddWithValue(reference.ArticleId);
        command.Parameters.AddWithValue(reference.Revision);
        command.Parameters.AddWithValue(owner);
        var observed = await command.ExecuteScalarAsync(ct) as string;
        return observed is not null ? DigestMediaDocument(observed) :
            throw new InvalidOperationException("The original reviewed attachment must refer to the owner's exact current private revision.");
    }

    private static async Task<bool> VerifyLegacyMediaRuntimeBackupAsync(NpgsqlConnection db, NpgsqlTransaction tx, ImportBackup backup,
        LegacyMediaActivationPlan plan, string approvalSha, bool hasApproval, CancellationToken ct)
    {
        var (relations, media) = await ReadBackupSiteAsync(db, tx, ct);
        var previous = backup.Site.Relations.ToDictionary(relation => relation.Name, StringComparer.Ordinal);
        bool already = media.Count != 0;
        if (db.PostgreSqlVersion.Major.ToString(CultureInfo.InvariantCulture) != backup.Site.PostgreSqlMajor ||
            relations.Count != previous.Count || relations.Count(item => ActivatedMediaRelations.Contains(item.Name, StringComparer.Ordinal)) != ActivatedMediaRelations.Length ||
            relations.Any(item => !previous.TryGetValue(item.Name, out var prior) ||
                (ActivatedMediaRelations.Contains(item.Name, StringComparer.Ordinal) ? prior.Kind != "r" || prior.Rows != 0 ||
                    item.Kind != "r" || item.Rows != (already ? 1 : 0) || !already && item != prior : item != prior)) ||
            already && (!hasApproval || media is not [var activated] ||
                activated != new BackupMedia(plan.Source.AssetId.ToString("N"), plan.Image.Length, plan.Image.NormalizedSha256) ||
                !await MatchesLegacyMediaActivationAsync(db, tx, plan, approvalSha, ct)))
            throw new InvalidOperationException("Runtime database does not match the reviewed pre-activation backup or this exact committed media activation.");
        return already;
    }

    private static void RequireLegacyMediaActivationRoot(string path, string leaf, bool allowExactFile)
    {
        using var root = OpenImportBackupDirectory(path);
        if (EnumerateLegacyMediaLeaves(root).Any(name => !allowExactFile || name != leaf))
            throw new InvalidOperationException("The approved runtime media root contains unexpected files. Recover the reviewed backup pair before continuing.");
    }

    private static async Task<bool> MatchesLegacyMediaActivationAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyMediaActivationPlan plan, string approvalSha, CancellationToken ct)
    {
        await using var command = LegacyMediaActivationCommand(db, tx, plan, approvalSha, """
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
        return await command.ExecuteScalarAsync(ct) is true;
    }

    private static NpgsqlCommand LegacyMediaActivationCommand(NpgsqlConnection db, NpgsqlTransaction tx,
        LegacyMediaActivationPlan plan, string approvalSha, string sql)
    {
        var command = new NpgsqlCommand(sql, db, tx);
        command.Parameters.AddWithValue("asset", plan.Source.AssetId);
        command.Parameters.AddWithValue("owner", plan.Source.TargetOwnerId);
        command.Parameters.AddWithValue("source_site", plan.SourceSiteId);
        command.Parameters.AddWithValue("site", plan.DestinationSiteId);
        command.Parameters.AddWithValue("old_owner", plan.Source.SourceOwnerId);
        command.Parameters.AddWithValue("approval", Convert.FromHexString(approvalSha));
        command.Parameters.AddWithValue("plan", Convert.FromHexString(plan.LegacyPlanSha256));
        command.Parameters.AddWithValue("projection", Convert.FromHexString(plan.ProjectionSha256));
        command.Parameters.AddWithValue("custody", Convert.FromHexString(plan.CustodyManifestSha256));
        command.Parameters.AddWithValue("request", Convert.FromHexString(plan.RequestSha256));
        command.Parameters.AddWithValue("prepared", Convert.FromHexString(plan.PreparedManifestSha256));
        command.Parameters.AddWithValue("normalizer", Convert.FromHexString(plan.NormalizerSha256));
        command.Parameters.AddWithValue("raw", Convert.FromHexString(plan.Source.RawSha256));
        command.Parameters.AddWithValue("content", Convert.FromHexString(plan.Image.NormalizedSha256));
        command.Parameters.AddWithValue("name", $"{plan.Source.AssetId:N}.png");
        command.Parameters.AddWithValue("bytes", plan.Image.Length);
        command.Parameters.AddWithValue("width", plan.Image.Width);
        command.Parameters.AddWithValue("height", plan.Image.Height);
        command.Parameters.AddWithValue("created", plan.CreatedAtUtc);
        command.Parameters.AddWithValue("article", plan.Reference.ArticleId);
        command.Parameters.AddWithValue("revision", plan.Reference.Revision);
        command.Parameters.AddWithValue("source_revision", plan.Reference.SourceRevisionId);
        command.Parameters.AddWithValue("reference_count", plan.Reference.ReferenceCount);
        command.Parameters.AddWithValue("alt", NpgsqlDbType.Text, (object?)plan.Reference.AltText ?? DBNull.Value);
        return command;
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
