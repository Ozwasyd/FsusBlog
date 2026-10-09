using System.Data;
using System.Security.Claims;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleGraphCurrentArticleHostTests
{
    private const string ArticleIdentity = "article:dd90413e-7d50-4264-9910-d89294ac2f18";
    private const string RevisionIdentity = "revision:aa90413e-7d50-4264-9910-d89294ac2f18";

    [Theory]
    [InlineData("context")]
    [InlineData("unauthenticated")]
    [InlineData("user")]
    [InlineData("admin-id")]
    [InlineData("session")]
    [InlineData("article-write")]
    [InlineData("site")]
    public async Task InvalidActualRequestStopsBeforeAnyPermissionSource(string change)
    {
        var permission = new RecordingPermissionSource();
        DefaultHttpContext context = Context();
        var identity = new ClaimsIdentity(context.User.Claims, "unit-auth");
        context.User = new ClaimsPrincipal(identity);
        var accessor = new HttpContextAccessor { HttpContext = context };
        if (change == "context")
        {
            accessor.HttpContext = null;
        }
        else if (change == "unauthenticated")
        {
            context.User = new ClaimsPrincipal(new ClaimsIdentity(identity.Claims));
        }
        else
        {
            string claimType = change switch
            {
                "user" => "identity_kind",
                "admin-id" => "admin_id",
                "session" => "admin_sid",
                _ => AdminPermissions.PermissionClaimType
            };
            if (change != "site")
            {
                identity.RemoveClaim(identity.FindFirst(claimType)!);
            }
        }
        ArticleGraphCurrentArticleHost host = CreateHost(
            accessor, permission, site: change == "site" ? " " : "https://graph-host.test/");
        Assert.Null(await host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));
        Assert.Empty(permission.Requests);
    }

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Serializable)]
    [InlineData(IsolationLevel.Snapshot)]
    [InlineData(IsolationLevel.ReadUncommitted)]
    public async Task HistoricalTransactionStopsBeforeAnyPermissionSource(IsolationLevel isolation)
    {
        var permission = new RecordingPermissionSource();
        var transaction = Substitute.For<IDbTransaction>();
        transaction.IsolationLevel.Returns(isolation);
        ArticleGraphCurrentArticleHost host = CreateHost(
            new HttpContextAccessor { HttpContext = Context() }, permission, transaction);
        Assert.Null(await host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));
        Assert.Empty(permission.Requests);
    }

    [Fact]
    public async Task OwnerAndCorrelationComeFromTheActualRequest()
    {
        var permission = new RecordingPermissionSource();
        ArticleGraphCurrentArticleHost host = CreateHost(
            new HttpContextAccessor { HttpContext = Context() }, permission);
        Assert.Null(await host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));
        AuthorArticlePinPermissionBatchRequest request = Assert.Single(permission.Requests);
        Assert.Equal(new AuthorArticlePinOwner(9000000001, "https://graph-host.test"), request.Owner);
        Assert.NotEqual(Guid.Empty, request.RequestId);
        Assert.Empty(request.ArticleIds);
    }

    [Fact]
    public async Task CancellationBeforeAdmissionAndAfterSourceFailurePropagates()
    {
        using var cancellation = new CancellationTokenSource();
        var permission = new RecordingPermissionSource(() =>
        {
            cancellation.Cancel();
            throw new InvalidOperationException("private source failure");
        });
        ArticleGraphCurrentArticleHost host = CreateHost(
            new HttpContextAccessor { HttpContext = Context() }, permission);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity, cancellation.Token));
        Assert.Single(permission.Requests);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity, cancellation.Token));
        Assert.Single(permission.Requests);
    }

    private static DefaultHttpContext Context()
        => new()
        {
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                new Claim("admin_id", "9000000001"),
                new Claim("admin_sid", "actual-admin-session"),
                new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
            ], "unit-auth"))
        };

    private static ArticleGraphCurrentArticleHost CreateHost(
        IHttpContextAccessor accessor,
        RecordingPermissionSource permission,
        IDbTransaction? transaction = null,
        string site = "https://graph-host.test/")
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.Transaction.Returns(transaction);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = site }).Build();
        var reader = new SqlArticleGraphAdmissionReader(db, new(), permission, new ForbiddenArticleSource());
        return new(db, reader, accessor, configuration);
    }

    private sealed class RecordingPermissionSource(Action? beforeRefusal = null)
        : IAuthorArticlePinPermissionProjectionProvider
    {
        public List<AuthorArticlePinPermissionBatchRequest> Requests { get; } = [];

        public Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
            AuthorArticlePinPermissionBatchRequest request,
            CancellationToken cancellationToken = default)
        {
            Requests.Add(request);
            beforeRefusal?.Invoke();
            return Task.FromResult(new AuthorArticlePinPermissionSnapshot(
                AuthorArticlePinPermissionSnapshotStatus.Unavailable, request.Owner,
                "", "", "", [], ""));
        }
    }

    private sealed class ForbiddenArticleSource : IAuthorArticlePinArticleProjectionSource
    {
        public Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
            IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("Metadata must not be reached.");
    }
}
