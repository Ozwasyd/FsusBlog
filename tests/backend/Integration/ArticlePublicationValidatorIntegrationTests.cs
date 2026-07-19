using FsusBlog.Server.Entities;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Tests.TestInfrastructure;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticlePublicationValidatorIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly DateTime s_now = new(2026, 7, 19, 8, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task ValidateAsync_ReportsStableCodesForMissingTaxonomy()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePublicationValidator validator = CreateValidator(db);

        ArticlePublicationValidationResult result = await validator.ValidateAsync(
            ValidInput(categoryId: 404, tagIds: [999]),
            s_now);

        Assert.False(result.CanWrite);
        Assert.Contains(result.Issues, static issue => issue.Code == "category_not_found");
        Assert.Contains(result.Issues, static issue => issue.Code == "tag_not_found");
    }

    [Fact]
    public async Task ValidateAsync_DraftAllowsMissingCategoryButRejectsNegativeIdentity()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePublicationValidator validator = CreateValidator(db);

        ArticlePublicationValidationResult missing = await validator.ValidateAsync(
            ValidInput(categoryId: 0, tagIds: []) with
            {
                Status = ArticleStatus.Draft
            },
            s_now);
        ArticlePublicationValidationResult negative = await validator.ValidateAsync(
            ValidInput(categoryId: -1, tagIds: []) with
            {
                Status = ArticleStatus.Draft
            },
            s_now);

        Assert.True(missing.CanWrite);
        Assert.False(negative.CanWrite);
        Assert.Contains(negative.Issues, static issue => issue.Code == "category_not_found");
    }

    [Fact]
    public async Task ValidateAsync_UsesTheCallersPostgresTransactionForTaxonomy()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePublicationValidator validator = CreateValidator(db);

        await db.Ado.BeginTranAsync();
        try
        {
            int categoryId = await db.Insertable(new Category { Name = "transaction category" })
                .ExecuteReturnIdentityAsync();
            int tagId = await db.Insertable(new Tag { Name = "transaction tag" })
                .ExecuteReturnIdentityAsync();

            ArticlePublicationValidationResult result = await validator.ValidateAsync(
                ValidInput(categoryId, [tagId]),
                s_now);

            string issues = string.Join(';', result.Issues.Select(static issue => $"{issue.Severity}:{issue.Code}"));
            Assert.True(result.CanWrite, issues);
            Assert.True(result.CanPublish, issues);
        }
        finally
        {
            db.Ado.RollbackTran();
        }

        Assert.Equal(0, await db.Queryable<Category>().CountAsync());
        Assert.Equal(0, await db.Queryable<Tag>().CountAsync());
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Category), typeof(Tag));
        return db;
    }

    private static ArticlePublicationValidator CreateValidator(ISqlSugarClient db)
    {
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, "ok", string.Empty));
        return new ArticlePublicationValidator(db, contentFilter);
    }

    private static ArticlePublicationValidationInput ValidInput(int categoryId, IReadOnlyList<int> tagIds)
        => new("Publishable article", "# Body", "summary", null, categoryId, tagIds, ArticleStatus.Published, null);
}
