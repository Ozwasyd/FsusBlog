using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

using NSubstitute;

using SqlSugar;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class SchemaMigrationDdlPrimitivesTests
{
    [Theory]
    [InlineData(SchemaDdlDialect.PostgreSql, "\"article\"", "varchar(64) NULL")]
    [InlineData(SchemaDdlDialect.MySql, "`article`", "varchar(64) NULL")]
    [InlineData(SchemaDdlDialect.Sqlite, "\"article\"", "TEXT NULL")]
    public void ProviderSnapshot_CoversEveryDdlStepKind(
        SchemaDdlDialect dialect,
        string quotedTable,
        string expectedColumnDefinition)
    {
        SchemaMigrationCommand[] commands = BuildSnapshot(SchemaDdlProviders.For(dialect)).Values.ToArray();

        Assert.All(commands, static command => Assert.True(command.IsDdl));
        Assert.Equal("CREATE TABLE IF NOT EXISTS article (id bigint);", commands[0].Sql);
        string columnSql = dialect == SchemaDdlDialect.MySql ? DecodeMySqlText(commands[1].Sql) : commands[1].Sql;
        Assert.Contains(quotedTable, columnSql, StringComparison.Ordinal);
        Assert.Contains(expectedColumnDefinition, columnSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("article_archive", commands[2].Sql, StringComparison.Ordinal);
        Assert.Contains("headline", commands[3].Sql, StringComparison.Ordinal);
        Assert.Contains("legacy_title", commands[4].Sql, StringComparison.Ordinal);
        Assert.StartsWith("DROP TABLE", commands[5].Sql, StringComparison.Ordinal);
        if (dialect == SchemaDdlDialect.MySql)
        {
            Assert.Equal("ALTER TABLE `article` ADD COLUMN `title` varchar(64) NULL;", columnSql);
            Assert.Equal("DROP INDEX `idx_article_title` ON ", DecodeMySqlText(commands[6].Sql));
            Assert.Equal("CREATE INDEX `idx_article_title` ON `article` (title);", DecodeMySqlText(commands[7].Sql));
            foreach (int index in new[] { 1, 6, 7 })
            {
                Assert.Contains("WHEN DATABASE() IS NULL THEN NULL", commands[index].Sql, StringComparison.Ordinal);
                Assert.Contains("PREPARE fsus_schema_ddl_statement FROM @fsus_schema_ddl;", commands[index].Sql, StringComparison.Ordinal);
                Assert.Contains("DEALLOCATE PREPARE fsus_schema_ddl_statement;", commands[index].Sql, StringComparison.Ordinal);
                Assert.EndsWith("SET @fsus_schema_ddl = NULL;", commands[index].Sql, StringComparison.Ordinal);
                Assert.DoesNotContain("IF NOT EXISTS", DecodeMySqlText(commands[index].Sql), StringComparison.Ordinal);
            }
            Assert.Contains("SELECT DISTINCT CAST(CONCAT(", commands[6].Sql, StringComparison.Ordinal);
            Assert.Contains("AS BINARY)", commands[6].Sql, StringComparison.Ordinal);
            Assert.Contains("table_schema = DATABASE()", commands[6].Sql, StringComparison.Ordinal);
        }
        else
        {
            Assert.StartsWith("DROP INDEX", commands[6].Sql, StringComparison.Ordinal);
            Assert.Contains("CREATE INDEX IF NOT EXISTS", commands[7].Sql, StringComparison.Ordinal);
        }

        if (dialect == SchemaDdlDialect.PostgreSql)
        {
            Assert.Contains("information_schema.tables", commands[1].Sql, StringComparison.Ordinal);
            Assert.Contains("information_schema.columns", commands[3].Sql, StringComparison.Ordinal);
            Assert.Contains("WHEN undefined_table OR undefined_column", commands[7].Sql, StringComparison.Ordinal);
        }
        else
        {
            Assert.DoesNotContain(
                "DO $$",
                string.Join('\n', commands.Select(static command => command.Sql)),
                StringComparison.Ordinal);
        }
    }

    [Theory]
    [InlineData(SchemaDdlDialect.MySql)]
    [InlineData(SchemaDdlDialect.Sqlite)]
    [InlineData(SchemaDdlDialect.PostgreSql)]
    public void ProviderSnapshot_MatchesCheckedInCrossDialectContract(SchemaDdlDialect dialect)
    {
        JsonObject contract = JsonNode.Parse(File.ReadAllText(
            Path.Combine(AppContext.BaseDirectory, "schema-ddl-provider-snapshots.json")))!.AsObject();
        JsonObject expected = contract["dialects"]![dialect.ToString()]!.AsObject();
        IReadOnlyDictionary<string, SchemaMigrationCommand> actual = BuildSnapshot(SchemaDdlProviders.For(dialect));

        Assert.Equal(expected.Count, actual.Count);
        foreach ((string kind, SchemaMigrationCommand command) in actual)
        {
            Assert.Equal(expected[kind]!.GetValue<string>(), command.Sql);
        }
    }

    [Fact]
    public async Task PreviewAsync_IsDryRunAndWrapsTransactionalDescriptor()
    {
        var descriptor = new SchemaMigrationDescriptor(
            "preview-typed-ddl",
            "typed ddl preview",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            [
                new EnsureColumnStep("article", "headline", "text NULL"),
                new DropColumnStep("article", "legacy_title", DestructiveMigrationProofs.For("20260418-post-content-cleanup"))
            ]);

        SchemaMigrationPreviewResult preview = await SchemaMigrationPreviewer.PreviewAsync(
            descriptor,
            SchemaDdlDialect.MySql,
            CancellationToken.None);

        Assert.Equal("preview-typed-ddl", preview.MigrationId);
        Assert.Equal(SchemaDdlDialect.MySql, preview.Dialect);
        Assert.True(preview.Transactional);
        Assert.Equal(2, preview.Steps.Count);
        Assert.All(preview.Steps, static step => Assert.True(step.IsDdl));
        Assert.StartsWith("BEGIN;", preview.Script, StringComparison.Ordinal);
        Assert.EndsWith("COMMIT;", preview.Script, StringComparison.Ordinal);
        Assert.Equal("ALTER TABLE `article` ADD COLUMN `headline` text NULL;", DecodeMySqlText(preview.Script));
        Assert.Contains("DROP COLUMN `legacy_title`", preview.Script, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PreviewAsync_NonTransactionalDescriptor_DoesNotAddTransactionStatements()
    {
        var descriptor = new SchemaMigrationDescriptor(
            "preview-non-transactional",
            "typed ddl preview without transaction",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: false,
            [new DropColumnStep("article", "legacy_title", DestructiveMigrationProofs.For("20260418-post-content-cleanup"))]);

        SchemaMigrationPreviewResult preview = await SchemaMigrationPreviewer.PreviewAsync(
            descriptor,
            SchemaDdlDialect.Sqlite,
            CancellationToken.None);

        Assert.DoesNotContain("BEGIN;", preview.Script, StringComparison.Ordinal);
        Assert.DoesNotContain("COMMIT;", preview.Script, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Runner_ExecutesTransactionalDescriptorsThroughSingleTransactionWrapper()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        var events = new List<string>();
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            events.Add("begin");
            await call.Arg<Func<Task>>()();
            events.Add("commit");
            return new DbResult<bool> { IsSuccess = true };
        });
        var descriptor = new SchemaMigrationDescriptor(
            "transaction-wrapper",
            "executes every step in one transaction",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            [
                new EnsureTableStep("first_step", "CREATE TABLE IF NOT EXISTS first_step (id bigint);"),
                new EnsureTableStep("second_step", "CREATE TABLE IF NOT EXISTS second_step (id bigint);")
            ]);

        await SchemaMigrationTransactionExecutor.ExecuteAsync(
            db,
            descriptor,
            (step, _) =>
            {
                events.Add(step.Fingerprint);
                return Task.CompletedTask;
            },
            CancellationToken.None);

        Assert.Equal(
            ["begin", descriptor.Steps[0].Fingerprint, descriptor.Steps[1].Fingerprint, "commit"],
            events);
        await ado.Received(1).UseTranAsync(Arg.Any<Func<Task>>());
    }

    [Theory]
    [InlineData("")]
    [InlineData("public.article")]
    [InlineData("article\"")]
    [InlineData("article;DROP_TABLE")]
    [InlineData("文章")]
    public void IdentifierValidation_RejectsUntrustedShapes(string identifier)
    {
        var step = new DropColumnStep(identifier, "title", DestructiveMigrationProofs.For("20260418-post-content-cleanup"));

        foreach (SchemaDdlDialect dialect in Enum.GetValues<SchemaDdlDialect>())
        {
            Assert.Throws<ArgumentException>(() => step.BuildCommand(SchemaDdlProviders.For(dialect)));
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("jsonb NULL")]
    [InlineData("text; DROP TABLE article")]
    [InlineData("varchar(64) DEFAULT (SELECT secret FROM sys_user)")]
    [InlineData("integer /* unsafe */")]
    public void ColumnDefinitionValidation_RejectsArbitrarySql(string definition)
    {
        var step = new EnsureColumnStep("article", "title", definition);

        foreach (SchemaDdlDialect dialect in Enum.GetValues<SchemaDdlDialect>())
        {
            Assert.Throws<ArgumentException>(() => step.BuildCommand(SchemaDdlProviders.For(dialect)));
        }
    }

    [Fact]
    public void DdlTemplateValidation_RejectsWrongKindMultipleStatementsAndComments()
    {
        string[] invalidTableTemplates =
        [
            "DROP TABLE article;",
            "CREATE TABLE article (id bigint); DROP TABLE sys_user;",
            "CREATE TABLE article (id bigint); -- bypass",
            "CREATE TABLE article (id bigint); /* bypass */"
        ];

        foreach (SchemaDdlDialect dialect in Enum.GetValues<SchemaDdlDialect>())
        {
            ISchemaDdlProvider provider = SchemaDdlProviders.For(dialect);
            Assert.All(
                invalidTableTemplates,
                sql => Assert.Throws<ArgumentException>(
                    () => new EnsureTableStep("article", sql).BuildCommand(provider)));
            Assert.Throws<ArgumentException>(() => new CreateIndexStep(
                "idx_article_title",
                "CREATE TABLE article (id bigint);").BuildCommand(provider));
        }
    }

    [Theory]
    [InlineData("CREATE INDEX idx_other ON article (title);")]
    [InlineData("CREATE INDEX idx_article_title ON another.article (title);")]
    [InlineData("CREATE INDEX idx_article_title ON article (title); DROP TABLE article;")]
    [InlineData("CREATE INDEX idx_article_title ON article (title); -- comment")]
    [InlineData("CREATE INDEX idx_article_title ON article (title) /* comment */;")]
    [InlineData("CREATE INDEX idx_article_title ON article (title) # comment")]
    [InlineData("CREATE INDEX idx_article_title ON article;")]
    public void MySqlIndexTemplate_RejectsWrongIdentityCrossSchemaAndUnsafeSql(string template)
    {
        Assert.Throws<ArgumentException>(() => new CreateIndexStep(
            "idx_article_title",
            template).BuildCommand(MySqlSchemaDdlProvider.Instance));
    }

    [Fact]
    public void DataSteps_AreExplicitlySeparatedFromDdlCommands()
    {
        SchemaMigrationStep[] dataSteps =
        [
            new BackfillSqlStep("UPDATE article SET title = 'untitled' WHERE title IS NULL;"),
            new RawSqlStep("SELECT 1;"),
            new AssertSqlStep("assert", "SELECT 1;")
        ];

        Assert.All(
            dataSteps,
            step => Assert.False(step.BuildCommand(PostgresSchemaDdlProvider.Instance)!.IsDdl));
    }

    [Fact]
    public void Registry_AllExistingStepsBuildPreviewForEverySupportedDialect()
    {
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors = new SchemaMigrationRegistry().GetDescriptors();

        foreach (SchemaDdlDialect dialect in Enum.GetValues<SchemaDdlDialect>())
        {
            ISchemaDdlProvider provider = SchemaDdlProviders.For(dialect);
            foreach (ISchemaMigrationDescriptor descriptor in descriptors)
            {
                foreach (SchemaMigrationStep step in descriptor.Steps)
                {
                    Exception? error = Record.Exception(() => step.BuildCommand(provider));
                    Assert.True(
                        error is null,
                        $"{descriptor.MigrationId}/{step.Kind} cannot build for {dialect}: {error}");
                }
            }
        }
    }

    private static string DecodeMySqlText(string sql)
    {
        Match literal = Regex.Match(sql, "CONVERT\\(X'(?<hex>[A-F0-9]+)' USING utf8mb4\\)", RegexOptions.CultureInvariant);
        Assert.True(literal.Success, "MySQL prepared DDL must contain an explicit UTF-8 SQL constant.");
        return Encoding.UTF8.GetString(Convert.FromHexString(literal.Groups["hex"].Value));
    }

    private static IReadOnlyDictionary<string, SchemaMigrationCommand> BuildSnapshot(ISchemaDdlProvider provider)
    {
        SchemaMigrationStep[] steps =
        [
            new EnsureTableStep("article", "CREATE TABLE IF NOT EXISTS article (id bigint);"),
            new EnsureColumnStep("article", "title", "varchar(64) NULL"),
            new RenameTableStep("article", "article_archive"),
            new RenameColumnStep("article", "title", "headline"),
            new DropColumnStep("article", "legacy_title", DestructiveMigrationProofs.For("20260418-post-content-cleanup")),
            new DropTableStep("article_archive", DestructiveMigrationProofs.For("20260418-post-content-cleanup")),
            new DropIndexStep("idx_article_title"),
            new CreateIndexStep(
                "idx_article_title",
                "CREATE INDEX IF NOT EXISTS idx_article_title ON article (title);")
        ];

        return steps.ToDictionary(
            static step => step.Kind,
            step => step.BuildCommand(provider)!,
            StringComparer.Ordinal);
    }
}
