using System.Text.RegularExpressions;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public enum SchemaDdlDialect
{
    PostgreSql,
    MySql,
    Sqlite
}

public readonly record struct SchemaIdentifier
{
    private static readonly Regex s_validIdentifier = new(
        "^[A-Za-z_][A-Za-z0-9_]{0,62}$",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private SchemaIdentifier(string value) => Value = value;

    public string Value
    {
        get;
    }

    public static SchemaIdentifier Parse(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value) || !s_validIdentifier.IsMatch(value))
        {
            throw new ArgumentException(
                "Schema identifiers must start with a letter or underscore and contain only ASCII letters, digits, or underscores.",
                parameterName);
        }

        return new SchemaIdentifier(value);
    }

    public override string ToString() => Value;
}

public sealed record SchemaColumnDefinition
{
    private static readonly Regex s_supportedDefinition = new(
        "^(?:smallint|integer|bigint|boolean|bytea|text|timestamp(?:\\s+(?:without|with)\\s+time\\s+zone)?|varchar\\([1-9][0-9]{0,4}\\))(?:\\s+(?:NULL|NOT NULL))?(?:\\s+DEFAULT\\s+(?:-?[0-9]+|true|false|now\\(\\)|'(?:[^']|'')*'))?$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private SchemaColumnDefinition(string value) => Value = value;

    public string Value
    {
        get;
    }

    public static SchemaColumnDefinition Parse(string value, string parameterName)
    {
        string normalized = NormalizeLegacyLiteralEscapes(value?.Trim() ?? string.Empty);
        if (!s_supportedDefinition.IsMatch(normalized))
        {
            throw new ArgumentException(
                "Unsupported schema column definition. Use a supported type, nullability, and scalar default instead of raw DDL.",
                parameterName);
        }

        return new SchemaColumnDefinition(normalized);
    }

    internal string ForDialect(SchemaDdlDialect dialect)
        => dialect switch
        {
            SchemaDdlDialect.PostgreSql => Value,
            SchemaDdlDialect.MySql => Regex.Replace(Value, "\\bnow\\(\\)", "CURRENT_TIMESTAMP", RegexOptions.IgnoreCase),
            SchemaDdlDialect.Sqlite => ToSqliteDefinition(Value),
            _ => throw new ArgumentOutOfRangeException(nameof(dialect), dialect, null)
        };

    private static string NormalizeLegacyLiteralEscapes(string value)
        => Regex.Replace(value, "''([^']+)''", "'$1'", RegexOptions.CultureInvariant);

    private static string ToSqliteDefinition(string value)
    {
        string translated = Regex.Replace(value, "^varchar\\([1-9][0-9]{0,4}\\)", "TEXT", RegexOptions.IgnoreCase);
        translated = Regex.Replace(translated, "^(?:smallint|integer|bigint)", "INTEGER", RegexOptions.IgnoreCase);
        translated = Regex.Replace(translated, "^boolean", "INTEGER", RegexOptions.IgnoreCase);
        translated = Regex.Replace(translated, "^bytea", "BLOB", RegexOptions.IgnoreCase);
        translated = Regex.Replace(
            translated,
            "^timestamp(?:\\s+(?:without|with)\\s+time\\s+zone)?",
            "TEXT",
            RegexOptions.IgnoreCase);
        translated = Regex.Replace(translated, "\\bDEFAULT\\s+true\\b", "DEFAULT 1", RegexOptions.IgnoreCase);
        translated = Regex.Replace(translated, "\\bDEFAULT\\s+false\\b", "DEFAULT 0", RegexOptions.IgnoreCase);
        return Regex.Replace(translated, "\\bnow\\(\\)", "CURRENT_TIMESTAMP", RegexOptions.IgnoreCase);
    }
}

public sealed record SchemaMigrationCommand(string Sql, bool IsDdl);

public interface ISchemaDdlProvider
{
    SchemaDdlDialect Dialect
    {
        get;
    }

