using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Tests;

public sealed class PublicContentPublishedFixtureContractTests
{
    [Fact]
    public void PublishedFixtureRequest_PreservesOwnedPublicationBindingAndContent()
    {
        var binding = new CanonicalArticlePublicationFixtureBinding(
            "related-reading-run", "owned-namespace", "public-minimal",
            ["public.article.published"], 31,
            "sha256:" + new string('a', 64), "sha256:" + new string('b', 64));

        CanonicalArticlePublicationRequest request = PublicContentFixtureSeeder.BuildPublishedArticleRequest(
            binding, "published-focus", "Owned published article", "# Published body",
            "Public summary", null, 7, 9);

        Assert.Same(binding, request.Binding);
        Assert.Equal("published-focus", request.Plan.SemanticRole);
        Assert.Equal("Owned published article", request.Plan.Title);
        Assert.Equal("# Published body", request.Plan.Content);
        Assert.Equal("Public summary", request.Plan.Summary);
        Assert.Equal(7, request.Plan.CategoryId);
        Assert.Equal([9], request.Plan.TagIds);
        Assert.Null(request.Plan.CoverImageUrl);
        Assert.Null(request.Plan.Rights);
        Assert.NotNull(request.Plan.Responsibility);
        Assert.True(request.Plan.Responsibility.ResponsiblePersonConfirmed);
        Assert.NotEmpty(request.Plan.Responsibility.Authors);
        Assert.Null(request.Plan.Responsibility.EffectiveAt);
    }
}
