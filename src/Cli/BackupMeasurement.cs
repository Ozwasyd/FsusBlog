using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Cli
{
    private const int BackupMeasurementVersion = 1;
    private const int BackupRelationLimit = 200;
    private const int BackupRowsPerRelation = 1_000_000;
    private const int BackupMediaLimit = 5_000;
    private const int BackupRowBytes = 4_000_000;

    private static async Task<int> MeasureBackupAsync(bool holdSnapshot, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMinutes(5));
        var dsn = Environment.GetEnvironmentVariable(DatabaseVariable);
        if (string.IsNullOrWhiteSpace(dsn))
            throw new ArgumentException($"Set {DatabaseVariable} to an offline backup database.");
        var settings = new NpgsqlConnectionStringBuilder(dsn)
        {
            Pooling = false,
            Enlist = false,
            CommandTimeout = 30
        };
        if (string.IsNullOrWhiteSpace(settings.Database))
            throw new ArgumentException($"Set the explicit database name in {DatabaseVariable}.");

        await using var connection = new NpgsqlConnection(settings.ConnectionString);
        await connection.OpenAsync(deadline.Token);
        await RequireBackupDatabaseLockAsync(connection, deadline.Token);
        await CurrentSchema.VerifyAsync(connection, deadline.Token);
        await VerifyPublicationsAsync(connection, deadline.Token);
        await using var transaction = await BeginReadOnlyAsync(connection, deadline.Token);
        await SetBackupRepresentationAsync(connection, transaction, deadline.Token);
        var (measured, media) = await ReadBackupSiteAsync(connection, transaction, deadline.Token);
        string? exportedSnapshot = null;
        if (holdSnapshot)
        {
            await using var export = new NpgsqlCommand("SELECT pg_catalog.pg_export_snapshot()", connection, transaction);
            exportedSnapshot = await export.ExecuteScalarAsync(deadline.Token) as string ??
                throw new InvalidOperationException("PostgreSQL did not export a backup snapshot.");
        }
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            version = BackupMeasurementVersion,
            schemaVersion = CurrentSchema.Version,
            postgreSqlMajor = connection.PostgreSqlVersion.Major.ToString(CultureInfo.InvariantCulture),
            relations = measured,
            media,
            database = settings.Database,
            host = connection.Host,
            port = connection.Port,
            exportedSnapshot
        }, new JsonSerializerOptions(Json) { WriteIndented = false }));
        await Console.Out.FlushAsync(deadline.Token);
        if (holdSnapshot && await Console.In.ReadLineAsync(deadline.Token) != "finish")
            throw new InvalidOperationException("The backup snapshot holder was not finished by its capture operation.");
        await transaction.RollbackAsync(deadline.Token);
        return 0;
    }

    private static Task SetBackupRepresentationAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken token)
        => ExecuteAsync(connection, transaction, """
            SET LOCAL TimeZone = 'UTC';
            SET LOCAL datestyle = 'ISO, YMD';
            SET LOCAL intervalstyle = 'iso_8601';
            SET LOCAL bytea_output = 'hex';
            SET LOCAL extra_float_digits = 3
            """, token);

    private static async Task<(List<BackupRelation> Relations, List<BackupMedia> Media)> ReadBackupSiteAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken token)
    {
        var relations = await RelationsAsync(connection, transaction, token);
        if (relations.Count > BackupRelationLimit || relations.Any(row => row.Kind is not ("r" or "S") || row.Schema != "public"))
            throw new InvalidOperationException("Backup measurement needs only supported public tables and sequences.");
        await RejectUnmeasuredDatabaseStateAsync(connection, transaction, token);
        if (relations.Any(relation => relation.Name == "private_media_upload_part"))
        {
            await using var unfinished = new NpgsqlCommand(
                "SELECT EXISTS (SELECT FROM public.private_media_upload_part)", connection, transaction);
            if (await unfinished.ExecuteScalarAsync(token) is true)
                throw new InvalidOperationException("Finish or cancel staged media parts before backup.");
        }

        var measured = new List<BackupRelation>(relations.Count);
        foreach (var relation in relations)
        {
            measured.Add(await MeasureBackupRelationAsync(connection, transaction, relation, token));
        }
        return (measured, await BackupMediaAsync(connection, transaction, token));
    }

    private static async Task RequireBackupDatabaseLockAsync(NpgsqlConnection connection, CancellationToken token)
    {
        await using var primary = new NpgsqlCommand("SELECT pg_catalog.pg_try_advisory_lock($1)", connection);
        primary.Parameters.Add(new NpgsqlParameter<long> { TypedValue = PublicationLocks.Ownership });
        if (await primary.ExecuteScalarAsync(token) is not true)
            throw new InvalidOperationException("Stop the v2 writer before measuring a backup.");

        await using var handoff = new NpgsqlCommand("SELECT pg_catalog.pg_try_advisory_lock($1, $2)", connection);
        handoff.Parameters.Add(new NpgsqlParameter<int> { TypedValue = PublicationLocks.HandoffClass });
        handoff.Parameters.Add(new NpgsqlParameter<int> { TypedValue = PublicationLocks.HandoffObject });
        if (await handoff.ExecuteScalarAsync(token) is not true)
            throw new InvalidOperationException("The v2 backup database has admitted writes that have not drained.");
    }

    private static async Task RejectUnmeasuredDatabaseStateAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken token)
    {
        const string sql = """
            SELECT EXISTS (SELECT FROM pg_largeobject_metadata)
                OR EXISTS (SELECT FROM pg_extension WHERE extname <> 'plpgsql')
            """;
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        if (await command.ExecuteScalarAsync(token) is true)
            throw new InvalidOperationException("Database extensions or large objects need separate backup evidence.");
    }

    private static async Task<BackupRelation> MeasureBackupRelationAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, Relation relation, CancellationToken token)
    {
        using var names = new NpgsqlCommandBuilder();
        var qualified = names.QuoteIdentifier(relation.Schema) + "." + names.QuoteIdentifier(relation.Name);
        await using var keys = ForRelation(connection, transaction, relation, """
            SELECT a.attname
            FROM pg_constraint pk JOIN pg_class c ON c.oid=pk.conrelid
            JOIN pg_namespace ns ON ns.oid=c.relnamespace
            CROSS JOIN LATERAL unnest(pk.conkey) WITH ORDINALITY AS key(attnum, position)
            JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=key.attnum
            WHERE pk.contype='p' AND ns.nspname=$1 AND c.relname=$2
            ORDER BY key.position
            """);
        var order = new List<string>();
        await using (var cursor = await keys.ExecuteReaderAsync(token))
        {
            while (await cursor.ReadAsync(token)) order.Add("t." + names.QuoteIdentifier(cursor.GetString(0)));
        }
        if (relation.Kind == "r" && order.Count == 0)
            throw new InvalidOperationException($"Backup relation {relation.Name} lacks a deterministic primary key.");

        var content = "pg_catalog.row_to_json(t)::text";
        var render = $"CASE WHEN pg_catalog.octet_length({content}) <= {BackupRowBytes} THEN {content} END";
        var sql = relation.Kind == "S"
            ? $"SELECT {render} FROM (SELECT last_value, is_called FROM {qualified}) t"
            : $"SELECT {render} FROM {qualified} t ORDER BY {string.Join(", ", order)} LIMIT {BackupRowsPerRelation + 1}";
        await using var rows = new NpgsqlCommand(sql, connection, transaction);
        await using var read = await rows.ExecuteReaderAsync(System.Data.CommandBehavior.SequentialAccess, token);
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendBackupString(digest, relation.Name);
        AppendBackupString(digest, relation.Kind);
        long count = 0;
        while (await read.ReadAsync(token))
        {
            if (++count > BackupRowsPerRelation)
                throw new InvalidOperationException($"Backup relation {relation.Name} exceeds the measurement row budget.");
            if (await read.IsDBNullAsync(0, token))
                throw new InvalidOperationException($"Backup relation {relation.Name} contains a row outside the measurement byte budget.");
            AppendBackupString(digest, read.GetString(0));
        }
        return new BackupRelation(relation.Name, relation.Kind, count, Convert.ToHexStringLower(digest.GetHashAndReset()));
    }

    private static void AppendBackupString(IncrementalHash digest, string text)
    {
        var bytes = StrictUtf8.GetBytes(text);
        Span<byte> prefix = stackalloc byte[5];
        prefix[0] = (byte)'s';
        BinaryPrimitives.WriteInt32BigEndian(prefix[1..], bytes.Length);
        digest.AppendData(prefix);
        digest.AppendData(bytes);
    }

    private static async Task<List<BackupMedia>> BackupMediaAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, CancellationToken token)
    {
        await using (var pending = new NpgsqlCommand(
            "SELECT EXISTS (SELECT FROM public.private_media WHERE phase NOT IN (1, 3))", connection, transaction))
        {
            if (await pending.ExecuteScalarAsync(token) is true)
                throw new InvalidOperationException("Settle pending and removing private media before backup.");
        }
        await using var command = new NpgsqlCommand("""
            SELECT id,length,encode(content_hash,'hex')
            FROM public.private_media WHERE phase=1 ORDER BY id
            """, connection, transaction);
        await using var cursor = await command.ExecuteReaderAsync(token);
        var files = new List<BackupMedia>();
        while (await cursor.ReadAsync(token))
        {
            if (files.Count == BackupMediaLimit)
                throw new InvalidOperationException("Backup media metadata exceeds the candidate limit.");
            files.Add(new BackupMedia(cursor.GetGuid(0).ToString("N", CultureInfo.InvariantCulture),
                cursor.GetInt32(1), cursor.GetString(2)));
        }
        return files;
    }

    private sealed record BackupRelation(string Name, string Kind, long Rows, string Sha256);
    private sealed record BackupMedia(string Id, int Bytes, string Sha256);
}