    string EnsureTable(SchemaIdentifier table, string createTableTemplate);
    string EnsureColumn(SchemaIdentifier table, SchemaIdentifier column, SchemaColumnDefinition definition);
    string RenameTable(SchemaIdentifier oldTable, SchemaIdentifier newTable);
    string RenameColumn(SchemaIdentifier table, SchemaIdentifier oldColumn, SchemaIdentifier newColumn);
    string DropColumn(SchemaIdentifier table, SchemaIdentifier column);
    string DropTable(SchemaIdentifier table);
    string DropIndex(SchemaIdentifier index);
    string CreateIndex(SchemaIdentifier index, string createIndexTemplate);
}

public static class SchemaDdlProviders
{
    public static ISchemaDdlProvider For(SchemaDdlDialect dialect)
        => dialect switch
        {
            SchemaDdlDialect.PostgreSql => PostgresSchemaDdlProvider.Instance,
            SchemaDdlDialect.MySql => MySqlSchemaDdlProvider.Instance,
            SchemaDdlDialect.Sqlite => SqliteSchemaDdlProvider.Instance,
            _ => throw new ArgumentOutOfRangeException(nameof(dialect), dialect, null)
        };

    internal static ISchemaDdlProvider For(ISqlSugarClient db)
    {
        string provider = db.CurrentConnectionConfig?.DbType.ToString() ?? "PostgreSQL";
        return provider switch
        {
            "MySql" => For(SchemaDdlDialect.MySql),
            "Sqlite" => For(SchemaDdlDialect.Sqlite),
            "PostgreSQL" => For(SchemaDdlDialect.PostgreSql),
            _ => throw new NotSupportedException($"Schema migration DDL provider '{provider}' is not supported.")
        };
    }
}

public abstract class SchemaDdlProviderBase(SchemaDdlDialect dialect, char quote) : ISchemaDdlProvider
{
    public SchemaDdlDialect Dialect { get; } = dialect;

    protected string Quote(SchemaIdentifier identifier)
    {
        string delimiter = quote.ToString();
        return $"{delimiter}{identifier.Value.Replace(delimiter, delimiter + delimiter, StringComparison.Ordinal)}{delimiter}";
    }

    public virtual string EnsureTable(SchemaIdentifier table, string createTableTemplate)
        => ValidateEnsureTableTemplate(createTableTemplate, table);

    public abstract string EnsureColumn(SchemaIdentifier table, SchemaIdentifier column, SchemaColumnDefinition definition);
    public abstract string RenameTable(SchemaIdentifier oldTable, SchemaIdentifier newTable);
    public abstract string RenameColumn(SchemaIdentifier table, SchemaIdentifier oldColumn, SchemaIdentifier newColumn);
    public abstract string DropColumn(SchemaIdentifier table, SchemaIdentifier column);
    public virtual string DropTable(SchemaIdentifier table) => $"DROP TABLE IF EXISTS {Quote(table)};";
    public virtual string DropIndex(SchemaIdentifier index) => $"DROP INDEX IF EXISTS {Quote(index)};";

    public virtual string CreateIndex(SchemaIdentifier index, string createIndexTemplate)
        => ValidateCreateIndexTemplate(createIndexTemplate, index);

    private static string ValidateEnsureTableTemplate(string sql, SchemaIdentifier table)
    {
        string normalized = sql?.Trim() ?? string.Empty;
        if (normalized.Contains("--", StringComparison.Ordinal)
            || normalized.Contains("/*", StringComparison.Ordinal))
        {
            throw InvalidTemplate(
                table,
                "CREATE TABLE followed only by CREATE TABLE, CREATE [UNIQUE] INDEX, or same-table bootstrap INSERT statements without comments");
        }

        string[] statements = normalized
            .Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (statements.Length == 0
            || !IsTypedCreateTable(statements[0], table.Value)
            || statements.Skip(1).Any(statement => !IsAllowedPostCreateStatement(statement, table)))
        {
            throw InvalidTemplate(
                table,
                "CREATE TABLE followed only by CREATE TABLE, CREATE [UNIQUE] INDEX, or same-table bootstrap INSERT statements");
        }

        return normalized.EndsWith(';') ? normalized : normalized + ";";
    }

