using System.Text.Json.Nodes;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

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
        Assert.Contains(quotedTable, commands[1].Sql, StringComparison.Ordinal);
        Assert.Contains(expectedColumnDefinition, commands[1].Sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("article_archive", commands[2].Sql, StringComparison.Ordinal);
        Assert.Contains("headline", commands[3].Sql, StringComparison.Ordinal);
        Assert.Contains("legacy_title", commands[4].Sql, StringComparison.Ordinal);
        Assert.StartsWith("DROP TABLE", commands[5].Sql, StringComparison.Ordinal);
        Assert.StartsWith("DROP INDEX", commands[6].Sql, StringComparison.Ordinal);
        Assert.Contains("CREATE INDEX IF NOT EXISTS", commands[7].Sql, StringComparison.Ordinal);

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
    public void ProviderSnapshot_MatchesCheckedInCrossDialectContract(SchemaDdlDialect dialect)
    {
        JsonObject contract = BackendTestPaths.ReadJsonFromRoot(
            "tests",
            "backend",
            "Fixtures",
            "schema-ddl-provider-snapshots.json");
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
        Assert.Contains("ADD COLUMN IF NOT EXISTS `headline` text NULL", preview.Script, StringComparison.OrdinalIgnoreCase);
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
    public void Runner_ExecutesTransactionalDescriptorsThroughSingleTransactionWrapper()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(
            "src",
            "backend",
            "Infrastructure",
            "SchemaMigration",
            "SchemaMigrationRunner.cs");

        Assert.Contains("if (descriptor.Transactional)", source, StringComparison.Ordinal);
        Assert.Contains("_db.Ado.UseTranAsync", source, StringComparison.Ordinal);
        Assert.Contains("descriptor.Steps", source, StringComparison.Ordinal);
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

        Assert.Throws<ArgumentException>(() => step.BuildCommand(PostgresSchemaDdlProvider.Instance));
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

        Assert.Throws<ArgumentException>(() => step.BuildCommand(PostgresSchemaDdlProvider.Instance));
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

        Assert.All(
            invalidTableTemplates,
            sql => Assert.Throws<ArgumentException>(
                () => new EnsureTableStep("article", sql).BuildCommand(PostgresSchemaDdlProvider.Instance)));
        Assert.Throws<ArgumentException>(() => new CreateIndexStep(
            "idx_article_title",
            "CREATE TABLE article (id bigint);").BuildCommand(PostgresSchemaDdlProvider.Instance));
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
