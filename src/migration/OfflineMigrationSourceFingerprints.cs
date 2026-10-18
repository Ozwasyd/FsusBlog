using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

/// <summary>
/// Migration-owned source definitions, independent of the current target model. The old
/// profile records the complete checked-in 20260517 representative schema, not arbitrary
/// dumps bearing that date. Actual cross-provider qualification remains a separate gate.
/// </summary>
internal static class OfflineMigrationSourceFingerprints
{
    internal const string ExtractorId = "migration-native-source-observation";
    internal const string ExtractorVersion = "1";
    internal const string EmptyId = "empty-database";
    internal const string LegacyId = "legacy-20260517-representative-profile";

    // These are historical input fields, not a copy or projection of current entities.
    // Provenance: legacy-20260517-minimal.sql and BuildLegacy20260517ProfileCompatibilityMigration.
    internal static ImmutableArray<LegacyTable> LegacyTables
    {
        get;
    } =
    [
        Table("article", "id", "id:int:!:identity", "title:varchar(200):!", "content:text:?",
            "summary:varchar(500):?", "categoryid:int:!", "views:int:!", "createtime:timestamp:!", "isdeleted:bool:!:false"),
        Table("article_tag", "articleid,tagid", "articleid:int:!", "tagid:int:!"),
        Table("category", "id", "id:int:!:identity", "name:varchar(255):!"),
        Table("comment", "id", "id:bigint:!", "article_id:int:!", "content:text:!", "create_time:timestamp:!",
            "user_id:int:!", "moderated_by_user_id:int:?"),
        Table("sys_message", "id", "id:bigint:!", "title:varchar(255):!", "content:text:!", "category:int:!",
            "sourceid:bigint:?", "createtime:timestamp:!"),
        Table("sys_systemconfig", "key", "key:varchar(255):!", "value:text:!"),
        Table("sys_user", "id", "id:int:!:identity", "username:varchar(50):!", "password:varchar(100):!",
            "role:varchar(20):!", "lastusernameupdatetime:timestamp:?", "refreshtoken:varchar(200):?",
            "refreshtokenexpirytime:timestamp:?", "status:int:!:0", "banreason:varchar(500):?",
            "createtime:timestamp:?", "lastloginip:varchar(50):?", "lastlogintime:timestamp:?"),
        Table("sys_user_message", "userid,messageid", "userid:bigint:!", "messageid:bigint:!", "isread:bool:!", "readtime:timestamp:?"),
        Table("sys_visit_log", "id", "id:int:!:identity", "ip:varchar(255):!", "userid:int:?",
            "region:varchar(255):!", "createtime:timestamp:!"),
        Table("tag", "id", "id:int:!:identity", "name:varchar(255):!")
    ];

    internal static OfflineMigrationSourceRegistry CreateRegistry()
        => new("1",
        [
            Definition(EmptyId, "bootstrap-current-schema", false),
            Definition(LegacyId, "legacy-20260517-to-current", true)
        ]);

    internal static OfflineMigrationSourceShape Shape(CurrentSchemaProviderKind provider, bool legacy)
        => new(provider, ExtractorId, ExtractorVersion, Schema(provider, legacy),
            [new("history.state", "absent")], Business(legacy, 0, 0, 0, 0));