    private static bool IsAllowedPostCreateStatement(string statement, SchemaIdentifier table)
        => IsTypedCreateTable(statement)
            || statement.StartsWith("CREATE INDEX", StringComparison.OrdinalIgnoreCase)
            || statement.StartsWith("CREATE UNIQUE INDEX", StringComparison.OrdinalIgnoreCase)
            || Regex.IsMatch(
                statement,
                $"^INSERT\\s+INTO\\s+[\"`]?{Regex.Escape(table.Value)}[\"`]?\\s*\\(",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    private static bool IsTypedCreateTable(string statement, string? expectedTable = null)
    {
        Match match = Regex.Match(
            statement,
            "^CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(?<table>[A-Za-z_][A-Za-z0-9_]{0,62})\\s*\\(",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
        return match.Success
            && (expectedTable is null
                || string.Equals(match.Groups["table"].Value, expectedTable, StringComparison.OrdinalIgnoreCase));
    }

    protected static string ValidateCreateIndexTemplate(string sql, SchemaIdentifier index)
    {
        string normalized = ValidateTemplate(
            sql,
            ["CREATE INDEX", "CREATE UNIQUE INDEX"],
            "CREATE [UNIQUE] INDEX",
            index);
        Match match = Regex.Match(
            normalized,
            "^CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+(?<index>[A-Za-z_][A-Za-z0-9_]{0,62})\\b",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
        if (!match.Success
            || !string.Equals(match.Groups["index"].Value, index.Value, StringComparison.OrdinalIgnoreCase))
        {
            throw InvalidTemplate(index, $"a CREATE [UNIQUE] INDEX statement for index '{index.Value}'");
        }

        return normalized;
    }

    protected static string ValidateTemplate(
        string sql,
        IReadOnlyList<string> expectedPrefixes,
        string expectedKind,
        SchemaIdentifier subject)
    {
        string normalized = sql?.Trim() ?? string.Empty;
        if (!expectedPrefixes.Any(prefix => normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            || normalized.Contains("--", StringComparison.Ordinal)
            || normalized.Contains("/*", StringComparison.Ordinal)
            || normalized.TrimEnd(';').Contains(';', StringComparison.Ordinal))
        {
            throw InvalidTemplate(subject, $"exactly one {expectedKind} statement without comments");
        }

        return normalized.EndsWith(';') ? normalized : normalized + ";";
    }

    private static ArgumentException InvalidTemplate(SchemaIdentifier subject, string requirement)
        => new(
            $"DDL template for '{subject.Value}' must contain {requirement}.",
            "sql");
}

public sealed class PostgresSchemaDdlProvider : SchemaDdlProviderBase
{
    public static PostgresSchemaDdlProvider Instance { get; } = new();
    private PostgresSchemaDdlProvider() : base(SchemaDdlDialect.PostgreSql, '"')
    {
    }

    public override string EnsureColumn(SchemaIdentifier table, SchemaIdentifier column, SchemaColumnDefinition definition)
    {
        string alter = SchemaMigrationSql.EscapeLiteral(
            $"ALTER TABLE {Quote(table)} ADD COLUMN IF NOT EXISTS {Quote(column)} {definition.ForDialect(Dialect)}");
        return $"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name = '{SchemaMigrationSql.EscapeLiteral(table.Value)}'
                ) THEN
                    EXECUTE '{alter}';
                END IF;
            END $$;
            """;
    }

    public override string RenameTable(SchemaIdentifier oldTable, SchemaIdentifier newTable)
        => $"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = '{SchemaMigrationSql.EscapeLiteral(oldTable.Value)}'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = '{SchemaMigrationSql.EscapeLiteral(newTable.Value)}'
                ) THEN
                    EXECUTE 'ALTER TABLE {Quote(oldTable)} RENAME TO {Quote(newTable)}';
                END IF;
            END $$;
            """;

    public override string RenameColumn(SchemaIdentifier table, SchemaIdentifier oldColumn, SchemaIdentifier newColumn)
        => $"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = '{SchemaMigrationSql.EscapeLiteral(table.Value)}'
                      AND column_name = '{SchemaMigrationSql.EscapeLiteral(oldColumn.Value)}'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = '{SchemaMigrationSql.EscapeLiteral(table.Value)}'
                      AND column_name = '{SchemaMigrationSql.EscapeLiteral(newColumn.Value)}'
                ) THEN
                    EXECUTE 'ALTER TABLE {Quote(table)} RENAME COLUMN {Quote(oldColumn)} TO {Quote(newColumn)}';
                END IF;
            END $$;
            """;

    public override string DropColumn(SchemaIdentifier table, SchemaIdentifier column)
        => $"ALTER TABLE IF EXISTS {Quote(table)} DROP COLUMN IF EXISTS {Quote(column)};";

    public override string CreateIndex(SchemaIdentifier index, string createIndexTemplate)
    {
        string template = ValidateCreateIndexTemplate(createIndexTemplate, index);
        return $"""
            DO $$
            BEGIN
                EXECUTE '{SchemaMigrationSql.EscapeLiteral(template)}';
            EXCEPTION
                WHEN undefined_table OR undefined_column THEN
                    NULL;
            END $$;
            """;
    }
}

public sealed class MySqlSchemaDdlProvider : SchemaDdlProviderBase
{
    public static MySqlSchemaDdlProvider Instance { get; } = new();
    private MySqlSchemaDdlProvider() : base(SchemaDdlDialect.MySql, '`')
    {
    }

    public override string EnsureColumn(SchemaIdentifier table, SchemaIdentifier column, SchemaColumnDefinition definition)
        => $"ALTER TABLE {Quote(table)} ADD COLUMN IF NOT EXISTS {Quote(column)} {definition.ForDialect(Dialect)};";
    public override string RenameTable(SchemaIdentifier oldTable, SchemaIdentifier newTable)
        => $"RENAME TABLE {Quote(oldTable)} TO {Quote(newTable)};";
    public override string RenameColumn(SchemaIdentifier table, SchemaIdentifier oldColumn, SchemaIdentifier newColumn)
        => $"ALTER TABLE {Quote(table)} RENAME COLUMN {Quote(oldColumn)} TO {Quote(newColumn)};";
    public override string DropColumn(SchemaIdentifier table, SchemaIdentifier column)
        => $"ALTER TABLE {Quote(table)} DROP COLUMN {Quote(column)};";
    public override string DropIndex(SchemaIdentifier index) => $"DROP INDEX {Quote(index)};";
}

public sealed class SqliteSchemaDdlProvider : SchemaDdlProviderBase
{
    public static SqliteSchemaDdlProvider Instance { get; } = new();
    private SqliteSchemaDdlProvider() : base(SchemaDdlDialect.Sqlite, '"')
    {
    }

    public override string EnsureColumn(SchemaIdentifier table, SchemaIdentifier column, SchemaColumnDefinition definition)
        => $"ALTER TABLE {Quote(table)} ADD COLUMN {Quote(column)} {definition.ForDialect(Dialect)};";
    public override string RenameTable(SchemaIdentifier oldTable, SchemaIdentifier newTable)
        => $"ALTER TABLE {Quote(oldTable)} RENAME TO {Quote(newTable)};";
    public override string RenameColumn(SchemaIdentifier table, SchemaIdentifier oldColumn, SchemaIdentifier newColumn)
        => $"ALTER TABLE {Quote(table)} RENAME COLUMN {Quote(oldColumn)} TO {Quote(newColumn)};";
    public override string DropColumn(SchemaIdentifier table, SchemaIdentifier column)
        => $"ALTER TABLE {Quote(table)} DROP COLUMN {Quote(column)};";
}

public sealed record SchemaMigrationPreviewStep(string Kind, string? Sql, bool IsDdl);

public sealed record SchemaMigrationPreviewResult(
    string MigrationId,
    SchemaDdlDialect Dialect,
    bool Transactional,
    IReadOnlyList<SchemaMigrationPreviewStep> Steps,
    string Script);

public static class SchemaMigrationPreviewer
{
    public static Task<SchemaMigrationPreviewResult> PreviewAsync(
        ISchemaMigrationDescriptor descriptor,
        SchemaDdlDialect dialect,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ISchemaDdlProvider provider = SchemaDdlProviders.For(dialect);
        SchemaMigrationPreviewStep[] steps = descriptor.Steps
            .Select(step =>
            {
                SchemaMigrationCommand? command = step.BuildCommand(provider);
                return new SchemaMigrationPreviewStep(step.Kind, command?.Sql, command?.IsDdl ?? false);
            })
            .ToArray();

        IEnumerable<string> statements = steps
            .Where(static step => !string.IsNullOrWhiteSpace(step.Sql))
            .Select(static step => step.Sql!);
        string body = string.Join(Environment.NewLine, statements);
        string script = descriptor.Transactional && body.Length > 0
            ? $"BEGIN;{Environment.NewLine}{body}{Environment.NewLine}COMMIT;"
            : body;

        return Task.FromResult(new SchemaMigrationPreviewResult(
            descriptor.MigrationId,
            dialect,
            descriptor.Transactional,
            steps,
            script));
    }
}
