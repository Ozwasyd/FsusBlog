using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed partial class ArticleVaultCurrentSourceReaderTests
{
    [Theory]
    [MemberData(nameof(ArticleVaultMaterializationPreflightTests.Sources), MemberType = typeof(ArticleVaultMaterializationPreflightTests))]
    public async Task ActualCurrentRevisionReader_PreservesRawBytesAndFiniteMetadataWithoutGrantingExecution(byte[] bytes)
    {
        Fixture fixture = new(bytes);
        ArticleVaultCurrentSourceSnapshot snapshot = await fixture.ReadAsync();
        Assert.Equal(bytes, snapshot.Package.RawMarkdown.ToArray());
        Assert.Equal(fixture.Item.Server.Source, snapshot.Source);
        Assert.Equal(RevisionCompareSourceKind.CurrentRevision, fixture.LastSelector!.Kind);
        Assert.Equal(4, fixture.LastSelector.RevisionId);
        Assert.Equal(snapshot.Source.Sha256, fixture.LastSelector.ExpectedSourceDigest);
        Assert.Equal(900, snapshot.Package.RevisionNo);
        Assert.Equal("revision:4:900", snapshot.Package.SourceIdentity);
        Assert.Equal(AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, fixture.LastReaderContext!.SiteScope);
        Assert.Equal(fixture.Context.AdminPrincipalId, fixture.LastReaderContext.AdminPrincipalId);
        Assert.Equal(["category-id", "cover-image-url", "summary", "tag-ids", "title"],
            snapshot.Package.Metadata.Select(static field => field.FieldId));
        Assert.Equal(2, fixture.ObservationReads);
        Assert.Equal(2, fixture.PermissionReads);
        Assert.False(snapshot.CanExecute);
        Assert.False(snapshot.CanCommitBase);
        await fixture.Store.DidNotReceiveWithAnyArgs().SealAsync(default!, default);
        await fixture.Store.DidNotReceiveWithAnyArgs().SaveResultAsync(default!, default);
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("site")]
    [InlineData("vault")]
    [InlineData("device")]
    [InlineData("article")]
    [InlineData("portable")]
    [InlineData("plan-digest")]
    [InlineData("group")]
    [InlineData("operation")]
    public async Task CrossDocumentAndExactPlanReferences_DoNotReadRevisionBytes(string mutation)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        fixture.Context = mutation switch
        {
            "actor" => fixture.Context with { AdminPrincipalId = 999 },
            "site" => fixture.Context with { SiteIdentity = "foreign-site" },
            "vault" => fixture.Context with { VaultIdentity = "foreign-vault" },
            "device" => fixture.Context with { DeviceIdentity = "foreign-device" },
            "article" => fixture.Context with { ArticleId = 102 },
            "portable" => fixture.Context with { PortableArticleIdentity = "foreign-article" },
            _ => fixture.Context
        };
        fixture.Reference = mutation switch
        {
            "plan-digest" => fixture.Reference with { PlanSha256 = ArticleVaultOperationFixture.DigestA },
            "group" => fixture.Reference with { GroupIdentity = "foreign-group" },
            "operation" => fixture.Reference with { OperationIdentity = "foreign-operation" },
            _ => fixture.Reference
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(0, fixture.SourceReads);
    }

    [Theory]
    [InlineData("before-revision")]
    [InlineData("after-revision")]
    [InlineData("before-denied")]
    [InlineData("after-denied")]
    [InlineData("before-incomplete")]
    [InlineData("after-incomplete")]
    [InlineData("after-permission")]
    [InlineData("after-dependency")]
    [InlineData("after-observation-digest")]
    [InlineData("after-rights")]
    [InlineData("after-publication")]
    public async Task OriginalGroupGuardAndBeforeAfterAuthorityDrift_ReturnNoSnapshot(string mutation)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        fixture.ObservationMutation = (observation, read) => mutation switch
        {
            "before-revision" when read == 1 => observation with { ServerRevision = 5 },
            "after-revision" when read == 2 => observation with { ServerRevision = 5 },
            "before-denied" when read == 1 => observation with { Permitted = false },
            "after-denied" when read == 2 => observation with { Permitted = false },
            "after-permission" when read == 2 => observation with { PermissionSha256 = ArticleVaultOperationFixture.DigestA },
            "after-dependency" when read == 2 => observation with { DependencySha256 = ArticleVaultOperationFixture.DigestA },
            "after-observation-digest" when read == 2 => observation with { ContentSha256 = ArticleVaultOperationFixture.DigestA },
            "after-rights" when read == 2 => observation with { RightsBoundarySha256 = ArticleVaultOperationFixture.DigestB },
            "after-publication" when read == 2 => observation with { PublicationBoundarySha256 = ArticleVaultOperationFixture.DigestB },
            _ => observation
        };
        fixture.MissingObservationRead = mutation == "before-incomplete" ? 1 : mutation == "after-incomplete" ? 2 : 0;
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(mutation.StartsWith("before-", StringComparison.Ordinal) ? 0 : 1, fixture.SourceReads);
    }

    [Theory]
    [InlineData("source")]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("historical")]
    [InlineData("identity")]
    [InlineData("seal")]
    [InlineData("actual-current-drift")]
    public async Task CanonicalPackageSealAndPinnedCurrentRevision_CannotBeReplacedWithResealedAssertions(string mutation)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        if (mutation == "actual-current-drift")
        {
            fixture.CurrentRevision = 5;
        }
        fixture.PackageMutation = package =>
        {
            if (mutation == "seal")
            {
                typeof(RevisionComparePackage).GetField("<PackageDigest>k__BackingField",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                    .SetValue(package, ArticleVaultOperationFixture.DigestA);
                return RevisionComparePackageReadResult.Available(package);
            }
            return RevisionComparePackageReadResult.Available(RevisionComparePackageSeal.Create(
                mutation == "article" ? 102 : package.ArticleId,
                mutation == "historical" ? RevisionCompareSourceKind.HistoricalRevision : package.SourceKind,
                mutation == "identity" ? "revision:99:900" : package.SourceIdentity,
                mutation == "revision" ? 99 : package.RevisionId,
                package.RevisionNo, null, null,
                mutation == "source" ? "body\n"u8.ToArray() : package.RawMarkdown.ToArray(),
                package.Metadata, package.Snapshots));
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(1, fixture.ObservationReads);
    }

    [Theory]
    [InlineData("before-denied")]
    [InlineData("after-denied")]
    [InlineData("session")]
    [InlineData("site-configuration")]
    [InlineData("wrong-owner")]
    [InlineData("permission-seal")]
    public async Task OriginalLivePermissionGuardAndScopeDrift_ReturnNoCurrentSource(string mutation)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        fixture.PermissionMutation = (snapshot, read) => mutation switch
        {
            "before-denied" when read == 1 => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
            "after-denied" when read == 2 => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
            "session" when read == 2 => SealPermission(snapshot with { SessionRevision = ArticleVaultOperationFixture.DigestB }),
            "wrong-owner" => SealPermission(snapshot with { Owner = snapshot.Owner with { AdminPrincipalId = 999 } }),
            "permission-seal" => snapshot with { ContentDigest = ArticleVaultOperationFixture.DigestA },
            _ => snapshot
        };
        if (mutation == "site-configuration")
        {
            fixture.AfterSource = () => fixture.Configuration["SITE_BASEURL"] = "https://other.example/";
        }
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CancellationOrExpiryAfterReading_DoesNotReturnPartialCurrentFacts(bool cancel)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        using var cancellation = new CancellationTokenSource();
        fixture.AfterSource = () =>
        {
            if (cancel)
                cancellation.Cancel();
            else
                fixture.Clock.NowUnixMs = fixture.Bundle.Plan.ExpiresAtUnixMs + 1;
        };
        if (cancel)
            await Assert.ThrowsAsync<OperationCanceledException>(() => fixture.ReadAsync(cancellation.Token));
        else
            await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(1, fixture.ObservationReads);
        Assert.Equal(1, fixture.PermissionReads);
    }

    [Fact]
    public async Task OriginalThreeWayAdmission_BindsActualServerBytesAndRejectsUnrelatedLocalBytes()
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        ArticleVaultSourceAdmissionInput input = fixture.Input() with
        {
            ServerBytes = "caller assertion"u8.ToArray()
        };
        ArticleVaultCurrentSourceBinding bound = await fixture.Reader.BindServerAsync(input, fixture.Context);
        Assert.Equal("body\r\n"u8.ToArray(), bound.Source.CopyServerBytes());
        Assert.Equal(input.Binding, bound.Source.Binding);
        Assert.False(bound.CanExecute);
        Assert.False(bound.CanCommitBase);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Reader.BindServerAsync(
            input with
            {
                LocalBytes = "other bytes"u8.ToArray()
            }, fixture.Context));
        Assert.Equal(2, fixture.SourceReads);
        await fixture.Store.DidNotReceiveWithAnyArgs().SaveResultAsync(default!, default);
    }

    [Fact]
    public async Task BlockedOriginalPlan_CanReadCurrentServerFactsWithoutChangingItsDecisionOrCoordinates()
    {
        Fixture fixture = new("server\r\n"u8.ToArray(), blocked: true);
        string originalDigest = fixture.Bundle.Plan.ContentSha256;
        Assert.Equal(VaultSyncPlanStatus.Blocked, fixture.Bundle.Plan.Status);
        ArticleVaultCurrentSourceSnapshot snapshot = await fixture.ReadAsync();
        Assert.Equal(5, snapshot.Package.RevisionId);
        Assert.Equal("server\r\n"u8.ToArray(), snapshot.Package.RawMarkdown.ToArray());
        Assert.Equal(originalDigest, fixture.Bundle.Plan.ContentSha256);
        Assert.Equal(VaultSyncPlanStatus.Blocked, fixture.Bundle.Plan.Status);
        Assert.Empty(fixture.Bundle.Plan.OperationOrder);
        Assert.False(snapshot.CanExecute);
        Assert.False(snapshot.CanCommitBase);
    }

    private static ArticleVaultSealedExecutionBundle BlockedBundle(byte[] serverBytes)
    {
        ArticleVaultSealedExecutionBundle baseline = ArticleVaultOperationFixture.Bundle("base\r\n"u8.ToArray());
        ArticleVaultArticleManifest article = baseline.ArticleManifests[0];
        VaultArticleCoordinate local = article.Coordinates.Local with
        {
            Source = ArticleVaultManifestCodec.CaptureSourceBytes("local\r\n"u8)
        };
        local = local with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(local)
        };
        article = article with
        {
            Coordinates = article.Coordinates with
            {
                Local = local
            }
        };
        article = article with
        {
            State = ArticleVaultStateMachine.Derive(article)
        };
        article = article with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(article)
        };
        VaultArticleCoordinate server = article.Coordinates.Server with
        {
            ServerRevision = 5,
            Source = ArticleVaultManifestCodec.CaptureSourceBytes(serverBytes)
        };
        server = server with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(server)
        };
        ArticleVaultServerObservation observation = baseline.PlannedObservations[0] with
        {
            ServerCoordinate = server
        };
        observation = observation with
        {
            ContentSha256 = ArticleVaultSyncPlanCodec.ComputeContentSha256(observation)
        };
        ArticleVaultRootManifest root = baseline.RootManifest with
        {
            Articles = [baseline.RootManifest.Articles[0] with { ManifestSha256 = article.ContentSha256 }]
        };
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        ArticleVaultPlanBuildResult built = ArticleVaultSyncPlanner.Build(new(root, [article], [observation],
            [new("group-primary", [article.PortableArticleIdentity], [])], baseline.Plan.Direction,
            baseline.Plan.CreatedAtUnixMs, baseline.Plan.ExpiresAtUnixMs, false));
        Assert.True(built.IsSuccess, string.Join(',', built.Errors));
        ArticleVaultSyncPlan plan = built.Plan!;
        ArticleVaultSealedExecutionBundle bundle = baseline with
        {
            PlanReference = plan.PlanCandidateIdentity,
            PlanSha256 = plan.ContentSha256,
            Plan = plan,
            RootManifest = root,
            ArticleManifests = [article],
            PlannedObservations = [observation]
        };
        return bundle with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
        };
    }

    private static AuthorRecentArticleHistoryPermissionSnapshot SealPermission(AuthorRecentArticleHistoryPermissionSnapshot snapshot)
        => snapshot with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
        };

    private sealed class Clock : TimeProvider
    {
        internal long NowUnixMs { get; set; } = 1_800_000_000_001;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeMilliseconds(NowUnixMs);
    }

    /// <summary>Diagnostic ports around the actual production CurrentRevision reader; no runtime qualification.</summary>
    private sealed class Fixture
    {
        internal ArticleVaultSealedExecutionBundle Bundle
        {
            get;
        }
        internal IArticleVaultExecutionStore Store { get; } = Substitute.For<IArticleVaultExecutionStore>();
        internal ArticleVaultCurrentSourceReader Reader
        {
            get;
        }
        internal IConfiguration Configuration
        {
            get;
        }
        internal Clock Clock { get; } = new();
        internal ArticleVaultCurrentSourceReference Reference
        {
            get; set;
        }
        internal ArticleVaultConflictReviewContext Context
        {
            get; set;
        }
        internal VaultSyncPlanItem Item => Bundle.Plan.Groups[0].Items[0];
        internal int ObservationReads
        {
            get; set;
        }
        internal int PermissionReads
        {
            get; set;
        }
        internal int SourceReads
        {
            get; set;
        }
        internal int MissingObservationRead
        {
            get; set;
        }
        internal long CurrentRevision { get; set; } = 4;
        internal RevisionCompareSourceSelector? LastSelector
        {
            get; set;
        }
        internal RevisionCompareReadContext? LastReaderContext
        {
            get; set;
        }
        internal Func<ArticleVaultCurrentArticleObservation, int, ArticleVaultCurrentArticleObservation>? ObservationMutation
        {
            get; set;
        }
        internal Func<AuthorRecentArticleHistoryPermissionSnapshot, int, AuthorRecentArticleHistoryPermissionSnapshot>? PermissionMutation
        {
            get; set;
        }
        internal Func<RevisionComparePackage, RevisionComparePackageReadResult>? PackageMutation
        {
            get; set;
        }
        internal Action? AfterSource
        {
            get; set;
        }

        internal Fixture(byte[] bytes, bool blocked = false)
        {
            Bundle = blocked ? BlockedBundle(bytes) : ArticleVaultOperationFixture.Bundle(bytes);
            Reference = new(Bundle.PlanReference, Bundle.PlanSha256, Item.GroupIdentity, Item.OperationIdentity);
            Context = new(Bundle.AdminPrincipalId, Bundle.Plan.SiteIdentity, Bundle.Plan.VaultIdentity,
                Bundle.Plan.DeviceIdentity, 101, Item.PortableArticleIdentity);
            CurrentRevision = Item.Server.ServerRevision!.Value;
            Store.LoadSealedAsync(Bundle.PlanReference, Bundle.PlanSha256, Arg.Any<CancellationToken>()).Returns(Bundle);
            var observations = Substitute.For<IArticleVaultCurrentObservationAuthority>();
            observations.ObserveGroupAsync(Bundle, Bundle.Plan.Groups[0], Arg.Any<CancellationToken>()).Returns(_ =>
            {
                ObservationReads++;
                var value = new ArticleVaultCurrentArticleObservation(Item.PortableArticleIdentity,
                    Item.ServerArticleIdentity, Item.Preconditions.ExpectedServerRevision, Item.Preconditions.ExpectedLifecycle,
                    true, Item.Preconditions.ExpectedPermissionSha256, Item.Server.DependencySha256,
                    ArticleVaultOperationFixture.DigestA, ArticleVaultOperationFixture.DigestA,
                    Item.Server.Source!.Sha256, Item.Preconditions.ServerObservationSha256);
                return Task.FromResult<IReadOnlyList<ArticleVaultCurrentArticleObservation>>(
                    ObservationReads == MissingObservationRead ? [] : [ObservationMutation?.Invoke(value, ObservationReads) ?? value]);
            });
            var authority = Substitute.For<IAuthoringRevisionCompareAuthority>();
            authority.GetAuthorizedArticleAsync(Arg.Any<RevisionCompareReadContext>(), 101, Arg.Any<CancellationToken>())
                .Returns(new AuthoringRevisionCompareArticle(101, Item.Server.ServerRevision));
            authority.GetCurrentRevisionIdAsync(101, Arg.Any<CancellationToken>()).Returns(_ => Task.FromResult<long?>(CurrentRevision));
            authority.GetRevisionAsync(101, CurrentRevision, Arg.Any<CancellationToken>()).Returns(new ArticleRevisionDetailResponse(
                CurrentRevision.ToString(System.Globalization.CultureInfo.InvariantCulture), 101, 900, "Title", Encoding.UTF8.GetString(bytes), "summary", "cover.png", 1, [2, 3],
                "", "1001", DateTime.UnixEpoch, null, null, true, null, null, null));
            var canonicalReader = new AuthoringRevisionComparePackageReader(authority,
                Substitute.For<IAuthoringRevisionCompareDraftContextAuthority>());
            var revisions = Substitute.For<IRevisionComparePackageReader>();
            revisions.ReadAuthorizedAsync(Arg.Any<RevisionCompareReadContext>(), Arg.Any<int>(),
                Arg.Any<RevisionCompareSourceSelector>(), Arg.Any<CancellationToken>()).Returns(async call =>
            {
                SourceReads++;
                LastReaderContext = call.Arg<RevisionCompareReadContext>();
                LastSelector = call.Arg<RevisionCompareSourceSelector>();
                RevisionComparePackageReadResult result = await canonicalReader.ReadAuthorizedAsync(
                    LastReaderContext, call.Arg<int>(), LastSelector, call.Arg<CancellationToken>());
                AfterSource?.Invoke();
                return result.Package is { } package && PackageMutation is not null ? PackageMutation(package) : result;
            });
            var permissions = Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
            permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>()).Returns(call =>
            {
                PermissionReads++;
                var request = call.Arg<AuthorRecentArticleHistoryPermissionRequest>();
                var snapshot = SealPermission(new(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                    request.Owner, ArticleVaultOperationFixture.DigestA, ArticleVaultOperationFixture.DigestA,
                    ArticleVaultOperationFixture.DigestA, [new(101, true, true, ArticleVaultOperationFixture.DigestA)], string.Empty));
                return Task.FromResult(PermissionMutation?.Invoke(snapshot, PermissionReads) ?? snapshot);
            });
            Configuration = new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.example/" }).Build();
            Reader = new(Store, observations, revisions, permissions, Configuration, Clock, Bundle.Plan.SiteIdentity);
        }

        internal Task<ArticleVaultCurrentSourceSnapshot> ReadAsync(CancellationToken cancellationToken = default)
            => Reader.ReadAsync(Reference, Context, cancellationToken);

        internal ArticleVaultSourceAdmissionInput Input()
        {
            var binding = new VaultConflictBinding(Bundle.Plan.SiteIdentity, Bundle.Plan.VaultIdentity,
                Bundle.Plan.DeviceIdentity, Item.PortableArticleIdentity, Item.ServerArticleIdentity,
                Bundle.PlanReference, Bundle.PlanSha256, Item.GroupIdentity, Item.OperationIdentity,
                Item.Preconditions.ArticleManifestSha256, Item.Preconditions.ServerObservationSha256,
                new(Item.Base, Item.Local, Item.Server));
            byte[] source = "body\r\n"u8.ToArray();
            return new(Bundle.Plan, Bundle.RootManifest, Bundle.ArticleManifests, Bundle.PlannedObservations,
                new(Bundle.Plan.CreatedAtUnixMs, Bundle.Plan.Direction, false), binding, source, source, source);
        }
    }
}
