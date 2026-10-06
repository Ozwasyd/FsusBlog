using Microsoft.Data.Sqlite;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class MigrationProviderExecutionTests
{
    [Fact]
    public async Task SqliteExecutesTypedDdlAndPreservesRowsWithoutServer()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        ISchemaDdlProvider provider = SchemaDdlProviders.For(SchemaDdlDialect.Sqlite);
        SchemaIdentifier table = SchemaIdentifier.Parse("migration_probe", "table");
        SchemaIdentifier archive = SchemaIdentifier.Parse("migration_archive", "archive");
        SchemaIdentifier oldColumn = SchemaIdentifier.Parse("title", "oldColumn");
        SchemaIdentifier newColumn = SchemaIdentifier.Parse("headline", "newColumn");
        SchemaIdentifier index = SchemaIdentifier.Parse("idx_migration_probe_title", "index");

        await ExecuteAsync(connection, provider.EnsureTable(
            table,
            "CREATE TABLE IF NOT EXISTS migration_probe (id INTEGER PRIMARY KEY, legacy_value TEXT NOT NULL);"));
        await ExecuteAsync(connection, "INSERT INTO migration_probe (id, legacy_value) VALUES (1, 'preserved');");
        await ExecuteAsync(connection, provider.EnsureColumn(
            table,
            oldColumn,
            SchemaColumnDefinition.Parse("varchar(64) NULL", "definition")));
        await ExecuteAsync(connection, "UPDATE migration_probe SET title = legacy_value;");
        await ExecuteAsync(connection, provider.CreateIndex(
            index,
            "CREATE INDEX IF NOT EXISTS idx_migration_probe_title ON migration_probe (title);"));

        Assert.Equal("preserved", await ScalarAsync(connection, "SELECT title FROM migration_probe WHERE id = 1;"));
        Assert.Equal(1L, await ScalarAsync(connection, "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = 'idx_migration_probe_title';"));

        await ExecuteAsync(connection, provider.RenameColumn(table, oldColumn, newColumn));
        await ExecuteAsync(connection, provider.DropIndex(index));
        await ExecuteAsync(connection, provider.DropColumn(table, SchemaIdentifier.Parse("legacy_value", "column")));
        await ExecuteAsync(connection, provider.RenameTable(table, archive));

        Assert.Equal("preserved", await ScalarAsync(connection, "SELECT headline FROM migration_archive WHERE id = 1;"));
        Assert.Equal(2L, await ScalarAsync(connection, "SELECT COUNT(*) FROM pragma_table_info('migration_archive');"));
        Assert.Equal(0L, await ScalarAsync(connection, "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('migration_probe', 'idx_migration_probe_title');"));

        await ExecuteAsync(connection, provider.DropTable(archive));
        Assert.Equal(0L, await ScalarAsync(connection, "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'migration_archive';"));
    }

    [Fact]
    public async Task SqliteTransactionRollsBackTypedDdlAndDataTogether()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        ISchemaDdlProvider provider = SchemaDdlProviders.For(SchemaDdlDialect.Sqlite);
        SchemaIdentifier table = SchemaIdentifier.Parse("migration_probe", "table");
        await ExecuteAsync(connection, provider.EnsureTable(
            table,
            "CREATE TABLE IF NOT EXISTS migration_probe (id INTEGER PRIMARY KEY, title TEXT NOT NULL);"));
        await ExecuteAsync(connection, "INSERT INTO migration_probe (id, title) VALUES (1, 'preserved');");

        using (SqliteTransaction transaction = connection.BeginTransaction())
        {
            await ExecuteAsync(connection, "UPDATE migration_probe SET title = 'changed';", transaction);
            await ExecuteAsync(connection, provider.DropTable(table), transaction);
            Assert.Equal(0L, await ScalarAsync(connection, "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'migration_probe';", transaction));
            await transaction.RollbackAsync();
        }

        Assert.Equal("preserved", await ScalarAsync(connection, "SELECT title FROM migration_probe WHERE id = 1;"));
        Assert.Equal(1L, await ScalarAsync(connection, "SELECT COUNT(*) FROM migration_probe;"));
    }

    private static async Task ExecuteAsync(SqliteConnection connection, string sql, SqliteTransaction? transaction = null)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<object?> ScalarAsync(SqliteConnection connection, string sql, SqliteTransaction? transaction = null)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        command.Transaction = transaction;
        return await command.ExecuteScalarAsync();
    }
}
