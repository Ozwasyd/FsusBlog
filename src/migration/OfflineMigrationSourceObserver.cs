using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Migration;

using Npgsql;

namespace FsusBlog.Migration;

/// <summary>
/// Observes native catalogs and legacy business preconditions without changing database data.
/// It never builds old inputs from current entities, a JSON receipt, or a caller's assertions.
/// </summary>
public sealed partial class OfflineMigrationSourceObserver : IOfflineMigrationSnapshotSourceObserver
{
    internal const int MaximumMetadataRows = 4096;
    internal const int MaximumMetadataCharacters = 4 * 1024 * 1024;
    internal const int MaximumCellCharacters = 4096;

    /// <summary>Own a native connection and a consistent, read-only observation transaction.</summary>
    public async Task<OfflineMigrationSourceObservation> ObserveAsync(
        CurrentSchemaProviderKind provider, string connectionString, CancellationToken cancellationToken)
    {
        RequireContentCapability(provider);
        return provider switch
        {
            CurrentSchemaProviderKind.PostgreSql => await OfflineMigrationPostgreSqlNativeSession.ObserveAsync(connectionString,
                (connection, transaction, token) => ObserveAsync(provider, connection, transaction, token), cancellationToken).ConfigureAwait(false),
            CurrentSchemaProviderKind.MySql => await OfflineMigrationMySqlNativeSession.ObserveAsync(connectionString,
                (connection, transaction, token) => ObserveAsync(provider, connection, transaction, token), cancellationToken).ConfigureAwait(false),
            CurrentSchemaProviderKind.Sqlite => await OfflineMigrationSqliteNativeSession.ObserveAsync(connectionString,
                (connection, transaction, token) => ObserveAsync(provider, connection, transaction, token), cancellationToken).ConfigureAwait(false),
            _ => throw new InvalidOperationException("offline_source_provider_unknown")
        };
    }

