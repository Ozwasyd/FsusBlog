using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Text.Json;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private const int LegacyProjectionVersion = 1;
    private const string LegacyProjectionReceipt = "current_projection";

    private static async Task<int> RunLegacyProjectionAsync(string mode, string planPath, string planDigest, string backupPath,
        string backupDigest, CancellationToken token)
    {
        if (!IsSha256(planDigest)) throw new ArgumentException("Supply the original staging plan SHA-256.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromMinutes(8));
        var ct = timeout.Token;
        try
        {
            var plan = await ReadImportPlanAsync(planPath, ct);
            if (plan.Version != ImportPlanVersion || plan.SourceReference != LegacyReference || !plan.ReadyToStage ||
                plan.ReadyToApply || plan.Findings is not { Length: 0 } || plan.ExpectedTables is null ||
                plan.SchemaVersion != CurrentSchema.Version || plan.SchemaSha256 != Digest(await SchemaSqlAsync(ct)) ||
                plan.BackupManifestSha256 != backupDigest || CanonicalImportPlanDigest(plan) != planDigest)
                throw new InvalidOperationException("The independently recorded staging plan and current schema must match exactly.");
            var backup = await ReadLegacyImportBackupAsync(backupPath, backupDigest, ct);
            var settings = ParseImportTarget();
            await using var target = new NpgsqlConnection(settings.ConnectionString);
            await target.OpenAsync(ct);
            await RequireBackupDatabaseLockAsync(target, ct);
            await using var tx = mode == "verify"
                ? await BeginReadOnlyAsync(target, ct)
                : await target.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
            await ExecuteAsync(target, tx, "SET LOCAL search_path TO pg_catalog", ct);
            await SetBackupRepresentationAsync(target, tx, ct);

            bool already = await VerifyProjectionCandidateAsync(target, tx, plan, planDigest, ct);
            if (mode == "verify" && !already)
                throw new InvalidOperationException("No sealed current-table projection exists.");
            await VerifyLegacyProjectionFactsAsync(target, tx, ct);
            await VerifyProjectedLegacyRightsAsync(target, tx, ct);
            var projection = await BuildProjectionRelationsAsync(target, tx, ct);
            await VerifyProjectionCoverageAsync(target, tx, backup, projection, already, ct);
            if (!already)
                await InsertLegacyProjectionAsync(target, tx, projection, ct);

            await VerifyActivePublicationsAsync(target, tx, ct);
            await VerifyPublicationHistoryAsync(target, tx, ct);
            await VerifyArticleScheduleAsync(target, tx, ct);
            await VerifyProjectionReadbackAsync(target, tx, projection, ct);
            var (business, media) = await ReadBackupSiteAsync(target, tx, ct, excludedSchema: ImportSchema);
            if (media.Count != 0) throw new InvalidOperationException("A quarantined article projection cannot contain private media.");
            var projectionDigest = DigestMediaDocument(new { format = LegacyProjectionVersion, planDigest, business });
            await SaveOrVerifyProjectionReceiptAsync(target, tx, already, planDigest, projectionDigest, ct);
            await tx.CommitAsync(ct);

            Console.WriteLine(JsonSerializer.Serialize(new
            {
                planSha256 = planDigest,
                projectionSha256 = projectionDigest,
                result = mode == "verify" ? "verified" : already ? "revalidated" : "projected",
                readyToApply = false,
                retainedLegacyPublicationRows = plan.ExpectedTables.Single(row => row.Table == "shadow_publication").Rows,
                remaining = new[] { "quarantined legacy history and responsibility metadata", "nonpublished rights and digital proof custody",
                    "unsupported domain conversion and activation" }
            }, Json));
            return 0;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && timeout.IsCancellationRequested)
        {
            throw new InvalidOperationException("The staged legacy projection exceeded its run budget.");
        }
        catch (PostgresException error)
        {
            throw new InvalidOperationException($"The candidate rejected its staged projection ({error.SqlState}).");
        }
        catch (DbException error)
        {
            throw new InvalidOperationException($"The candidate rejected its staged projection ({error.GetType().Name}).");
        }
    }

    private static async Task<bool> VerifyProjectionCandidateAsync(NpgsqlConnection target, NpgsqlTransaction tx, ImportPlan plan,
        string planDigest, CancellationToken token)
    {
        if (await ReadTargetAsync(target, tx, token) != plan.Target ||
            await CurrentSchema.ReadRecoverySiteIdAsync(target, tx, token) != plan.TargetSiteId)
            throw new InvalidOperationException("The quarantined candidate is not the original staged database and site.");
        await CurrentSchema.VerifyCatalogAsync(target, tx, token);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(target, tx, token);
        await using (var marker = new NpgsqlCommand($"""
            SELECT current_setting('session_replication_role')='origin'
               AND (SELECT version FROM public.v2_schema WHERE singleton)=$1
               AND to_regnamespace('{ImportSchema}') IS NOT NULL
            """, target, tx))
        {
            marker.Parameters.AddWithValue(ImportQuarantineVersion);
            if (await marker.ExecuteScalarAsync(token) is not true)
                throw new InvalidOperationException("Projection requires an existing non-serving legacy candidate.");
        }
        await VerifyCandidateHeaderAsync(target, plan, planDigest, token, tx);
        var already = await HasRelation(target, tx, $"{ImportSchema}.{LegacyProjectionReceipt}", token);
        await AssertCandidateRelationsAsync(target, StagingTables, token, tx, already);
        var expected = plan.ExpectedTables;
        if (expected.Length != StagingTables.Length || !expected.Select(row => row.Table).ToHashSet()
                .SetEquals(StagingTables.Select(table => table.Name)) ||
            expected.Any(row => row.Rows < 0 || !IsSha256(row.Sha256)))
            throw new InvalidOperationException("The staging plan does not define the complete verified projection.");
        await using (var check = new NpgsqlCommand($"SELECT phase,digest FROM {ImportSchema}.checkpoint ORDER BY phase", target, tx))
        await using (var rows = await check.ExecuteReaderAsync(token))
        {
            for (var phase = 1; phase <= 3; phase++)
            {
                var stage = StagingTables.Where(table => table.Phase == phase).Select(table => table.Name).ToHashSet();
                if (!await rows.ReadAsync(token) || rows.GetInt32(0) != phase ||
                    rows.GetString(1) != StagingCheckpointDigest(expected.Where(row => stage.Contains(row.Table))))
                    throw new InvalidOperationException("The staged candidate requires all original verified checkpoints.");
            }
            if (await rows.ReadAsync(token)) throw new InvalidOperationException("The staged candidate has an unregistered checkpoint.");
        }
        foreach (var table in StagingTables)
            if (await MeasureCandidateTableAsync(target, tx, table, token) != expected.Single(row => row.Table == table.Name))
                throw new InvalidOperationException($"Staged source has changed: {table.Name}.");
        return already;
    }

    private static async Task SaveOrVerifyProjectionReceiptAsync(NpgsqlConnection target, NpgsqlTransaction tx, bool already,
        string planDigest, string projectionDigest, CancellationToken token)
    {
        if (!already)
        {
            await ExecuteAsync(target, tx, $"""
                CREATE TABLE {ImportSchema}.{LegacyProjectionReceipt} (
                    singleton boolean PRIMARY KEY CHECK (singleton),
                    version integer NOT NULL CHECK (version={LegacyProjectionVersion}),
                    plan_sha256 text NOT NULL CHECK (char_length(plan_sha256)=64),
                    projection_sha256 text NOT NULL CHECK (char_length(projection_sha256)=64),
                    projected_at timestamptz NOT NULL
                )
                """, token);
            await using var insert = new NpgsqlCommand($"""
                INSERT INTO {ImportSchema}.{LegacyProjectionReceipt} VALUES (true,{LegacyProjectionVersion},$1,$2,clock_timestamp())
                """, target, tx);
            insert.Parameters.AddWithValue(planDigest);
            insert.Parameters.AddWithValue(projectionDigest);
            await insert.ExecuteNonQueryAsync(token);
        }
        await using var select = new NpgsqlCommand($"""
            SELECT singleton,version,plan_sha256,projection_sha256,
                projected_at IS NOT NULL AND isfinite(projected_at)
            FROM {ImportSchema}.{LegacyProjectionReceipt}
            """, target, tx);
        await using var row = await select.ExecuteReaderAsync(token);
        if (!await row.ReadAsync(token) || !row.GetBoolean(0) || row.GetInt32(1) != LegacyProjectionVersion ||
            row.GetString(2) != planDigest || row.GetString(3) != projectionDigest || !row.GetBoolean(4) ||
            await row.ReadAsync(token))
            throw new InvalidOperationException("The sealed current-table projection receipt differs.");
    }
}
