using System.Collections.Immutable;
using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleVaultAuthenticatedConflictReviewAdapterTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task HttpContextMapping_RequiresRealAdminSidInsteadOfOrdinaryAccountSid(bool adminSession)
    {
        var fixture = new Fixture();
        var context = new DefaultHttpContext();
        var claims = new List<Claim>
        {
            new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", "7"), new("sid", "ordinary-account-session")
        };
        if (adminSession)
        {
            claims.Add(new("admin_sid", "current-admin-session"));
        }
        context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "controlled-authentication"));
        if (adminSession)
        {
            ArticleVaultConflictReviewSnapshot result = await fixture.Adapter.ReadFromHttpContextAsync(
                fixture.Reference, 101, context, fixture.Current);
            Assert.False(result.ExecutionAdmission.IsValid);
        }
        else
        {
            await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Adapter.ReadFromHttpContextAsync(
                fixture.Reference, 101, context, fixture.Current));
            Assert.Empty(fixture.Proposals.ReceivedCalls());
        }
        fixture.NoWrites();
    }

    [Fact]
    public async Task AuthenticatedHost_MapsOnlyExactStoredDocumentAndPreservesCanonicalCurrentRefusal()
    {
        var fixture = new Fixture();
        ArticleVaultConflictReviewSnapshot result = await fixture.Adapter.ReadAsync(fixture.Reference,
            101, fixture.Authenticated, fixture.Current);
        Assert.Same(fixture.Stored.Resolution, result.Proposal);
        Assert.Equal(ArticleVaultResolutionPlanner.VerifyCurrent(fixture.Stored.Resolution, fixture.Current), result.CurrentValidation);
        Assert.Equal(ArticleVaultResolutionPlanner.RequireExecutionAdmission(fixture.Stored.Resolution, fixture.Current), result.ExecutionAdmission);
        Assert.Null(result.CurrentEvidence);
        Assert.False(result.ExecutionAdmission.IsValid);
        Assert.Equal(2, fixture.PermissionRequests.Count);
        Assert.All(fixture.PermissionRequests, request => Assert.Equal(new AuthorRecentArticleHistoryOwner(7,
            "https://permission.example"), request.Owner));
        Assert.Equal(fixture.Stored.Checkpoint, Assert.Single(result.Checkpoint!.Checkpoints));
        fixture.NoWrites();
    }

    [Theory]
    [InlineData("anonymous")]
    [InlineData("account")]
    [InlineData("principal")]
    [InlineData("session")]
    public async Task MissingAuthenticatedAdminSession_RefusesBeforePrivateStoreRead(string mutation)
    {
        var fixture = new Fixture();
        EndpointUserContext current = mutation switch
        {
            "anonymous" => fixture.Authenticated with { IsAuthenticated = false },
            "account" => fixture.Authenticated with { IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind },
            "principal" => fixture.Authenticated with { AdminPrincipalId = 0 },
            _ => fixture.Authenticated with { SessionId = null }
        };
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => fixture.Adapter.ReadAsync(
            fixture.Reference, 101, current, fixture.Current));
        Assert.Empty(fixture.Proposals.ReceivedCalls());
        Assert.Empty(fixture.PermissionRequests);
    }

    [Theory]
    [InlineData("article")]
    [InlineData("site")]
    [InlineData("proposal")]
    [InlineData("actor")]
    [InlineData("permission")]
    public async Task ScopeActorOrLivePermissionMismatch_RefusesWithoutCreatingAlternativeAuthority(string mutation)
    {
        var fixture = new Fixture();
        if (mutation == "permission")
        {
            fixture.AllowPermission = false;
        }
        var adapter = mutation == "site"
            ? new ArticleVaultAuthenticatedConflictReviewAdapter(fixture.Proposals, fixture.Reader, "other-site") : fixture.Adapter;
        ArticleVaultConflictReviewReference reference = mutation == "proposal"
            ? fixture.Reference with
            {
                ProposalSha256 = new string('b', 64)
            } : fixture.Reference;
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => adapter.ReadAsync(reference,
            mutation == "article" ? 102 : 101,
            mutation == "actor" ? fixture.Authenticated with
            {
                AdminPrincipalId = 8
            } : fixture.Authenticated, fixture.Current));
        fixture.NoWrites();
    }

    [Fact]
    public async Task CancelledHostRead_RefusesBeforeLookupAndMayRepeatAgainstSameCanonicalInputs()
    {
        var fixture = new Fixture();
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => fixture.Adapter.ReadAsync(fixture.Reference,
            101, fixture.Authenticated, fixture.Current, cancelled.Token));
        Assert.Empty(fixture.Proposals.ReceivedCalls());
        ArticleVaultConflictReviewSnapshot result = await fixture.Adapter.ReadAsync(fixture.Reference,
            101, fixture.Authenticated, fixture.Current);
        Assert.False(result.ExecutionAdmission.IsValid);
        fixture.NoWrites();
    }

    private sealed class Fixture
    {
        internal ArticleVaultRecoveryCheckpointReaderTests.Fixture Stored { get; } = ArticleVaultRecoveryCheckpointReaderTests.Create();
        internal IArticleVaultResolutionProposalStore Proposals { get; } = Substitute.For<IArticleVaultResolutionProposalStore>();
        internal IAuthorRecentArticleHistoryPermissionProjectionProvider Permissions { get; } = Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
        internal List<AuthorRecentArticleHistoryPermissionRequest> PermissionRequests { get; } = [];
        internal bool AllowPermission { get; set; } = true;
        internal EndpointUserContext Authenticated
        {
            get;
        } = new(0, 7, AnonymousIdentityRuntime.AdminPrincipalKind,
            "live-admin-session", true, false);
        internal ArticleVaultConflictReviewReference Reference
        {
            get;
        }
        internal ArticleVaultResolutionPlanInput Current
        {
            get;
        }
        internal ArticleVaultConflictReviewReader Reader
        {
            get;
        }
        internal ArticleVaultAuthenticatedConflictReviewAdapter Adapter
        {
            get;
        }

        internal Fixture()
        {
            Proposals.ReadExactAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<ArticleVaultResolutionPlan?>(Stored.Resolution));
            Permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>())
                .Returns(call =>
                {
                    var request = call.Arg<AuthorRecentArticleHistoryPermissionRequest>();
                    PermissionRequests.Add(request);
                    var snapshot = new AuthorRecentArticleHistoryPermissionSnapshot(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                        request.Owner, Digest, Digest, Digest, [new(101, AllowPermission, AllowPermission, Digest)], string.Empty);
                    return Task.FromResult(snapshot with
                    {
                        ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
                    });
                });
            Reference = new(Stored.Resolution.ResolutionOperationIdentity, Stored.Resolution.ContentSha256,
                new(Stored.Operation, Stored.Checkpoint.Sequence, Stored.Checkpoint.ContentSha256));
            ArticleVaultSealedExecutionBundle bundle = Stored.Bundle;
            var metadata = new ArticleVaultScalarMetadataInput(bundle.Plan, bundle.RootManifest, bundle.ArticleManifests, bundle.PlannedObservations,
                new(bundle.Plan.CreatedAtUnixMs, bundle.Plan.Direction, false), Stored.Resolution.Binding,
                ReadOnlyMemory<byte>.Empty, ReadOnlyMemory<byte>.Empty, ReadOnlyMemory<byte>.Empty);
            var evidence = new ArticleVaultConflictEvidence(ArticleVaultConflictSchemas.Evidence, 1,
                ArticleVaultConflictRegistry.ContentSha256, Stored.Resolution.Binding, [], string.Empty);
            evidence = evidence with
            {
                ContentSha256 = ArticleVaultConflictCodec.ComputeContentSha256(evidence)
            };
            ImmutableArray<VaultGitSourceFacts> sources = [new("article-one", bundle.ArticleManifests[0].Coordinates.Local.Source!.Sha256, [])];
            var git = new ArticleVaultGitFacts(ArticleVaultGitFactDecoder.Schema, 1,
                new("site-one", "vault-one", "device-one", "agent-one", Digest, bundle.RootManifest.ContentSha256, VaultPathComparisonPolicy.Ordinal),
                VaultGitAvailability.NotPresent, "git-not-present", null, null, null, null, null, null, null, [], sources,
                ArticleVaultGitFactDecoder.ComputeWorktreeSha256(sources), ArticleVaultGitFactDecoder.ComputeOperationSha256([]), string.Empty);
            git = git with
            {
                ContentSha256 = ArticleVaultGitFactDecoder.ComputeContentSha256(git)
            };
            // An explicit unavailable-metadata/stale-Git ordinary input, never a real acquisition receipt.
            Current = new(metadata, evidence, git, Stored.Resolution.Decisions, null,
                Stored.Resolution.Confirmation, Stored.Resolution.ExpiresAtUnixMs);
            IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SITE_BASEURL"] = "https://permission.example/"
            }).Build();
            Reader = new(Proposals, Stored.ExecutionStore, Stored.Reader, Permissions, configuration, "site-one");
            Adapter = new(Proposals, Reader, "site-one");
        }

        internal void NoWrites()
        {
            Assert.DoesNotContain(Proposals.ReceivedCalls(), call => call.GetMethodInfo().Name != "ReadExactAsync");
            Assert.DoesNotContain(Stored.ExecutionStore.ReceivedCalls(), call => call.GetMethodInfo().Name != "LoadSealedAsync");
            Assert.DoesNotContain(Stored.CheckpointStore.ReceivedCalls(), call => call.GetMethodInfo().Name != "ReadThroughAsync");
        }
    }
}
