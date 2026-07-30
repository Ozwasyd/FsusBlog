using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Fixtures;

using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class PublicContentFixtureSeederTests
{
    [Fact]
    public async Task EnsureTaxonomyAsync_InvalidatesAfterBothOwnedRowsExist()
    {
        var sequence = new List<string>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        using var cancellation = new CancellationTokenSource();
        dispatcher
            .InvalidateCategoryTagAsync(cancellation.Token)
            .Returns(_ =>
            {
                sequence.Add("invalidate");
                return Task.CompletedTask;
            });

        (Category category, Tag tag) = await PublicContentFixtureSeeder.EnsureTaxonomyAsync(
            (name, token) =>
            {
                Assert.Equal(cancellation.Token, token);
                sequence.Add("category");
                return Task.FromResult(new Category { Id = 17, Name = name });
            },
            (name, token) =>
            {
                Assert.Equal(cancellation.Token, token);
                sequence.Add("tag");
                return Task.FromResult(new Tag { Id = 23, Name = name });
            },
            dispatcher,
            "fxpc:acceptance:run",
            cancellation.Token);

        Assert.Equal(["category", "tag", "invalidate"], sequence);
        Assert.Equal("fxpc:acceptance:run:category", category.Name);
        Assert.Equal("fxpc:acceptance:run:tag", tag.Name);
        await dispatcher.Received(1).InvalidateCategoryTagAsync(cancellation.Token);
    }
}
