using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringRevisionComparePackageReaderTests
{
    [Fact]
    public void RuntimeDomainRegistrations_ResolveRevisionComparePlanningServices()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        services.AddSingleton(Substitute.For<IAuthoringDraftLifecycle>());
        services.AddSingleton(Substitute.For<IAuthoringRevisionCompareAuthority>());
        using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
        using IServiceScope scope = provider.CreateScope();

        Assert.Contains(
            services,
            static descriptor => descriptor.ServiceType == typeof(IAuthoringRevisionCompareAuthority)
                && descriptor.ImplementationType == typeof(AuthoringRevisionCompareAuthority));
        Assert.Contains(
            services,
            static descriptor => descriptor.ServiceType == typeof(IAuthoringRevisionCompareDraftContextProvider)
                && descriptor.ImplementationType == typeof(AuthoringRevisionCompareDraftContextProvider));
        Assert.IsType<AuthoringRevisionCompareDraftContextAuthority>(
            scope.ServiceProvider.GetRequiredService<IAuthoringRevisionCompareDraftContextAuthority>());
        Assert.IsType<AuthoringRevisionComparePackageReader>(
            scope.ServiceProvider.GetRequiredService<IRevisionComparePackageReader>());
        Assert.IsType<RevisionComparePlanner>(scope.ServiceProvider.GetRequiredService<RevisionComparePlanner>());
        Assert.IsType<RevisionComparePlanVerifier>(scope.ServiceProvider.GetRequiredService<RevisionComparePlanVerifier>());
    }

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

    [Theory]
    [InlineData(" https://historical.example/articles/Original%2fPath?version=1#Section ")]
    [InlineData(null)]
    public void ToRevisionDetailResponse_ProjectsStoredCanonicalUrlVerbatim(string? canonicalUrl)
    {
        ArticleRevisionDetailResponse revision = MapRevision(11, canonicalUrl);

        ArticleRevisionRightsSnapshotResponse rights = Assert.IsType<ArticleRevisionRightsSnapshotResponse>(revision.Rights);
        Assert.Equal(canonicalUrl, rights.CanonicalUrl);
        Assert.Equal("stored-policy-hash", rights.PolicyHash);
        Assert.Equal("stored-content-hash", rights.ContentCanonicalHash);
        Assert.True(revision.PackageComplete);
    }

    [Theory]
    [InlineData(" https://historical.example/articles/Original%2fPath?version=1#Section ")]
    [InlineData(null)]
    public async Task ReadAuthorizedAsync_ExposesStoredHistoricalCanonicalUrl(string? canonicalUrl)
    {
        IAuthoringRevisionCompareAuthority authority = Authority(currentRevisionId: 99);
        authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>())
            .Returns(MapRevision(11, canonicalUrl));
        var reader = Reader(authority);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(Context(), 7, HistoricalSelector());

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        RevisionCompareSnapshot snapshot = result.Package!.Snapshots.Single(
            static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights);
        Assert.Equal(RevisionCompareSnapshotState.Present, snapshot.State);
        Assert.Equal("rights:21", snapshot.Reference);
        using JsonDocument payload = JsonDocument.Parse(snapshot.Payload.ToArray());
        JsonElement url = payload.RootElement.GetProperty("CanonicalUrl");
        Assert.Equal(canonicalUrl is null ? JsonValueKind.Null : JsonValueKind.String, url.ValueKind);
        Assert.Equal(canonicalUrl, url.GetString());
        ArticleRevisionRightsSnapshotResponse rights = Assert.IsType<ArticleRevisionRightsSnapshotResponse>(
            JsonSerializer.Deserialize<ArticleRevisionRightsSnapshotResponse>(snapshot.Payload.AsSpan()));
        Assert.Equal(canonicalUrl, rights.CanonicalUrl);
        Assert.Equal("stored-policy-hash", rights.PolicyHash);
        Assert.Equal("stored-content-hash", rights.ContentCanonicalHash);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_KeepsMissingRightsDistinctFromStoredNullCanonicalUrl()
    {
        ArticleRevisionDetailResponse revision = MapRevision(11, null, missingRights: true);
        Assert.Null(revision.Rights);
        Assert.False(revision.PackageComplete);
        IAuthoringRevisionCompareAuthority authority = Authority();
        authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(revision);
        var reader = Reader(authority);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(Context(), 7, HistoricalSelector());

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        RevisionCompareSnapshot snapshot = result.Package!.Snapshots.Single(
            static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights);
        Assert.Equal(RevisionCompareSnapshotState.Missing, snapshot.State);
        Assert.Null(snapshot.Reference);
        Assert.Empty(snapshot.Payload);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_PreservesEachSelectedRevisionsCanonicalUrl()
    {
        const string FirstUrl = "https://historical.example/first";
        const string SecondUrl = "https://historical.example/second";
        IAuthoringRevisionCompareAuthority authority = Authority(currentRevisionId: 99);
        authority.GetRevisionAsync(7, 11, Arg.Any<CancellationToken>()).Returns(MapRevision(11, FirstUrl));
        authority.GetRevisionAsync(7, 12, Arg.Any<CancellationToken>()).Returns(MapRevision(12, SecondUrl));
        var reader = Reader(authority);

        foreach ((long revisionId, string canonicalUrl) in new[] { (11L, FirstUrl), (12L, SecondUrl) })
        {
            RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(
                Context(),
                7,
                new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: revisionId));

            Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
            Assert.Equal(revisionId, result.Package!.RevisionId);
            RevisionCompareSnapshot snapshot = result.Package.Snapshots.Single(
                static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights);
            ArticleRevisionRightsSnapshotResponse rights = Assert.IsType<ArticleRevisionRightsSnapshotResponse>(
                JsonSerializer.Deserialize<ArticleRevisionRightsSnapshotResponse>(snapshot.Payload.AsSpan()));
            Assert.Equal(canonicalUrl, rights.CanonicalUrl);
        }
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
        Type[] draftContextProviderDependencies = typeof(AuthoringRevisionCompareDraftContextProvider)
            .GetConstructors()
            .Single()
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Contains(typeof(IAuthoringDraftLifecycle), authorityDependencies);
        Assert.Equal([typeof(IAuthoringDraftLifecycle)], draftContextProviderDependencies);
        Assert.Equal(
            [typeof(IAuthoringRevisionCompareAuthority), typeof(IAuthoringRevisionCompareDraftContextAuthority)],
            packageReaderDependencies);
    }

    [Fact]
    public async Task DraftContextProvider_RereadsAndSealsExactAuthoritativeDraftContext()
    {
        DateTime updatedAt = new(2026, 9, 8, 5, 0, 0, DateTimeKind.Utc);
        ServerDraftResponse draft = Draft(7, 3, "client-write-3", updatedAt: updatedAt);
        IAuthoringDraftLifecycle authoring = Substitute.For<IAuthoringDraftLifecycle>();
        authoring.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>()).Returns(draft);
        var provider = new AuthoringRevisionCompareDraftContextProvider(authoring);
        string epoch = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(Context(), 7, draft);
        var request = new AuthoringRevisionCompareDraftContextRequest(
            Context(),
            7,
            "draft-key",
            3,
            epoch,
            RightsPayloadDigest(draft));

        AuthoringRevisionCompareDraftContextResult result = await provider.ReadAsync(request, default);

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        Assert.Equal(epoch, result.Context!.DocumentEpoch);
        Assert.Equal(request.RightsPayloadDigest, result.Context.RightsPayloadDigest);
        Assert.Equal(
            request.RightsPayloadDigest,
            result.Context.Snapshots.Single(static snapshot => snapshot.Kind == RevisionCompareSnapshotKind.Rights)
                .PayloadDigest);
        Assert.All(result.Context.Snapshots, static snapshot =>
            Assert.NotEqual(RevisionCompareSnapshotState.Missing, snapshot.State));
        await authoring.Received(1).GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task DraftContextProvider_RejectsSiteArticleRevisionAndEpochDriftWithoutLeakingContext()
    {
        DateTime updatedAt = new(2026, 9, 8, 5, 0, 0, DateTimeKind.Utc);
        ServerDraftResponse draft = Draft(7, 3, "client-write-3", updatedAt: updatedAt);
        IAuthoringDraftLifecycle authoring = Substitute.For<IAuthoringDraftLifecycle>();
        authoring.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>()).Returns(draft);
        var provider = new AuthoringRevisionCompareDraftContextProvider(authoring);
        string epoch = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(Context(), 7, draft);
        var accepted = new AuthoringRevisionCompareDraftContextRequest(
            Context(),
            7,
            "draft-key",
            3,
            epoch,
            RightsPayloadDigest(draft));
        AuthoringRevisionCompareDraftContextRequest[] rejected =
        [
            accepted with { Reader = accepted.Reader with { SiteScope = "other" } },
            accepted with { ArticleId = 8 },
            accepted with { ServerRevision = 4 },
            accepted with { DocumentEpoch = "draft-epoch-v1:" + new string('0', 64) },
            accepted with { RightsPayloadDigest = new string('0', 64) }
        ];

        foreach (AuthoringRevisionCompareDraftContextRequest request in rejected)
        {
            AuthoringRevisionCompareDraftContextResult result = await provider.ReadAsync(request, default);

            Assert.NotEqual(RevisionComparePackageReadStatus.Available, result.Status);
            Assert.Null(result.Context);
        }
    }

    [Fact]
    public void DraftDocumentEpoch_BindsOwnerSiteArticleRevisionTimeSourceAndRights()
    {
        DateTime updatedAt = new(2026, 9, 8, 5, 0, 0, DateTimeKind.Utc);
        ServerDraftResponse draft = Draft(7, 3, "client-write-3", updatedAt: updatedAt);
        string expected = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(Context(), 7, draft);
        string repeated = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(Context(), 7, draft);
        string changedSource = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(
            Context(),
            7,
            draft with
            {
                Content = draft.Content + "changed"
            });
        string changedRights = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(
            Context(),
            7,
            draft with
            {
                Rights = draft.Rights with
                {
                    Enabled = false
                }
            });
        string changedSite = AuthoringRevisionCompareDraftContextProvider.CreateDocumentEpoch(
            Context() with
            {
                SiteScope = "other"
            },
            7,
            draft);

        Assert.Equal(expected, repeated);
        Assert.Equal(3, new[] { changedSource, changedRights, changedSite }.Distinct(StringComparer.Ordinal).Count());
        Assert.DoesNotContain(expected, new[] { changedSource, changedRights, changedSite });
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

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DraftContextAuthority_ReturnsInvalidForMalformedSnapshotSet(bool duplicateRights)
    {
        var request = new AuthoringRevisionCompareDraftContextRequest(
            Context(),
            7,
            "draft-key",
            3,
            "document-epoch-3",
            RightsPayloadDigest());
        RevisionCompareSnapshot rights = RevisionCompareSnapshot.Present(
            RevisionCompareSnapshotKind.Rights,
            "draft-rights:external:3",
            1,
            JsonSerializer.SerializeToUtf8Bytes(Draft(7, 3, "client-write-3").Rights));
        RevisionCompareSnapshot malformed = duplicateRights
            ? rights
            : RevisionCompareSnapshot.NotApplicable((RevisionCompareSnapshotKind)int.MaxValue);
        AuthoringRevisionCompareDraftContext context = AuthoringRevisionCompareDraftContextAuthority.Seal(
            request,
            [
                rights,
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]) with
        {
            Snapshots = new RevisionCompareSnapshot[]
            {
                rights,
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                malformed
            }
        };
        IAuthoringRevisionCompareDraftContextProvider provider = Substitute.For<IAuthoringRevisionCompareDraftContextProvider>();
        provider.ReadAsync(request, Arg.Any<CancellationToken>()).Returns(
            new AuthoringRevisionCompareDraftContextResult(RevisionComparePackageReadStatus.Available, context));
        var authority = new AuthoringRevisionCompareDraftContextAuthority([provider]);

        AuthoringRevisionCompareDraftContextResult result = await authority.ReadAsync(request, default);

        Assert.Equal(RevisionComparePackageReadStatus.Invalid, result.Status);
        Assert.Null(result.Context);
    }

    [Fact]
    public async Task DraftContextAuthority_SealCopiesCallerSnapshotList()
    {
        var request = new AuthoringRevisionCompareDraftContextRequest(
            Context(),
            7,
            "draft-key",
            3,
            "document-epoch-3",
            RightsPayloadDigest());
        RevisionCompareSnapshot rights = RevisionCompareSnapshot.Present(
            RevisionCompareSnapshotKind.Rights,
            "draft-rights:external:3",
            1,
            JsonSerializer.SerializeToUtf8Bytes(Draft(7, 3, "client-write-3").Rights));
        RevisionCompareSnapshot[] snapshots =
        [
            rights,
            RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
            RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
        ];
        AuthoringRevisionCompareDraftContext context = AuthoringRevisionCompareDraftContextAuthority.Seal(
            request,
            snapshots);
        snapshots[0] = RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights);
        IAuthoringRevisionCompareDraftContextProvider provider = Substitute.For<IAuthoringRevisionCompareDraftContextProvider>();
        provider.ReadAsync(request, Arg.Any<CancellationToken>()).Returns(
            new AuthoringRevisionCompareDraftContextResult(RevisionComparePackageReadStatus.Available, context));
        var authority = new AuthoringRevisionCompareDraftContextAuthority([provider]);

        AuthoringRevisionCompareDraftContextResult result = await authority.ReadAsync(request, default);

        Assert.Equal(RevisionComparePackageReadStatus.Available, result.Status);
        Assert.Same(rights, Assert.Single(result.Context!.Snapshots, static snapshot =>
            snapshot.Kind == RevisionCompareSnapshotKind.Rights));
    }

    [Fact]
    public async Task DraftContextAuthority_ReturnsInvalidForNullSnapshotSet()
    {
        var request = new AuthoringRevisionCompareDraftContextRequest(
            Context(),
            7,
            "draft-key",
            3,
            "document-epoch-3",
            RightsPayloadDigest());
        AuthoringRevisionCompareDraftContext context = AuthoringRevisionCompareDraftContextAuthority.Seal(
            request,
            [
                RevisionCompareSnapshot.Present(
                    RevisionCompareSnapshotKind.Rights,
                    "draft-rights:external:3",
                    1,
                    JsonSerializer.SerializeToUtf8Bytes(Draft(7, 3, "client-write-3").Rights)),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]) with
        {
            Snapshots = null!
        };
        IAuthoringRevisionCompareDraftContextProvider provider = Substitute.For<IAuthoringRevisionCompareDraftContextProvider>();
        provider.ReadAsync(request, Arg.Any<CancellationToken>()).Returns(
            new AuthoringRevisionCompareDraftContextResult(RevisionComparePackageReadStatus.Available, context));
        var authority = new AuthoringRevisionCompareDraftContextAuthority([provider]);

        AuthoringRevisionCompareDraftContextResult result = await authority.ReadAsync(request, default);

        Assert.Equal(RevisionComparePackageReadStatus.Invalid, result.Status);
        Assert.Null(result.Context);
    }

    [Fact]
    public async Task ReadAuthorizedAsync_RejectsOversizedDraftBeforeContextOrByteCopy()
    {
        IAuthoringRevisionCompareAuthority authority = Authority();
        authority.GetDraftAsync(5, "draft-key", Arg.Any<CancellationToken>())
            .Returns(Draft(
                7,
                3,
                "client-write-3",
                new string('x', RevisionCompareContract.AbsoluteMaxSourceBytes + 1)));
        IAuthoringRevisionCompareDraftContextProvider provider = DraftContextProvider();
        var reader = Reader(authority, provider);

        RevisionComparePackageReadResult result = await reader.ReadAuthorizedAsync(
            Context(),
            7,
            new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: 3,
                DocumentEpoch: "document-epoch-3"));

        Assert.Equal(RevisionComparePackageReadStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_compare_source_budget_exceeded", result.ReasonCode);
        Assert.Null(result.Package);
        await provider.DidNotReceiveWithAnyArgs().ReadAsync(default!, default);
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

    private static string RightsPayloadDigest(ServerDraftResponse? draft = null)
        => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes((draft ?? Draft(7, 3, "client-write-3")).Rights)));

    private static RevisionCompareReadContext Context()
        => new(5, "primary", Guid.Parse("297dfbc4-ddaa-4830-9455-d88e6c8f29de"));

    private static RevisionCompareSourceSelector HistoricalSelector()
        => new(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11);

    private static ServerDraftResponse Draft(
        int articleId,
        long serverRevision,
        string clientRevision,
        string content = "raw\r\nmarkdown\n",
        DateTime? updatedAt = null)
        => new(
            "draft-key",
            articleId,
            "Draft title",
            content,
            "Summary",
            null,
            2,
            [4, 3],
            clientRevision,
            1,
            null,
            updatedAt ?? DateTime.UtcNow,
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

    private static ArticleRevisionDetailResponse MapRevision(
        long revisionId,
        string? canonicalUrl,
        bool missingRights = false)
    {
        MethodInfo? mapper = typeof(AuthoringDraftLifecycleService).GetMethod(
            "ToRevisionDetailResponse",
            BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(mapper);
        var revision = new ArticleRevision
        {
            Id = revisionId,
            ArticleId = 7,
            RevisionNo = 1,
            Title = "Revision title",
            MarkdownContent = "raw\nmarkdown\n"
        };
        ArticleRightsSnapshot? rights = missingRights ? null : new ArticleRightsSnapshot
        {
            Id = 21,
            ArticleId = 7,
            ArticleRevisionId = revisionId,
            CanonicalUrl = canonicalUrl,
            PolicyHash = "stored-policy-hash",
            ContentCanonicalHash = "stored-content-hash"
        };
        var responsibility = new ArticleResponsibilitySnapshot
        {
            ArticleId = 7,
            ArticleRevisionId = revisionId
        };
        return Assert.IsType<ArticleRevisionDetailResponse>(mapper.Invoke(null, [revision, rights, responsibility, null]));
    }

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
            null,
            "policy-hash",
            "content-hash",
            DateTime.UtcNow);
}
