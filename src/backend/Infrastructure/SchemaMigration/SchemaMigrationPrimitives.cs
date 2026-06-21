using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public enum SchemaMigrationPhase
{
    PreCodeFirst = 0,
    PostCodeFirst = 1
}

public interface ISchemaMigrationDescriptor
{
    string MigrationId { get; }
    string Description { get; }
    SchemaMigrationPhase Phase { get; }
    bool Transactional { get; }
    IReadOnlyList<SchemaMigrationStep> Steps { get; }
    string Checksum { get; }
}

public sealed record SchemaMigrationDescriptor(
    string MigrationId,
    string Description,
    SchemaMigrationPhase Phase,
    bool Transactional,
    IReadOnlyList<SchemaMigrationStep> Steps) : ISchemaMigrationDescriptor
{
    public string Checksum { get; } = ComputeChecksum(MigrationId, Description, Phase, Transactional, Steps);

    private static string ComputeChecksum(
        string migrationId,
        string description,
        SchemaMigrationPhase phase,
        bool transactional,
        IReadOnlyList<SchemaMigrationStep> steps)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        WriteString(writer, migrationId);
        WriteString(writer, description);
        writer.Write((int)phase);
        writer.Write(transactional);
        writer.Write(steps.Count);
        foreach (SchemaMigrationStep step in steps)
        {
            WriteString(writer, step.Kind);
            WriteString(writer, step.Fingerprint);
        }

        writer.Flush();
        byte[] hash = SHA256.HashData(stream.ToArray());
        return Convert.ToHexString(hash);
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        writer.Write(bytes.Length);
        writer.Write(bytes);
    }
}

public abstract record SchemaMigrationStep
{
    internal abstract string Kind { get; }
    internal abstract string Fingerprint { get; }
    internal abstract Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken);
}

public sealed record EnsureTableStep(string TableName, string CreateSql) : SchemaMigrationStep
{
    internal override string Kind => "EnsureTable";
    internal override string Fingerprint => $"{TableName}\n{CreateSql}";
    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(CreateSql);
}

public sealed record EnsureColumnStep(string TableName, string ColumnName, string ColumnDefinition) : SchemaMigrationStep
{
    internal override string Kind => "EnsureColumn";
    internal override string Fingerprint => $"{TableName}.{ColumnName}:{ColumnDefinition}";

    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        string normalizedColumnDefinition = NormalizeLegacyDynamicSqlLiteralEscapes(ColumnDefinition);
        string alterColumnSql = SchemaMigrationSql.EscapeLiteral(
            $"ALTER TABLE {SchemaMigrationSql.QuoteIdentifier(TableName)} ADD COLUMN IF NOT EXISTS {SchemaMigrationSql.QuoteIdentifier(ColumnName)} {normalizedColumnDefinition}");

        return db.Ado.ExecuteCommandAsync($"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name = '{SchemaMigrationSql.EscapeLiteral(TableName)}'
                ) THEN
                    EXECUTE '{alterColumnSql}';
                END IF;
            END $$;
            """);
    }

    private static string NormalizeLegacyDynamicSqlLiteralEscapes(string columnDefinition)
        // Older descriptors pre-escaped default string literals for the EXECUTE wrapper.
        => Regex.Replace(columnDefinition, "''([^']+)''", "'$1'");
}

public sealed record RenameTableStep(string OldTableName, string NewTableName) : SchemaMigrationStep
{
    internal override string Kind => "RenameTable";
    internal override string Fingerprint => $"{OldTableName}->{NewTableName}";

    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync($"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = '{SchemaMigrationSql.EscapeLiteral(OldTableName)}'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = '{SchemaMigrationSql.EscapeLiteral(NewTableName)}'
                ) THEN
                    EXECUTE 'ALTER TABLE {SchemaMigrationSql.QuoteIdentifier(OldTableName)} RENAME TO {SchemaMigrationSql.QuoteIdentifier(NewTableName)}';
                END IF;
            END $$;
            """);
}

