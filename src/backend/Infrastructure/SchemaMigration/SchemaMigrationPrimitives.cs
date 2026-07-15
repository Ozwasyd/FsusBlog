using System.Security.Cryptography;
using System.Text;
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
    IReadOnlySet<string> AcceptedChecksums { get; }
}

public sealed record SchemaMigrationDescriptor(
    string MigrationId,
    string Description,
    SchemaMigrationPhase Phase,
    bool Transactional,
    IReadOnlyList<SchemaMigrationStep> Steps,
    IReadOnlyCollection<string>? CompatibleChecksums = null) : ISchemaMigrationDescriptor
{
    public string Checksum { get; } = ComputeChecksum(MigrationId, Description, Phase, Transactional, Steps);
    public IReadOnlySet<string> AcceptedChecksums { get; } = BuildAcceptedChecksums(
        ComputeChecksum(MigrationId, Description, Phase, Transactional, Steps),
        CompatibleChecksums);

    private static IReadOnlySet<string> BuildAcceptedChecksums(
        string checksum,
        IReadOnlyCollection<string>? compatibleChecksums)
    {
        var checksums = new HashSet<string>(StringComparer.Ordinal)
        {
            checksum
        };

        if (compatibleChecksums is not null)
        {
            foreach (string compatibleChecksum in compatibleChecksums)
            {
                checksums.Add(compatibleChecksum);
            }
        }

        return checksums;
    }

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
    internal abstract SchemaMigrationCommand? BuildCommand(ISchemaDdlProvider ddl);

    internal virtual Task ExecuteAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SchemaMigrationCommand? command = BuildCommand(SchemaDdlProviders.For(db));
        return command is null
            ? Task.CompletedTask
            : db.Ado.ExecuteCommandAsync(command.Sql);
    }
}

public sealed record EnsureTableStep(string TableName, string CreateSql) : SchemaMigrationStep
{
    internal override string Kind => "EnsureTable";
    internal override string Fingerprint => $"{TableName}\n{CreateSql}";
    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(ddl.EnsureTable(
            SchemaIdentifier.Parse(TableName, nameof(TableName)),
            CreateSql), IsDdl: true);
}

public sealed record EnsureColumnStep(string TableName, string ColumnName, string ColumnDefinition) : SchemaMigrationStep
{
    internal override string Kind => "EnsureColumn";
    internal override string Fingerprint => $"{TableName}.{ColumnName}:{ColumnDefinition}";

    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(ddl.EnsureColumn(
            SchemaIdentifier.Parse(TableName, nameof(TableName)),
            SchemaIdentifier.Parse(ColumnName, nameof(ColumnName)),
            SchemaColumnDefinition.Parse(ColumnDefinition, nameof(ColumnDefinition))), IsDdl: true);
}

public sealed record RenameTableStep(string OldTableName, string NewTableName) : SchemaMigrationStep
{
    internal override string Kind => "RenameTable";
    internal override string Fingerprint => $"{OldTableName}->{NewTableName}";

    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(ddl.RenameTable(
            SchemaIdentifier.Parse(OldTableName, nameof(OldTableName)),
            SchemaIdentifier.Parse(NewTableName, nameof(NewTableName))), IsDdl: true);
}

public sealed record RenameColumnStep(string TableName, string OldColumnName, string NewColumnName) : SchemaMigrationStep
{
    internal override string Kind => "RenameColumn";
    internal override string Fingerprint => $"{TableName}.{OldColumnName}->{NewColumnName}";

    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(ddl.RenameColumn(
            SchemaIdentifier.Parse(TableName, nameof(TableName)),
            SchemaIdentifier.Parse(OldColumnName, nameof(OldColumnName)),
            SchemaIdentifier.Parse(NewColumnName, nameof(NewColumnName))), IsDdl: true);
}

public sealed record BackfillSqlStep(string Sql) : SchemaMigrationStep
{
    internal override string Kind => "BackfillSql";
    internal override string Fingerprint => Sql;
    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(Sql, IsDdl: false);
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

    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
    {
        string targetExpression = TargetSqlExpression ?? SchemaMigrationSql.QuoteIdentifier(SourceColumnName);
        string predicate = string.IsNullOrWhiteSpace(PredicateSql)
            ? $"{SchemaMigrationSql.QuoteIdentifier(TargetColumnName)} IS NULL"
            : PredicateSql;
        return new SchemaMigrationCommand($"""
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
            """, IsDdl: false);
    }
}

public sealed record CopyColumnToTableStep(
    string SourceTableName,
    string TargetTableName,
    string Sql) : SchemaMigrationStep
{
    internal override string Kind => "CopyColumnToTable";
    internal override string Fingerprint => $"{SourceTableName}->{TargetTableName}\n{Sql}";
    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(Sql, IsDdl: false);
}

public sealed record DropColumnStep(
    string TableName,
    string ColumnName,
    DestructiveMigrationProof Proof) : SchemaMigrationStep, IDestructiveSchemaMigrationStep
{
    internal override string Kind => "DropColumn";
    internal override string Fingerprint => $"{TableName}.{ColumnName}";

    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(ddl.DropColumn(
            SchemaIdentifier.Parse(TableName, nameof(TableName)),
            SchemaIdentifier.Parse(ColumnName, nameof(ColumnName))), IsDdl: true);
}

public sealed record DropTableStep(
    string TableName,
    DestructiveMigrationProof Proof) : SchemaMigrationStep, IDestructiveSchemaMigrationStep
{
    internal override string Kind => "DropTable";
    internal override string Fingerprint => TableName;
    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(ddl.DropTable(SchemaIdentifier.Parse(TableName, nameof(TableName))), IsDdl: true);
}

public sealed record DropIndexStep(string IndexName) : SchemaMigrationStep
{
    internal override string Kind => "DropIndex";
    internal override string Fingerprint => IndexName;
    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(ddl.DropIndex(SchemaIdentifier.Parse(IndexName, nameof(IndexName))), IsDdl: true);
}

public sealed record CreateIndexStep(string IndexName, string CreateSql) : SchemaMigrationStep
{
    internal override string Kind => "CreateIndex";
    internal override string Fingerprint => $"{IndexName}\n{CreateSql}";
    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(ddl.CreateIndex(
            SchemaIdentifier.Parse(IndexName, nameof(IndexName)),
            CreateSql), IsDdl: true);
}

public sealed record RawSqlStep(string Sql) : SchemaMigrationStep
{
    internal override string Kind => "RawSql";
    internal override string Fingerprint => Sql;
    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(Sql, IsDdl: false);
}

public sealed record ClearLegacyPublicArtifactsStep : SchemaMigrationStep
{
    internal override string Kind => "ClearLegacyPublicArtifacts";
    internal override string Fingerprint => "runtime-cache/public/articles/*.aeds:article-detail-aeds-v3";
    internal override SchemaMigrationCommand? BuildCommand(ISchemaDdlProvider ddl) => null;
}

public sealed record AssertSqlStep(string Description, string Sql) : SchemaMigrationStep
{
    internal override string Kind => "AssertSql";
    internal override string Fingerprint => $"{Description}\n{Sql}";
    internal override SchemaMigrationCommand BuildCommand(ISchemaDdlProvider ddl)
        => new(Sql, IsDdl: false);
}

internal static class SchemaMigrationSql
{
    public static string QuoteIdentifier(string identifier)
        => $"\"{identifier.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";

    public static string EscapeLiteral(string value)
        => value.Replace("'", "''", StringComparison.Ordinal);
}
