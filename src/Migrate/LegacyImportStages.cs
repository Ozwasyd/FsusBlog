using System.Data;
using System.Data.Common;
using System.Security.Cryptography;
using Npgsql;
using NpgsqlTypes;

internal static partial class Migration
{
    private sealed record CandidateColumn(string Name, string Kind);
    private sealed record CandidateTable(string Name, int Phase, string Key, CandidateColumn[] Columns,
        string[]? Unique = null, string[]? NonNull = null);
    private sealed record StageResult(int Phase, string Sha256, string Result);

    private static readonly Lazy<CandidateTable[]> StagingDefinitions = new(() =>
    [
        Candidate("shadow_article", 1, "id", """
            id legacy_admin_id owner_id:text current_source_revision_id current_revision title:text body:text summary:text
            cover_image_url:text source_status source_category_id deleted scheduled_publish_at:text pending_publication_at:text
            published_at:text last_published_at:text public_updated_at:text archived_at:text deleted_at:text current_publication_id
            current_public_revision_candidate last_publication_number created_at:text updated_at:text
            source_metadata_updated_at:text source_body_updated_at:text
            """),
        Candidate("shadow_revision", 1, "source_revision_id", """
            source_revision_id article_id revision title:text body:text summary:text cover_image_url:text source_category_id
            source_tag_ids:text source_content_block_id source_content_sha256:text source_inline_markdown:text source_diff_summary:text
            source_admin_id source_rollback_revision_id source_rollback_reason:text happened_at:text
            """),
        Candidate("shadow_publication", 1, "source_publication_id", """
            source_publication_id article_id source_revision_id revision publication_number source_rights_snapshot_id
            source_responsibility_snapshot_id source_transition:text published_at:text source_created_at:text
            """),
        ReleaseCandidate(Block, 1, "id"),
        ReleaseCandidate(Category, 2, "id"),
        ReleaseCandidate(Tag, 2, "id"),
        ReleaseCandidate(TagAlias, 2, "normalized_name COLLATE BINARY"),
        ReleaseCandidate(ArticleTag, 2, "articleid, tagid"),
        Candidate("shadow_revision_tag", 2, "source_revision_id, tag_id", "source_revision_id tag_id"),
        ReleaseCandidate(RightsPolicy, 3, "id"),
        ReleaseCandidate(RightsSnapshot, 3, "id"),
        ReleaseCandidate(Responsibility, 3, "id")
    ]);

    private static CandidateTable[] CandidateDefinitions(ImportPlan plan)
    {
        var definitions = BaseCandidateDefinitions(plan);
        var readingHistory = LegacyReadingHistoryDefinitions(plan);
        return [.. definitions, .. readingHistory, .. LegacySavedViewDefinitions(plan)];
    }

    private static CandidateTable[] BaseCandidateDefinitions(ImportPlan plan) => plan.Version switch
    {
        ImportPlanVersion => StagingDefinitions.Value,
        ImportPlanWithCreateCommandsVersion when plan.Provider == "postgres" && HasCompleteLegacyCommandPlan(plan) =>
            [.. StagingDefinitions.Value, LegacyCreateCommandShadow],
        ImportPlanWithProcessedOutboxVersion or ImportPlanWithRepublishOutboxVersion or ImportPlanWithRollbackOutboxVersion
            when plan.Provider == "postgres" && HasCompleteLegacyOutboxPlan(plan) =>
            [.. StagingDefinitions.Value, .. OptionalLegacyCommandDefinition(plan), LegacyOutboxParent.Table, LegacyOutboxEdge.Table],
        _ => throw new InvalidOperationException("The legacy import plan version and provider do not support this projection.")
    };

    private static CandidateTable Candidate(string name, int phase, string key, string fields, string[]? unique = null,
        string[]? nonNull = null) =>
        new(name, phase, key, fields.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Select(field => field.EndsWith(":text", StringComparison.Ordinal)
                ? new CandidateColumn(field[..^5], "TEXT") : new CandidateColumn(field, "INTEGER")).ToArray(), unique, nonNull);

    private static CandidateTable ReleaseCandidate(string name, int phase, string key) =>
        new("shadow_" + name, phase, key, LegacyColumns[name].Select(field =>
            new CandidateColumn(field, IsLegacyText(field) || IsLegacyTimestamp(field) ? "TEXT" : "INTEGER")).ToArray());

