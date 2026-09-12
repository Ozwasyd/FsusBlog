using System.Collections.Immutable;

using FsusBlog.Server.Services.Articles.Bulk;
using FsusBlog.Server.Services.Authoring;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkProductionAuthorityTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task CallerFrozenSelectionsRequireCanonicalIdentity(
        int kindValue)
    {
        var kind = (ArticleBulkSelectionKind)kindValue;
        IAuthorSavedViewStore store = Substitute.For<IAuthorSavedViewStore>();
        IAuthorSavedViewQueryValidator validator = Substitute.For<IAuthorSavedViewQueryValidator>();
        IArticleBulkQuerySelectionAuthority query = Substitute.For<IArticleBulkQuerySelectionAuthority>();
        var authority = new ArticleBulkSelectionAuthority(store, validator, query);
        var actor = new ArticleBulkActor("42", "site-1", ArticleBulkDigest.Of("actor"));
        ImmutableArray<string> articleIds = ["article-1", "article-2"];
        string identityDigest = ArticleBulkDigest.Of(new
        {
            Kind = kind,
            ArticleIds = articleIds,
            actor.SiteId
        });
        var selection = new ArticleBulkSelection(kind, articleIds, null, identityDigest);

        ArticleBulkSelectionResolution resolution = await authority.ResolveAsync(
            selection,
            actor,
            CancellationToken.None);

        Assert.Equal(articleIds, await MaterializeAsync(resolution.OrderedArticleIds));
        Assert.Equal(identityDigest, resolution.ResolutionDigest);
        Assert.Equal(
            "article-bulk.selection-identity-drift",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() => authority.ResolveAsync(
                selection with
                {
                    IdentityDigest = ArticleBulkDigest.Of("tampered")
                },
                actor,
                CancellationToken.None))).Code);
    }

    [Fact]
    public async Task SavedViewUsesStoreValidatorAndCanonicalQueryAuthorityExactlyOnce()
    {
        IAuthorSavedViewStore store = Substitute.For<IAuthorSavedViewStore>();
        IAuthorSavedViewQueryValidator validator = Substitute.For<IAuthorSavedViewQueryValidator>();
        IArticleBulkQuerySelectionAuthority queryAuthority =
            Substitute.For<IArticleBulkQuerySelectionAuthority>();
        var actor = new ArticleBulkActor("42", "site-1", ArticleBulkDigest.Of("actor"));
        var owner = new AuthorSavedViewOwner(42, actor.SiteId);
        Guid viewId = Guid.Parse("82f3f31b-9cc3-4a67-9982-ec7aaf9f70c8");
        var query = new AuthorSavedViewQuery(
            AuthorSavedViewContract.SchemaVersion,
            [],
            new AuthorSavedViewSort(
                new AuthorSavedViewFieldReference(
                    AuthorSavedViewFieldKind.Date,
                    AuthorSavedViewContract.UpdatedAtField),
                AuthorSavedViewSortDirection.Descending,
                AuthorSavedViewNullPlacement.Last,
                "temporal",
                AuthorSavedViewContract.ArticleIdentityTieBreaker,
                "UTC"),
            [
                new AuthorSavedViewFieldReference(
                    AuthorSavedViewFieldKind.Date,
                    AuthorSavedViewContract.UpdatedAtField)
            ],
            100);
        string queryDigest = AuthorSavedViewContract.ComputeQueryDigest(query);
        string dependencyDigest = AuthorSavedViewContract.ComputeDependencyDigest([]);
        var view = new AuthorSavedView(
            viewId,
            owner,
            AuthorSavedViewContract.SchemaVersion,
            7,
            "review",
            query,
            queryDigest,
            dependencyDigest,
            false,
            0,
            AuthorSavedViewLifecycleState.Active,
            DateTime.UnixEpoch,
            DateTime.UnixEpoch,
            "view-content");
        var validation = new AuthorSavedViewQueryValidationResult(
            true,
            query,
            queryDigest,
            dependencyDigest,
            [],
            []);
        store.GetAsync(owner, viewId, Arg.Any<CancellationToken>()).Returns(view);
        validator.ValidateAsync(owner, query, Arg.Any<CancellationToken>()).Returns(validation);
        queryAuthority.ResolveSavedViewAsync(owner, view, validation, Arg.Any<CancellationToken>())
            .Returns(new ArticleBulkSelectionResolution(
                ArticleBulkDigest.Of("query-authority"),
                ArticleBulkDigest.Of("query-resolution"),
                Stream(["article-7"])));
        string identityDigest = ArticleBulkDigest.Of(new
        {
            view.Id,
            view.Revision,
            view.QueryDigest,
            view.DependencyDigest,
            view.ContentDigest
        });
        var selection = new ArticleBulkSelection(
            ArticleBulkSelectionKind.SavedView,
            [],
            viewId.ToString("D"),
            identityDigest);
        var authority = new ArticleBulkSelectionAuthority(store, validator, queryAuthority);

        ArticleBulkSelectionResolution resolution = await authority.ResolveAsync(
            selection,
            actor,
            CancellationToken.None);

        Assert.Equal(["article-7"], await MaterializeAsync(resolution.OrderedArticleIds));
        await store.Received(1).GetAsync(owner, viewId, Arg.Any<CancellationToken>());
        await validator.Received(1).ValidateAsync(owner, query, Arg.Any<CancellationToken>());
        await queryAuthority.Received(1).ResolveSavedViewAsync(
            owner,
            view,
            validation,
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task MissingDirectQueryOwnerRemainsExplicitlyUnavailable()
    {
        var selection = new ArticleBulkSelectionAuthority(
            Substitute.For<IAuthorSavedViewStore>(),
            Substitute.For<IAuthorSavedViewQueryValidator>(),
            new UnavailableArticleBulkQuerySelectionAuthority());
        var actor = new ArticleBulkActor("42", "site-1", ArticleBulkDigest.Of("actor"));

        Assert.Equal(
            "article-bulk.query-selection-authority-unavailable",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() => selection.ResolveAsync(
                new ArticleBulkSelection(
                    ArticleBulkSelectionKind.Query,
                    [],
                    "query-1",
                    ArticleBulkDigest.Of("query")),
                actor,
                CancellationToken.None))).Code);
        Assert.Equal(
            ["article-property-query", "author-article-query", "author-search-query"],
            ArticleBulkProductionAuthorityAvailability.SelectionDependencies
                .Where(static dependency => !dependency.Available)
                .Select(static dependency => dependency.Id)
                .Order(StringComparer.Ordinal));
    }

    [Fact]
    public void CompositionRegistersOnlyPlanningAndFailClosedAuthorityBoundaries()
    {
        var services = new ServiceCollection();

        services.AddArticleBulkPlanning();

        Assert.Contains(services, descriptor => descriptor.ServiceType == typeof(ArticleBulkPlanAuthority));
        Assert.Contains(services, descriptor =>
            descriptor.ServiceType == typeof(IArticleBulkSelectionAuthority)
            && descriptor.ImplementationType == typeof(ArticleBulkSelectionAuthority));
        Assert.DoesNotContain(services, descriptor =>
            descriptor.ServiceType.Name.Contains("Controller", StringComparison.Ordinal)
            || descriptor.ServiceType.Name.Contains("Endpoint", StringComparison.Ordinal));
    }

    private static async Task<string[]> MaterializeAsync(IAsyncEnumerable<string> source)
    {
        var values = new List<string>();
        await foreach (string value in source)
        {
            values.Add(value);
        }
        return [.. values];
    }

    private static async IAsyncEnumerable<string> Stream(IEnumerable<string> values)
    {
        foreach (string value in values)
        {
            yield return value;
            await Task.Yield();
        }
    }
}
