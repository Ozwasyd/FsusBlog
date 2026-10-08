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
public sealed class ArticleVaultAcceptedSourceAdapterTests
{
    [Theory]
    [MemberData(nameof(ArticleVaultMaterializationPreflightTests.Sources), MemberType = typeof(ArticleVaultMaterializationPreflightTests))]
    public async Task CanonicalReader_PreservesBytesAndUsesRevisionIdRatherThanRevisionNumber(byte[] source)
    {
        Fixture fixture = new(source);
        ArticleVaultAcceptedSource accepted = await fixture.ReadAsync();
        Assert.Equal(source, accepted.Package.RawMarkdown.ToArray());
        Assert.Equal(ArticleVaultManifestCodec.CaptureSourceBytes(source), accepted.Source);
        Assert.Equal(4, accepted.Package.RevisionId);
        Assert.Equal(900, accepted.Package.RevisionNo);
        Assert.Equal("revision:4:900", accepted.Package.SourceIdentity);
        Assert.Equal(RevisionCompareSourceKind.HistoricalRevision, accepted.Package.SourceKind);
        Assert.Equal(accepted.Source.Sha256, fixture.LastSelector!.ExpectedSourceDigest);
        Assert.Equal(AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, fixture.LastContext!.SiteScope);
        Assert.Equal("https://site.example", fixture.LastPermissionRequest!.Owner.SiteScope);
        Assert.Equal(fixture.Bundle.AdminPrincipalId, fixture.LastContext.AdminPrincipalId);
        Assert.Equal(2, fixture.PermissionReads);
        Assert.False(accepted.CanCommitBase);
        Assert.Equal(fixture.Bundle.Plan.RootManifestSha256, accepted.Instruction.RootManifestSha256);
        Assert.Equal(fixture.Result.ContentSha256, accepted.Instruction.ServerResultSha256);
    }

    [Theory]
    [InlineData("source")]
    [InlineData("article")]
    [InlineData("revision-id")]
    [InlineData("source-identity")]
    [InlineData("current-revision")]
    [InlineData("unavailable")]
    [InlineData("seal")]
    public async Task ResealedOrUnavailablePackage_DoesNotReplaceExactAcceptedSource(string mutation)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        fixture.PackageMutation = package =>
        {
            if (mutation == "unavailable")
            {
                return RevisionComparePackageReadResult.Unavailable();
            }
            if (mutation == "seal")
            {
                typeof(RevisionComparePackage).GetField("<PackageDigest>k__BackingField",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                    .SetValue(package, ArticleVaultOperationFixture.DigestA);
                return RevisionComparePackageReadResult.Available(package);
            }
            return RevisionComparePackageReadResult.Available(RevisionComparePackageSeal.Create(
                mutation == "article" ? 102 : package.ArticleId,
                mutation == "current-revision" ? RevisionCompareSourceKind.CurrentRevision : package.SourceKind,
                mutation == "source-identity" ? "revision:99:900" : package.SourceIdentity,
                mutation == "revision-id" ? 99 : package.RevisionId,
                package.RevisionNo, null, null,
                mutation == "source" ? "different\r\n"u8.ToArray() : package.RawMarkdown.ToArray(),
                package.Metadata, package.Snapshots));
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(1, fixture.PermissionReads);
    }

    [Theory]
    [InlineData("before-denied")]
    [InlineData("after-denied")]
    [InlineData("session-drift")]
    [InlineData("wrong-owner")]
    [InlineData("wrong-article")]
    [InlineData("tampered-digest")]
    public async Task LivePermissionRefusalOrDrift_ProducesNoAcceptedSource(string mutation)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        fixture.PermissionMutation = (snapshot, read) => mutation switch
        {
            "before-denied" when read == 1 => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
            "after-denied" when read == 2 => snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
            "session-drift" when read == 2 => SealPermission(snapshot with { SessionRevision = ArticleVaultOperationFixture.DigestB }),
            "wrong-owner" => SealPermission(snapshot with { Owner = snapshot.Owner with { AdminPrincipalId = 999 } }),
            "wrong-article" => SealPermission(snapshot with { Decisions = [snapshot.Decisions[0] with { ArticleId = 102 }] }),
            "tampered-digest" => snapshot with { ContentDigest = ArticleVaultOperationFixture.DigestA },
            _ => snapshot
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(mutation is "after-denied" or "session-drift" ? 1 : 0, fixture.SourceReads);
    }

    [Fact]
    public async Task TrustedSiteMismatch_DoesNotCallAnyReaderOrPermissionAuthority()
    {
        Fixture fixture = new("body\r\n"u8.ToArray(), "other-site");
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(0, fixture.SourceReads);
        Assert.Equal(0, fixture.PermissionReads);
        await fixture.Store.DidNotReceiveWithAnyArgs().LoadSealedAsync(default!, default!, default);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ExactResultOrOperationMismatch_DoesNotReadSource(bool resultMismatch)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Adapter.ReadAsync(
            fixture.Identity, fixture.Result.ResultReference,
            resultMismatch ? ArticleVaultOperationFixture.DigestA : fixture.Result.ContentSha256,
            resultMismatch ? fixture.ItemOperation : "unknown-item"));
        Assert.Equal(0, fixture.SourceReads);
        Assert.Equal(0, fixture.PermissionReads);
    }

