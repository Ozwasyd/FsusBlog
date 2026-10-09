using System.Security.Claims;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Controlled composition checks; persisted session decisions are verified by the PostgreSQL controls.</summary>
public sealed class DocumentExportSessionJobAuthorizationTests
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
    [InlineData("anonymous")]
    [InlineData("principal")]
    [InlineData("permission")]
    [InlineData("session")]
    public async Task UnboundContext_ReadsNoOriginalPermission(string mutation)
    {
        var fixture = new Fixture();
        if (mutation == "anonymous")
        {
            fixture.Accessor.HttpContext!.User = new ClaimsPrincipal();
        }
        else if (mutation == "permission")
        {
            fixture.Accessor.HttpContext!.User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", "admin_principal"),
                new Claim("admin_id", "7"),
                new Claim("admin_sid", "controlled-session")
            ], "controlled-admin"));
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
    [InlineData("unavailable")]
    [InlineData("count")]
    [InlineData("revision")]
    [InlineData("owner")]
    [InlineData("seal")]
    [InlineData("article")]
    [InlineData("decision")]
    public async Task ChangedOrDeniedProjection_IsRejected(string mutation)
    {
        var fixture = new Fixture();
        fixture.Snapshot = mutation switch
        {
            "unavailable" => fixture.Snapshot with { Status = AuthorRecentArticleHistoryPermissionSnapshotStatus.Unavailable },
            "count" => Seal(fixture.Snapshot with { Decisions = [] }),
            "revision" => fixture.Snapshot with { SessionRevision = string.Empty },
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

    [Theory]
    [InlineData(DocumentExportJobOperation.Read, true)]
    [InlineData(DocumentExportJobOperation.Download, true)]
    [InlineData(DocumentExportJobOperation.Create, false)]
    [InlineData(DocumentExportJobOperation.Cancel, false)]
    [InlineData(DocumentExportJobOperation.Retry, false)]
    [InlineData(DocumentExportJobOperation.Delete, false)]
    public async Task BackgroundOperation_UsesProjectOrWriteDecision(DocumentExportJobOperation operation, bool expected)
    {
        var fixture = new Fixture();
        fixture.Accessor.HttpContext = null;
        fixture.Snapshot = Seal(fixture.Snapshot with
        {
            Decisions = [fixture.Snapshot.Decisions[0] with { CanWrite = false }]
        });
        Assert.Equal(expected, await fixture.Authorization.IsAllowedAsync(
            fixture.Actor, fixture.Coordinate, operation, default));
        Assert.Equal(1, fixture.Reads);
    }

    [Fact]
    public async Task BackgroundSuccessiveReads_RejectNewDenial()
    {
        var fixture = new Fixture();
        fixture.Accessor.HttpContext = null;
        Assert.True(await fixture.Authorization.IsAllowedAsync(fixture.Actor, fixture.Coordinate,
            DocumentExportJobOperation.Read, default));
        fixture.Snapshot = Seal(fixture.Snapshot with
        {
            Decisions = [fixture.Snapshot.Decisions[0] with { CanProject = false }]
        });
        Assert.False(await fixture.Authorization.IsAllowedAsync(fixture.Actor, fixture.Coordinate,
            DocumentExportJobOperation.Read, default));
        Assert.Equal(2, fixture.Reads);
    }

    [Theory]
    [InlineData("operation")]
    [InlineData("owner")]
    [InlineData("site")]
    [InlineData("session")]
    [InlineData("article")]
    public async Task InvalidActorOrCoordinate_ReadsNoPersistedFacts(string mutation)
    {
        var fixture = new Fixture();
        fixture.Accessor.HttpContext = null;
        DocumentExportJobActor actor = mutation switch
        {
            "owner" => fixture.Actor with { UserId = 0 },
            "site" => fixture.Actor with { SiteScope = string.Empty },
            "session" => fixture.Actor with { SessionId = string.Empty },
            _ => fixture.Actor
        };
        DocumentExportArticleCoordinate coordinate = mutation == "article"
            ? fixture.Coordinate with
            {
                ArticleId = 0
            } : fixture.Coordinate;
        DocumentExportJobOperation operation = mutation == "operation" ? (DocumentExportJobOperation)99
            : DocumentExportJobOperation.Read;
        Assert.False(await fixture.Authorization.IsAllowedAsync(actor, coordinate, operation, default));
        Assert.Equal(0, fixture.Reads);
    }

    [Fact]
    public async Task CancellationBeforeRead_Propagates()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Authorization.IsAllowedAsync(fixture.Actor, fixture.Coordinate,
                DocumentExportJobOperation.Read, cancellation.Token));
        Assert.Equal(0, fixture.Reads);
    }

    [Fact]
    public async Task CancellationDuringRead_RejectsReturnedSnapshot()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        fixture.OnRead = cancellation.Cancel;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Authorization.IsAllowedAsync(fixture.Actor, fixture.Coordinate,
                DocumentExportJobOperation.Read, cancellation.Token));
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
        internal DocumentExportSessionJobAuthorization Authorization
        {
            get;
        }
        internal Action? OnRead
        {
            get; set;
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
                    new Claim("admin_sid", "controlled-session"),
                    new Claim("admin_permission", "article.write")
                ], "controlled-admin"))
            };
            string digest = AuthorRecentArticleHistoryContract.HashText("controlled-permission");
            Snapshot = Seal(new(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                new(Actor.UserId, Actor.SiteScope), digest, digest, digest,
                [new(42, true, true, digest)], string.Empty));
            var permissions = Substitute.For<IAuthorRecentArticleHistoryPersistedPermissionReader>();
            permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(),
                Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ =>
                {
                    Reads++;
                    OnRead?.Invoke();
                    Assert.Equal(Actor.SessionId, _.Arg<string>());
                    Assert.Equal(new AuthorRecentArticleHistoryOwner(Actor.UserId, Actor.SiteScope),
                        _.Arg<AuthorRecentArticleHistoryPermissionRequest>().Owner);
                    return Task.FromResult(Snapshot);
                });
            Authorization = new(permissions, Accessor);
        }
    }
}
