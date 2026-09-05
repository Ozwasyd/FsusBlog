using System.Text.Json;

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
        var reader = Reader(authority);

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
            .Returns(Draft(articleId: 7, serverRevision: 3, clientRevision: "client-write-3"));
        var reader = Reader(authority, DraftContextProvider());
        var selector = new RevisionCompareSourceSelector(
            RevisionCompareSourceKind.CurrentDraft,
            DraftKey: "draft-key",
            ExpectedServerRevision: 3,
            DocumentEpoch: "document-epoch-3");

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(Context(), 7, selector);

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        Assert.True(RevisionComparePackageSeal.Verify(result.Package!));
        Assert.Equal(3, result.Package!.ServerRevision);
        Assert.Equal("document-epoch-3", result.Package.DocumentEpoch);
        Assert.NotEqual("client-write-3", result.Package.DocumentEpoch);
        Assert.Contains(result.Package.Metadata, static value => value.FieldId == "status" && value.CanonicalValue == "1");
        Assert.Equal(
            RevisionCompareSnapshotState.Present,
            result.Package.Snapshots.Single(static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights).State);
    }

    [Theory]
    [InlineData(8, 3, "document-epoch-3", RevisionComparePackageReadStatus.Unavailable)]
    [InlineData(7, 4, "document-epoch-3", RevisionComparePackageReadStatus.Stale)]
    [InlineData(7, 3, "other-epoch", RevisionComparePackageReadStatus.Stale)]
    public async Task ReadAuthorizedAsync_RejectsCrossArticleOrStaleDraftCoordinates(
        int draftArticleId,
        long expectedServerRevision,
        string documentEpoch,
        RevisionComparePackageReadStatus expectedStatus)
    {
        IAuthoringRevisionCompareAuthority authority = Authority();
        authority.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>())
            .Returns(Draft(draftArticleId, 3, "client-write-3"));
        var reader = Reader(authority, DraftContextProvider());

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
        var reader = Reader(authority);

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
        var reader = Reader(authority);

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
        var reader = Reader(authority);

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
        Assert.Equal(
            [typeof(IAuthoringRevisionCompareAuthority), typeof(IAuthoringRevisionCompareDraftContextAuthority)],
            packageReaderDependencies);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_DraftIsUnavailableWithoutExternalContextProvider()
    {
        IAuthoringRevisionCompareAuthority authority = Authority();
        authority.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>())
            .Returns(Draft(7, 3, "client-write-3"));
        var reader = Reader(authority);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(
            Context(),
            7,
            new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: 3,
                DocumentEpoch: "document-epoch-3"));

        Assert.Equal(RevisionComparePackageReadStatus.Unavailable, result.Status);
        Assert.Null(result.Package);
    }

    [Fact]
    public async Task DraftContextAuthority_RejectsAmbiguousProviders()
    {
        IAuthoringRevisionCompareDraftContextProvider provider = DraftContextProvider();
        var authority = new AuthoringRevisionCompareDraftContextAuthority([provider, provider]);
        var request = new AuthoringRevisionCompareDraftContextRequest(
            Context(),
            7,
            "draft-key",
            3,
            "document-epoch-3",
            RightsPayloadDigest());

        AuthoringRevisionCompareDraftContextResult result = await authority.ReadAsync(request, default);

        Assert.Equal(RevisionComparePackageReadStatus.Invalid, result.Status);
        Assert.Null(result.Context);
    }

    [Fact]
    public async Task DraftContextAuthority_RejectsProviderScopeOrRightsSubstitution()
    {
        var request = new AuthoringRevisionCompareDraftContextRequest(
            Context(),
            7,
            "draft-key",
            3,
            "document-epoch-3",
            RightsPayloadDigest());
        IAuthoringRevisionCompareDraftContextProvider provider = Substitute.For<IAuthoringRevisionCompareDraftContextProvider>();
        provider.ReadAsync(request, Arg.Any<CancellationToken>()).Returns(call =>
        {
            AuthoringRevisionCompareDraftContextRequest substituted = request with
            {
                Reader = request.Reader with
                {
                    SiteScope = "other-site"
                }
            };
            AuthoringRevisionCompareDraftContext context = AuthoringRevisionCompareDraftContextAuthority.Seal(
                substituted,
                [
                    RevisionCompareSnapshot.Present(
                        RevisionCompareSnapshotKind.Rights,
                        "wrong-rights",
                        1,
                        JsonSerializer.SerializeToUtf8Bytes(new ArticleRightsRequest { Enabled = false })),
                    RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                    RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
                ]);
            return new AuthoringRevisionCompareDraftContextResult(
                RevisionComparePackageReadStatus.Available,
                context);
        });
        var authority = new AuthoringRevisionCompareDraftContextAuthority([provider]);

        AuthoringRevisionCompareDraftContextResult result = await authority.ReadAsync(request, default);

        Assert.Equal(RevisionComparePackageReadStatus.Stale, result.Status);
        Assert.Null(result.Context);
    }

    private static IAuthoringRevisionCompareAuthority Authority(long currentRevisionId = 11)
    {
        IAuthoringRevisionCompareAuthority authority = Substitute.For<IAuthoringRevisionCompareAuthority>();
        authority.GetAuthorizedArticleAsync(Context(), 7, Arg.Any<CancellationToken>())
            .Returns(new AuthoringRevisionCompareArticle(7, currentRevisionId));
        authority.GetCurrentRevisionIdAsync(7, Arg.Any<CancellationToken>()).Returns(currentRevisionId);
        return authority;
    }

    private static AuthoringRevisionComparePackageReader Reader(
        IAuthoringRevisionCompareAuthority authority,
        IAuthoringRevisionCompareDraftContextProvider? provider = null)
        => new(
            authority,
            new AuthoringRevisionCompareDraftContextAuthority(
                provider is null ? [] : [provider]));

    private static IAuthoringRevisionCompareDraftContextProvider DraftContextProvider()
    {
        IAuthoringRevisionCompareDraftContextProvider provider = Substitute.For<IAuthoringRevisionCompareDraftContextProvider>();
        provider.ReadAsync(Arg.Any<AuthoringRevisionCompareDraftContextRequest>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                AuthoringRevisionCompareDraftContextRequest request = call.Arg<AuthoringRevisionCompareDraftContextRequest>();
                if (!string.Equals(request.DocumentEpoch, "document-epoch-3", StringComparison.Ordinal))
                {
                    return new AuthoringRevisionCompareDraftContextResult(RevisionComparePackageReadStatus.Stale, null);
                }
                RevisionCompareSnapshot rights = RevisionCompareSnapshot.Present(
                    RevisionCompareSnapshotKind.Rights,
                    "draft-rights:external:3",
                    1,
                    JsonSerializer.SerializeToUtf8Bytes(Draft(7, 3, "client-write-3").Rights));
                AuthoringRevisionCompareDraftContext context = AuthoringRevisionCompareDraftContextAuthority.Seal(
                    request,
                    [
                        rights,
                        RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                        RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
                    ]);
                return new AuthoringRevisionCompareDraftContextResult(
                    RevisionComparePackageReadStatus.Available,
                    context);
            });
        return provider;
    }

    private static string RightsPayloadDigest()
        => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes(Draft(7, 3, "client-write-3").Rights)));

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
