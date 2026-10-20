using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Articles;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

public sealed partial class ArticleSourceMutationHooksIntegrationTests
{
    [Fact]
    public async Task SourceTaxonomy_CreateWithoutArticlesMustEnrollItsActualMutation()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int categoryId = await BinaryEndpoints.CreateCategoryAsync(db, "source category", "description", CancellationToken.None);
        Assert.True(categoryId > 0);
        Assert.Equal("source category", (await db.Queryable<Category>().Where(row => row.Id == categoryId).SingleAsync()).Name);
        long? generation = await ArticleSourceGenerationAuthority.ReadGenerationAsync(db);
        Assert.True(generation is > 0, "The original category insert committed, but its actual source mutation was not enrolled.");
    }

    [Fact]
    public async Task SourceTaxonomy_DescriptionOnlyMustAdvanceTheOriginalFamily()
    {
        using SqlSugarClient db = await DatabaseAsync();
        int categoryId = await BinaryEndpoints.CreateCategoryAsync(db, "source category", "before", CancellationToken.None);
        Assert.Equal(1, categoryId);
        var create = await db.Ado.UseTranAsync(async () => await CreateAsync(db));
        Assert.True(create.IsSuccess, create.ErrorException?.ToString());
        long before = (await ArticleSourceGenerationAuthority.ReadGenerationAsync(db))!.Value;

        await BinaryEndpoints.UpdateCategoryAndEnqueueProjectionAsync(db, categoryId, "source category", "after",
            preserveDescription: false, CancellationToken.None);

        Assert.Equal("after", (await db.Queryable<Category>().Where(row => row.Id == categoryId).SingleAsync()).Description);
        long? after = await ArticleSourceGenerationAuthority.ReadGenerationAsync(db);
        Assert.True(after > before, "The original description-only transaction committed without advancing source generation.");
    }

    [Fact]
    public async Task SourceTaxonomy_DeleteUnlinkedTagMustAdvanceTheOriginalFamily()
    {
        using SqlSugarClient db = await DatabaseAsync();
        Assert.Equal(1, await BinaryEndpoints.CreateCategoryAsync(db, "source category", null, CancellationToken.None));
        var create = await db.Ado.UseTranAsync(async () => await CreateAsync(db));
        Assert.True(create.IsSuccess, create.ErrorException?.ToString());
        int tagId = await BinaryEndpoints.CreateTagAsync(db, "unlinked-source-tag", "description", CancellationToken.None);
        long before = (await ArticleSourceGenerationAuthority.ReadGenerationAsync(db))!.Value;

        Assert.Equal(BinaryEndpoints.TagDeleteOutcome.Deleted, await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, tagId));

        Assert.Equal(0, await db.Queryable<Tag>().Where(row => row.Id == tagId).CountAsync());
        long? after = await ArticleSourceGenerationAuthority.ReadGenerationAsync(db);
        Assert.True(after > before, "The original tag delete committed without advancing source generation.");
    }
}
