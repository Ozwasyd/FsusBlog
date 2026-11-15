using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyReleaseActivationVariable = "FSUSBLOG_RELEASE_ACTIVATION_DB";
    private static readonly Lazy<HashSet<string>> ReleaseActivationShadows = new(() => StagingDefinitions.Value.Select(table => table.Name)
        .Where(name => name != "shadow_article_responsibility_snapshot")
        .Concat([LegacyOutboxParent.Table.Name, LegacyOutboxEdge.Table.Name]).ToHashSet(StringComparer.Ordinal));

    private sealed record LegacyReleaseActivationInput(Guid Site, string Backup, string BackupSha256, string[] Approval);
    private sealed record LegacyReleaseActivationPlan(string Format, string SourcePlanSha256, string ProjectionSha256,
        Guid QuarantineSiteId, Guid RuntimeSiteId, DatabaseTarget RuntimeDatabase, string RuntimeCluster,
        string RollbackManifestSha256, Guid[] Owners, BackupRelation[] Relations);

    private static async Task RunLegacyReleaseActivationAsync(NpgsqlConnection source, NpgsqlTransaction sourceTx,
        ImportPlan plan, string planSha, string projectionSha, LegacyReleaseActivationInput input,
        ProjectionRelation[] projection, List<BackupRelation> business, int verifiedRepublishEvents, int verifiedRollbackEvents, CancellationToken ct)
    {
        if (input.Site == plan.TargetSiteId)
            throw new InvalidOperationException("The approved runtime site must differ from the source quarantine site.");
        var rollback = plan.Version == ImportPlanWithRollbackOutboxVersion;
        var owners = await VerifyLegacyReleaseScopeAsync(source, sourceTx, plan, verifiedRepublishEvents, verifiedRollbackEvents, ct);
        var publishProof = await ReadLegacyReleasePublishProofAsync(source, sourceTx, rollback, ct);
        var origin = rollback ? await ReadLegacyReleaseOriginAsync(source, sourceTx, planSha, projectionSha,
            plan.SourceAdminIdentitySha256, plan.SiteAuthor, ct, publishProof) : null;
        string? approved = null;
        if (input.Approval is [var path, var digest])
        {
            if (!IsSha256(digest)) throw new ArgumentException("Supply the independently approved release activation SHA-256.");
            await using var file = OpenLegacyMediaReviewFile(path);
            if (file.Length is < 1 or > 32_768 || Convert.ToHexStringLower(await SHA256.HashDataAsync(file, ct)) != digest)
                throw new InvalidOperationException("The legacy release approval file differs from its recorded SHA-256.");
            approved = digest;
        }
        var backup = await ReadLegacyImportBackupAsync(input.Backup, input.BackupSha256, ct);
        var settings = ParseLegacyRuntimeActivationDatabase(LegacyReleaseActivationVariable);
        await using var target = new NpgsqlConnection(settings.ConnectionString);
        await target.OpenAsync(ct);
        await RequireBackupDatabaseLockAsync(target, ct);
        await using var tx = await target.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        if (approved is null) await ExecuteAsync(target, tx, "SET TRANSACTION READ ONLY", ct);
        await ExecuteAsync(target, tx, "SET LOCAL search_path=pg_catalog", ct);
        await SetBackupRepresentationAsync(target, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(target, tx, ct, requireArticleMedia: true, requireArticleSummary: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(target, tx, ct);
        if (rollback && !await CurrentSchema.HasLegacyReleaseOriginAsync(target, tx, ct))
            throw new InvalidOperationException("Rollback activation requires the offline legacy release-origin schema.");
        var identity = await ReadTargetAsync(target, tx, ct);
        var cluster = await ReadLegacyPostgresClusterAsync(target, tx, ct);
        await using (var gate = new NpgsqlCommand("""
            SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')=''
                 AND current_setting('session_replication_role')='origin' AND NOT pg_is_in_recovery()
                 AND to_regnamespace('fsus_legacy_candidate') IS NULL
                 AND (SELECT array_agg(version) FROM public.v2_schema)=ARRAY[$2::int]
                 AND (SELECT count(*)=cardinality($1) AND bool_and(id=ANY($1) AND NOT enabled AND NOT can_author AND generation=1)
                      FROM public.blog_user)
            """, target, tx))
        {
            gate.Parameters.AddWithValue(owners);
            gate.Parameters.AddWithValue(CurrentSchema.Version);
            if (await gate.ExecuteScalarAsync(ct) is not true || identity == plan.Target ||
                await CurrentSchema.ReadRecoverySiteIdAsync(target, tx, ct) != input.Site ||
                source.PostgreSqlVersion.Major != target.PostgreSqlVersion.Major ||
                backup.Site.PostgreSqlMajor != target.PostgreSqlVersion.Major.ToString(CultureInfo.InvariantCulture))
                throw new InvalidOperationException("The independent runtime database, disabled owner mapping, site or PostgreSQL version differs.");
        }

        var transferredNames = projection.Select(relation => relation.Name).Concat(ProjectionSequences.Select(sequence => sequence.Name))
            .ToHashSet(StringComparer.Ordinal);
        var measured = business.Where(relation => transferredNames.Contains(relation.Name));
        if (origin is not null)
        {
            transferredNames.Add(origin.Measurement.Name);
            measured = measured.Append(origin.Measurement);
        }
        var expected = measured.OrderBy(row => row.Name, StringComparer.Ordinal).ToArray();
        if (expected.Length != transferredNames.Count) throw new InvalidOperationException("The verified source release rows are incomplete.");
        var before = backup.Site.Relations.ToDictionary(row => row.Name, StringComparer.Ordinal);
        foreach (var row in before.Values)
            if (row.Kind == "r" && row.Rows > 0 && row.Name != "blog_user" &&
                !await IsPristineLegacyCandidateSeedAsync(target, tx, row.Name, ct))
                throw new InvalidOperationException("The approved runtime rollback contains operational rows.");
        var (actual, media) = await ReadBackupSiteAsync(target, tx, ct);
        var transferable = actual.Where(row => transferredNames.Contains(row.Name)).OrderBy(row => row.Name, StringComparer.Ordinal).ToArray();
        if (media.Count != 0 || actual.Count != before.Count ||
            actual.Any(row => !before.TryGetValue(row.Name, out var prior) || row.Kind != prior.Kind ||
                !transferredNames.Contains(row.Name) && row != prior))
            throw new InvalidOperationException("The runtime database differs from the independently verified rollback baseline.");
        var pristine = transferable.All(row => row == before[row.Name]);
        var committed = transferable.SequenceEqual(expected);
        if (!pristine && (approved is null || !committed))
            throw new InvalidOperationException("The runtime releases match neither the empty rollback nor this complete approved batch.");

        var review = new LegacyReleaseActivationPlan("fsusblog.legacy-release-activation.v1", planSha, projectionSha,
            plan.TargetSiteId, input.Site, identity, cluster, input.BackupSha256, owners, expected);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(review, OwnerMapJson);
        var approvalSha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        if (approved is null)
        {
            await tx.RollbackAsync(ct);
            await Console.OpenStandardOutput().WriteAsync(bytes, ct);
            return;
        }
        if (approved != approvalSha)
            throw new InvalidOperationException("The approved release activation plan differs from this source, destination or rollback.");
        if (pristine)
        {
            foreach (var relation in projection)
            {
                var table = $"public.{relation.Name} ({relation.Columns})";
                await using var output = await source.BeginRawBinaryCopyAsync($"COPY {table} TO STDOUT (FORMAT BINARY)", ct);
                await using var copy = await target.BeginRawBinaryCopyAsync($"COPY {table} FROM STDIN (FORMAT BINARY)", ct);
                try { await output.CopyToAsync(copy, ct); }
                catch { await copy.CancelAsync(); throw; }
            }
            foreach (var sequence in ProjectionSequences)
            {
                var next = await ProjectionSequenceNextAsync(source, sourceTx, sequence, ct);
                await ExecuteAsync(target, tx, $"ALTER SEQUENCE public.{sequence.Name} RESTART WITH {next.ToString(CultureInfo.InvariantCulture)}", ct);
            }
            if (origin is not null)
            {
                await using var write = new NpgsqlCommand("""
                    INSERT INTO public.legacy_release_origin
                    SELECT * FROM json_populate_recordset(NULL::public.legacy_release_origin,$1::json)
                    """, target, tx);
                write.Parameters.AddWithValue(origin.Rows);
                if (await write.ExecuteNonQueryAsync(ct) != origin.Measurement.Rows)
                    throw new InvalidOperationException("Legacy release accountability rows were not imported.");
            }
            await ExecuteAsync(target, tx, "SET CONSTRAINTS ALL IMMEDIATE", ct);
            var (written, attached) = await ReadBackupSiteAsync(target, tx, ct);
            if (attached.Count != 0 || !written.Where(row => transferredNames.Contains(row.Name)).OrderBy(row => row.Name, StringComparer.Ordinal).SequenceEqual(expected) ||
                !written.Where(row => !transferredNames.Contains(row.Name)).SequenceEqual(actual.Where(row => !transferredNames.Contains(row.Name))))
                throw new InvalidOperationException("Activated runtime release rows failed independent database readback.");
        }
        await VerifyActivePublicationsAsync(target, tx, ct);
        await VerifyPublicationHistoryAsync(target, tx, ct);
        await VerifyArticleScheduleAsync(target, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            activationSha256 = approvalSha, siteId = input.Site, publications = expected.Single(row => row.Name == "article_publication").Rows,
            result = pristine ? "activated" : "revalidated", legacyCandidateServing = false, readyToApply = false
        }, Json));
    }

    private static async Task<Guid[]> VerifyLegacyReleaseScopeAsync(NpgsqlConnection db, NpgsqlTransaction tx,
        ImportPlan plan, int verifiedRepublishEvents, int verifiedRollbackEvents, CancellationToken ct)
    {
        var counts = plan.ExpectedTables.ToDictionary(row => row.Table, row => row.Rows, StringComparer.Ordinal);
        var articles = counts["shadow_article"];
        var rollback = plan.Version == ImportPlanWithRollbackOutboxVersion;
        var historical = rollback ? counts["shadow_article_responsibility_snapshot"] - 2 : 0;
        var validHistory = plan.Version switch
        {
            ImportPlanWithProcessedOutboxVersion => verifiedRepublishEvents == 0,
            ImportPlanWithRepublishOutboxVersion => verifiedRepublishEvents > 0 && verifiedRepublishEvents <= articles,
            ImportPlanWithRollbackOutboxVersion => articles == 1 && verifiedRepublishEvents == 1 && verifiedRollbackEvents == 1 &&
                historical is >= 0 and <= 2,
            _ => false
        };
        var publications = articles + verifiedRepublishEvents + verifiedRollbackEvents;
        if (plan.Provider != "postgres" || plan.SourceSeal?.Provenance != PostgresClusterProvenance ||
            !validHistory || plan.Media is not null || articles is < 1 or > 32 || counts["shadow_article_rights_policy"] != articles ||
            counts.Any(item => item.Value != 0 && !ReleaseActivationShadows.Value.Contains(item.Key) &&
                !(rollback && item.Key == "shadow_article_responsibility_snapshot")) ||
            new[] { "shadow_revision", "shadow_publication", "shadow_article_rights_snapshot" }
                .Any(table => !counts.TryGetValue(table, out var rows) || rows != publications) ||
            !counts.TryGetValue(LegacyOutboxParent.Table.Name, out var events) || events != publications + historical ||
            !counts.TryGetValue(LegacyOutboxEdge.Table.Name, out var edges) ||
            edges != publications * LegacyRequiredOutboxEdges.Length + historical * LegacyKnownOutboxEdges.Count)
            throw new InvalidOperationException("Release activation requires a complete verified immediate publication or rollback batch and its retained work.");
        await using var command = new NpgsqlCommand($"""
            SELECT a.owner_id::uuid
            FROM {ImportSchema}.shadow_article a
            JOIN {ImportSchema}.shadow_revision r ON r.source_revision_id=a.current_source_revision_id
            JOIN {ImportSchema}.shadow_publication p ON p.source_publication_id=a.current_publication_id
            JOIN {ImportSchema}.shadow_article_rights_snapshot s ON s.id=p.source_rights_snapshot_id
            JOIN {ImportSchema}.shadow_article_rights_policy q ON q.id=s.article_rights_policy_id AND q.article_id=a.id
            WHERE a.source_status=2 AND a.deleted=0 AND ((NOT $1 AND a.current_revision IN (1,2)) OR ($1 AND a.current_revision=3))
              AND a.current_public_revision_candidate=a.current_revision AND a.last_publication_number=a.current_revision
              AND a.summary IS NOT DISTINCT FROM r.summary
              AND p.article_id=a.id AND p.source_revision_id=r.source_revision_id AND r.article_id=a.id AND r.revision=a.current_revision
              AND p.publication_number=a.current_revision AND p.revision=a.current_revision AND s.enabled=1
              AND ($1 OR s.proof_binding_enabled=0)
              AND (q.enabled,q.license_type,q.copyright_holder,q.copyright_year,q.rights_statement,q.attribution_template,
                q.copy_policy,q.max_excerpt_chars,q.allow_code_copy,q.show_public_badge,q.proof_binding_enabled)
                  IS NOT DISTINCT FROM (s.enabled,s.license_type,s.copyright_holder,s.copyright_year,s.rights_statement,s.attribution_template,
                    s.copy_policy,s.max_excerpt_chars,s.allow_code_copy,s.show_public_badge,s.proof_binding_enabled)
              AND (SELECT count(DISTINCT old.publication_number)
                  FROM {ImportSchema}.shadow_publication old
                  JOIN {ImportSchema}.shadow_revision original ON original.article_id=a.id
                      AND original.source_revision_id=old.source_revision_id AND original.revision=old.revision
                  JOIN {ImportSchema}.shadow_article_rights_snapshot rights ON rights.id=old.source_rights_snapshot_id
                  JOIN {ImportSchema}.{LegacyOutboxParent.Table.Name} e ON e.aggregate_id=a.id
                      AND e.event_type=CASE WHEN old.publication_number=1 THEN 'created' ELSE 'updated' END
                      AND e.article_revision_id=original.source_revision_id AND e.article_publication_id=old.source_publication_id
                      AND e.rights_snapshot_id=rights.id
                  WHERE old.article_id=a.id AND old.publication_number BETWEEN 1 AND a.current_revision
                    AND old.revision=old.publication_number AND rights.enabled=1
                    AND old.source_transition=CASE WHEN old.publication_number=3 THEN 'rollback' ELSE 'immediate-publish' END
                    AND ($1 OR (old.source_responsibility_snapshot_id IS NULL AND rights.proof_binding_enabled=0)))=a.current_revision
              AND NOT EXISTS (SELECT FROM {ImportSchema}.shadow_article_revision_content_block b
                  WHERE NOT EXISTS (SELECT FROM {ImportSchema}.shadow_revision x WHERE x.source_content_block_id=b.id))
            ORDER BY a.id
            """, db, tx);
        command.Parameters.AddWithValue(rollback);
        var owners = new List<Guid>();
        await using var rows = await command.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct)) owners.Add(rows.GetGuid(0));
        if (owners.Count != articles)
            throw new InvalidOperationException("A legacy release article, approved owner, rights policy or retained delivery differs.");
        return owners.Distinct().Order().ToArray();
    }
}