    [Fact]
    public async Task SiteConfigurationDriftBeforeRead_CannotRebindAnExistingAdapter()
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        fixture.Configuration["SITE_BASEURL"] = "https://other-site.example";
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(0, fixture.SourceReads);
        Assert.Equal(0, fixture.PermissionReads);
        await fixture.Store.DidNotReceiveWithAnyArgs().LoadSealedAsync(default!, default!, default);
    }

    [Fact]
    public async Task SiteConfigurationDriftDuringRead_CannotReleaseAcceptedBytes()
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        fixture.PackageMutation = package =>
        {
            fixture.Configuration["SITE_BASEURL"] = "https://other-site.example";
            return RevisionComparePackageReadResult.Available(package);
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.ReadAsync());
        Assert.Equal(2, fixture.PermissionReads);
    }

    [Fact]
    public async Task CancellationAfterRead_ReturnsNoAcceptedSourceOrPermissionCompletion()
    {
        using CancellationTokenSource cancellation = new();
        Fixture fixture = new("body\r\n"u8.ToArray());
        fixture.PackageMutation = package =>
        {
            cancellation.Cancel();
            return RevisionComparePackageReadResult.Available(package);
        };
        await Assert.ThrowsAsync<OperationCanceledException>(() => fixture.ReadAsync(cancellation.Token));
        Assert.Equal(1, fixture.PermissionReads);
    }

    private static AuthorRecentArticleHistoryPermissionSnapshot SealPermission(AuthorRecentArticleHistoryPermissionSnapshot snapshot)
        => snapshot with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
        };

    /// <summary>Test-only port substitutes; the historical package is read by the actual production reader.</summary>
    private sealed class Fixture
    {
        internal readonly ArticleVaultSealedExecutionBundle Bundle;
        internal readonly ArticleVaultExecutionResult Result;
        internal readonly ArticleVaultOperationIdentity Identity;
        internal readonly IArticleVaultExecutionStore Store = Substitute.For<IArticleVaultExecutionStore>();
        internal readonly ArticleVaultAcceptedSourceAdapter Adapter;
        internal readonly IConfiguration Configuration;
        internal string ItemOperation => Bundle.Plan.Groups[0].Items[0].OperationIdentity;
        internal int PermissionReads;
        internal int SourceReads;
        internal RevisionCompareSourceSelector? LastSelector;
        internal RevisionCompareReadContext? LastContext;
        internal AuthorRecentArticleHistoryPermissionRequest? LastPermissionRequest;
        internal Func<RevisionComparePackage, RevisionComparePackageReadResult>? PackageMutation;
        internal Func<AuthorRecentArticleHistoryPermissionSnapshot, int, AuthorRecentArticleHistoryPermissionSnapshot>? PermissionMutation;

        internal Fixture(byte[] source, string trustedSite = "site-primary")
        {
            Bundle = ArticleVaultOperationFixture.Bundle(source);
            Result = ArticleVaultOperationFixture.NoOpResult(Bundle);
            Identity = ArticleVaultOperationFixture.Identity(Bundle.Plan);
            Store.LoadSealedAsync(Identity.PlanReference, Identity.PlanSha256, Arg.Any<CancellationToken>()).Returns(Bundle);
            Store.LoadResultAsync(Result.ResultReference, Arg.Any<CancellationToken>()).Returns(Result);
            IAuthoringRevisionCompareAuthority authority = Substitute.For<IAuthoringRevisionCompareAuthority>();
            authority.GetAuthorizedArticleAsync(Arg.Any<RevisionCompareReadContext>(), 101, Arg.Any<CancellationToken>())
                .Returns(new AuthoringRevisionCompareArticle(101, 4));
            authority.GetRevisionAsync(101, 4, Arg.Any<CancellationToken>()).Returns(
                new ArticleRevisionDetailResponse("4", 101, 900, "Title", Encoding.UTF8.GetString(source),
                    null, null, 1, [], "", "1001", DateTime.UnixEpoch, null, null, true, null, null, null));
            var canonicalReader = new AuthoringRevisionComparePackageReader(authority,
                Substitute.For<IAuthoringRevisionCompareDraftContextAuthority>());
            IRevisionComparePackageReader reader = Substitute.For<IRevisionComparePackageReader>();
            reader.ReadAuthorizedAsync(Arg.Any<RevisionCompareReadContext>(), Arg.Any<int>(),
                Arg.Any<RevisionCompareSourceSelector>(), Arg.Any<CancellationToken>()).Returns(async call =>
            {
                SourceReads++;
                LastContext = call.Arg<RevisionCompareReadContext>();
                LastSelector = call.Arg<RevisionCompareSourceSelector>();
                RevisionComparePackageReadResult read = await canonicalReader.ReadAuthorizedAsync(
                    LastContext, call.Arg<int>(), LastSelector, call.Arg<CancellationToken>());
                return read.Package is { } package && PackageMutation is not null ? PackageMutation(package) : read;
            });
            IAuthorRecentArticleHistoryPermissionProjectionProvider permissions =
                Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
            permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    PermissionReads++;
                    LastPermissionRequest = call.Arg<AuthorRecentArticleHistoryPermissionRequest>();
                    AuthorRecentArticleHistoryPermissionSnapshot snapshot = SealPermission(new(
                        AuthorRecentArticleHistoryPermissionSnapshotStatus.Current, LastPermissionRequest.Owner,
                        ArticleVaultOperationFixture.DigestA, ArticleVaultOperationFixture.DigestA,
                        ArticleVaultOperationFixture.DigestA,
                        [new(101, true, true, ArticleVaultOperationFixture.DigestA)], string.Empty));
                    return Task.FromResult(PermissionMutation?.Invoke(snapshot, PermissionReads) ?? snapshot);
                });
            Configuration = new ConfigurationBuilder().AddInMemoryCollection(
                new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.example/" }).Build();
            Adapter = new(Store, reader, permissions, Configuration, trustedSite);
        }

        internal Task<ArticleVaultAcceptedSource> ReadAsync(CancellationToken cancellationToken = default)
            => Adapter.ReadAsync(Identity, Result.ResultReference, Result.ContentSha256, ItemOperation, cancellationToken);
    }
}
