using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using FsusBlogV2.Storage;
using Microsoft.Data.Sqlite;
using MySqlConnector;
using Npgsql;

internal static partial class Migration
{
    private static async Task<string> ReadLegacySourceDatabaseFingerprintAsync(LegacySource source, DbTransaction transaction,
        string targetCluster, CancellationToken token, bool bindSqliteBytes = true)
    {
        switch (source.Connection)
        {
            case NpgsqlConnection postgres:
                var pgRead = (NpgsqlTransaction)transaction;
                var cluster = await ReadLegacyPostgresClusterAsync(postgres, pgRead, token);
                if (cluster == targetCluster)
                    throw new InvalidOperationException("The PostgreSQL source and rehearsal candidate must use separate clusters.");
                return await FingerprintLegacyPostgresDatabaseAsync(postgres, pgRead, cluster, token);
            case SqliteConnection sqlite:
                var path = sqlite.DataSource;
                if (path != Path.GetFullPath(path))
                    throw new InvalidOperationException("Use the canonical path of a detached frozen SQLite source.");
                using (var directory = OpenImportBackupDirectory(Path.GetDirectoryName(path)!))
                using (var handle = new Microsoft.Win32.SafeHandles.SafeFileHandle(
                           (nint)OpenImportChild(directory, Path.GetFileName(path), ImportFileFlags), ownsHandle: true))
                {
                    if (handle.IsInvalid)
                        throw new InvalidOperationException("The frozen SQLite source file is unavailable or linked.");
                    // Administrator staging binds selected metadata and external site identity without reading credential pages.
                    if (!bindSqliteBytes) return DigestMediaDocument(new { provider = "sqlite", database = path });
                    await using var file = new FileStream(handle, FileAccess.Read);
                    long size = file.Length;
                    if (size is < 512 or > ImportBackupBytes)
                        throw new InvalidOperationException("The frozen SQLite source file is outside the rehearsal byte bound.");
                    var digest = await DigestLegacyMediaStreamAsync(file, size, token);
                    return digest ?? throw new InvalidOperationException("The frozen SQLite source file changed during the rehearsal.");
                }
            case MySqlConnection:
                await using (var server = CreateLegacyCommand(transaction, "SELECT @@server_uuid, DATABASE()"))
                await using (var row = await server.ExecuteReaderAsync(token))
                {
                    if (!await row.ReadAsync(token) || !Guid.TryParseExact(row.GetString(0), "D", out var uuid) || uuid == Guid.Empty ||
                        row.GetString(1) != source.Schema)
                        throw new InvalidOperationException("The MySQL source server identity is unavailable.");
                    return DigestMediaDocument(new { provider = "mysql", server = uuid, database = source.Schema });
                }
            default:
                throw new InvalidOperationException("Unknown rehearsal database provider.");
        }
    }

    private static async Task<string> ReadLegacyPostgresClusterAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken token)
    {
        await using var command = new NpgsqlCommand(
            "SELECT system_identifier::text FROM pg_catalog.pg_control_system()", connection, transaction);
        var value = await command.ExecuteScalarAsync(token) as string;
        if (!ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var cluster) || cluster == 0)
            throw new InvalidOperationException("The PostgreSQL cluster identity is unavailable.");
        return cluster.ToString(CultureInfo.InvariantCulture);
    }

    private static async Task<string> FingerprintLegacyPostgresDatabaseAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string cluster, CancellationToken token)
    {
        var identity = await ReadTargetAsync(connection, transaction, token);
        return DigestMediaDocument(new { provider = "postgres", cluster, identity.Database, identity.DatabaseOid });
    }

    private static async Task<string> CheckMediaCandidateAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        Guid targetSite, string cluster, CancellationToken token)
    {
        await using (var command = new NpgsqlCommand("""
            SELECT current_setting('session_replication_role') = 'origin'
               AND NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'fsus_legacy_candidate')
               AND (SELECT count(*) FROM public.v2_schema WHERE singleton AND version = $1) = 1
            """, connection, transaction))
        {
            command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = CurrentSchema.Version });
            if (await command.ExecuteScalarAsync(token) is not true)
                throw new InvalidOperationException("Use an unmodified, fresh isolated v2 rehearsal candidate before article staging.");
        }
        await CurrentSchema.VerifyCatalogAsync(connection, transaction, token, requireArticleMedia: true, requireSubscription: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, transaction, token);
        if (await CurrentSchema.ReadRecoverySiteIdAsync(connection, transaction, token) != targetSite)
            throw new InvalidOperationException("The actual v2 candidate site does not match the reviewed target site.");
        await RejectUnmeasuredDatabaseStateAsync(connection, transaction, token);

        foreach (var relation in await RelationsAsync(connection, transaction, token))
        {
            if (relation.Schema != "public" || relation.Kind is not ("r" or "S"))
                throw new InvalidOperationException("The isolated media rehearsal candidate contains an unreviewed relation.");
            if (relation.Kind == "S" || relation.Name == "blog_user" ||
                await IsPristineLegacyCandidateSeedAsync(connection, transaction, relation.Name, token)) continue;
            var table = '"' + relation.Name.Replace("\"", "\"\"", StringComparison.Ordinal) + '"';
            await using var occupied = new NpgsqlCommand($"SELECT EXISTS (SELECT FROM public.{table})", connection, transaction);
            if (await occupied.ExecuteScalarAsync(token) is not false)
                throw new InvalidOperationException("The isolated media rehearsal candidate contains operational rows.");
        }
        return await FingerprintLegacyPostgresDatabaseAsync(connection, transaction, cluster, token);
    }

    private static async Task CheckMediaDestinationOwnersAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        LegacyMediaOwner[] approvedOwners, CancellationToken token)
    {
        var required = approvedOwners.Select(owner => owner.TargetUserId!.Value).ToHashSet();
        await using var command = new NpgsqlCommand("SELECT id, enabled, can_author FROM public.blog_user", connection, transaction);
        await using var rows = await command.ExecuteReaderAsync(token);
        while (await rows.ReadAsync(token))
            if (!required.Remove(rows.GetGuid(0)) || !rows.GetBoolean(1) || !rows.GetBoolean(2))
                throw new InvalidOperationException("Candidate authors must be independently provisioned and match the reviewed media owners exactly.");
        if (required.Count != 0)
            throw new InvalidOperationException("Candidate authors must be independently provisioned and match the reviewed media owners exactly.");
    }
}