    /// <summary>
    /// Re-observe the caller-owned native apply session without opening another connection.
    /// This does not confer write admission, alter isolation, or mutate the caller's session.
    /// Other providers remain refused until their complete native content capability exists.
    /// </summary>
    public async Task<OfflineMigrationSourceObservation> ObserveAsync(
        CurrentSchemaProviderKind provider, DbConnection connection, DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        RequireContentCapability(provider);
        if (provider == CurrentSchemaProviderKind.MySql)
        {
            return await ReadMySqlObservationAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        }
        if (provider == CurrentSchemaProviderKind.Sqlite)
        {
            return await ReadSqliteObservationAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        }
        if (connection is not NpgsqlConnection || transaction is not NpgsqlTransaction)
        {
            throw new InvalidOperationException("offline_source_native_streaming_driver_required");
        }
        if (!Enum.IsDefined(provider) || connection.State != ConnectionState.Open
            || transaction.Connection != connection
            || transaction.IsolationLevel is not (IsolationLevel.RepeatableRead or IsolationLevel.Serializable))
        {
            throw new InvalidOperationException("offline_source_consistent_native_session_required");
        }
        var budget = new ObservationBudget();
        CurrentSchemaDatabaseIdentity database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        ImmutableArray<OfflineMigrationFact> schema = await ReadSchemaAsync(
            provider, connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        bool legacy = OfflineMigrationSourceFingerprints.RequireKnownSchema(provider, schema);
        // A control/history table is part of the complete schema inventory. Neither accepted
        // source has one: unknown or partially migrated databases were refused above, before
        // reading arbitrary historical payloads or assuming failed history was empty.
        ImmutableArray<OfflineMigrationFact> business = legacy
            ? await ReadBusinessAsync(provider, connection, transaction, budget, cancellationToken).ConfigureAwait(false)
            : OfflineMigrationSourceFingerprints.Business(false, 0, 0, 0, 0);
        string contentDigest = await ReadContentDigestAsync(connection, transaction, legacy, cancellationToken).ConfigureAwait(false);
        var observation = new OfflineMigrationSourceObservation(database,
            OfflineMigrationSourceFingerprints.ExtractorId, OfflineMigrationSourceFingerprints.ExtractorVersion,
            schema, [new("history.state", "absent")], business, contentDigest);
        _ = OfflineMigrationSourceFingerprints.CreateRegistry().Match(observation);
        return observation;
    }

    /// <summary>
    /// Keep one actual PostgreSQL source snapshot alive until the backup owner's admitted
    /// dump child has terminated and its pre-bound file has been independently hashed.
    /// The callback is transport/lifecycle coordination, not backup authentication.
    /// </summary>
    public async Task<(OfflineMigrationSourceObservation Source, string SnapshotId, DateTimeOffset CapturedAt, string DumpSha256)> CapturePostgreSqlSnapshotAsync(
        string connectionString,
        Func<OfflineMigrationSourceObservation, string, DateTimeOffset, CancellationToken, Task<string>> awaitCompletedDumpPath,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(awaitCompletedDumpPath);
        return await OfflineMigrationPostgreSqlNativeSession.CaptureAsync(connectionString,
            (connection, transaction, token) => ObserveAsync(CurrentSchemaProviderKind.PostgreSql, connection, transaction, token),
            awaitCompletedDumpPath, cancellationToken).ConfigureAwait(false);
    }

    // Apply-phase measurement only. The public planning observer above still
    // inventories and refuses the control table as an unknown historical object.
    internal async Task<OfflineMigrationSourceObservation> ObserveLegacyAfterValidatedJournalAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        RequirePostgreSqlStageSession(connection, transaction);
        await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        var budget = new ObservationBudget();
        CurrentSchemaDatabaseIdentity database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        ImmutableArray<OfflineMigrationFact> schema = await ReadSchemaAsync(CurrentSchemaProviderKind.PostgreSql,
            connection, transaction, budget, cancellationToken, validatedJournal: true).ConfigureAwait(false);
        if (!OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.PostgreSql, schema))
            throw new InvalidOperationException("legacy_target_prepare_known_legacy_required");
        ImmutableArray<OfflineMigrationFact> business = await ReadBusinessAsync(CurrentSchemaProviderKind.PostgreSql,
            connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        string content = await ReadContentDigestAsync(connection, transaction, true, cancellationToken).ConfigureAwait(false);
        var observation = new OfflineMigrationSourceObservation(database, OfflineMigrationSourceFingerprints.ExtractorId,
            OfflineMigrationSourceFingerprints.ExtractorVersion, schema, [new("history.state", "absent")], business, content);
        _ = OfflineMigrationSourceFingerprints.CreateRegistry().Match(observation);
        return observation;
    }