    private static async Task<StageResult[]> StageLegacyCandidateAsync(NpgsqlConnection target, LegacyShadow shadow,
        ImportPlan plan, string digest, bool quarantined, CancellationToken token)
    {
        var definitions = CandidateDefinitions(plan);
        if (!quarantined) await BeginLegacyCandidateAsync(target, plan, digest, token);
        await VerifyCandidateHeaderAsync(target, plan, digest, token);
        await ValidateCommittedPhasePrefixAsync(target, definitions, token);
        var stages = new List<StageResult>();
        foreach (var phase in definitions.Select(table => table.Phase).Distinct())
        {
            await using var tx = await target.BeginTransactionAsync(IsolationLevel.RepeatableRead, token);
            await ExecuteAsync(target, tx, "SET LOCAL search_path TO pg_catalog", token);
            var cohort = definitions.Where(table => table.Phase == phase).ToArray();
            var expectedTables = plan.ExpectedTables.Where(row => cohort.Any(table => table.Name == row.Table)).ToArray();
            var expectedCheckpoint = StagingCheckpointDigest(expectedTables);

            await using var checkpoint = new NpgsqlCommand(
                $"SELECT digest FROM {ImportSchema}.checkpoint WHERE phase=$1", target, tx);
            checkpoint.Parameters.Add(new NpgsqlParameter<int> { TypedValue = phase });
            var previous = await checkpoint.ExecuteScalarAsync(token) as string;
            if (previous is not null && previous != expectedCheckpoint)
                throw new InvalidOperationException("The legacy candidate stage checkpoint no longer matches the verified source.");

            foreach (var table in cohort)
            {
                if (previous is null) await StageCandidateTableAsync(target, tx, shadow.Database, table, token);
                var observed = await MeasureCandidateTableAsync(target, tx, table, token);
                if (observed != expectedTables.Single(row => row.Table == table.Name))
                    throw new InvalidOperationException($"Candidate table {table.Name} does not match its independently read source projection.");
            }

            if (previous is null)
            {
                await using var save = new NpgsqlCommand(
                    $"INSERT INTO {ImportSchema}.checkpoint (phase,digest) VALUES ($1,$2)", target, tx);
                save.Parameters.Add(new NpgsqlParameter<int> { TypedValue = phase });
                save.Parameters.Add(new NpgsqlParameter<string> { TypedValue = expectedCheckpoint });
                await save.ExecuteNonQueryAsync(token);
            }
            await tx.CommitAsync(token);
            stages.Add(new StageResult(phase, expectedCheckpoint, previous is null ? "staged" : "revalidated"));
        }
        await AssertCandidateRelationsAsync(target, definitions, token);
        return stages.ToArray();
    }

    private static async Task BeginLegacyCandidateAsync(NpgsqlConnection target, ImportPlan plan, string digest, CancellationToken token)
    {
        await using var tx = await target.BeginTransactionAsync(token);
        await ExecuteAsync(target, tx, "SET LOCAL search_path TO pg_catalog", token);
        await ExecuteAsync(target, tx, BootstrapLock, token);
        await ExecuteAsync(target, tx, $"""
            CREATE SCHEMA {ImportSchema};
            CREATE TABLE {ImportSchema}.candidate (
                singleton boolean PRIMARY KEY CHECK (singleton),
                plan_sha256 text NOT NULL CHECK (char_length(plan_sha256)=64),
                site_id uuid NOT NULL,
                backup_manifest_sha256 text NOT NULL CHECK (char_length(backup_manifest_sha256)=64),
                serving boolean NOT NULL CHECK (serving = false)
            );
            CREATE TABLE {ImportSchema}.checkpoint (
                phase integer PRIMARY KEY CHECK (phase IN (1,2,3)),
                digest text NOT NULL CHECK (char_length(digest)=64)
            )
            """, token);
        await using (var insert = new NpgsqlCommand(
            $"INSERT INTO {ImportSchema}.candidate VALUES (true,$1,$2,$3,false)", target, tx))
        {
            insert.Parameters.Add(new NpgsqlParameter<string> { TypedValue = digest });
            insert.Parameters.Add(new NpgsqlParameter<Guid> { TypedValue = plan.TargetSiteId });
            insert.Parameters.Add(new NpgsqlParameter<string> { TypedValue = plan.BackupManifestSha256 });
            await insert.ExecuteNonQueryAsync(token);
        }
        await using (var quarantine = new NpgsqlCommand(
            "UPDATE public.v2_schema SET version=$1 WHERE singleton AND version=$2", target, tx))
        {
            quarantine.Parameters.Add(new NpgsqlParameter<int> { TypedValue = ImportQuarantineVersion });
            quarantine.Parameters.Add(new NpgsqlParameter<int> { TypedValue = plan.SchemaVersion });
            if (await quarantine.ExecuteNonQueryAsync(token) != 1)
                throw new InvalidOperationException("The candidate's current schema marker changed.");
        }
        await tx.CommitAsync(token);
    }