public sealed record RenameColumnStep(string TableName, string OldColumnName, string NewColumnName) : SchemaMigrationStep
{
    internal override string Kind => "RenameColumn";
    internal override string Fingerprint => $"{TableName}.{OldColumnName}->{NewColumnName}";

    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync($"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = '{SchemaMigrationSql.EscapeLiteral(TableName)}'
                      AND column_name = '{SchemaMigrationSql.EscapeLiteral(OldColumnName)}'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = '{SchemaMigrationSql.EscapeLiteral(TableName)}'
                      AND column_name = '{SchemaMigrationSql.EscapeLiteral(NewColumnName)}'
                ) THEN
                    EXECUTE 'ALTER TABLE {SchemaMigrationSql.QuoteIdentifier(TableName)} RENAME COLUMN {SchemaMigrationSql.QuoteIdentifier(OldColumnName)} TO {SchemaMigrationSql.QuoteIdentifier(NewColumnName)}';
                END IF;
            END $$;
            """);
}

public sealed record BackfillSqlStep(string Sql) : SchemaMigrationStep
{
    internal override string Kind => "BackfillSql";
    internal override string Fingerprint => Sql;
    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(Sql);
}

public sealed record CopyColumnToColumnStep(
    string TableName,
    string SourceColumnName,
    string TargetColumnName,
    string? TargetSqlExpression = null,
    string? PredicateSql = null) : SchemaMigrationStep
{
    internal override string Kind => "CopyColumnToColumn";
    internal override string Fingerprint => $"{TableName}:{SourceColumnName}->{TargetColumnName}|{TargetSqlExpression}|{PredicateSql}";

    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        string targetExpression = TargetSqlExpression ?? SchemaMigrationSql.QuoteIdentifier(SourceColumnName);
        string predicate = string.IsNullOrWhiteSpace(PredicateSql)
            ? $"{SchemaMigrationSql.QuoteIdentifier(TargetColumnName)} IS NULL"
            : PredicateSql;
        return db.Ado.ExecuteCommandAsync($"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = '{SchemaMigrationSql.EscapeLiteral(TableName)}'
                      AND column_name = '{SchemaMigrationSql.EscapeLiteral(SourceColumnName)}'
                )
                AND EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = '{SchemaMigrationSql.EscapeLiteral(TableName)}'
                      AND column_name = '{SchemaMigrationSql.EscapeLiteral(TargetColumnName)}'
                ) THEN
                    EXECUTE 'UPDATE {SchemaMigrationSql.QuoteIdentifier(TableName)} SET {SchemaMigrationSql.QuoteIdentifier(TargetColumnName)} = {targetExpression} WHERE {predicate}';
                END IF;
            END $$;
            """);
    }
}

public sealed record CopyColumnToTableStep(
    string SourceTableName,
    string TargetTableName,
    string Sql) : SchemaMigrationStep
{
    internal override string Kind => "CopyColumnToTable";
    internal override string Fingerprint => $"{SourceTableName}->{TargetTableName}\n{Sql}";
    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(Sql);
}

public sealed record DropColumnStep(string TableName, string ColumnName) : SchemaMigrationStep
{
    internal override string Kind => "DropColumn";
    internal override string Fingerprint => $"{TableName}.{ColumnName}";

    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(
            $"ALTER TABLE IF EXISTS {SchemaMigrationSql.QuoteIdentifier(TableName)} DROP COLUMN IF EXISTS {SchemaMigrationSql.QuoteIdentifier(ColumnName)};");
}

public sealed record DropTableStep(string TableName) : SchemaMigrationStep
{
    internal override string Kind => "DropTable";
    internal override string Fingerprint => TableName;
    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync($"DROP TABLE IF EXISTS {SchemaMigrationSql.QuoteIdentifier(TableName)};");
}

public sealed record DropIndexStep(string IndexName) : SchemaMigrationStep
{
    internal override string Kind => "DropIndex";
    internal override string Fingerprint => IndexName;
    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync($"DROP INDEX IF EXISTS {SchemaMigrationSql.QuoteIdentifier(IndexName)};");
}

public sealed record CreateIndexStep(string IndexName, string CreateSql) : SchemaMigrationStep
{
    internal override string Kind => "CreateIndex";
    internal override string Fingerprint => $"{IndexName}\n{CreateSql}";
    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync($"""
            DO $$
            BEGIN
                EXECUTE '{SchemaMigrationSql.EscapeLiteral(CreateSql)}';
            EXCEPTION
                WHEN undefined_table OR undefined_column THEN
                    NULL;
            END $$;
            """);
}

public sealed record RawSqlStep(string Sql) : SchemaMigrationStep
{
    internal override string Kind => "RawSql";
    internal override string Fingerprint => Sql;
    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(Sql);
}

public sealed record AssertSqlStep(string Description, string Sql) : SchemaMigrationStep
{
    internal override string Kind => "AssertSql";
    internal override string Fingerprint => $"{Description}\n{Sql}";
    internal override Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        => db.Ado.ExecuteCommandAsync(Sql);
}

internal static class SchemaMigrationSql
{
    public static string QuoteIdentifier(string identifier)
        => $"\"{identifier.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";

    public static string EscapeLiteral(string value)
        => value.Replace("'", "''", StringComparison.Ordinal);
}
