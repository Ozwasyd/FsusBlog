using System.Data;
using System.Data.Common;
using System.Security.Cryptography;
using Npgsql;
using NpgsqlTypes;

internal static partial class Migration
{
    private sealed record CandidateColumn(string Name, string Kind);
    private sealed record CandidateTable(string Name, int Phase, string Key, CandidateColumn[] Columns);
    private sealed record StageResult(int Phase, string Sha256, string Result);

    private static readonly (string Name, int Phase, string Key)[] StagingOrder =
    [
        ("shadow_article", 1, "id"), ("shadow_revision", 1, "source_revision_id"),
        ("shadow_publication", 1, "source_publication_id"),
        ("shadow_article_revision_content_block", 1, "id"),
        ("shadow_category", 2, "id"), ("shadow_tag", 2, "id"),
        ("shadow_tag_url_alias", 2, "normalized_name COLLATE BINARY"),
        ("shadow_article_tag", 2, "articleid, tagid"), ("shadow_revision_tag", 2, "source_revision_id, tag_id"),
        ("shadow_article_rights_policy", 3, "id"), ("shadow_article_rights_snapshot", 3, "id"),
        ("shadow_article_responsibility_snapshot", 3, "id")
    ];

    private static async Task<StageResult[]> StageLegacyCandidateAsync(NpgsqlConnection target, LegacyShadow shadow,
        ImportPlan plan, string digest, bool quarantined, CancellationToken token)
    {
        var definitions = await ReadCandidateShapeAsync(shadow.Database, token);
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
            var expectedCheckpoint = Digest(string.Join('\n', expectedTables.Select(row => $"{row.Table}:{row.Rows}:{row.Sha256}")));

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
        CancellationToken token)
    {
        await using var command = new NpgsqlCommand($"""
            SELECT plan_sha256,site_id,backup_manifest_sha256,serving FROM {ImportSchema}.candidate WHERE singleton
            """, target);
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

    private static async Task<CandidateTable[]> ReadCandidateShapeAsync(DbConnection shadow, CancellationToken token)
    {
        var result = new List<CandidateTable>();
        foreach (var (name, phase, key) in StagingOrder)
        {
            await using var command = shadow.CreateCommand();
            command.CommandText = $"SELECT name,type FROM pragma_table_info('{name}') ORDER BY cid";
            await using var read = await command.ExecuteReaderAsync(token);
            var columns = new List<CandidateColumn>();
            while (await read.ReadAsync(token))
            {
                var kind = read.GetString(1).ToUpperInvariant();
                if (kind is not ("TEXT" or "INTEGER")) throw new InvalidOperationException("Unsupported shadow target field.");
                columns.Add(new CandidateColumn(read.GetString(0), kind));
            }
            if (columns.Count == 0) throw new InvalidOperationException($"Missing typed shadow table {name}.");
            result.Add(new CandidateTable(name, phase, key, columns.ToArray()));
        }
        return result.ToArray();
    }

    private static async Task StageCandidateTableAsync(NpgsqlConnection target, NpgsqlTransaction tx, DbConnection shadow,
        CandidateTable table, CancellationToken token)
    {
        using var quote = new NpgsqlCommandBuilder();
        var fields = table.Columns.Select(column => quote.QuoteIdentifier(column.Name)).ToArray();
        var types = table.Columns.Select(column => column.Kind == "TEXT" ? "text" : "bigint").ToArray();
        var fieldList = string.Join(", ", fields);
        var declarations = string.Join(", ", fields.Zip(types, (field, type) => $"{field} {type}"));
        var pkFields = table.Key.Replace(" COLLATE BINARY", "", StringComparison.Ordinal);
        await ExecuteAsync(target, tx, $"CREATE TABLE {ImportSchema}.{table.Name} ({declarations}, PRIMARY KEY ({pkFields}))", token);

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
        CancellationToken token)
    {
        var expected = definitions.Select(table => table.Name).Append("candidate").Append("checkpoint").ToHashSet(StringComparer.Ordinal);
        await using var command = new NpgsqlCommand("""
            SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=$1 AND c.relkind NOT IN ('i','I')
            """, target);
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = ImportSchema });
        await using var rows = await command.ExecuteReaderAsync(token);
        while (await rows.ReadAsync(token))
            if (!expected.Remove(rows.GetString(0))) throw new InvalidOperationException("Unexpected legacy candidate schema content.");
        if (expected.Count > 0) throw new InvalidOperationException("Missing legacy candidate schema content.");
    }
}
