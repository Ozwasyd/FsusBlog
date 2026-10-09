using NSubstitute;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

// Synthetic authority responses exercise only the production read composition.
// No database, responsibility writes, hosted workers or security audit fixtures.
public sealed class CurrentAuthoringResponsibilityReaderTests
{
    [Fact]
    public async Task ReadAuthorizedAsync_ReturnsLatestExistingHistoryWithExactCoordinates()
    {
        var fixture = new ReaderFixture();
        fixture.History = [Version(1), Version(3), Version(2)];

        CurrentAuthoringResponsibilityReadResult result = await fixture.ReadAsync();

        Assert.Equal(CurrentAuthoringResponsibilityReadStatus.Current, result.Status);
        Assert.Equal(Version(3).Id, result.Responsibility!.Id);
        Assert.Equal(7, result.Responsibility.ArticleId);
        Assert.Equal("11", result.Responsibility.ArticleRevisionId);
        Assert.Equal(3, result.Responsibility.ResponsibilityVersion);
        Assert.Equal("Synthetic author 3", Assert.Single(result.Responsibility.Authors).Name);
        await fixture.Service.Received(2).GetHistoryAsync(7, 11, Arg.Any<CancellationToken>());
        await fixture.Authority.Received(2).GetAuthorizedArticleAsync(fixture.Context, 7, Arg.Any<CancellationToken>());
        await fixture.Authority.Received(2).GetRevisionAsync(7, 11, Arg.Any<CancellationToken>());
        await fixture.Service.DidNotReceiveWithAnyArgs().SaveAsync(default, default, default!, default);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_ObservesResponsibilityChangesThroughExistingHistoryApi()
    {
        var fixture = new ReaderFixture();
        CurrentAuthoringResponsibilityReadResult first = await fixture.ReadAsync();
        fixture.History = [Version(2), Version(1)];

        CurrentAuthoringResponsibilityReadResult second = await fixture.ReadAsync();

        Assert.Equal(CurrentAuthoringResponsibilityReadStatus.Current, second.Status);
        Assert.Equal(1, first.Responsibility!.ResponsibilityVersion);
        Assert.Equal(2, second.Responsibility!.ResponsibilityVersion);
        await fixture.Service.Received(4).GetHistoryAsync(7, 11, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ReadAuthorizedAsync_IgnoresPublicationPinnedRevisionResponsibility()
    {
        var fixture = new ReaderFixture();
        fixture.Revision = Revision() with
        {
            Responsibility = new ArticleRevisionResponsibilitySnapshotResponse(
                "90", 99, null, true, [], null, [], null, null, null,
                null, null, null, null, true, default)
        };

        CurrentAuthoringResponsibilityReadResult result = await fixture.ReadAsync();

        Assert.Equal(Version(1).Id, result.Responsibility!.Id);
        Assert.Equal(1, result.Responsibility.ResponsibilityVersion);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RejectsHeadChangedBeforeReadWithoutReadingHistory()
    {
        var fixture = new ReaderFixture { Article = new(7, 12) };

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Stale);

        await fixture.Service.DidNotReceiveWithAnyArgs().GetHistoryAsync(default, default, default);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RejectsHeadChangedDuringRead()
    {
        var fixture = new ReaderFixture();
        fixture.Service.GetHistoryAsync(7, 11, Arg.Any<CancellationToken>()).Returns(_ =>
        {
            fixture.Article = new(7, 12);
            return fixture.History;
        });

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Stale);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RejectsResponsibilityVersionChangedDuringRead()
    {
        var fixture = new ReaderFixture();
        int reads = 0;
        fixture.Service.GetHistoryAsync(7, 11, Arg.Any<CancellationToken>())
            .Returns(_ => ++reads == 1 ? [Version(1)] : [Version(2), Version(1)]);

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Stale);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RejectsChangedPayloadUnderSameVersion()
    {
        var fixture = new ReaderFixture();
        int reads = 0;
        fixture.Service.GetHistoryAsync(7, 11, Arg.Any<CancellationToken>())
            .Returns(_ => ++reads == 1 ? [Version(1)] : [Version(1) with { ResponsiblePersonConfirmed = false }]);

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Stale);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RejectsAbsenceChangedDuringRead()
    {
        var fixture = new ReaderFixture();
        int reads = 0;
        fixture.Service.GetHistoryAsync(7, 11, Arg.Any<CancellationToken>())
            .Returns(_ => ++reads == 1 ? [] : [Version(1)]);

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Stale);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_EmptyHistoryIsAbsentAfterRecheckingAuthority()
    {
        var fixture = new ReaderFixture { History = [] };

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Absent);

        await fixture.Authority.Received(2).GetAuthorizedArticleAsync(fixture.Context, 7, Arg.Any<CancellationToken>());
        await fixture.Service.Received(2).GetHistoryAsync(7, 11, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ReadAuthorizedAsync_UnconfirmedLatestVersionDoesNotFallBackToConfirmedHistory()
    {
        var fixture = new ReaderFixture
        {
            History = [Version(2) with { ResponsiblePersonConfirmed = false }, Version(1)]
        };

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Absent);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_EmptyExplicitAuthorsAreAbsent()
    {
        var fixture = new ReaderFixture { History = [Version(1) with { Authors = [] }] };

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Absent);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_PreservesExplicitInheritanceWithoutInventingSiteAuthor()
    {
        var fixture = new ReaderFixture { History = [Version(1) with { Authors = [], InheritSiteAuthor = true }] };

        CurrentAuthoringResponsibilityReadResult result = await fixture.ReadAsync();

        Assert.Equal(CurrentAuthoringResponsibilityReadStatus.Current, result.Status);
        Assert.True(result.Responsibility!.InheritSiteAuthor);
        Assert.Empty(result.Responsibility.Authors);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_DeniedAndMissingShareUnavailableShape()
    {
        var denied = new ReaderFixture { Article = null };
        var missing = new ReaderFixture { Revision = null };

        Assert.Equal(await denied.ReadAsync(), await missing.ReadAsync());
        AssertNoResponsibility(await denied.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Unavailable);
        await denied.Authority.DidNotReceiveWithAnyArgs().GetRevisionAsync(default, default, default);
        await denied.Service.DidNotReceiveWithAnyArgs().GetHistoryAsync(default, default, default);
        await missing.Service.DidNotReceiveWithAnyArgs().GetHistoryAsync(default, default, default);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RevokedPermissionAfterReadReturnsNoData()
    {
        var fixture = new ReaderFixture();
        fixture.Service.GetHistoryAsync(7, 11, Arg.Any<CancellationToken>()).Returns(_ =>
        {
            fixture.Article = null;
            return fixture.History;
        });

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Unavailable);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_MissingHistoryReturnsNoData()
    {
        var fixture = new ReaderFixture { History = null };

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Unavailable);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_ForeignRevisionCannotEstablishCurrentAuthority()
    {
        var fixture = new ReaderFixture { Revision = Revision() with { ArticleId = 8 } };

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Unavailable);

        await fixture.Service.DidNotReceiveWithAnyArgs().GetHistoryAsync(default, default, default);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_ForeignHistoryReturnsNoData()
    {
        var fixture = new ReaderFixture { History = [Version(1) with { ArticleRevisionId = "12" }] };

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Unavailable);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RevisionRemovedAfterReadReturnsNoData()
    {
        var fixture = new ReaderFixture();
        fixture.Service.GetHistoryAsync(7, 11, Arg.Any<CancellationToken>()).Returns(_ =>
        {
            fixture.Revision = null;
            return fixture.History;
        });

        AssertNoResponsibility(await fixture.ReadAsync(), CurrentAuthoringResponsibilityReadStatus.Unavailable);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_FreezesObservedCollections()
    {
        var fixture = new ReaderFixture();
        var authors = new List<ArticleResponsiblePerson> { new("Synthetic author", null) };
        fixture.History = [Version(1) with { Authors = authors }];

        CurrentAuthoringResponsibilityReadResult result = await fixture.ReadAsync();
        authors.Clear();

        Assert.Single(result.Responsibility!.Authors);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticleResponsiblePerson>)result.Responsibility.Authors).Clear());
    }

    [Fact]
    public async Task ReadAuthorizedAsync_PreCancelledDoesNotReadAuthorities()
    {
        var fixture = new ReaderFixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ReadAsync(cancellation.Token));

        await fixture.Authority.DidNotReceiveWithAnyArgs().GetAuthorizedArticleAsync(default!, default, default);
        await fixture.Service.DidNotReceiveWithAnyArgs().GetHistoryAsync(default, default, default);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_CancellationDuringHistoryPropagatesExactToken()
    {
        var fixture = new ReaderFixture();
        using var cancellation = new CancellationTokenSource();
        fixture.Service.GetHistoryAsync(7, 11, cancellation.Token).Returns(_ =>
        {
            cancellation.Cancel();
            return fixture.History;
        });

        OperationCanceledException exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => fixture.ReadAsync(cancellation.Token));

        Assert.Equal(cancellation.Token, exception.CancellationToken);
        await fixture.Service.Received(1).GetHistoryAsync(7, 11, cancellation.Token);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_CancellationDuringFinalPermissionCheckPropagates()
    {
        var fixture = new ReaderFixture();
        using var cancellation = new CancellationTokenSource();
        int reads = 0;
        fixture.Authority.GetAuthorizedArticleAsync(fixture.Context, 7, cancellation.Token).Returns(_ =>
        {
            if (++reads == 2)
            {
                cancellation.Cancel();
            }
            return fixture.Article;
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.ReadAsync(cancellation.Token));
    }

    private static void AssertNoResponsibility(
        CurrentAuthoringResponsibilityReadResult result,
        CurrentAuthoringResponsibilityReadStatus status)
    {
        Assert.Equal(status, result.Status);
        Assert.Null(result.Responsibility);
    }

    private static ArticleResponsibilityVersionResponse Version(int version)
        => new(
            (100 + version).ToString(System.Globalization.CultureInfo.InvariantCulture),
            7, "11", 1, version, null, false,
            [new ArticleResponsiblePerson($"Synthetic author {version}", null)],
            null, [], null, null, null, null, null, null, null, true, default);

    private static ArticleRevisionDetailResponse Revision()
        => new("11", 7, 1, "Synthetic article", "Synthetic source", null, null, 0, [],
            "Synthetic revision", "5", default, null, null, true, null, null, null);

    private sealed class ReaderFixture
    {
        internal RevisionCompareReadContext Context { get; } = new(5, "primary", Guid.NewGuid());
        internal IAuthoringRevisionCompareAuthority Authority { get; } = Substitute.For<IAuthoringRevisionCompareAuthority>();
        internal IArticleResponsibilityAuthoringService Service { get; } = Substitute.For<IArticleResponsibilityAuthoringService>();
        internal AuthoringRevisionCompareArticle? Article { get; set; } = new(7, 11);
        internal ArticleRevisionDetailResponse? Revision { get; set; } = CurrentAuthoringResponsibilityReaderTests.Revision();
        internal IReadOnlyList<ArticleResponsibilityVersionResponse>? History { get; set; } = [Version(1)];

        internal ReaderFixture()
        {
            Authority.GetAuthorizedArticleAsync(Context, 7, Arg.Any<CancellationToken>()).Returns(_ => Article);
            Authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(_ => Revision);
            Service.GetHistoryAsync(7, 11, Arg.Any<CancellationToken>()).Returns(_ => History);
        }

        internal Task<CurrentAuthoringResponsibilityReadResult> ReadAsync(CancellationToken cancellationToken = default)
            => new CurrentAuthoringResponsibilityReader(Authority, Service)
                .ReadAuthorizedAsync(Context, 7, 11, cancellationToken);
    }
}