    internal static Task<string> ReadStagedLegacyContentAsync(PgLegacyCurrentSchemaPreparation staged,
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => ReadContentDigestAsync(connection, transaction, true, cancellationToken,
            staged.RequireOriginalSession(connection, transaction));

    internal static void RequirePostgreSqlStageSession(DbConnection connection, DbTransaction transaction)
    {
        if (connection is not NpgsqlConnection || transaction is not NpgsqlTransaction
            || connection.State != ConnectionState.Open || !ReferenceEquals(transaction.Connection, connection)
            || transaction.IsolationLevel != IsolationLevel.RepeatableRead)
            throw new InvalidOperationException("legacy_target_prepare_original_transaction_required");
    }

    // Measurement preparation only, not a public admission entrypoint. The original
    // apply owner must first mint and retain its actual writer read scope. No current
    // public or apply entrypoint calls this method while that capability is absent.
    private async Task<OfflineMigrationSourceObservation> ReadControlledEmptyCandidateAsync(
        CurrentSchemaProviderKind provider, DbConnection connection, DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (provider == CurrentSchemaProviderKind.MySql)
            return await ReadMySqlControlledEmptyCandidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (provider == CurrentSchemaProviderKind.Sqlite)
            return await ReadSqliteControlledEmptyCandidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (provider != CurrentSchemaProviderKind.PostgreSql)
            throw new InvalidOperationException("offline_source_provider_unknown");

        RequirePostgreSqlStageSession(connection, transaction);
        var budget = new ObservationBudget();
        CurrentSchemaDatabaseIdentity database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        ImmutableArray<OfflineMigrationFact> complete = await ReadSchemaAsync(
            provider, connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        RequireEmptyJournalRowCount(await ScalarAsync(connection, transaction,
            "SELECT COUNT(*) FROM public.\"" + OfflineMigrationStateStore.ApplyJournalTableName + "\"",
            budget, cancellationToken).ConfigureAwait(false));
        ImmutableArray<OfflineMigrationFact> domain = await ReadSchemaAsync(
            provider, connection, transaction, budget, cancellationToken, validatedJournal: true).ConfigureAwait(false);
        if (OfflineMigrationSourceFingerprints.RequireKnownSchema(provider, domain))
            throw new InvalidOperationException("offline_source_controlled_empty_business_domain_required");
        string content = await ReadContentDigestAsync(connection, transaction, false, cancellationToken).ConfigureAwait(false);
        if (!OfflineMigrationPlanValidation.Equal(complete, await ReadSchemaAsync(
            provider, connection, transaction, budget, cancellationToken).ConfigureAwait(false)))
            throw new InvalidOperationException("offline_source_controlled_empty_catalog_changed");
        await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        RequireEmptyJournalRowCount(await ScalarAsync(connection, transaction,
            "SELECT COUNT(*) FROM public.\"" + OfflineMigrationStateStore.ApplyJournalTableName + "\"",
            budget, cancellationToken).ConfigureAwait(false));
        cancellationToken.ThrowIfCancellationRequested();
        var observation = new OfflineMigrationSourceObservation(database, OfflineMigrationSourceFingerprints.ExtractorId,
            OfflineMigrationSourceFingerprints.ExtractorVersion, domain, [new("history.state", "absent")],
            OfflineMigrationSourceFingerprints.Business(false, 0, 0, 0, 0), content);
        _ = OfflineMigrationSourceFingerprints.CreateRegistry().Match(observation);
        return observation;
    }

    // The global count is measured on the original transaction, never a filtered
    // plan/run lookup. Pure controls of this predicate are not native admission.
    internal static void RequireEmptyJournalRowCount(long actualRows)
    {
        if (actualRows != 0)
            throw new InvalidOperationException("offline_source_controlled_empty_journal_history_present");
    }

    // This is a projection of the already measured unsupported-object query,
    // not a second journal schema. Its owner validates the complete journal
    // columns/constraints first. Exclude only those constraint-backed indexes;
    // extra indexes, triggers, policies and physical options remain observations.
    internal static string ValidatedJournalUnsupportedSql()
    {
        string journal = "'public." + OfflineMigrationStateStore.ApplyJournalTableName + "'";
        string constraint = "AND p.contype<>'p')";
        string index = "WHERE n.nspname='public' AND NOT i.indisprimary)";
        string supportedIndex = "i.indisvalid AND i.indisready AND i.indislive AND i.indisunique AND i.indimmediate"
            + " AND i.indnatts=i.indnkeyatts AND i.indpred IS NULL AND i.indexprs IS NULL"
            + " AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indoption) option WHERE option<>0)"
            + " AND EXISTS (SELECT 1 FROM pg_catalog.pg_class idx JOIN pg_catalog.pg_am am ON am.oid=idx.relam"
            + " WHERE idx.oid=i.indexrelid AND am.amname='btree' AND idx.reloptions IS NULL)"
            + " AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indclass) classid"
            + " JOIN pg_catalog.pg_opclass op ON op.oid=classid WHERE NOT op.opcdefault)"
            + " AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indcollation) WITH ORDINALITY coll(collation,position)"
            + " JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=i.indkey[(coll.position-1)::int]"
            + " WHERE coll.collation<>a.attcollation)";
        return PostgreSqlUnsupported.Replace(constraint, "AND p.contype<>'p' AND p.conrelid<>pg_catalog.to_regclass(" + journal + "))",
                StringComparison.Ordinal)
            .Replace(index, "WHERE n.nspname='public' AND NOT i.indisprimary AND NOT (c.oid=pg_catalog.to_regclass("
                + journal + ") AND " + supportedIndex + " AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint owned"
                + " WHERE owned.conrelid=c.oid AND owned.conindid=i.indexrelid AND owned.contype='u')))", StringComparison.Ordinal);
    }

    private static void RequireContentCapability(CurrentSchemaProviderKind provider)
    {
        if (!Enum.IsDefined(provider))
        {
            throw new InvalidOperationException("offline_source_provider_unknown");
        }
    }

    private static async Task<string> ReadContentDigestAsync(DbConnection connection, DbTransaction transaction,
        bool legacy, CancellationToken cancellationToken, string quotedSchema = "\"public\"")
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.ASCII.GetBytes("fsusblog.migration-source-content.v1\0"));
        if (legacy)
        {
            foreach (OfflineMigrationSourceFingerprints.LegacyTable table in OfflineMigrationSourceFingerprints.LegacyTables
                         .OrderBy(value => value.Name, StringComparer.Ordinal))
            {
                hash.AppendData([1]);
                using var tableName = new StringReader(table.Name);
                await AppendTextAsync(hash, tableName, cancellationToken).ConfigureAwait(false);
                foreach (OfflineMigrationSourceFingerprints.LegacyColumn column in table.Columns)
                {
                    hash.AppendData([2]);
                    using var columnName = new StringReader(column.Name);
                    using var columnType = new StringReader(column.Type);
                    await AppendTextAsync(hash, columnName, cancellationToken).ConfigureAwait(false);
                    await AppendTextAsync(hash, columnType, cancellationToken).ConfigureAwait(false);
                }
                await using DbCommand command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandTimeout = 30;
                string columns = string.Join(",", table.Columns.Select(column => column.Type == "timestamp"
                    ? $"pg_catalog.timestamp_send(\"{column.Name}\")" : $"\"{column.Name}\""));
                string order = string.Join(",", table.PrimaryKey.Select(key =>
                    table.Columns.Single(column => column.Name == key).Type.StartsWith("varchar", StringComparison.Ordinal)
                        ? $"\"{key}\" COLLATE \"C\" ASC" : $"\"{key}\" ASC"));
                command.CommandText = $"SELECT {columns} FROM {quotedSchema}.\"{table.Name}\" ORDER BY {order}";
                await using DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false);
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    hash.AppendData([3]);
                    for (int index = 0; index < table.Columns.Length; index++)
                    {
                        if (await reader.IsDBNullAsync(index, cancellationToken).ConfigureAwait(false))
                        {
                            hash.AppendData([0]);
                            continue;
                        }
                        hash.AppendData([1]);
                        string type = table.Columns[index].Type;
                        if (type == "text" || type.StartsWith("varchar", StringComparison.Ordinal))
                        {
                            using TextReader text = await ((NpgsqlDataReader)reader).GetTextReaderAsync(index, cancellationToken).ConfigureAwait(false);
                            await AppendTextAsync(hash, text, cancellationToken).ConfigureAwait(false);
                        }
                        else
                        {
                            long scalar = type switch
                            {
                                "int" => reader.GetInt32(index),
                                "bigint" => reader.GetInt64(index),
                                "bool" => reader.GetBoolean(index) ? 1 : 0,
                                // Preserve PostgreSQL's microsecond representation, including both
                                // infinity sentinels, instead of mapping them to finite DateTime values.
                                "timestamp" => ReadTimestamp(reader.GetFieldValue<byte[]>(index)),
                                _ => throw new InvalidOperationException("offline_source_content_type_unsupported")
                            };
                            AppendInteger(hash, scalar);
                        }
                    }
                }
                hash.AppendData([4]);
            }
            // Sequence values are not PostgreSQL MVCC rows. They are committed input state too;
            // capture re-observes them after the dump and refuses changed source evidence.
            foreach (OfflineMigrationSourceFingerprints.LegacyTable table in OfflineMigrationSourceFingerprints.LegacyTables
                         .OrderBy(value => value.Name, StringComparer.Ordinal))
            {
                foreach (OfflineMigrationSourceFingerprints.LegacyColumn column in table.Columns.Where(value => value.Identity))
                {
                    string sequence = $"{table.Name}_{column.Name}_seq";
                    hash.AppendData([5]);
                    using var name = new StringReader(sequence);
                    await AppendTextAsync(hash, name, cancellationToken).ConfigureAwait(false);
                    await using DbCommand command = connection.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandText = $"SELECT last_value,is_called FROM {quotedSchema}.\"{sequence}\"";
                    command.CommandTimeout = 30;
                    await using DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false);
                    if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        throw new InvalidOperationException("offline_source_sequence_state_missing");
                    }
                    AppendInteger(hash, reader.GetInt64(0));
                    AppendInteger(hash, reader.GetBoolean(1) ? 1 : 0);
                    if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        throw new InvalidOperationException("offline_source_sequence_state_ambiguous");
                    }
                }
            }
        }
        hash.AppendData([255]);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    internal static async Task AppendTextAsync(IncrementalHash hash, TextReader reader, CancellationToken cancellationToken)
    {
        char[] characters = new char[4096];
        byte[] bytes = new byte[8192];
        long total = 0;
        while (true)
        {
            int filled = 0;
            while (filled < characters.Length)
            {
                int read = await reader.ReadAsync(characters.AsMemory(filled), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }
                filled += read;
            }
            if (filled == 0)
            {
                break;
            }
            AppendInteger(hash, filled);
            for (int index = 0; index < filled; index++)
            {
                bytes[index * 2] = (byte)characters[index];
                bytes[index * 2 + 1] = (byte)(characters[index] >> 8);
            }
            hash.AppendData(bytes.AsSpan(0, filled * 2));
            total = checked(total + filled);
        }
        AppendInteger(hash, 0);
        AppendInteger(hash, total);
    }

    private static void AppendInteger(IncrementalHash hash, long value)
    {
        Span<byte> bytes = stackalloc byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(bytes, value);
        hash.AppendData(bytes);
    }

    private static long ReadTimestamp(byte[] value)
    {
        if (value.Length != 8)
        {
            throw new InvalidOperationException("offline_source_timestamp_representation_invalid");
        }
        return System.Buffers.Binary.BinaryPrimitives.ReadInt64BigEndian(value);
    }

    private static async Task<ImmutableArray<OfflineMigrationFact>> ReadSchemaAsync(
        CurrentSchemaProviderKind provider, DbConnection connection, DbTransaction transaction,
        ObservationBudget budget, CancellationToken cancellationToken, bool validatedJournal = false)
    {
        var facts = ImmutableArray.CreateBuilder<OfflineMigrationFact>();
        ImmutableArray<ImmutableArray<string>> tables = await ReadRowsAsync(connection, transaction,
            "SELECT c.relname, c.relkind::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname",
            budget, cancellationToken).ConfigureAwait(false);
        foreach (ImmutableArray<string> row in tables)
        {
            if (validatedJournal && row[0] == OfflineMigrationStateStore.ApplyJournalTableName)
            {
                if (row[1] != "r")
                    throw new InvalidOperationException("legacy_target_prepare_journal_relation_unowned");
                continue;
            }
            facts.Add(new($"table/{row[0]}", row[1] == "r" ? "base" : row[1]));
        }
        ImmutableArray<ImmutableArray<string>> columns = await ReadRowsAsync(connection, transaction,
            PostgreSqlColumns, budget, cancellationToken).ConfigureAwait(false);
        foreach (ImmutableArray<string> row in columns)
        {
            if (validatedJournal && row[0] == OfflineMigrationStateStore.ApplyJournalTableName)
            {
                // The original journal owner confirms names/types/requiredness
                // and constraints, not arbitrary default or generation effects.
                if (row[5].Length != 0 || row[6].Length != 0)
                    throw new InvalidOperationException("legacy_target_prepare_journal_column_unowned_facts");
                continue;
            }
            string type = row[3] == "timestamp without time zone" ? "timestamp" : row[3];
            string identity = row[6] switch
            {
                "d" => "by-default",
                "a" => "always",
                "" => "none",
                _ => row[6]
            };
            facts.Add(OfflineMigrationSourceFingerprints.ColumnFact(row[0], row[1], int.Parse(row[2], CultureInfo.InvariantCulture),
                type, row[4] == "1", Default(row[5]), identity, int.Parse(row[7], CultureInfo.InvariantCulture)));
        }
        string unsupportedSql = validatedJournal ? ValidatedJournalUnsupportedSql() : PostgreSqlUnsupported;
        long unsupported = await ScalarAsync(connection, transaction, unsupportedSql, budget, cancellationToken).ConfigureAwait(false);
        facts.Add(new("objects.unsupported", unsupported.ToString(CultureInfo.InvariantCulture)));
        ImmutableArray<ImmutableArray<string>> sequences = await ReadRowsAsync(connection, transaction,
            PostgreSqlSequences, budget, cancellationToken).ConfigureAwait(false);
        foreach (ImmutableArray<string> row in sequences)
        {
            facts.Add(OfflineMigrationSourceFingerprints.SequenceFact(row[0], row[1], row[2], row[3],
                row[4], row[5], row[6], row[7], row[8], row[9]));
        }
        return OfflineMigrationPlanValidation.NormalizeFacts(facts.ToImmutable());
    }

    private static async Task<ImmutableArray<OfflineMigrationFact>> ReadBusinessAsync(
        CurrentSchemaProviderKind provider, DbConnection connection, DbTransaction transaction,
        ObservationBudget budget, CancellationToken cancellationToken)
    {
        // Only the already matched historical tables are addressed. These reproduce the existing
        // shrink preconditions; page entries migrate to page_content and are not truncated.
        long category = await ScalarAsync(connection, transaction,
            "SELECT COUNT(*) FROM public.category WHERE LENGTH(name)>128", budget, cancellationToken).ConfigureAwait(false);
        long tag = await ScalarAsync(connection, transaction,
            "SELECT COUNT(*) FROM public.tag WHERE LENGTH(name)>128", budget, cancellationToken).ConfigureAwait(false);
        const string NonPage = "\"key\" NOT LIKE 'Page_%' AND \"key\" NOT LIKE 'sys:page:%'";
        long configKey = await ScalarAsync(connection, transaction,
            $"SELECT COUNT(*) FROM public.sys_systemconfig WHERE {NonPage} AND LENGTH(\"key\")>64", budget, cancellationToken).ConfigureAwait(false);
        long configValue = await ScalarAsync(connection, transaction,
            $"SELECT COUNT(*) FROM public.sys_systemconfig WHERE {NonPage} AND LENGTH(value)>512", budget, cancellationToken).ConfigureAwait(false);
        return OfflineMigrationSourceFingerprints.Business(true, category, tag, configKey, configValue);
    }

    private static string Default(string value)
        => value is "" or "NULL" or "NULL::character varying" ? "none" : value;

    private static async Task<long> ScalarAsync(DbConnection connection, DbTransaction transaction, string sql,
        ObservationBudget budget, CancellationToken cancellationToken)
    {
        ImmutableArray<ImmutableArray<string>> rows = await ReadRowsAsync(connection, transaction, sql, budget, cancellationToken).ConfigureAwait(false);
        if (rows.Length != 1 || rows[0].Length != 1 || !long.TryParse(rows[0][0], NumberStyles.None, CultureInfo.InvariantCulture, out long value))
        {
            throw new InvalidOperationException("offline_source_scalar_observation_invalid");
        }
        return value;
    }

    private static async Task<ImmutableArray<ImmutableArray<string>>> ReadRowsAsync(DbConnection connection,
        DbTransaction transaction, string sql, ObservationBudget budget, CancellationToken cancellationToken)
    {
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.CommandTimeout = 30;
        await using DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false);
        var rows = ImmutableArray.CreateBuilder<ImmutableArray<string>>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (++budget._rows > MaximumMetadataRows || reader.FieldCount > 16)
            {
                throw new InvalidOperationException("offline_source_metadata_budget_exceeded");
            }
            var cells = ImmutableArray.CreateBuilder<string>();
            for (int index = 0; index < reader.FieldCount; index++)
            {
                string text;
                if (await reader.IsDBNullAsync(index, cancellationToken).ConfigureAwait(false))
                {
                    text = string.Empty;
                }
                else if (reader.GetFieldType(index) == typeof(string))
                {
                    // GetChars(null) may consume a sequential field. Bound its native stream
                    // directly instead of hydrating an arbitrarily large catalog expression.
                    using TextReader field = await ((NpgsqlDataReader)reader).GetTextReaderAsync(index, cancellationToken).ConfigureAwait(false);
                    char[] buffer = new char[MaximumCellCharacters + 1];
                    int filled = 0;
                    while (filled < buffer.Length)
                    {
                        int read = await field.ReadAsync(buffer.AsMemory(filled), cancellationToken).ConfigureAwait(false);
                        if (read == 0)
                        {
                            break;
                        }
                        filled += read;
                        if (filled > MaximumCellCharacters || filled > MaximumMetadataCharacters - budget._characters)
                        {
                            throw new InvalidOperationException("offline_source_metadata_budget_exceeded");
                        }
                    }
                    text = new string(buffer, 0, filled);
                }
                else
                {
                    text = Convert.ToString(reader.GetValue(index), CultureInfo.InvariantCulture) ?? string.Empty;
                }
                budget._characters += text.Length;
                if (text.Length > MaximumCellCharacters || budget._characters > MaximumMetadataCharacters)
                {
                    throw new InvalidOperationException("offline_source_metadata_budget_exceeded");
                }
                cells.Add(text);
            }
            rows.Add(cells.ToImmutable());
        }
        return rows.ToImmutable();
    }

    private sealed class ObservationBudget
    {
        internal int _rows;
        internal long _characters;
    }

    private const string PostgreSqlColumns = """
        SELECT c.relname, a.attname, a.attnum::text, pg_catalog.format_type(a.atttypid,a.atttypmod),
               CASE WHEN a.attnotnull THEN '0' ELSE '1' END,
               COALESCE(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''), a.attidentity::text,
               COALESCE((SELECT k.position::text FROM pg_catalog.pg_constraint p,
                   pg_catalog.unnest(p.conkey) WITH ORDINALITY k(attnum,position)
                   WHERE p.conrelid=c.oid AND p.contype='p' AND k.attnum=a.attnum),'0')
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname,a.attnum
        """;

    private const string PostgreSqlUnsupported = """
        SELECT (
            (SELECT COUNT(*) FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')) +
            (SELECT COUNT(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_collation o JOIN pg_catalog.pg_namespace n ON n.oid=o.collnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_conversion o JOIN pg_catalog.pg_namespace n ON n.oid=o.connamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_opfamily o JOIN pg_catalog.pg_namespace n ON n.oid=o.opfnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_statistic_ext o JOIN pg_catalog.pg_namespace n ON n.oid=o.stxnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_ts_config o JOIN pg_catalog.pg_namespace n ON n.oid=o.cfgnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_ts_dict o JOIN pg_catalog.pg_namespace n ON n.oid=o.dictnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_ts_parser o JOIN pg_catalog.pg_namespace n ON n.oid=o.prsnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_ts_template o JOIN pg_catalog.pg_namespace n ON n.oid=o.tmplnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
                WHERE n.nspname='public' AND t.typrelid=0 AND (t.typtype IN ('d','e','r','m')
                    OR NOT t.typisdefined OR (t.typtype='b' AND t.typelem=0))) +
            (SELECT COUNT(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='c') +
            (SELECT COUNT(*) FROM pg_catalog.pg_largeobject_metadata) +
            (SELECT COUNT(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'
                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
                    WHERE d.objid=c.oid AND d.deptype='i' AND a.attidentity='d')) +
            (SELECT COUNT(*) FROM pg_catalog.pg_constraint p JOIN pg_catalog.pg_namespace n ON n.oid=p.connamespace WHERE n.nspname='public' AND p.contype<>'p') +
            (SELECT COUNT(*) FROM pg_catalog.pg_constraint p JOIN pg_catalog.pg_namespace n ON n.oid=p.connamespace WHERE n.nspname='public'
                AND p.contype='p' AND (p.condeferrable OR p.condeferred OR NOT p.convalidated)) +
            (SELECT COUNT(*) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND NOT i.indisprimary) +
            (SELECT COUNT(*) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=idx.relam
                WHERE n.nspname='public' AND i.indisprimary AND (NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
                    OR NOT i.indisunique OR NOT i.indimmediate OR i.indnatts<>i.indnkeyatts OR i.indpred IS NOT NULL
                    OR i.indexprs IS NOT NULL OR am.amname<>'btree' OR idx.reloptions IS NOT NULL
                    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indoption) option WHERE option<>0)
                    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indclass) classid JOIN pg_catalog.pg_opclass op ON op.oid=classid
                        WHERE NOT op.opcdefault)
                    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(i.indcollation) WITH ORDINALITY coll(collation,position)
                        JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=i.indkey[(coll.position-1)::int]
                        WHERE coll.collation<>a.attcollation))) +
            (SELECT COUNT(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND NOT t.tgisinternal) +
            (SELECT COUNT(*) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname='public' AND c.relkind='r') +
            (SELECT COUNT(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
                AND c.relkind='r' AND (c.relrowsecurity OR c.relforcerowsecurity OR c.relpersistence<>'p' OR c.reloptions IS NOT NULL)) +
            (SELECT COUNT(*) FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') +
            (SELECT COUNT(*) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                JOIN pg_catalog.pg_type t ON t.oid=a.atttypid WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
                    AND (a.attgenerated<>'' OR (a.attcollation<>0 AND a.attcollation<>t.typcollation)))
        )::text
        """;

    private const string PostgreSqlSequences = """
        SELECT owner.relname,a.attname,sequence.relname,pg_catalog.format_type(s.seqtypid,-1),
               s.seqstart::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle::text
        FROM pg_catalog.pg_class sequence JOIN pg_catalog.pg_namespace n ON n.oid=sequence.relnamespace
        JOIN pg_catalog.pg_sequence s ON s.seqrelid=sequence.oid
        JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=sequence.oid AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype='i'
        JOIN pg_catalog.pg_class owner ON owner.oid=d.refobjid
        JOIN pg_catalog.pg_attribute a ON a.attrelid=owner.oid AND a.attnum=d.refobjsubid AND a.attidentity='d'
        WHERE n.nspname='public' ORDER BY owner.relname,a.attname
        """;
}
