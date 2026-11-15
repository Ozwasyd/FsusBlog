using System.Data;
using System.Data.Common;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using MySqlConnector;
using Npgsql;

internal static partial class Migration
{
    private const string LegacyReference = "2605b438eed8f16d12ddddf033d08a6fa18fcd12";
    private const string LegacyDatabaseVariable = "FSUSBLOG_V1_DB";
    private const string LegacySqliteVariable = "FSUSBLOG_V1_SQLITE_PATH";
    private const string LegacySchemaVariable = "FSUSBLOG_V1_SCHEMA";
    private const int LegacyCommandTimeout = 30;

    private sealed record LegacyImportAdmission(bool ClassificationComplete, bool EligibleForCandidatePlanning,
        LegacyProjection[] SourceProjections, ImportFinding[] Findings);

    private static async Task<int> RunLegacyAsync(string mode, string provider, string? ownerMap, CancellationToken token)
    {
        if (mode is not ("inventory" or "plan") && (mode != "rehearse" || ownerMap is null))
            throw new ArgumentException("Use legacy inventory, legacy plan, or legacy rehearse with an owner map.");

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMinutes(4));
        try
        {
            return await InspectLegacyAsync(mode, provider, ownerMap, deadline.Token);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && deadline.IsCancellationRequested)
        {
            Console.Error.WriteLine("The legacy intake exceeded its four-minute snapshot budget.");
            return 1;
        }
        catch (DbException error)
        {
            // Source errors may contain input values or connection properties.
            var code = error switch
            {
                SqliteException sqlite => $"{sqlite.SqliteErrorCode}/{sqlite.SqliteExtendedErrorCode}",
                MySqlException mysql => mysql.Number.ToString(System.Globalization.CultureInfo.InvariantCulture),
                PostgresException postgres => postgres.SqlState,
                _ => error.GetType().Name
            };
            Console.Error.WriteLine($"Legacy {provider} database rejected the read-only intake ({code}).");
            return 1;
        }
    }

    private static async Task<int> InspectLegacyAsync(string mode, string provider, string? ownerMap, CancellationToken token)
    {
        var source = ParseLegacySource(provider);
        await using var connection = source.Connection;
        await connection.OpenAsync(token);
        await using var transaction = await BeginLegacyReadAsync(connection, token);
        var catalog = await ReadLegacyCatalogAsync(source, transaction, token);
        var (tables, blockers) = SelectLegacyTables(source, catalog);
        var properties = provider == "postgres" && (mode is "inventory" or "plan")
            ? await ReadLegacyPropertyInventoryAsync(source, transaction, catalog, token) : null;

        var audit = blockers.Count == 0
            ? await AuditLegacyAsync(source, transaction, tables, mode != "inventory", token)
            : null;
        if (audit is not null)
            blockers.AddRange(audit.Issues.Select(issue => $"{issue.Kind}: {issue.Count}"));
        var taxonomy = mode == "plan" && audit is not null && blockers.Count == 0
            ? await VerifyLegacyTaxonomyAsync(source, transaction, catalog, tables, audit, token)
            : null;

        string? sourceAdminIdentitySha256 = null;
        ShadowReport? shadow = null;
        LegacyImportAdmission? importAdmission = mode == "plan" && provider == "postgres"
            ? new(false, false, [], []) : null;
        if (mode != "inventory" && audit is not null && blockers.Count == 0)
        {
            if (FindLegacyImportPrincipal(source, catalog) is { } table)
            {
                if (ownerMap is not null)
                {
                    shadow = await RehearseLegacyAsync(source, transaction, tables, table, audit, ownerMap, token);
                    sourceAdminIdentitySha256 = shadow.SourceAdminIdentitySha256;
                }
                else
                {
                    sourceAdminIdentitySha256 = await FingerprintLegacyPrincipalsAsync(source, transaction, table, owners: null, token);
                }
                if (importAdmission is not null && taxonomy is not null)
                {
                    var evidence = await ReadLegacyImportEvidenceAsync(source, transaction, catalog, tables, table, taxonomy, token);
                    importAdmission = new(true, evidence.Findings.Length == 0, evidence.SourceProjections(audit), evidence.Findings);
                }
            }
            else
            {
                blockers.Add("admin_principal.id and handle must be readable from one supported v1 base table");
            }
        }
        if (taxonomy is not null)
            blockers.AddRange(taxonomy.Findings.Select(finding => $"{finding.Category}: {finding.Source} ({finding.Rows})"));
        bool rehearsed = shadow is not null && blockers.Count == 0;
        if (mode is "plan" or "rehearse")
        {
            blockers.Add("v2 activation requires an approved complete principal, role and article ownership mapping");
            blockers.Add("rights signatures, canonical digest recomputation, transparency history, publication schedule and source registration/authority remain unverified");
            blockers.Add("preserve credentials, media, properties, Canvas, drafts, pending work and other durable v1 domains");
            blockers.Add("the full v1-to-v2 converter and independent restore acceptance are unavailable");
        }

        await transaction.RollbackAsync(token);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            sourceReference = LegacyReference,
            provider,
            source.Schema,
            serverVersion = connection.ServerVersion,
            mode,
            readyToApply = false,
            catalog,
            audit,
            propertyInventory = properties,
            taxonomyProjection = taxonomy,
            sourceAdminIdentitySha256,
            rehearsal = shadow,
            blockers,
            importAdmission
        }, Json));
        if (mode == "rehearse" && rehearsed) return 0;
        return blockers.Count == 0 ? 0 : 2;
    }

    private static (Dictionary<string, LegacyTable> Tables, List<string> Blockers) SelectLegacyTables(
        LegacySource source, LegacyTable[] catalog)
    {
        var blockers = new List<string>();
        if (catalog.Any(table => table.Name.Equals("v2_schema", StringComparison.OrdinalIgnoreCase)))
            blockers.Add("expected v1 source, found a v2 schema marker");
        var tables = new Dictionary<string, LegacyTable>(StringComparer.Ordinal);
        foreach (var (name, columns) in LegacyColumns)
        {
            var matches = catalog.Where(table => table.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (matches is not [var table])
            {
                blockers.Add($"{name}: required v1 table missing or ambiguous");
                continue;
            }
            if (!source.IsSnapshotTable(table.Kind))
            {
                blockers.Add($"{name}: relation is not a supported transactional base table");
                continue;
            }
            foreach (var column in columns)
            {
                if (table.Columns.Count(field => field.Name.Equals(column, StringComparison.OrdinalIgnoreCase)) != 1)
                    blockers.Add($"{name}.{column}: required v1 column missing or ambiguous");
            }
            tables.Add(name, table);
        }
        return (tables, blockers);
    }

    private static LegacySource ParseLegacySource(string provider)
    {
        if (provider == "sqlite")
        {
            var path = Path.GetFullPath(RequireLegacyValue(LegacySqliteVariable));
            if (!File.Exists(path) || File.Exists(path + "-wal") || File.Exists(path + "-journal"))
                throw new ArgumentException($"Provide a frozen standalone database copy in {LegacySqliteVariable}.");
            var settings = new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadOnly,
                Cache = SqliteCacheMode.Private,
                Pooling = false,
                DefaultTimeout = LegacyCommandTimeout
            };
            return new LegacySource(provider, "main", new SqliteConnection(settings.ConnectionString));
        }

        if (provider is not ("postgres" or "mysql"))
            throw new ArgumentException("Use legacy provider postgres, mysql, or sqlite.");

        var dsn = RequireLegacyValue(LegacyDatabaseVariable);
        if (provider == "postgres")
        {
            var settings = new NpgsqlConnectionStringBuilder(dsn) { Pooling = false, Enlist = false };
            if (string.IsNullOrWhiteSpace(settings.Database))
                throw new ArgumentException($"Set the source database name in {LegacyDatabaseVariable}.");
            string schema = Environment.GetEnvironmentVariable(LegacySchemaVariable) ?? "public";
            return new LegacySource(provider, schema, new NpgsqlConnection(settings.ConnectionString));
        }

        var mysql = new MySqlConnectionStringBuilder(dsn)
        {
            Pooling = false,
            AllowLoadLocalInfile = false,
            ConvertZeroDateTime = false
        };
        if (string.IsNullOrWhiteSpace(mysql.Database))
            throw new ArgumentException($"Set the source database name in {LegacyDatabaseVariable}.");
        return new LegacySource(provider, mysql.Database, new MySqlConnection(mysql.ConnectionString));
    }

    private static string RequireLegacyValue(string name) =>
        Environment.GetEnvironmentVariable(name) is { Length: > 0 } value && !string.IsNullOrWhiteSpace(value)
            ? value : throw new ArgumentException($"Set {name} to the isolated v1 source.");

    private static async Task<DbTransaction> BeginLegacyReadAsync(DbConnection connection, CancellationToken token)
    {
        if (connection is NpgsqlConnection postgres)
        {
            return await BeginReadOnlyAsync(postgres, token);
        }

        if (connection is MySqlConnection mysql)
        {
            return await mysql.BeginTransactionAsync(IsolationLevel.RepeatableRead, isReadOnly: true, token);
        }

        var sqlite = (SqliteConnection)connection;
        await using var protect = sqlite.CreateCommand();
        protect.CommandText = "PRAGMA query_only = ON; PRAGMA trusted_schema = OFF";
        await protect.ExecuteNonQueryAsync(token);
        return sqlite.BeginTransaction(IsolationLevel.Serializable, deferred: true);
    }

    private static async Task<LegacyTable[]> ReadLegacyCatalogAsync(LegacySource source, DbTransaction transaction,
        CancellationToken token)
    {
        var sql = source.Provider switch
        {
            "postgres" => """
                SELECT c.relname::text,
                    CASE WHEN c.relrowsecurity THEN 'row-security' ELSE c.relkind::text END,
                    a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod)
                FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
                WHERE n.nspname = @schema AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY c.relname, a.attnum
                """,
            "mysql" => """
                SELECT t.TABLE_NAME, COALESCE(t.ENGINE, t.TABLE_TYPE), c.COLUMN_NAME, c.COLUMN_TYPE
                FROM INFORMATION_SCHEMA.TABLES t JOIN INFORMATION_SCHEMA.COLUMNS c
                  ON BINARY c.TABLE_SCHEMA = BINARY t.TABLE_SCHEMA AND BINARY c.TABLE_NAME = BINARY t.TABLE_NAME
                WHERE BINARY t.TABLE_SCHEMA = BINARY @schema ORDER BY BINARY t.TABLE_NAME, c.ORDINAL_POSITION
                """,
            _ => """
                SELECT t.name, t.type, c.name, COALESCE(c.type, '')
                FROM pragma_table_list t JOIN pragma_table_xinfo(t.name, 'main') c
                WHERE t.schema = 'main' AND substr(t.name, 1, 7) <> 'sqlite_' ORDER BY t.name, c.cid
                """
        };
        await using var command = CreateLegacyCommand(transaction, sql);
        if (source.Provider != "sqlite")
        {
            var parameter = command.CreateParameter();
            parameter.ParameterName = "schema";
            parameter.Value = source.Schema;
            command.Parameters.Add(parameter);
        }

        var tables = new Dictionary<string, LegacyTable>(StringComparer.Ordinal);
        var columns = 0;
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token))
        {
            if (++columns > 20_000)
                throw new InvalidOperationException("Legacy source catalog exceeds the intake column limit.");
            var name = reader.GetString(0);
            if (!tables.TryGetValue(name, out var table))
            {
                table = new LegacyTable(name, reader.GetString(1), []);
                tables.Add(name, table);
            }
            table.Columns.Add(new LegacyField(reader.GetString(2), reader.GetString(3)));
        }

        return tables.Values.OrderBy(table => table.Name, StringComparer.Ordinal).ToArray();
    }

    private static DbCommand CreateLegacyCommand(DbTransaction transaction, string sql)
    {
        var command = transaction.Connection!.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.CommandTimeout = LegacyCommandTimeout;
        return command;
    }

    private sealed record LegacyField(string Name, string Type);
    private sealed record LegacyTable(string Name, string Kind, List<LegacyField> Columns);

    private sealed record LegacySource(string Provider, string Schema, DbConnection Connection)
    {
        internal bool IsSnapshotTable(string kind) => Provider switch
        {
            "postgres" => kind is "r" or "p",
            "mysql" => kind.Equals("InnoDB", StringComparison.OrdinalIgnoreCase),
            _ => kind == "table"
        };

        internal string Quote(string name)
        {
            string quote = Provider == "mysql" ? "`" : "\"";
            return quote + name.Replace(quote, quote + quote, StringComparison.Ordinal) + quote;
        }

        internal string Table(LegacyTable table) => $"{Quote(Schema)}.{Quote(table.Name)}";

        internal string Field(LegacyTable table, string column) =>
            Quote(table.Columns.Single(field => field.Name.Equals(column, StringComparison.OrdinalIgnoreCase)).Name);

        internal string Utf8Length(string text) => Provider switch
        {
            "postgres" => $"octet_length(convert_to({text}, 'UTF8'))",
            "mysql" => $"octet_length(convert({text} using utf8mb4))",
            _ => $"length(cast({text} as blob))"
        };

        internal string InvalidStorage(string column, bool text, bool timestamp, bool boolean) => Provider switch
        {
            "sqlite" => $"typeof({column}) NOT IN ('null', '{(text || timestamp ? "text" : "integer")}')" +
                (boolean ? $" OR {column} NOT IN (0, 1)" : ""),
            _ => "false"
        };
    }
}
