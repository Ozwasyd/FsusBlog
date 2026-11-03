using System.Security.Claims;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Controlled HTTP permission adapter tests; no database or genuine session qualification.</summary>
public sealed class DocumentExportHttpJobAuthorizationTests
{
    [Fact]
    public async Task CurrentOriginalProjection_IsReadFreshForEachOperation()
    {
        var fixture = new Fixture();
        Assert.True(await fixture.Authorization.IsAllowedAsync(fixture.Actor, fixture.Coordinate,
            DocumentExportJobOperation.Create, default));
        Assert.True(await fixture.Authorization.IsAllowedAsync(fixture.Actor, fixture.Coordinate,
            DocumentExportJobOperation.Download, default));
        Assert.Equal(2, fixture.Reads);
    }

    [Theory]
    [InlineData("missing-context")]
    [InlineData("principal")]
    [InlineData("session")]
    public async Task UnboundContext_ReadsNoOriginalPermission(string mutation)
    {
        var fixture = new Fixture();
        if (mutation == "missing-context")
        {
            fixture.Accessor.HttpContext = null;
        }
        else
        {
            fixture.Actor = mutation == "principal"
                ? fixture.Actor with
                {
                    UserId = fixture.Actor.UserId + 1
                }
                : fixture.Actor with
                {
                    SessionId = "other-session"
                };
        }
        Assert.False(await fixture.Authorization.IsAllowedAsync(fixture.Actor, fixture.Coordinate,
            DocumentExportJobOperation.Read, default));
        Assert.Equal(0, fixture.Reads);
    }

    [Theory]
    [InlineData("stale")]
    [InlineData("owner")]
    [InlineData("seal")]
    [InlineData("article")]
    [InlineData("decision")]
    public async Task ChangedOrDeniedProjection_IsRejected(string mutation)
    {
        var fixture = new Fixture();
        fixture.Snapshot = mutation switch
        {
            "stale" => Seal(fixture.Snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Stale }),
            "owner" => Seal(fixture.Snapshot with
            {
                Owner = fixture.Snapshot.Owner with
                {
                    SiteScope = "https://other.example"
                }
            }),
            "article" => Seal(fixture.Snapshot with
            {
                Decisions = [fixture.Snapshot.Decisions[0] with { ArticleId = 99 }]
            }),
            "decision" => Seal(fixture.Snapshot with
            {
                Decisions = [fixture.Snapshot.Decisions[0] with { CanWrite = false }]
            }),
            _ => fixture.Snapshot with { ContentDigest = new string('0', 64) }
        };
        Assert.False(await fixture.Authorization.IsAllowedAsync(fixture.Actor, fixture.Coordinate,
            DocumentExportJobOperation.Create, default));
        Assert.Equal(1, fixture.Reads);
    }

    private static AuthorRecentArticleHistoryPermissionSnapshot Seal(AuthorRecentArticleHistoryPermissionSnapshot snapshot)
        => snapshot with
        {
            ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
        };

    private sealed class Fixture
    {
        internal DocumentExportJobActor Actor { get; set; } = new(7, "https://example.test", "controlled-session");
        internal DocumentExportArticleCoordinate Coordinate
        {
            get;
        } = new(
            DocumentExportCoordinateKind.Publication, 42, null, 101, 202, 3);
        internal HttpContextAccessor Accessor { get; } = new();
        internal AuthorRecentArticleHistoryPermissionSnapshot Snapshot
        {
            get; set;
        }
        internal DocumentExportHttpJobAuthorization Authorization
        {
            get;
        }
        internal int Reads
        {
            get; private set;
        }

        internal Fixture()
        {
            Accessor.HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("identity_kind", "admin_principal"),
                    new Claim("admin_id", "7"),
                    new Claim("admin_sid", "controlled-session")
                ], "controlled-admin"))
            };
            string digest = AuthorRecentArticleHistoryContract.HashText("controlled-permission");
            Snapshot = Seal(new(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                new(Actor.UserId, Actor.SiteScope), digest, digest, digest,
                [new(42, true, true, digest)], string.Empty));
            var permissions = Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
            permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(),
                Arg.Any<CancellationToken>()).Returns(_ =>
                {
                    Reads++;
                    return Task.FromResult(Snapshot);
                });
            Authorization = new(permissions, Accessor);
        }
    }
}
