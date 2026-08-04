using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class PublicContentFixtureSeederTests
{
    [Fact]
    public void SecurityMatrixOutboxOwnership_RequiresExplicitFixtureOwnershipAndDisabledDispatcher()
    {
        static IConfiguration Configuration(params (string Key, string Value)[] values)
            => new ConfigurationBuilder()
                .AddInMemoryCollection(values.ToDictionary(
                    static item => item.Key,
                    static item => (string?)item.Value))
                .Build();

        Assert.True(PublicContentFixtureSeeder.OwnsSecurityMatrixOutbox(Configuration(
            ("PublicContentFixture:SecurityMatrixOwnsOutbox", "true"),
            ("ArticleMutationOutbox:Enabled", "false"))));
        Assert.False(PublicContentFixtureSeeder.OwnsSecurityMatrixOutbox(Configuration(
            ("PublicContentFixture:SecurityMatrixOwnsOutbox", "true"),
            ("ArticleMutationOutbox:Enabled", "true"))));
        Assert.False(PublicContentFixtureSeeder.OwnsSecurityMatrixOutbox(Configuration(
            ("ArticleMutationOutbox:Enabled", "false"))));
    }

    [Fact]
    public void SecurityMatrixOwnedOutboxHandoff_RequiresPublishedObligationAndNoTombstones()
    {
        PublicHotArtifactObligation published = Obligation(PublicHotArtifactObligationState.Published);

        Assert.True(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady([], [], null));
        Assert.True(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady([], [], published));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady(
            [],
            [],
            Obligation(PublicHotArtifactObligationState.Processing)));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady(
            [
                new PublicArtifactTombstone(
                    ArticleId: 23,
                    Generation: 5,
                    RevokedAtUnixMilliseconds: 1,
                    PurgeConfirmed: true,
                    TransitionPending: false)
            ],
            [],
            published));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady(
            [],
            [
                new PublicArtifactTombstone(
                    ArticleId: 23,
                    Generation: 5,
                    RevokedAtUnixMilliseconds: 1,
                    PurgeConfirmed: true,
                    TransitionPending: false)
            ],
            published));
    }

    [Fact]
    public void SecurityMatrixPublicationConvergence_RequiresProcessedEventPerArticleAndNoTombstones()
    {
        int[] articleIds = [17, 23];
        var processed = new[]
        {
            new ArticleMutationOutboxEvent { AggregateId = 17, Status = "processed" },
            new ArticleMutationOutboxEvent { AggregateId = 23, Status = "processed" }
        };

        Assert.True(PublicContentFixtureSeeder.IsSecurityMatrixPublicationConverged(
            articleIds,
            processed,
            []));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixPublicationConverged(
            articleIds,
            processed[..1],
            []));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixPublicationConverged(
            articleIds,
            [
                processed[0],
                new ArticleMutationOutboxEvent { AggregateId = 23, Status = "processing" }
            ],
            []));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixPublicationConverged(
            articleIds,
            processed,
            [
                new PublicArtifactTombstone(
                    ArticleId: 23,
                    Generation: 5,
                    RevokedAtUnixMilliseconds: 1,
                    PurgeConfirmed: true,
                    TransitionPending: false)
            ]));
    }

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

    private static PublicHotArtifactObligation Obligation(PublicHotArtifactObligationState state)
        => new(
            ObligationId: "obligation",
            TargetGeneration: 5,
            DirtyReasons: PublicHotArtifactDirtyReason.Content,
            ArticleIds: [23],
            RequiresFullRebuild: false,
            ExpectedReleaseIds: new Dictionary<int, long>(),
            AttemptNumber: 1,
            State: state,
            LastFailureKind: PublicHotArtifactFailureKind.None,
            NextEligibleAt: DateTimeOffset.MinValue,
            Attempts: []);
}
