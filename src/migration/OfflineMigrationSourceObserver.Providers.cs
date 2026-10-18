using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text;

using Microsoft.Data.Sqlite;
using MySqlConnector;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

public sealed partial class OfflineMigrationSourceObserver
{
    internal const string SourceMaterialCleanupFailuresKey = "FsusBlog.Migration.SourceMaterialCleanupFailures";

    // Private measurement bodies are reserved for the original apply-owned writer
    // capability. They do not weaken or replace either public read-only observer.
    private static async Task<OfflineMigrationSourceObservation> ReadMySqlControlledEmptyCandidateAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        MySqlCurrentSchemaCatalog complete = await MySqlCurrentSchemaCatalogObserver.ReadAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        var budget = new ObservationBudget();
        RequireEmptyJournalRowCount(await ProviderScalarAsync(connection, transaction,
            "SELECT COUNT(*) FROM `" + OfflineMigrationStateStore.ApplyJournalTableName + "`",
            budget, cancellationToken).ConfigureAwait(false));
        RequireMySqlControlledEmptyDomainCandidate(complete);
        ImmutableArray<ImmutableArray<string>> allocator = await ReadMySqlAutoIncrementAsync(
            connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        if (!allocator.IsEmpty)
            throw new InvalidOperationException("offline_source_controlled_empty_allocator_present");
        string content = await ReadMySqlContentAsync((MySqlConnection)connection, (MySqlTransaction)transaction,
            false, allocator, cancellationToken).ConfigureAwait(false);
        MySqlCurrentSchemaCatalog terminal = await MySqlCurrentSchemaCatalogObserver.ReadAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        MySqlCurrentSchemaCatalogObserver.RequireUnchanged(complete, terminal);
        await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        RequireEmptyJournalRowCount(await ProviderScalarAsync(connection, transaction,
            "SELECT COUNT(*) FROM `" + OfflineMigrationStateStore.ApplyJournalTableName + "`",
            budget, cancellationToken).ConfigureAwait(false));
        cancellationToken.ThrowIfCancellationRequested();
        var observation = new OfflineMigrationSourceObservation(complete.Database,
            OfflineMigrationSourceFingerprints.ExtractorId, OfflineMigrationSourceFingerprints.ExtractorVersion,
            [new("objects.unsupported", "0")], [new("history.state", "absent")],
            OfflineMigrationSourceFingerprints.Business(false, 0, 0, 0, 0), content);
        _ = OfflineMigrationSourceFingerprints.CreateRegistry().Match(observation);
        return observation;
    }