    private static async Task VerifyCandidateHeaderAsync(NpgsqlConnection target, ImportPlan plan, string digest,
        CancellationToken token, NpgsqlTransaction? transaction = null)
    {
        await using var command = new NpgsqlCommand($"""
            SELECT plan_sha256,site_id,backup_manifest_sha256,serving FROM {ImportSchema}.candidate WHERE singleton
            """, target, transaction);
        await using var row = await command.ExecuteReaderAsync(token);
        if (!await row.ReadAsync(token) || row.GetString(0) != digest || row.GetGuid(1) != plan.TargetSiteId ||
            row.GetString(2) != plan.BackupManifestSha256 || row.GetBoolean(3) || await row.ReadAsync(token))
            throw new InvalidOperationException("The candidate is already quarantined under a different plan.");
    }

    private static async Task ValidateCommittedPhasePrefixAsync(NpgsqlConnection target, CandidateTable[] definitions,
        CancellationToken token)
    {
        await using var command = new NpgsqlCommand($"SELECT phase FROM {ImportSchema}.checkpoint ORDER BY phase", target);
        var last = 0;
        await using (var rows = await command.ExecuteReaderAsync(token))
        {
            while (await rows.ReadAsync(token))
            {
                if (rows.GetInt32(0) != ++last || last > 3)
                    throw new InvalidOperationException("The legacy candidate checkpoints do not form a committed prefix.");
            }
        }
        await AssertCandidateRelationsAsync(target, definitions.Where(table => table.Phase <= last).ToArray(), token);
    }

    private static string StagingCheckpointDigest(IEnumerable<ShadowCount> tables) =>
        Digest(string.Join('\n', tables.Select(row => $"{row.Table}:{row.Rows}:{row.Sha256}")));

    private static async Task StageCandidateTableAsync(NpgsqlConnection target, NpgsqlTransaction tx, DbConnection shadow,
        CandidateTable table, CancellationToken token)
    {
        using var quote = new NpgsqlCommandBuilder();
        var fields = table.Columns.Select(column => quote.QuoteIdentifier(column.Name)).ToArray();
        var types = table.Columns.Select(column => column.Kind == "TEXT" ? "text" : "bigint").ToArray();
        var fieldList = string.Join(", ", fields);
        var declarations = string.Join(", ", table.Columns.Select((column, index) => $"{fields[index]} {types[index]}" +
            (table.NonNull?.Contains(column.Name, StringComparer.Ordinal) == true ? " NOT NULL" : "")));
        var unique = table.Unique is { } keys ? $", UNIQUE ({string.Join(',', keys)})" : "";
        var pkFields = table.Key.Replace(" COLLATE BINARY", "", StringComparison.Ordinal);
        await ExecuteAsync(target, tx,
            $"CREATE TABLE {ImportSchema}.{table.Name} ({declarations}, PRIMARY KEY ({pkFields}){unique})", token);

        await using var command = shadow.CreateCommand();
        command.CommandText = $"SELECT {fieldList} FROM {table.Name} ORDER BY {table.Key}";
        await using var read = await command.ExecuteReaderAsync(token);
        await using var writer = await target.BeginBinaryImportAsync(
            $"COPY {ImportSchema}.{table.Name} ({fieldList}) FROM STDIN (FORMAT BINARY)", token);
        while (await read.ReadAsync(token))
        {
            await writer.StartRowAsync(token);
            for (var i = 0; i < fields.Length; i++)
            {
                if (await read.IsDBNullAsync(i, token)) await writer.WriteNullAsync(token);
                else if (types[i] == "bigint")
                    await writer.WriteAsync(read.GetInt64(i), NpgsqlDbType.Bigint, token);
                else await writer.WriteAsync(read.GetString(i), NpgsqlDbType.Text, token);
            }
        }
        await writer.CompleteAsync(token);
    }

