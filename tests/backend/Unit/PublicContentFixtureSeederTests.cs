using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class PublicContentFixtureSeederTests
{
    [Fact]
    public void BuildPaginationProjection_UsesProductionCodecWithOneGenerationAndPageSize()
    {
        DateTime createdAtUtc = new(2026, 9, 14, 8, 0, 0, DateTimeKind.Utc);
        var codec = new ArticleListCursorCodec(
            new EphemeralDataProtectionProvider(),
            TimeProvider.System);
        var rows = new[]
        {
            new PublicContentPaginationBoundaryRow(10, 9010, createdAtUtc, 0, 90),
            new PublicContentPaginationBoundaryRow(100, 9910, createdAtUtc.AddSeconds(-1), 0, 990),
            new PublicContentPaginationBoundaryRow(1000, 99910, createdAtUtc.AddSeconds(-2), 0, 9990)
        };

        PublicContentPaginationProjection projection = PublicContentFixtureSeeder.BuildPaginationProjection(
            generation: 47,
            articleCount: 10_023,
            ownedArticleCount: 10_023,
            rows,
            codec);

        Assert.Equal(10, projection.PageSize);
        Assert.Equal(47, projection.Generation);
        Assert.Equal([10, 100, 1000], projection.Cursors.Select(static item => item.LogicalPage));
        for (int index = 0; index < rows.Length; index++)
        {
            Assert.True(codec.TryDecode(
                projection.Cursors[index].Cursor,
                categoryId: null,
                tagId: null,
                normalizedKeyword: string.Empty,
                pageSize: 10,
                queryVersion: 47,
                sort: ArticleListSortMode.Latest,
                out ArticleListCursorPosition decoded));
            Assert.Equal(rows[index].ArticleId, decoded.Id);
            Assert.Equal(rows[index].CreateTimeUtc, decoded.CreateTimeUtc);
            Assert.False(codec.TryDecode(
                projection.Cursors[index].Cursor,
                categoryId: null,
                tagId: null,
                normalizedKeyword: string.Empty,
                pageSize: 20,
                queryVersion: 47,
                sort: ArticleListSortMode.Latest,
                out _));
        }
    }

    [Fact]
    public void BuildPaginationProjection_RejectsMissingDeepBoundary()
    {
        var codec = Substitute.For<IArticleListCursorCodec>();
        var rows = new[]
        {
            new PublicContentPaginationBoundaryRow(10, 9010, DateTime.UtcNow, 0, 90),
            new PublicContentPaginationBoundaryRow(100, 9910, DateTime.UtcNow, 0, 990)
        };

        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.BuildPaginationProjection(
            generation: 1,
            articleCount: 10_020,
            ownedArticleCount: 10_020,
            rows,
            codec));
        codec.DidNotReceiveWithAnyArgs().Encode(default, default, default, default, default, default, default);
    }

    [Fact]
    public void AddPaginationBoundaryEvidence_PreservesExistingIdentityAndAddsScopedObservation()
    {
        var identities = new List<PublicContentEntityIdentity>
        {
            new("article", "9010", "domain-created", "article-published")
        };
        var observations = new List<PublicContentObservedEntity>
        {
            new()
            {
                Kind = "article",
                Id = "9010",
                CapabilityHint = "article-published",
                Fields = new Dictionary<string, object?> { ["status"] = "published" }
            }
        };
        var cursor = new PublicContentPaginationCursor(
            10,
            "production-opaque-cursor",
            new PublicContentPaginationBoundaryIdentity(
                "9010",
                new DateTime(2026, 9, 14, 8, 0, 0, DateTimeKind.Utc),
                0,
                90));

        PublicContentFixtureSeeder.AddPaginationBoundaryEvidence(
            identities,
            observations,
            "fxpc:pagination:run",
            cursor);

        Assert.Single(identities);
        Assert.Contains(observations, item => item.Kind == "article"
            && item.Id == "9010"
            && item.CapabilityHint == "article-pagination-deep");
    }

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
