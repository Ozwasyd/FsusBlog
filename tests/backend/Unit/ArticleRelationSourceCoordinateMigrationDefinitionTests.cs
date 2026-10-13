using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleRelationSourceCoordinateMigrationDefinitionTests
{
    [Fact]
    public void DefinitionIsTransactionalAndContainsNoBackfillOrRegistration()
    {
        ISchemaMigrationDescriptor definition = ArticleRelationSourceCoordinateMigrationDefinitions.BuildMigration();
        Assert.DoesNotContain(new SchemaMigrationRegistry().GetDescriptors(),
            registered => registered.MigrationId == definition.MigrationId);
        Assert.True(definition.Transactional);
        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, definition.Phase);
        RawSqlStep step = Assert.IsType<RawSqlStep>(Assert.Single(definition.Steps));
        Assert.Equal(ArticleRelationSourceCoordinateMigrationDefinitions.Sql, step.Sql);
        Assert.DoesNotContain("UPDATE article", step.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("INSERT INTO", step.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("DROP ", step.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("TRUNCATE ", step.Sql, StringComparison.Ordinal);
        Assert.DoesNotContain("DELETE FROM", step.Sql, StringComparison.Ordinal);
        Assert.Equal(definition.Checksum, ArticleRelationSourceCoordinateMigrationDefinitions.BuildMigration().Checksum);
    }
}
