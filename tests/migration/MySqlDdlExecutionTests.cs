using System.Text;

using Xunit;
using Xunit.Abstractions;

namespace FsusBlog.Migration.Tests;

public sealed class MySqlDdlExecutionTests(MySqlDdlFixture fixture, ITestOutputHelper output) : IClassFixture<MySqlDdlFixture>
{
    private static readonly ISchemaDdlProvider s_provider = MySqlSchemaDdlProvider.Instance;

    [Fact]
    public async Task EnsureColumn_ExecutesTwiceWithoutChangingExistingRows()
    {
        string database = await CreateAsync("CREATE TABLE article (id INT PRIMARY KEY, legacy_value VARCHAR(64)); INSERT INTO article VALUES (1, 'preserved');");
        string sql = s_provider.EnsureColumn(Id("article"), Id("title"), Definition("varchar(64) NULL"));
        await ExecuteAsync(database, sql);
        await ExecuteAsync(database, sql);
        Assert.Equal("1\tpreserved\tNULL", await ExecuteAsync(database, "SELECT id, legacy_value, title FROM article;"));
        Assert.Equal("1", await ExecuteAsync(database, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'article' AND column_name = 'title';"));
    }

    [Fact]
    public async Task CreateIndex_IsUniqueIdempotentAndTableScoped()
    {
        string database = await CreateAsync("CREATE TABLE article (id INT PRIMARY KEY, title VARCHAR(64)); INSERT INTO article VALUES (1, 'preserved'); CREATE TABLE other (title VARCHAR(64)); CREATE INDEX idx_title ON other (title);");
        string sql = s_provider.CreateIndex(Id("idx_title"), "CREATE UNIQUE INDEX IF NOT EXISTS idx_title ON article (title);");
        await ExecuteAsync(database, sql);
        await ExecuteAsync(database, sql);
        Assert.Equal("0", await ExecuteAsync(database, "SELECT non_unique FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'article' AND index_name = 'idx_title';"));
        Assert.Equal("2", await ExecuteAsync(database, "SELECT COUNT(DISTINCT table_name) FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name = 'idx_title';"));
        MySqlDdlClient.SqlResult duplicate = await fixture.ExecuteAsync(database, "INSERT INTO article VALUES (2, 'preserved');");
        Assert.NotEqual(0, duplicate.ExitCode);
        Assert.Contains("1062", duplicate.Error, StringComparison.Ordinal);
        Assert.Equal("1\tpreserved", await ExecuteAsync(database, "SELECT id, title FROM article;"));
    }

    [Fact]
    public async Task DropIndex_ResolvesOneTableAndNoOpsAfterRemoval()
    {
        string database = await CreateAsync("CREATE TABLE article (id INT PRIMARY KEY, title VARCHAR(64)); INSERT INTO article VALUES (1, 'preserved'); CREATE INDEX idx_title ON article (id, title);");
        string otherDatabase = await CreateAsync("CREATE TABLE article (title VARCHAR(64)); CREATE INDEX idx_title ON article (title);");
        string sql = s_provider.DropIndex(Id("idx_title"));
        await ExecuteAsync(database, sql);
        await ExecuteAsync(database, sql);
        Assert.Equal("0", await IndexCountAsync(database));
        Assert.Equal("1", await IndexCountAsync(otherDatabase));
        Assert.Equal("1\tpreserved", await ExecuteAsync(database, "SELECT id, title FROM article;"));
    }

    [Fact]
    public async Task DropIndex_RejectsAmbiguousTableBeforeAnyWrite()
    {
        string database = await CreateAsync("CREATE TABLE article (title VARCHAR(64)); CREATE TABLE other (title VARCHAR(64)); CREATE INDEX idx_title ON article (title); CREATE INDEX idx_title ON other (title);");
        MySqlDdlClient.SqlResult result = await fixture.ExecuteAsync(database, s_provider.DropIndex(Id("idx_title")));
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("1242", result.Error, StringComparison.Ordinal);
        Assert.Equal("2", await IndexCountAsync(database));
    }

    [Theory]
    [InlineData("")]
    [InlineData("NO_BACKSLASH_ESCAPES")]
    public async Task EnsureColumn_PreservesLiteralDefaultsUnderBothSqlModes(string sqlMode)
    {
        string database = await CreateAsync("CREATE TABLE article (id INT PRIMARY KEY, legacy_value VARCHAR(64));");
        const string Value = "O'Brien\\path中";
        string sql = s_provider.EnsureColumn(Id("article"), Id("title"), Definition("varchar(128) NOT NULL DEFAULT 'O''Brien\\path中'"));
        Assert.Equal(
            Convert.ToHexString(Encoding.UTF8.GetBytes(Value)),
            await ExecuteAsync(database, $"SET SESSION sql_mode = '{sqlMode}'; {sql} INSERT INTO article (id) VALUES (1); SELECT HEX(title) FROM article;"));
    }

    [Fact]
    public async Task MetadataSelection_PreservesCaseSensitiveTableIdentity()
    {
        string database = await CreateAsync("CREATE TABLE article (title VARCHAR(64)); CREATE TABLE Article (id INT PRIMARY KEY); CREATE INDEX idx_title ON article (title);");
        Assert.Equal("0", await ExecuteAsync(database, "SELECT @@lower_case_table_names;"));
        await ExecuteAsync(database, s_provider.EnsureColumn(Id("Article"), Id("title"), Definition("varchar(64) NULL")));
        await ExecuteAsync(database, s_provider.CreateIndex(Id("idx_title"), "CREATE INDEX idx_title ON Article (title);"));
        Assert.Equal("2", await IndexCountAsync(database));
        MySqlDdlClient.SqlResult ambiguous = await fixture.ExecuteAsync(database, s_provider.DropIndex(Id("idx_title")));
        Assert.NotEqual(0, ambiguous.ExitCode);
        Assert.Contains("1242", ambiguous.Error, StringComparison.Ordinal);
        Assert.Equal("2", await IndexCountAsync(database));
    }

    [Fact]
    public async Task MetadataSelection_PreservesCaseSensitiveDatabaseIdentity()
    {
        string database = await CreateAsync("CREATE TABLE article (title VARCHAR(64)); CREATE INDEX idx_title ON article (title);");
        string otherDatabase = database.ToUpperInvariant();
        (await fixture.ExecuteAsync(null, $"CREATE DATABASE {otherDatabase};")).RequireSuccess();
        await ExecuteAsync(otherDatabase, "CREATE TABLE article (id INT PRIMARY KEY);");
        await ExecuteAsync(otherDatabase, s_provider.EnsureColumn(Id("article"), Id("title"), Definition("varchar(64) NULL")));
        await ExecuteAsync(otherDatabase, s_provider.CreateIndex(Id("idx_title"), "CREATE INDEX idx_title ON article (title);"));
        await ExecuteAsync(otherDatabase, s_provider.DropIndex(Id("idx_title")));
        Assert.Equal("0", await IndexCountAsync(otherDatabase));
        Assert.Equal("1", await IndexCountAsync(database));
    }

    [Fact]
    public async Task DropIndex_QuotesMetadataTableNameWithoutChangingAnotherTable()
    {
        string database = await CreateAsync("CREATE TABLE `odd``table` (title VARCHAR(64)); CREATE INDEX idx_title ON `odd``table` (title); CREATE TABLE article (id INT PRIMARY KEY); INSERT INTO article VALUES (1);");
        await ExecuteAsync(database, s_provider.DropIndex(Id("idx_title")));
        Assert.Equal("0", await IndexCountAsync(database));
        Assert.Equal("1", await ExecuteAsync(database, "SELECT COUNT(*) FROM article;"));
        Assert.Equal("0", await ExecuteAsync(database, "SELECT COUNT(*) FROM `odd``table`;"));
    }

    [Fact]
    public async Task RepeatedCommands_ReleasePreparedStatementAndSessionText()
    {
        string database = await CreateAsync("CREATE TABLE article (id INT PRIMARY KEY);");
        string sql = s_provider.EnsureColumn(Id("article"), Id("title"), Definition("varchar(64) NULL"));
        MySqlDdlClient.SqlResult result = await fixture.ExecuteAsync(
            database,
            $"{sql} {sql} SELECT @fsus_schema_ddl IS NULL; EXECUTE fsus_schema_ddl_statement;");
        Assert.Equal("1", result.Output.Trim());
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("1243", result.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreateIndex_RejectsAbsentColumnAndPreservesRows()
    {
        string database = await CreateAsync("CREATE TABLE article (id INT PRIMARY KEY); INSERT INTO article VALUES (1);");
        string sql = s_provider.CreateIndex(Id("idx_title"), "CREATE INDEX idx_title ON article (title);");
        MySqlDdlClient.SqlResult result = await fixture.ExecuteAsync(database, sql);
        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("1072", result.Error, StringComparison.Ordinal);
        Assert.Equal("0", await IndexCountAsync(database));
        Assert.Equal("1", await ExecuteAsync(database, "SELECT id FROM article;"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("NO_BACKSLASH_ESCAPES")]
    public async Task EnsureColumn_QuotedSqlTextRemainsAValueNotAnotherDdlClause(string sqlMode)
    {
        string database = await CreateAsync("CREATE TABLE article (id INT PRIMARY KEY, legacy_value VARCHAR(64));");
        const string Value = "x\\' , DROP COLUMN legacy_value --";
        string sql = s_provider.EnsureColumn(Id("article"), Id("title"), Definition("varchar(128) NOT NULL DEFAULT 'x\\'' , DROP COLUMN legacy_value --'"));
        Assert.Equal(
            Convert.ToHexString(Encoding.UTF8.GetBytes(Value)),
            await ExecuteAsync(database, $"SET SESSION sql_mode = '{sqlMode}'; {sql} INSERT INTO article (id) VALUES (1); SELECT HEX(title) FROM article;"));
        Assert.Equal("1", await ExecuteAsync(database, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'article' AND column_name = 'legacy_value';"));
    }

    [Fact]
    public async Task MissingTargetsAndDatabaseRejectWithoutSchemaWrites()
    {
        string database = await fixture.CreateDatabaseAsync();
        string[] commands =
        [
            s_provider.EnsureColumn(Id("article"), Id("title"), Definition("varchar(64) NULL")),
            s_provider.CreateIndex(Id("idx_title"), "CREATE INDEX IF NOT EXISTS idx_title ON article (title);")
        ];
        foreach (string sql in commands)
        {
            Assert.NotEqual(0, (await fixture.ExecuteAsync(database, sql)).ExitCode);
            Assert.NotEqual(0, (await fixture.ExecuteAsync(null, sql)).ExitCode);
        }
        Assert.NotEqual(0, (await fixture.ExecuteAsync(null, s_provider.DropIndex(Id("idx_title")))).ExitCode);
        Assert.Equal("0", await ExecuteAsync(database, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE();"));
    }

    [Fact]
    public async Task DdlImplicitCommit_IsNotMistakenForTransactionalRollback()
    {
        string database = await CreateAsync("CREATE TABLE article (id INT PRIMARY KEY);");
        string sql = s_provider.EnsureColumn(Id("article"), Id("title"), Definition("varchar(64) NULL"));
        Assert.Equal("1", await ExecuteAsync(database, $"START TRANSACTION; INSERT INTO article VALUES (1); {sql} ROLLBACK; SELECT COUNT(*) FROM article;"));
        Assert.Equal("1", await ExecuteAsync(database, "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'article' AND column_name = 'title';"));
    }

    private async Task<string> CreateAsync(string fixtureSql)
    {
        output.WriteLine($"Actual MySQL engine: {fixture.EngineVersion}");
        string database = await fixture.CreateDatabaseAsync();
        await ExecuteAsync(database, fixtureSql);
        return database;
    }

    private async Task<string> ExecuteAsync(string database, string sql)
        => (await fixture.ExecuteAsync(database, sql)).RequireSuccess();

    private Task<string> IndexCountAsync(string database)
        => ExecuteAsync(database, "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name = 'idx_title';");

    private static SchemaIdentifier Id(string value) => SchemaIdentifier.Parse(value, "identifier");
    private static SchemaColumnDefinition Definition(string value) => SchemaColumnDefinition.Parse(value, "definition");
}