    private static async Task<OfflineMigrationSourceObservation> ReadSqliteControlledEmptyCandidateAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        using OfflineMigrationSqliteDatabaseIdentity.Snapshot identity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        var budget = new ObservationBudget();
        if (await ProviderScalarAsync(connection, transaction, "PRAGMA application_id", budget, cancellationToken).ConfigureAwait(false) != 0
            || await ProviderScalarAsync(connection, transaction, "PRAGMA user_version", budget, cancellationToken).ConfigureAwait(false) != 0)
            throw new InvalidOperationException("offline_source_controlled_empty_sqlite_namespace_required");
        ImmutableArray<ImmutableArray<string>> encoding = await ReadProviderRowsAsync(connection, transaction,
            "PRAGMA encoding", budget, cancellationToken).ConfigureAwait(false);
        if (encoding.Length != 1 || encoding[0].Length != 1 || encoding[0][0] != "UTF-8")
            throw new InvalidOperationException("offline_source_sqlite_content_encoding_unavailable");
        ImmutableArray<OfflineMigrationFact> complete = await ReadSqliteSchemaAsync(
            connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        ImmutableArray<ImmutableArray<string>> objects = await ReadProviderRowsAsync(connection, transaction,
            "SELECT type,name,tbl_name,substr(COALESCE(sql,''),1,4097) FROM main.sqlite_schema ORDER BY name COLLATE BINARY",
            budget, cancellationToken).ConfigureAwait(false);
        bool journalPresent = RequireSqliteControlledEmptyDomainCandidate(objects);
        if (journalPresent)
        {
            await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            RequireEmptyJournalRowCount(await ProviderScalarAsync(connection, transaction,
                "SELECT COUNT(*) FROM main.\"" + OfflineMigrationStateStore.ApplyJournalTableName + "\"",
                budget, cancellationToken).ConfigureAwait(false));
        }
        else if (OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.Sqlite, complete))
            throw new InvalidOperationException("offline_source_controlled_empty_business_domain_required");
        (string content, ImmutableArray<OfflineMigrationFact> business) = await ReadSqliteContentAsync(
            (SqliteConnection)connection, (SqliteTransaction)transaction, false, budget, cancellationToken).ConfigureAwait(false);
        if (!OfflineMigrationPlanValidation.Equal(complete, await ReadSqliteSchemaAsync(
            connection, transaction, budget, cancellationToken).ConfigureAwait(false)))
            throw new InvalidOperationException("offline_source_controlled_empty_catalog_changed");
        ImmutableArray<ImmutableArray<string>> terminalObjects = await ReadProviderRowsAsync(connection, transaction,
            "SELECT type,name,tbl_name,substr(COALESCE(sql,''),1,4097) FROM main.sqlite_schema ORDER BY name COLLATE BINARY",
            budget, cancellationToken).ConfigureAwait(false);
        if (objects.Length != terminalObjects.Length
            || !objects.Zip(terminalObjects).All(pair => pair.First.SequenceEqual(pair.Second))
            || journalPresent != RequireSqliteControlledEmptyDomainCandidate(terminalObjects))
            throw new InvalidOperationException("offline_source_controlled_empty_catalog_changed");
        await identity.ValidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (journalPresent)
        {
            await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            RequireEmptyJournalRowCount(await ProviderScalarAsync(connection, transaction,
                "SELECT COUNT(*) FROM main.\"" + OfflineMigrationStateStore.ApplyJournalTableName + "\"",
                budget, cancellationToken).ConfigureAwait(false));
        }
        cancellationToken.ThrowIfCancellationRequested();
        var observation = new OfflineMigrationSourceObservation(identity.Database,
            OfflineMigrationSourceFingerprints.ExtractorId, OfflineMigrationSourceFingerprints.ExtractorVersion,
            [new("objects.unsupported", "0")], [new("history.state", "absent")], business, content);
        _ = OfflineMigrationSourceFingerprints.CreateRegistry().Match(observation);
        return observation;
    }

    // This only checks absence of an ordinary domain in complete measured rows.
    // It cannot establish native custody or replace the sole whole-journal validator.
    internal static void RequireMySqlControlledEmptyDomainCandidate(MySqlCurrentSchemaCatalog actual)
    {
        ArgumentNullException.ThrowIfNull(actual);
        if (actual.Rows.IsDefault || actual.Rows.Any(row => row is null)
            || actual.Rows.Count(row => row.Part == MySqlCatalogPart.Tables) != 1)
            throw new InvalidOperationException("offline_source_controlled_empty_business_domain_required");
        SchemaTableModel shape = CurrentSchemaControlShape.DescribeApplyJournal();
        foreach (MySqlCatalogRow row in actual.Rows)
        {
            if (row is null || !Enum.IsDefined(row.Part) || row.Cells.IsDefault
                || row.Cells.Any(cell => cell is null)
                || !row.Cells.Select(cell => cell.Name).SequenceEqual(MySqlCurrentSchemaCatalogObserver.ObservedFieldNames(row.Part)))
                throw new InvalidOperationException("offline_source_controlled_empty_catalog_incomplete");
            string? Field(string name) => row.Cells.Single(cell => cell.Name == name).Value;
            bool ownedCandidate = row.Part switch
            {
                MySqlCatalogPart.Tables => Field("TABLE_NAME") == shape.Name
                    && Field("TABLE_TYPE") == "BASE TABLE" && Field("ENGINE") == "InnoDB"
                    && Field("CREATE_OPTIONS") == "" && Field("TABLE_COMMENT") == "" && Field("AUTO_INCREMENT") is null,
                MySqlCatalogPart.Columns => Field("TABLE_NAME") == shape.Name && shape.Columns.ContainsKey(Field("COLUMN_NAME") ?? "")
                    && Field("EXTRA") == "" && Field("GENERATION_EXPRESSION") == "" && Field("COLUMN_COMMENT") == ""
                    && Field("SRS_ID") is null,
                MySqlCatalogPart.IndexParts => Field("TABLE_NAME") == shape.Name && Field("COMMENT") == ""
                    && Field("INDEX_COMMENT") == "",
                MySqlCatalogPart.Constraints or MySqlCatalogPart.ConstraintColumns => Field("TABLE_NAME") == shape.Name,
                MySqlCatalogPart.Checks => shape.Constraints.TryGetValue(Field("CONSTRAINT_NAME") ?? "", out SchemaConstraintModel? constraint)
                    && constraint.Kind == "check",
                MySqlCatalogPart.Partitions => Field("TABLE_NAME") == shape.Name
                    && row.Cells.Where(cell => cell.Name != "TABLE_NAME").All(cell => cell.Value is null),
                _ => false
            };
            if (!ownedCandidate)
                throw new InvalidOperationException("offline_source_controlled_empty_business_domain_required");
        }
    }

    internal static bool RequireSqliteControlledEmptyDomainCandidate(ImmutableArray<ImmutableArray<string>> actual)
    {
        // A complete measured zero-object catalog needs no control exemption.
        // This predicate still grants neither writer custody nor native admission.
        if (!actual.IsDefault && actual.IsEmpty)
            return false;
        SchemaTableModel shape = CurrentSchemaControlShape.DescribeApplyJournal();
        int indexes = shape.Constraints.Values.Count(constraint => constraint.Kind != "check");
        if (actual.IsDefault || actual.Length != indexes + 1
            || actual.Any(row => row.IsDefault || row.Length != 4 || row.Any(value => value is null))
            || actual.Select(row => row[1]).Distinct(StringComparer.Ordinal).Count() != actual.Length
            || actual.Count(row => row[0] == "table" && row[1] == shape.Name) != 1)
            throw new InvalidOperationException("offline_source_controlled_empty_business_domain_required");
        foreach (ImmutableArray<string> row in actual)
        {
            bool ownedIndex = row.Length == 4 && row[0] == "index" && row[2] == shape.Name && row[3] == ""
                && Enumerable.Range(1, indexes).Any(index => row[1] == $"sqlite_autoindex_{shape.Name}_{index}");
            bool ownedTable = row.Length == 4 && row[0] == "table" && row[1] == shape.Name && row[2] == shape.Name;
            if (!ownedTable && !ownedIndex)
                throw new InvalidOperationException("offline_source_controlled_empty_business_domain_required");
        }
        return true;
    }

    // Complete raw read capability is independent of instance-incarnation admission.
    // The native VFS name below is a namespace fact, not an inode/generation proof.
    // Public observation separately requires the actual held-FD identity port below.
    internal sealed record SqliteSourceRead(string NativeVfsName, ImmutableArray<OfflineMigrationFact> Schema,
        ImmutableArray<OfflineMigrationFact> Business, string ContentDigest);

    private static async Task<OfflineMigrationSourceObservation> ReadSqliteObservationAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        using OfflineMigrationSqliteDatabaseIdentity.Snapshot identity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(
            connection, transaction, cancellationToken).ConfigureAwait(false);
        SqliteSourceRead actual = await ReadSqliteSourceAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await identity.ValidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (actual.NativeVfsName != identity.Database.DatabaseId)
        {
            throw new InvalidOperationException("offline_source_sqlite_native_namespace_changed");
        }
        var observation = new OfflineMigrationSourceObservation(identity.Database,
            OfflineMigrationSourceFingerprints.ExtractorId, OfflineMigrationSourceFingerprints.ExtractorVersion,
            actual.Schema, [new("history.state", "absent")], actual.Business, actual.ContentDigest);
        _ = OfflineMigrationSourceFingerprints.CreateRegistry().Match(observation);
        return observation;
    }

    internal static async Task<SqliteSourceRead> ReadSqliteSourceAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        if (connection.GetType() != typeof(SqliteConnection) || transaction.GetType() != typeof(SqliteTransaction))
        {
            throw new InvalidOperationException("offline_source_native_streaming_driver_required");
        }
        if (connection.State != ConnectionState.Open || transaction.Connection != connection
            || transaction.IsolationLevel != IsolationLevel.Serializable)
        {
            throw new InvalidOperationException("offline_source_consistent_native_session_required");
        }
        if (SQLitePCL.raw.sqlite3_db_readonly(((SqliteConnection)connection).Handle, "main") != 1)
        {
            throw new InvalidOperationException("offline_source_sqlite_read_only_profile_required");
        }
        var budget = new ObservationBudget();
        if (await ProviderScalarAsync(connection, transaction, "PRAGMA query_only", budget, cancellationToken).ConfigureAwait(false) != 1
            || await ProviderScalarAsync(connection, transaction, "PRAGMA application_id", budget, cancellationToken).ConfigureAwait(false) != 0
            || await ProviderScalarAsync(connection, transaction, "PRAGMA user_version", budget, cancellationToken).ConfigureAwait(false) != 0)
        {
            throw new InvalidOperationException("offline_source_sqlite_read_only_profile_required");
        }
        ImmutableArray<ImmutableArray<string>> databases = await ReadProviderRowsAsync(connection, transaction,
            "PRAGMA database_list", budget, cancellationToken).ConfigureAwait(false);
        string? nativeName = SQLitePCL.raw.sqlite3_db_filename(((SqliteConnection)connection).Handle, "main").utf8_to_string();
        if (databases.Length != 1 || databases[0].Length != 3 || databases[0][1] != "main"
            || string.IsNullOrEmpty(nativeName) || !Path.IsPathFullyQualified(nativeName)
            || !string.Equals(nativeName, databases[0][2], StringComparison.Ordinal))
        {
            throw new InvalidOperationException("offline_source_sqlite_persistent_main_namespace_required");
        }
        ImmutableArray<ImmutableArray<string>> encoding = await ReadProviderRowsAsync(connection, transaction,
            "PRAGMA encoding", budget, cancellationToken).ConfigureAwait(false);
        if (encoding.Length != 1 || encoding[0].Length != 1 || encoding[0][0] != "UTF-8")
        {
            throw new InvalidOperationException("offline_source_sqlite_content_encoding_unavailable");
        }
        ImmutableArray<OfflineMigrationFact> schema = await ReadSqliteSchemaAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        bool legacy = OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.Sqlite, schema);
        (string digest, ImmutableArray<OfflineMigrationFact> business) = await ReadSqliteContentAsync(
            (SqliteConnection)connection, (SqliteTransaction)transaction, legacy, budget, cancellationToken).ConfigureAwait(false);
        if (!OfflineMigrationPlanValidation.Equal(business, OfflineMigrationSourceFingerprints.Business(legacy, 0, 0, 0, 0)))
        {
            // These are actual native business facts, not receipt assertions.
            // Preserve their closed redacted differences without fabricating a
            // database incarnation just to construct an observation DTO.
            throw OfflineMigrationSourceFingerprintException.Unknown(
                [(OfflineMigrationSourceFingerprints.EmptyId, OfflineMigrationSourceFingerprints.Shape(CurrentSchemaProviderKind.Sqlite, false)),
                 (OfflineMigrationSourceFingerprints.LegacyId, OfflineMigrationSourceFingerprints.Shape(CurrentSchemaProviderKind.Sqlite, true))],
                new(CurrentSchemaProviderKind.Sqlite, OfflineMigrationSourceFingerprints.ExtractorId,
                    OfflineMigrationSourceFingerprints.ExtractorVersion, schema, [new("history.state", "absent")], business));
        }
        if (!OfflineMigrationPlanValidation.Equal(schema,
            await ReadSqliteSchemaAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false))
            || !string.Equals(nativeName, SQLitePCL.raw.sqlite3_db_filename(((SqliteConnection)connection).Handle, "main").utf8_to_string(), StringComparison.Ordinal))
        {
            throw new InvalidOperationException("offline_source_sqlite_namespace_or_schema_changed");
        }
        return new(nativeName, schema, business, digest);
    }

    private static async Task<ImmutableArray<OfflineMigrationFact>> ReadSqliteSchemaAsync(DbConnection connection,
        DbTransaction transaction, ObservationBudget budget, CancellationToken cancellationToken)
    {
        var facts = ImmutableArray.CreateBuilder<OfflineMigrationFact>();
        ImmutableArray<ImmutableArray<string>> objects = await ReadProviderRowsAsync(connection, transaction, """
            SELECT substr(type,1,4097),substr(name,1,4097),substr(tbl_name,1,4097),substr(COALESCE(sql,''),1,4097)
            FROM main.sqlite_schema ORDER BY name COLLATE BINARY
            """, budget, cancellationToken).ConfigureAwait(false);
        long unsupported = 0;
        foreach (ImmutableArray<string> value in objects)
        {
            if (value[0] == "table" && value[1] == "sqlite_sequence")
            {
                continue;
            }
            if (value[0] == "index" && value[1].StartsWith("sqlite_autoindex_", StringComparison.Ordinal) && value[3].Length == 0)
            {
                // Exact accepted table DDL below permits only the registered PRIMARY KEY.
                continue;
            }
            if (value[0] != "table" || value[1].StartsWith("sqlite_", StringComparison.Ordinal))
            {
                unsupported++;
                continue;
            }
            facts.Add(new("table/" + value[1], "base"));
            facts.Add(new("ddl/" + value[1], value[3]));
            ImmutableArray<ImmutableArray<string>> columns = await ReadProviderRowsAsync(connection, transaction,
                $"PRAGMA main.table_xinfo({QuoteSqlite(value[1])})", budget, cancellationToken).ConfigureAwait(false);
            OfflineMigrationSourceFingerprints.LegacyTable? registered = OfflineMigrationSourceFingerprints.LegacyTables.SingleOrDefault(table => table.Name == value[1]);
            bool exactIdentityDdl = registered is not null && value[3] == OfflineMigrationSourceFingerprints.SqliteTableSql(registered);
            foreach (ImmutableArray<string> column in columns)
            {
                if (column.Length != 7 || column[6] != "0")
                {
                    unsupported++;
                    continue;
                }
                bool identity = exactIdentityDdl && registered!.Columns.Any(expected => expected.Name == column[1] && expected.Identity);
                facts.Add(OfflineMigrationSourceFingerprints.ColumnFact(value[1], column[1], int.Parse(column[0], CultureInfo.InvariantCulture) + 1,
                    column[2], column[3] == "0", Default(column[4]), identity ? "rowid-autoincrement" : "none", int.Parse(column[5], CultureInfo.InvariantCulture)));
            }
        }
        if (objects.Any(value => value[1] == "sqlite_sequence") && !objects.Any(value => value[0] == "table" && !value[1].StartsWith("sqlite_", StringComparison.Ordinal)))
        {
            unsupported++;
        }
        facts.Add(new("objects.unsupported", unsupported.ToString(CultureInfo.InvariantCulture)));
        return OfflineMigrationPlanValidation.NormalizeFacts(facts.ToImmutable());
    }

    private static async Task<(string Digest, ImmutableArray<OfflineMigrationFact> Business)> ReadSqliteContentAsync(
        SqliteConnection connection, SqliteTransaction transaction, bool legacy, ObservationBudget budget, CancellationToken cancellationToken)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.ASCII.GetBytes("fsusblog.migration-source-content.v1\0"));
        long categoryOverflow = 0;
        long tagOverflow = 0;
        long keyOverflow = 0;
        long valueOverflow = 0;
        if (legacy)
        {
            foreach (OfflineMigrationSourceFingerprints.LegacyTable table in OfflineMigrationSourceFingerprints.LegacyTables.OrderBy(value => value.Name, StringComparer.Ordinal))
            {
                await AppendTableHeaderAsync(hash, table, cancellationToken).ConfigureAwait(false);
                await using SqliteCommand command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandTimeout = 30;
                // TEXT is never selected into a managed whole-value buffer. Its storage class
                // is selected, then the same rowid is read through native incremental BLOB IO.
                string columns = string.Join(',', table.Columns.Select(column =>
                {
                    string name = QuoteSqlite(column.Name);
                    bool text = column.Type is "text" or "timestamp" || column.Type.StartsWith("varchar", StringComparison.Ordinal);
                    return "typeof(" + name + ")," + (text ? "NULL" : "CASE WHEN typeof(" + name + ")='integer' THEN " + name + " ELSE NULL END");
                }));
                string order = string.Join(',', table.PrimaryKey.Select(key => QuoteSqlite(key) + " COLLATE BINARY"));
                command.CommandText = $"SELECT rowid,{columns} FROM main.{QuoteSqlite(table.Name)} ORDER BY {order}";
                await using SqliteDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    hash.AppendData([3]);
                    long rowid = reader.GetInt64(0);
                    long configKeyLength = 0;
                    long configValueLength = 0;
                    bool configPage = false;
                    for (int index = 0; index < table.Columns.Length; index++)
                    {
                        OfflineMigrationSourceFingerprints.LegacyColumn column = table.Columns[index];
                        bool text = column.Type is "text" or "timestamp" || column.Type.StartsWith("varchar", StringComparison.Ordinal);
                        int ordinal = 1 + index * 2;
                        string storage = reader.GetString(ordinal);
                        bool isNull = storage == "null";
                        if (isNull)
                        {
                            if (!column.Nullable)
                            {
                                throw new InvalidOperationException("offline_source_nonnullable_value_invalid");
                            }
                            hash.AppendData([0]);
                            continue;
                        }
                        hash.AppendData([1]);
                        if (text)
                        {
                            if (storage != "text")
                            {
                                throw new InvalidOperationException("offline_source_sqlite_storage_class_invalid");
                            }
                            using var blob = new SqliteBlob(connection, "main", table.Name, column.Name, rowid, readOnly: true);
                            if (column.Type == "timestamp" && blob.Length > 64)
                            {
                                throw new InvalidOperationException("offline_source_sqlite_timestamp_value_invalid");
                            }
                            using var decoded = new StreamReader(blob, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false, bufferSize: 4096, leaveOpen: true);
                            using var counted = new ScalarCountingReader(decoded);
                            await AppendTextAsync(hash, counted, cancellationToken).ConfigureAwait(false);
                            long length = counted.Scalars;
                            if (column.Type == "timestamp")
                            {
                                RequireSqliteTimestampRepresentation(counted.Prefix, length);
                            }
                            if (column.Type.StartsWith("varchar", StringComparison.Ordinal)
                                && length > int.Parse(column.Type[8..^1], CultureInfo.InvariantCulture))
                            {
                                throw new InvalidOperationException("offline_source_sqlite_varchar_value_invalid");
                            }
                            if (table.Name == "category" && column.Name == "name" && length > 128)
                            {
                                categoryOverflow++;
                            }
                            if (table.Name == "tag" && column.Name == "name" && length > 128)
                            {
                                tagOverflow++;
                            }
                            if (table.Name == "sys_systemconfig" && column.Name == "key")
                            {
                                configKeyLength = length;
                                configPage = IsLegacyPageKeyPrefix(counted.Prefix);
                            }
                            if (table.Name == "sys_systemconfig" && column.Name == "value")
                            {
                                configValueLength = length;
                            }
                        }
                        else
                        {
                            if (storage != "integer")
                            {
                                throw new InvalidOperationException("offline_source_sqlite_storage_class_invalid");
                            }
                            long value = reader.GetInt64(ordinal + 1);
                            if (column.Type == "int" && value is < int.MinValue or > int.MaxValue)
                            {
                                throw new InvalidOperationException("offline_source_integer_value_invalid");
                            }
                            AppendInteger(hash, column.Type == "bool" ? RequireBooleanInteger(value) : value);
                        }
                    }
                    if (table.Name == "sys_systemconfig" && !configPage)
                    {
                        if (configKeyLength > 64)
                        {
                            keyOverflow++;
                        }
                        if (configValueLength > 512)
                        {
                            valueOverflow++;
                        }
                    }
                }
                hash.AppendData([4]);
            }
            ImmutableArray<ImmutableArray<string>> sequences = await ReadProviderRowsAsync(connection, transaction,
                "SELECT substr(name,1,4097),typeof(seq),CASE WHEN typeof(seq)='integer' THEN CAST(seq AS TEXT) ELSE '' END FROM main.sqlite_sequence ORDER BY name COLLATE BINARY", budget, cancellationToken).ConfigureAwait(false);
            string[] identityTables = OfflineMigrationSourceFingerprints.LegacyTables.Where(table => table.Columns.Any(column => column.Identity))
                .Select(table => table.Name).OrderBy(value => value, StringComparer.Ordinal).ToArray();
            if (sequences.Any(row => row[1] != "integer" || !identityTables.Contains(row[0], StringComparer.Ordinal))
                || sequences.Select(row => row[0]).Distinct(StringComparer.Ordinal).Count() != sequences.Length)
            {
                throw new InvalidOperationException("offline_source_sqlite_sequence_state_invalid");
            }
            foreach (string table in identityTables)
            {
                hash.AppendData([5]);
                using var name = new StringReader(table);
                await AppendTextAsync(hash, name, cancellationToken).ConfigureAwait(false);
                ImmutableArray<string> row = sequences.SingleOrDefault(value => value[0] == table);
                hash.AppendData(new byte[] { row.IsDefault ? (byte)0 : (byte)1 });
                if (!row.IsDefault)
                {
                    if (!long.TryParse(row[2], NumberStyles.None, CultureInfo.InvariantCulture, out long value) || value < 0)
                    {
                        throw new InvalidOperationException("offline_source_sqlite_sequence_state_invalid");
                    }
                    AppendInteger(hash, value);
                }
            }
        }
        hash.AppendData([255]);
        return (Convert.ToHexStringLower(hash.GetHashAndReset()), OfflineMigrationSourceFingerprints.Business(legacy,
            categoryOverflow, tagOverflow, keyOverflow, valueOverflow));
    }

    internal static bool IsLegacyPageKeyPrefix(string value)
        => (value.Length >= 5 && value.StartsWith("Page", StringComparison.Ordinal))
            || value.StartsWith("sys:page:", StringComparison.Ordinal);

    internal static void RequireSqliteTimestampRepresentation(string value, long scalarLength)
    {
        if (scalarLength > 26 || scalarLength != value.Length
            || !DateTime.TryParseExact(value, ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm:ss.FFFFFF", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.FFFFFF"],
                CultureInfo.InvariantCulture, DateTimeStyles.None, out DateTime parsed)
            || parsed.Kind != DateTimeKind.Unspecified)
        {
            throw new InvalidOperationException("offline_source_sqlite_timestamp_value_invalid");
        }
    }

    private sealed class ScalarCountingReader(TextReader source) : TextReader
    {
        private readonly StringBuilder _prefix = new(32);
        internal long Scalars { get; private set; }
        internal string Prefix => _prefix.ToString();

        public override async ValueTask<int> ReadAsync(Memory<char> buffer, CancellationToken cancellationToken = default)
        {
            int count = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            for (int index = 0; index < count; index++)
            {
                char value = buffer.Span[index];
                if (!char.IsLowSurrogate(value))
                {
                    Scalars = checked(Scalars + 1);
                }
                if (_prefix.Length < 32)
                {
                    _prefix.Append(value);
                }
            }
            return count;
        }
    }

    private static string QuoteSqlite(string value) => "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";

    // Actual identity/settings material is not a retained writer capability. The
    // sole native owner must separately prove its minted transaction, access mode,
    // epoch, lock and creator deadline before using these measured values.
    internal sealed record MySqlNativeIdentityMaterial(CurrentSchemaDatabaseIdentity Database,
        string Isolation, string SessionReadOnly, string AutoIncrementIncrement, string AutoIncrementOffset);

    internal static Task<MySqlNativeIdentityMaterial> ReadMySqlNativeIdentityMaterialAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        // This per-material budget never replaces a complete observation's budget.
        // The public observation calls the overload with its existing accumulator.
        => ReadMySqlNativeIdentityMaterialAsync(connection, transaction, new ObservationBudget(), cancellationToken);

    private static async Task<MySqlNativeIdentityMaterial> ReadMySqlNativeIdentityMaterialAsync(
        DbConnection connection, DbTransaction transaction, ObservationBudget budget, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (connection.GetType() != typeof(MySqlConnection) || transaction.GetType() != typeof(MySqlTransaction))
            throw new InvalidOperationException("offline_source_native_streaming_driver_required");
        if (connection.State != ConnectionState.Open || transaction.Connection != connection)
            throw new InvalidOperationException("offline_source_consistent_native_session_required");
        ImmutableArray<ImmutableArray<string>> settings = await ReadProviderRowsAsync(connection, transaction,
            "SELECT @@server_uuid,DATABASE(),@@session.transaction_isolation,@@session.transaction_read_only,@@session.auto_increment_increment,@@session.auto_increment_offset",
            budget, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return ParseMySqlNativeIdentityMaterial(settings);
    }

    internal static MySqlNativeIdentityMaterial ParseMySqlNativeIdentityMaterial(ImmutableArray<ImmutableArray<string>> settings)
    {
        if (settings.IsDefault || settings.Length != 1 || settings[0].IsDefault || settings[0].Length != 6
            || settings[0].Any(value => value is null) || !Guid.TryParse(settings[0][0], out Guid server)
            || server == Guid.Empty || string.IsNullOrEmpty(settings[0][1]))
            throw new InvalidOperationException("offline_source_mysql_snapshot_or_identity_unavailable");
        return new(new(CurrentSchemaProviderKind.MySql, "mysql:" + server.ToString("D"), settings[0][1]),
            settings[0][2], settings[0][3], settings[0][4], settings[0][5]);
    }

    private static async Task<OfflineMigrationSourceObservation> ReadMySqlObservationAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        if (connection.GetType() != typeof(MySqlConnection) || transaction.GetType() != typeof(MySqlTransaction))
        {
            throw new InvalidOperationException("offline_source_native_streaming_driver_required");
        }
        if (connection.State != ConnectionState.Open || transaction.Connection != connection
            || transaction.IsolationLevel != IsolationLevel.Snapshot)
        {
            throw new InvalidOperationException("offline_source_consistent_native_session_required");
        }
        var budget = new ObservationBudget();
        MySqlNativeIdentityMaterial identity = await ReadMySqlNativeIdentityMaterialAsync(
            connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        if (identity.Isolation != "REPEATABLE-READ" || identity.SessionReadOnly != "1"
            || identity.AutoIncrementIncrement != "1" || identity.AutoIncrementOffset != "1")
        {
            throw new InvalidOperationException("offline_source_mysql_snapshot_or_identity_unavailable");
        }
        // Information_schema can hide objects from restricted users. Actual global SELECT
        // gives complete table/routine visibility; VIEW/TRIGGER/EVENT visibility is explicit.
        long visible = await ProviderScalarAsync(connection, transaction, """
            SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM information_schema.USER_PRIVILEGES
            WHERE GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1)))
              AND PRIVILEGE_TYPE IN ('SELECT','SHOW VIEW','TRIGGER','EVENT')
            """, budget, cancellationToken).ConfigureAwait(false);
        if (visible != 4)
        {
            throw new InvalidOperationException("offline_source_mysql_complete_catalog_visibility_required");
        }
        ImmutableArray<OfflineMigrationFact> schema = await ReadMySqlSchemaAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        bool legacy = OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.MySql, schema);
        ImmutableArray<OfflineMigrationFact> business = legacy
            ? await ReadMySqlBusinessAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false)
            : OfflineMigrationSourceFingerprints.Business(false, 0, 0, 0, 0);
        ImmutableArray<ImmutableArray<string>> identityBefore = await ReadMySqlAutoIncrementAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        string content = await ReadMySqlContentAsync((MySqlConnection)connection, (MySqlTransaction)transaction,
            legacy, identityBefore, cancellationToken).ConfigureAwait(false);
        ImmutableArray<ImmutableArray<string>> identityAfter = await ReadMySqlAutoIncrementAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        if (!EqualRows(identityBefore, identityAfter)
            || !OfflineMigrationPlanValidation.Equal(schema, await ReadMySqlSchemaAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false)))
        {
            throw new InvalidOperationException("offline_source_mysql_non_mvcc_catalog_or_identity_changed");
        }
        var observation = new OfflineMigrationSourceObservation(identity.Database, OfflineMigrationSourceFingerprints.ExtractorId,
            OfflineMigrationSourceFingerprints.ExtractorVersion, schema, [new("history.state", "absent")], business, content);
        _ = OfflineMigrationSourceFingerprints.CreateRegistry().Match(observation);
        return observation;
    }

    private static async Task<ImmutableArray<OfflineMigrationFact>> ReadMySqlSchemaAsync(
        DbConnection connection, DbTransaction transaction, ObservationBudget budget, CancellationToken cancellationToken)
    {
        var facts = ImmutableArray.CreateBuilder<OfflineMigrationFact>();
        ImmutableArray<ImmutableArray<string>> tables = await ReadProviderRowsAsync(connection, transaction, """
            SELECT TABLE_NAME,TABLE_TYPE,COALESCE(ENGINE,'') FROM information_schema.TABLES
            WHERE TABLE_SCHEMA=DATABASE() ORDER BY BINARY TABLE_NAME
            """, budget, cancellationToken).ConfigureAwait(false);
        foreach (ImmutableArray<string> table in tables)
        {
            facts.Add(new("table/" + table[0], table[1] == "BASE TABLE" && table[2] == "InnoDB" ? "base" : "unsupported"));
        }
        ImmutableArray<ImmutableArray<string>> columns = await ReadProviderRowsAsync(connection, transaction, """
            SELECT c.TABLE_NAME,c.COLUMN_NAME,c.ORDINAL_POSITION,c.COLUMN_TYPE,c.IS_NULLABLE,
                   LEFT(COALESCE(c.COLUMN_DEFAULT,''),4097),c.EXTRA,
                   COALESCE(k.ORDINAL_POSITION,0),COALESCE(c.CHARACTER_SET_NAME,''),COALESCE(c.COLLATION_NAME,''),
                   CAST(c.COLUMN_DEFAULT IS NULL AS UNSIGNED)
            FROM information_schema.COLUMNS c
            LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA=c.TABLE_SCHEMA
                AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME AND k.CONSTRAINT_NAME='PRIMARY'
            WHERE c.TABLE_SCHEMA=DATABASE() ORDER BY BINARY c.TABLE_NAME,c.ORDINAL_POSITION
            """, budget, cancellationToken).ConfigureAwait(false);
        foreach (ImmutableArray<string> column in columns)
        {
            facts.Add(OfflineMigrationSourceFingerprints.ColumnFact(column[0], column[1], int.Parse(column[2], CultureInfo.InvariantCulture),
                column[3], column[4] == "YES", MySqlDefault(column[3], column[10] == "1", column[5]), column[6] == "auto_increment" ? "auto-increment"
                : column[6].Length == 0 ? "none" : "unsupported", int.Parse(column[7], CultureInfo.InvariantCulture)));
            if (column[8].Length != 0 || column[9].Length != 0)
            {
                facts.Add(OfflineMigrationSourceFingerprints.MySqlTextFact(column[0], column[1], column[8], column[9]));
            }
        }
        long unsupported = await ProviderScalarAsync(connection, transaction, MySqlUnsupported, budget, cancellationToken).ConfigureAwait(false);
        facts.Add(new("objects.unsupported", unsupported.ToString(CultureInfo.InvariantCulture)));
        return OfflineMigrationPlanValidation.NormalizeFacts(facts.ToImmutable());
    }

    private static Task<ImmutableArray<ImmutableArray<string>>> ReadMySqlAutoIncrementAsync(
        DbConnection connection, DbTransaction transaction, ObservationBudget budget, CancellationToken cancellationToken)
        => ReadProviderRowsAsync(connection, transaction, """
            SELECT TABLE_NAME,CAST(AUTO_INCREMENT AS CHAR) FROM information_schema.TABLES
            WHERE TABLE_SCHEMA=DATABASE() AND AUTO_INCREMENT IS NOT NULL ORDER BY BINARY TABLE_NAME
            """, budget, cancellationToken);

    private static async Task<string> ReadMySqlContentAsync(MySqlConnection connection, MySqlTransaction transaction,
        bool legacy, ImmutableArray<ImmutableArray<string>> autoIncrement, CancellationToken cancellationToken)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(Encoding.ASCII.GetBytes("fsusblog.migration-source-content.v1\0"));
        if (legacy)
        {
            foreach (OfflineMigrationSourceFingerprints.LegacyTable table in OfflineMigrationSourceFingerprints.LegacyTables.OrderBy(value => value.Name, StringComparer.Ordinal))
            {
                await AppendTableHeaderAsync(hash, table, cancellationToken).ConfigureAwait(false);
                await using MySqlCommand command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandTimeout = 30;
                string columns = string.Join(',', table.Columns.Select(column => column.Type == "bool"
                    ? "CAST(" + QuoteMySql(column.Name) + " AS SIGNED)" : QuoteMySql(column.Name)));
                string order = string.Join(',', table.PrimaryKey.Select(key => table.Columns.Single(column => column.Name == key).Type.StartsWith("varchar", StringComparison.Ordinal)
                    ? "BINARY " + QuoteMySql(key) : QuoteMySql(key)));
                command.CommandText = $"SELECT {columns} FROM {QuoteMySql(table.Name)} ORDER BY {order}";
                await using MySqlDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false);
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    hash.AppendData([3]);
                    for (int index = 0; index < table.Columns.Length; index++)
                    {
                        if (await reader.IsDBNullAsync(index, cancellationToken).ConfigureAwait(false))
                        {
                            if (!table.Columns[index].Nullable)
                            {
                                throw new InvalidOperationException("offline_source_nonnullable_value_invalid");
                            }
                            hash.AppendData([0]);
                            continue;
                        }
                        hash.AppendData([1]);
                        string type = table.Columns[index].Type;
                        if (type == "text" || type.StartsWith("varchar", StringComparison.Ordinal))
                        {
                            // Connector buffers a row and GetTextReader calls GetString. This is
                            // not claimed as native streaming: the exact registered MySQL TEXT
                            // type is capped at 65,535 bytes; LONGTEXT/MEDIUMTEXT are unknown schemas.
                            using TextReader text = reader.GetTextReader(index);
                            await AppendTextAsync(hash, text, cancellationToken).ConfigureAwait(false);
                        }
                        else
                        {
                            long value = type switch
                            {
                                "int" => reader.GetInt32(index),
                                "bigint" => reader.GetInt64(index),
                                "bool" => RequireBooleanInteger(reader.GetInt64(index)),
                                "timestamp" => TimestampMicroseconds(reader.GetMySqlDateTime(index).GetDateTime()),
                                _ => throw new InvalidOperationException("offline_source_content_type_unsupported")
                            };
                            AppendInteger(hash, value);
                        }
                    }
                }
                hash.AppendData([4]);
            }
            foreach (ImmutableArray<string> row in autoIncrement)
            {
                hash.AppendData([5]);
                using var name = new StringReader(row[0]);
                await AppendTextAsync(hash, name, cancellationToken).ConfigureAwait(false);
                if (!long.TryParse(row[1], NumberStyles.None, CultureInfo.InvariantCulture, out long next) || next <= 0)
                {
                    throw new InvalidOperationException("offline_source_mysql_auto_increment_state_invalid");
                }
                AppendInteger(hash, next);
            }
            string[] expected = OfflineMigrationSourceFingerprints.LegacyTables.Where(table => table.Columns.Any(column => column.Identity))
                .Select(table => table.Name).OrderBy(value => value, StringComparer.Ordinal).ToArray();
            if (!expected.SequenceEqual(autoIncrement.Select(row => row[0]), StringComparer.Ordinal))
            {
                throw new InvalidOperationException("offline_source_mysql_auto_increment_readset_incomplete");
            }
        }
        else if (!autoIncrement.IsEmpty)
        {
            throw new InvalidOperationException("offline_source_mysql_empty_identity_state_not_empty");
        }
        hash.AppendData([255]);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static async Task AppendTableHeaderAsync(IncrementalHash hash,
        OfflineMigrationSourceFingerprints.LegacyTable table, CancellationToken cancellationToken)
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
    }

    private static async Task<ImmutableArray<OfflineMigrationFact>> ReadMySqlBusinessAsync(
        DbConnection connection, DbTransaction transaction, ObservationBudget budget, CancellationToken cancellationToken)
    {
        const string Key = "`key`";
        const string Length = "CHAR_LENGTH";
        const string NonPage = "BINARY `key` NOT LIKE BINARY 'Page_%' AND BINARY `key` NOT LIKE BINARY 'sys:page:%'";
        long category = await ProviderScalarAsync(connection, transaction, $"SELECT COUNT(*) FROM category WHERE {Length}(name)>128", budget, cancellationToken).ConfigureAwait(false);
        long tag = await ProviderScalarAsync(connection, transaction, $"SELECT COUNT(*) FROM tag WHERE {Length}(name)>128", budget, cancellationToken).ConfigureAwait(false);
        long configKey = await ProviderScalarAsync(connection, transaction, $"SELECT COUNT(*) FROM sys_systemconfig WHERE {NonPage} AND {Length}({Key})>64", budget, cancellationToken).ConfigureAwait(false);
        long configValue = await ProviderScalarAsync(connection, transaction, $"SELECT COUNT(*) FROM sys_systemconfig WHERE {NonPage} AND {Length}(value)>512", budget, cancellationToken).ConfigureAwait(false);
        return OfflineMigrationSourceFingerprints.Business(true, category, tag, configKey, configValue);
    }

    private static async Task<long> ProviderScalarAsync(DbConnection connection, DbTransaction transaction, string sql,
        ObservationBudget budget, CancellationToken cancellationToken)
    {
        ImmutableArray<ImmutableArray<string>> rows = await ReadProviderRowsAsync(connection, transaction, sql, budget, cancellationToken).ConfigureAwait(false);
        if (rows.Length != 1 || rows[0].Length != 1 || !long.TryParse(rows[0][0], NumberStyles.None, CultureInfo.InvariantCulture, out long value))
        {
            throw new InvalidOperationException("offline_source_scalar_observation_invalid");
        }
        return value;
    }

    private static async Task<ImmutableArray<ImmutableArray<string>>> ReadProviderRowsAsync(DbConnection connection,
        DbTransaction transaction, string sql, ObservationBudget budget, CancellationToken cancellationToken)
    {
        var cleanupFailures = ImmutableArray.CreateBuilder<string>(2);
        DbCommand command = connection.CreateCommand();
        DbDataReader? reader = null;
        ImmutableArray<ImmutableArray<string>> result = default;
        Exception? failure = null;
        try
        {
            command.Transaction = transaction;
            command.CommandText = sql;
            command.CommandTimeout = 30;
            reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false);
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
                    string text = reader.IsDBNull(index) ? string.Empty : Convert.ToString(reader.GetValue(index), CultureInfo.InvariantCulture) ?? string.Empty;
                    budget._characters += text.Length;
                    if (text.Length > MaximumCellCharacters || budget._characters > MaximumMetadataCharacters)
                    {
                        throw new InvalidOperationException("offline_source_metadata_budget_exceeded");
                    }
                    cells.Add(text);
                }
                rows.Add(cells.ToImmutable());
            }
            result = rows.ToImmutable();
        }
        catch (Exception primary)
        {
            failure = primary;
        }
        if (reader is not null)
        {
            try
            {
                await reader.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception cleanup)
            {
                failure ??= cleanup;
                cleanupFailures.Add("offline_source_material_reader_cleanup_failed");
            }
        }
        try
        {
            await command.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            failure ??= cleanup;
            cleanupFailures.Add("offline_source_material_command_cleanup_failed");
        }
        if (failure is not null)
        {
            if (cleanupFailures.Count > 0)
            {
                // Fixed diagnostics only; no secondary exception, SQL or cell data.
                failure.Data[SourceMaterialCleanupFailuresKey] = cleanupFailures.ToImmutable();
            }
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
        return result;
    }

    internal static long RequireBooleanInteger(long value) => value is 0 or 1 ? value
        : throw new InvalidOperationException("offline_source_boolean_value_invalid");

    internal static string MySqlDefault(string physicalType, bool isNull, string value)
        => isNull ? "none" : value == "0" && (physicalType is "int" or "tinyint(1)") ? "0" : "unsupported:" + value;

    internal static long TimestampMicroseconds(DateTime value)
    {
        if (value.Kind != DateTimeKind.Unspecified || value.Ticks % 10 != 0)
        {
            throw new InvalidOperationException("offline_source_timestamp_representation_invalid");
        }
        return checked((value.Ticks - new DateTime(2000, 1, 1).Ticks) / 10);
    }

    private static string QuoteMySql(string value) => "`" + value.Replace("`", "``", StringComparison.Ordinal) + "`";
    private static bool EqualRows(ImmutableArray<ImmutableArray<string>> left, ImmutableArray<ImmutableArray<string>> right)
        => left.Length == right.Length && left.Zip(right).All(pair => pair.First.SequenceEqual(pair.Second, StringComparer.Ordinal));

    private const string MySqlUnsupported = """
        SELECT (
            (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_TYPE<>'BASE TABLE' OR ENGINE<>'InnoDB' OR COALESCE(CREATE_OPTIONS,'')<>'')) +
            (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()) +
            (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()) +
            (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()) +
            (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE<>'PRIMARY KEY') +
            (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
                AND (INDEX_NAME<>'PRIMARY' OR NON_UNIQUE<>0 OR INDEX_TYPE<>'BTREE' OR SUB_PART IS NOT NULL OR COLLATION<>'A' OR IS_VISIBLE<>'YES')) +
            (SELECT COUNT(*) FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=DATABASE() AND PARTITION_NAME IS NOT NULL) +
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                AND (COALESCE(GENERATION_EXPRESSION,'')<>'' OR EXTRA NOT IN ('','auto_increment')
                    OR COLUMN_COMMENT<>'' OR DATA_TYPE NOT IN ('int','bigint','tinyint','varchar','text','datetime')
                    OR COALESCE(DATETIME_PRECISION,0)<>0))
        )
        """;
}