    internal static ImmutableArray<OfflineMigrationFact> Schema(CurrentSchemaProviderKind provider, bool legacy)
    {
        if (!Enum.IsDefined(provider))
        {
            throw new InvalidOperationException("offline_source_provider_unknown");
        }
        var facts = ImmutableArray.CreateBuilder<OfflineMigrationFact>();
        facts.Add(new("objects.unsupported", "0"));
        if (legacy)
        {
            foreach (LegacyTable table in LegacyTables)
            {
                facts.Add(new($"table/{table.Name}", "base"));
                for (int index = 0; index < table.Columns.Length; index++)
                {
                    LegacyColumn column = table.Columns[index];
                    int keyPosition = table.PrimaryKey.IndexOf(column.Name) + 1;
                    facts.Add(ColumnFact(table.Name, column.Name, index + 1, PhysicalType(provider, column.Type),
                        column.Nullable, PhysicalDefault(provider, column.Default),
                        column.Identity ? Identity(provider) : "none", keyPosition));
                    if (provider == CurrentSchemaProviderKind.MySql
                        && (column.Type == "text" || column.Type.StartsWith("varchar", StringComparison.Ordinal)))
                    {
                        facts.Add(MySqlTextFact(table.Name, column.Name, "utf8mb4", "utf8mb4_bin"));
                    }
                    if (provider == CurrentSchemaProviderKind.PostgreSql && column.Identity)
                    {
                        facts.Add(SequenceFact(table.Name, column.Name, $"{table.Name}_{column.Name}_seq",
                            "integer", "1", "1", "1", "2147483647", "1", "false"));
                    }
                }
                if (provider == CurrentSchemaProviderKind.Sqlite)
                {
                    facts.Add(new($"ddl/{table.Name}", SqliteTableSql(table)));
                }
            }
        }
        return OfflineMigrationPlanValidation.NormalizeFacts(facts.ToImmutable());
    }

    internal static OfflineMigrationFact ColumnFact(string table, string column, int ordinal, string type,
        bool nullable, string defaultValue, string identity, int primaryKeyPosition)
        => new($"column/{table}/{column}", JsonSerializer.Serialize(new object[]
        {
            ordinal, type, nullable, defaultValue, identity, primaryKeyPosition
        }));

    internal static OfflineMigrationFact MySqlTextFact(string table, string column, string charset, string collation)
        => new($"text-encoding/{table}/{column}", JsonSerializer.Serialize(new[] { charset, collation }));

    // A dialect realization of the checked-in representative input, not a production dump.
    // The closed binary UTF-8 collation is explicit source shape, not a server-default guess.
    internal static string MySqlTableSql(LegacyTable table)
    {
        string[] columns = table.Columns.Select(column =>
        {
            string declaration = $"`{column.Name}` {PhysicalType(CurrentSchemaProviderKind.MySql, column.Type)}";
            if (column.Type == "text" || column.Type.StartsWith("varchar", StringComparison.Ordinal))
            {
                declaration += " CHARACTER SET utf8mb4 COLLATE utf8mb4_bin";
            }
            declaration += column.Nullable ? " NULL" : " NOT NULL";
            if (column.Identity)
            {
                declaration += " AUTO_INCREMENT";
            }
            if (column.Default != "none")
            {
                declaration += $" DEFAULT {PhysicalDefault(CurrentSchemaProviderKind.MySql, column.Default)}";
            }
            return declaration;
        }).ToArray();
        return $"CREATE TABLE `{table.Name}` ({string.Join(", ", columns)}, PRIMARY KEY ({string.Join(", ", table.PrimaryKey.Select(key => "`" + key + "`"))})) ENGINE=InnoDB";
    }

    internal static ImmutableArray<OfflineMigrationFact> Business(bool legacy,
        long categoryOverflow, long tagOverflow, long configKeyOverflow, long configValueOverflow)
        => legacy
            ? [new("business.profile", LegacyId),
                new("legacy.category.name.over128", Number(categoryOverflow)),
                new("legacy.tag.name.over128", Number(tagOverflow)),
                new("legacy.config.nonpage.key.over64", Number(configKeyOverflow)),
                new("legacy.config.nonpage.value.over512", Number(configValueOverflow))]
            : [new("business.profile", EmptyId)];

    internal static OfflineMigrationFact SequenceFact(string table, string column, string name, string type,
        string start, string increment, string minimum, string maximum, string cache, string cyclic)
        => new($"sequence/{table}/{column}", JsonSerializer.Serialize(new[]
        {
            "public", name, type, start, increment, minimum, maximum, cache, cyclic, "internal"
        }));