    private static string KeyForPostgres(CandidateTable table)
        => table.Key.Replace(" COLLATE BINARY", " COLLATE \"C\"", StringComparison.Ordinal);

    private static async Task<ShadowCount> MeasureCandidateTableAsync(NpgsqlConnection target, NpgsqlTransaction tx,
        CandidateTable table, CancellationToken token)
    {
        if (table.Unique is not null && !await HasLegacyJournalCatalogAsync(tx, ImportSchema, table.Name, table, token))
            throw new InvalidOperationException($"Candidate table {table.Name} shape differs.");
        if (table == LegacyReadingHistoryShadow && !await HasLegacyReadingHistoryKeyAsync(tx, ImportSchema, table.Name, table.NonNull!, token))
            throw new InvalidOperationException($"Candidate table {table.Name} shape differs.");
        if (LegacySavedViewRelations.Any(relation => relation.Target == table) &&
            !await HasSavedViewKeysAsync(tx, ImportSchema, table.Name, table, [], token))
            throw new InvalidOperationException($"Candidate table {table.Name} shape differs.");
        await using (var catalog = new NpgsqlCommand("""
            SELECT a.attname,t.typname
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_attribute a ON a.attrelid=c.oid JOIN pg_type t ON t.oid=a.atttypid
            WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind='r' AND c.relpersistence='p'
              AND NOT c.relrowsecurity AND NOT c.relhasrules
              AND NOT EXISTS(SELECT FROM pg_trigger g WHERE g.tgrelid=c.oid)
              AND a.attnum>0 AND NOT a.attisdropped AND a.atttypmod=-1
            ORDER BY a.attnum
            """, target, tx))
        {
            catalog.Parameters.Add(new NpgsqlParameter<string> { TypedValue = ImportSchema });
            catalog.Parameters.Add(new NpgsqlParameter<string> { TypedValue = table.Name });
            await using var matches = await catalog.ExecuteReaderAsync(token);
            foreach (var column in table.Columns)
            {
                if (!await matches.ReadAsync(token) || matches.GetString(0) != column.Name ||
                    matches.GetString(1) != (column.Kind == "TEXT" ? "text" : "int8"))
                    throw new InvalidOperationException($"Candidate table {table.Name} shape differs.");
            }
            if (await matches.ReadAsync(token)) throw new InvalidOperationException($"Candidate table {table.Name} has extra fields.");
        }

        await using var command = new NpgsqlCommand(
            $"SELECT * FROM {ImportSchema}.{table.Name} ORDER BY {KeyForPostgres(table)} LIMIT {RehearsalLimit * 128 + 1}",
            target, tx);
        await using var read = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token);
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendLegacyValue(digest, table.Name);
        for (var i = 0; i < read.FieldCount; i++) AppendLegacyValue(digest, read.GetName(i));
        long count = 0;
        while (await read.ReadAsync(token))
        {
            if (++count > RehearsalLimit * 128)
                throw new InvalidOperationException("The legacy candidate exceeds its readback row limit.");
            for (var i = 0; i < read.FieldCount; i++)
                AppendLegacyValue(digest, await read.IsDBNullAsync(i, token) ? null : read.GetValue(i));
        }
        return new ShadowCount(table.Name, count, Convert.ToHexStringLower(digest.GetHashAndReset()));
    }

    private static async Task AssertCandidateRelationsAsync(NpgsqlConnection target, CandidateTable[] definitions,
        CancellationToken token, NpgsqlTransaction? transaction = null, bool projected = false, bool retainedSchedules = false)
    {
        var expected = definitions.Select(table => table.Name).Append("candidate").Append("checkpoint").ToHashSet(StringComparer.Ordinal);
        if (projected) expected.Add("current_projection");
        if (retainedSchedules) expected.Add(LegacyInitialScheduleTable);
        await using var command = new NpgsqlCommand("""
            SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I')
            """, target, transaction);
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = ImportSchema });
        await using var rows = await command.ExecuteReaderAsync(token);
        while (await rows.ReadAsync(token))
            if (!expected.Remove(rows.GetString(0))) throw new InvalidOperationException("Unexpected legacy candidate schema content.");
        if (expected.Count > 0) throw new InvalidOperationException("Missing legacy candidate schema content.");
    }
}
