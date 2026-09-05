using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Authoring;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringRevisionComparePackageReaderTests
{
    [Fact]
    public async Task ReadAuthorizedAsync_DoesNotReadSourceWhenPermissionOrArticleAdmissionFails()
    {
        IAuthoringRevisionCompareAuthority authority = Substitute.For<IAuthoringRevisionCompareAuthority>();
        authority.GetAuthorizedArticleAsync(Context(), 7, Arg.Any<CancellationToken>())
            .Returns((AuthoringRevisionCompareArticle?)null);
        var reader = new AuthoringRevisionComparePackageReader(authority);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(
            Context(),
            7,
            HistoricalSelector());

        Assert.Equal(RevisionComparePackageReadStatus.Unavailable, result.Status);
        await authority.DidNotReceiveWithAnyArgs().GetRevisionAsync(default, default, default);
        await authority.DidNotReceiveWithAnyArgs().GetDraftAsync(default, default!, default);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_SealsExactDraftOwnerEpochAndTypedMetadata()
    {
        IAuthoringRevisionCompareAuthority authority = Authority();
        authority.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>())
            .Returns(Draft(articleId: 7, serverRevision: 3, clientRevision: "epoch-3"));
        var reader = new AuthoringRevisionComparePackageReader(authority);
        var selector = new RevisionCompareSourceSelector(
            RevisionCompareSourceKind.CurrentDraft,
            DraftKey: "draft-key",
            ExpectedServerRevision: 3,
            DocumentEpoch: "epoch-3");

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(Context(), 7, selector);

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        Assert.True(RevisionComparePackageSeal.Verify(result.Package!));
        Assert.Equal(3, result.Package!.ServerRevision);
        Assert.Equal("epoch-3", result.Package.DocumentEpoch);
        Assert.Contains(result.Package.Metadata, static value => value.FieldId == "status" && value.CanonicalValue == "1");
        Assert.Equal(
            RevisionCompareSnapshotState.Present,
            result.Package.Snapshots.Single(static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights).State);
    }

    [Theory]
    [InlineData(8, 3, "epoch-3", RevisionComparePackageReadStatus.Unavailable)]
    [InlineData(7, 4, "epoch-3", RevisionComparePackageReadStatus.Stale)]
    [InlineData(7, 3, "other-epoch", RevisionComparePackageReadStatus.Stale)]
    public async Task ReadAuthorizedAsync_RejectsCrossArticleOrStaleDraftCoordinates(
        int draftArticleId,
        long expectedServerRevision,
        string documentEpoch,
        RevisionComparePackageReadStatus expectedStatus)
    {
        IAuthoringRevisionCompareAuthority authority = Authority();
        authority.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>())
            .Returns(Draft(draftArticleId, 3, "epoch-3"));
        var reader = new AuthoringRevisionComparePackageReader(authority);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(
            Context(),
            7,
            new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: expectedServerRevision,
                DocumentEpoch: documentEpoch));

        Assert.Equal(expectedStatus, result.Status);
        Assert.Null(result.Package);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_CurrentRevisionRechecksPointerAfterAuthoritativeRead()
    {
        IAuthoringRevisionCompareAuthority authority = Authority(currentRevisionId: 11);
        authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(Revision(articleId: 7));
        authority.GetCurrentRevisionIdAsync(7, Arg.Any<CancellationToken>()).Returns(12);
        var reader = new AuthoringRevisionComparePackageReader(authority);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(
            Context(),
            7,
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision, RevisionId: 11));

        Assert.Equal(RevisionComparePackageReadStatus.Stale, result.Status);
        Assert.Null(result.Package);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_HistoricalRevisionDoesNotReinterpretCurrentPointer()
    {
        IAuthoringRevisionCompareAuthority authority = Authority(currentRevisionId: 99);
        authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(Revision(articleId: 7));
        var reader = new AuthoringRevisionComparePackageReader(authority);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(
            Context(),
            7,
            HistoricalSelector());

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        Assert.Equal(11, result.Package!.RevisionId);
        await authority.DidNotReceiveWithAnyArgs().GetCurrentRevisionIdAsync(default, default);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RepresentsMissingImmutableSnapshotsWithoutFallback()
    {
        IAuthoringRevisionCompareAuthority authority = Authority();
        authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>())
            .Returns(Revision(articleId: 7, missingRights: true));
        var reader = new AuthoringRevisionComparePackageReader(authority);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(Context(), 7, HistoricalSelector());

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        Assert.Equal(
            RevisionCompareSnapshotState.Missing,
            result.Package!.Snapshots.Single(static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights).State);
        Assert.Equal(
            RevisionCompareSnapshotState.Missing,
            result.Package.Snapshots.Single(static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Responsibility).State);
    }

    [Fact]
    public void RuntimeAdapter_DependsOnExistingAuthoringAuthorityBoundary()
    {
        Type[] authorityDependencies = typeof(AuthoringRevisionCompareAuthority)
            .GetConstructors()
            .Single()
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Type[] packageReaderDependencies = typeof(AuthoringRevisionComparePackageReader)
            .GetConstructors()
            .Single()
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Contains(typeof(IAuthoringDraftLifecycle), authorityDependencies);
        Assert.Equal([typeof(IAuthoringRevisionCompareAuthority)], packageReaderDependencies);
    }

    private static IAuthoringRevisionCompareAuthority Authority(long currentRevisionId = 11)
    {
        IAuthoringRevisionCompareAuthority authority = Substitute.For<IAuthoringRevisionCompareAuthority>();
        authority.GetAuthorizedArticleAsync(Context(), 7, Arg.Any<CancellationToken>())
            .Returns(new AuthoringRevisionCompareArticle(7, currentRevisionId));
        authority.GetCurrentRevisionIdAsync(7, Arg.Any<CancellationToken>()).Returns(currentRevisionId);
        return authority;
    }

    private static RevisionCompareReadContext Context()
        => new(5, "primary", Guid.Parse("297dfbc4-ddaa-4830-9455-d88e6c8f29de"));

    private static RevisionCompareSourceSelector HistoricalSelector()
        => new(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11);

    private static ServerDraftResponse Draft(int articleId, long serverRevision, string clientRevision)
        => new(
            "draft-key",
            articleId,
            "Draft title",
            "raw\r\nmarkdown\n",
            "Summary",
            null,
            2,
            [4, 3],
            clientRevision,
            1,
            null,
            DateTime.UtcNow,
            new ArticleRightsRequest { Enabled = true, LicenseType = "all-rights-reserved" },
            11,
            serverRevision);

    private static ArticleRevisionDetailResponse Revision(
        int articleId,
        bool missingRights = false)
        => new(
            "11",
            articleId,
            1,
            "Revision title",
            "raw\nmarkdown\n",
            "Summary",
            null,
            2,
            [4, 3],
            "diff",
            "5",
            DateTime.UtcNow,
            null,
            null,
            !missingRights,
            missingRights ? null : Rights(),
            null,
            null);

    private static ArticleRevisionRightsSnapshotResponse Rights()
        => new(
            "21",
            true,
            "all-rights-reserved",
            null,
            null,
            null,
            null,
            "append-attribution",
            300,
            true,
            true,
            true,
            "policy-hash",
            "content-hash",
            DateTime.UtcNow);
}