    internal static bool RequireKnownSchema(CurrentSchemaProviderKind provider, ImmutableArray<OfflineMigrationFact> actual)
    {
        foreach (bool legacy in new[] { false, true })
        {
            if (OfflineMigrationPlanValidation.Equal(Schema(provider, legacy), OfflineMigrationPlanValidation.NormalizeFacts(actual)))
            {
                return legacy;
            }
        }
        var observed = new OfflineMigrationSourceShape(provider, ExtractorId, ExtractorVersion, actual, [], []);
        throw OfflineMigrationSourceFingerprintException.Unknown(new[] { false, true }.Select(legacy =>
            (legacy ? LegacyId : EmptyId, Shape(provider, legacy) with
            {
                History = [],
                BusinessShape = []
            })), observed);
    }

    internal static string SqliteTableSql(LegacyTable table)
    {
        string[] columns = table.Columns.Select(column =>
        {
            string declaration = $"{column.Name} {PhysicalType(CurrentSchemaProviderKind.Sqlite, column.Type)}";
            declaration += column.Nullable ? string.Empty : " NOT NULL";
            if (column.Identity)
            {
                declaration += " PRIMARY KEY AUTOINCREMENT";
            }
            if (column.Default != "none")
            {
                declaration += $" DEFAULT {PhysicalDefault(CurrentSchemaProviderKind.Sqlite, column.Default)}";
            }
            return declaration;
        }).ToArray();
        string primaryKey = table.Columns.Any(column => column.Identity)
            ? string.Empty : $", PRIMARY KEY ({string.Join(", ", table.PrimaryKey)})";
        return $"CREATE TABLE {table.Name} ({string.Join(", ", columns)}{primaryKey})";
    }

    internal static string PhysicalType(CurrentSchemaProviderKind provider, string type)
        => provider switch
        {
            CurrentSchemaProviderKind.PostgreSql => type switch
            {
                "int" => "integer",
                "bool" => "boolean",
                _ when type.StartsWith("varchar(", StringComparison.Ordinal) => "character varying" + type[7..],
                _ => type
            },
            CurrentSchemaProviderKind.MySql => type switch
            {
                "bool" => "tinyint(1)",
                "timestamp" => "datetime",
                _ => type
            },
            CurrentSchemaProviderKind.Sqlite => type is "int" or "bigint" or "bool" ? "INTEGER" : "TEXT",
            _ => throw new InvalidOperationException("offline_source_provider_unknown")
        };

    internal static string PhysicalDefault(CurrentSchemaProviderKind provider, string value)
        => value == "false" && provider != CurrentSchemaProviderKind.PostgreSql ? "0" : value;

    internal static string Identity(CurrentSchemaProviderKind provider)
        => provider switch
        {
            CurrentSchemaProviderKind.PostgreSql => "by-default",
            CurrentSchemaProviderKind.MySql => "auto-increment",
            CurrentSchemaProviderKind.Sqlite => "rowid-autoincrement",
            _ => throw new InvalidOperationException("offline_source_provider_unknown")
        };

    private static OfflineMigrationFingerprintDefinition Definition(string id, string entryStepId, bool legacy)
        => new(id, "1", "FsusBlog.Migration.OfflineMigrationSourceFingerprints",
            ["OfflineMigrationSourceObserverTests.RegistryContainsOnlyExplicitEmptyAndHistoricalProfiles",
                "OfflineMigrationSourceObserverTests.OneColumnOrBusinessShapeDriftIsRefused"],
            entryStepId, Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => Shape(provider, legacy)).ToImmutableArray());

    private static LegacyTable Table(string name, string primaryKey, params string[] columns)
        => new(name, primaryKey.Split(',').ToImmutableArray(), columns.Select(value =>
        {
            string[] parts = value.Split(':');
            return new LegacyColumn(parts[0], parts[1], parts[2] == "?", parts.Length == 4 && parts[3] == "identity",
                parts.Length == 4 && parts[3] != "identity" ? parts[3] : "none");
        }).ToImmutableArray());

    private static string Number(long value) => value.ToString(CultureInfo.InvariantCulture);

    internal sealed record LegacyTable(string Name, ImmutableArray<string> PrimaryKey, ImmutableArray<LegacyColumn> Columns);
    internal sealed record LegacyColumn(string Name, string Type, bool Nullable, bool Identity, string Default);
}
