using System.Data;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleGraphRootAdmissionHostTests
{
    private const string ArticleIdentity = "article:60000000-0000-0000-0000-000000000001";
    private const string RevisionIdentity = "revision:70000000-0000-0000-0000-000000000001";

    [Theory]
    [InlineData("anonymous")]
    [InlineData("public-user")]
    [InlineData("missing-id")]
    [InlineData("invalid-id")]
    [InlineData("missing-session")]
    [InlineData("missing-permission")]
    public async Task InvalidHostContextNeverInvokesTheAdmissionReader(string mutation)
    {
        Fixture fixture = CreateFixture(mutation);

        Assert.Null(await fixture.Host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));
        Assert.Empty(fixture.Permissions.Requests);
    }

    [Fact]
    public async Task MissingHttpContextNeverInvokesTheAdmissionReader()
    {
        Fixture fixture = CreateFixture();
        fixture.Context.HttpContext = null;

        Assert.Null(await fixture.Host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));
        Assert.Empty(fixture.Permissions.Requests);
    }

    [Fact]
    public async Task ServerDerivedOwnerAndRequestReachTheOriginalPermissionPreflight()
    {
        Fixture fixture = CreateFixture();

        Assert.Null(await fixture.Host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));

        AuthorArticlePinPermissionBatchRequest request = Assert.Single(fixture.Permissions.Requests);
        Assert.Equal(new AuthorArticlePinOwner(42, "https://graph.test"), request.Owner);
        Assert.NotEqual(Guid.Empty, request.RequestId);
        Assert.Equal(7, request.RequestId.Version);
        Assert.Empty(request.ArticleIds);
        Assert.Equal(0, fixture.Articles.Reads);
    }

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Serializable)]
    [InlineData(IsolationLevel.Snapshot)]
    public async Task PinnedSnapshotNeverInvokesTheAdmissionReader(IsolationLevel isolation)
    {
        Fixture fixture = CreateFixture();
        IDbTransaction transaction = Substitute.For<IDbTransaction>();
        transaction.IsolationLevel.Returns(isolation);
        fixture.Ado.Transaction.Returns(transaction);

        Assert.Null(await fixture.Host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));
        Assert.Empty(fixture.Permissions.Requests);
    }

    [Fact]
    public async Task ReadCommittedPreservesTheOriginalPermissionPreflight()
    {
        Fixture fixture = CreateFixture();
        IDbTransaction transaction = Substitute.For<IDbTransaction>();
        transaction.IsolationLevel.Returns(IsolationLevel.ReadCommitted);
        fixture.Ado.Transaction.Returns(transaction);

        Assert.Null(await fixture.Host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));
        Assert.Single(fixture.Permissions.Requests);
    }

    [Fact]
    public async Task DisposedTransactionFailsClosedBeforeAdmission()
    {
        Fixture fixture = CreateFixture();
        IDbTransaction transaction = Substitute.For<IDbTransaction>();
        transaction.IsolationLevel.Returns(_ => throw new ObjectDisposedException("transaction"));
        fixture.Ado.Transaction.Returns(transaction);

        Assert.Null(await fixture.Host.ReadCurrentAsync(ArticleIdentity, RevisionIdentity));
        Assert.Empty(fixture.Permissions.Requests);
    }

    [Fact]
    public async Task CancellationIsPropagatedBeforeAuthorityAccess()
    {
        Fixture fixture = CreateFixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Host.ReadCurrentAsync(
            ArticleIdentity, RevisionIdentity, cancellation.Token));
        Assert.Empty(fixture.Permissions.Requests);
    }

    [Theory]
    [InlineData("administrator")]
    [InlineData("site")]
    public async Task RevalidationRejectsChangedOwnerBeforeAuthorityAccess(string mutation)
    {
        Fixture fixture = CreateFixture();
        ArticleGraphRootRead read = RootRead(new AuthorArticlePinOwner(42, "https://graph.test"));
        if (mutation == "administrator")
        {
            fixture.Context.HttpContext!.User = Principal(adminId: "43");
        }
        else
        {
            fixture.Configuration["SITE_BASEURL"] = "https://other.test";
        }

        Assert.Null(await fixture.Host.RevalidateCurrentAsync(read));
        Assert.Empty(fixture.Permissions.Requests);
    }

    [Fact]
    public async Task RevalidationConsumesTheOriginalReaderAndCannotInheritAnAdmission()
    {
        Fixture fixture = CreateFixture();

        Assert.Null(await fixture.Host.RevalidateCurrentAsync(
            RootRead(new AuthorArticlePinOwner(42, "https://graph.test"))));
        Assert.Single(fixture.Permissions.Requests);
    }

    private static ArticleGraphRootRead RootRead(AuthorArticlePinOwner owner)
    {
        // A controlled prior admission is only a negative input. The real reader must acquire
        // fresh permission; this fixture cannot confer runtime or neighboring-node authority.
        var request = new ArticleGraphCurrentArticleReadRequest(
            owner, Guid.CreateVersion7(), ArticleIdentity, RevisionIdentity);
        var permission = new AuthorArticlePinPermissionSnapshot(
            AuthorArticlePinPermissionSnapshotStatus.Current, owner, "permission:1", "site:1",
            "session:1", [], string.Empty);
        var source = new ArticleRelationRevisionCoordinate(
            1, 2, 1, ArticleIdentity, RevisionIdentity, Guid.NewGuid());
        var article = new AuthorArticlePinArticleFact(
            1, "Root", ArticleStatus.Published, 2, 1, "article:1", "revision:1", true, false, string.Empty);
        return new ArticleGraphRootRead(request, new ArticleGraphCurrentArticleAdmission(
            Guid.CreateVersion7(), source, article, permission));
    }

    private static Fixture CreateFixture(string? mutation = null)
    {
        var context = new HttpContextAccessor
        {
            HttpContext = new DefaultHttpContext { User = Principal(mutation) }
        };
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = " https://graph.test/// " }).Build();
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAdo ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.Transaction.Returns((IDbTransaction?)null);
        var permissions = new RecordingDeniedPermissions();
        var articles = new ForbiddenArticles();
        var reader = new SqlArticleGraphAdmissionReader(
            db, new ArticleRelationSourceCoordinateAuthority(), permissions, articles);
        return new Fixture(new ArticleGraphRootAdmissionHost(context, configuration, db, reader),
            context, configuration, ado, permissions, articles);
    }

    private static ClaimsPrincipal Principal(string? mutation = null, string adminId = "42")
    {
        List<Claim> claims =
        [
            new Claim("identity_kind", mutation == "public-user" ? "public-user" : AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", mutation == "invalid-id" ? "0" : adminId),
            new Claim("admin_sid", "fixture-session"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        ];
        string? remove = mutation switch
        {
            "missing-id" => "admin_id",
            "missing-session" => "admin_sid",
            "missing-permission" => AdminPermissions.PermissionClaimType,
            _ => null
        };
        claims.RemoveAll(claim => claim.Type == remove);
        return new ClaimsPrincipal(new ClaimsIdentity(claims, mutation == "anonymous" ? null : "fixture"));
    }

    private sealed record Fixture(
        ArticleGraphRootAdmissionHost Host,
        HttpContextAccessor Context,
        IConfiguration Configuration,
        IAdo Ado,
        RecordingDeniedPermissions Permissions,
        ForbiddenArticles Articles);

    private sealed class ForbiddenArticles : IAuthorArticlePinArticleProjectionSource
    {
        internal int Reads
        {
            get; private set;
        }

        public Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
            IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken = default)
        {
            Reads++;
            throw new InvalidOperationException("Metadata must follow admission.");
        }
    }

    private sealed class RecordingDeniedPermissions : IAuthorArticlePinPermissionProjectionProvider
    {
        internal List<AuthorArticlePinPermissionBatchRequest> Requests { get; } = [];

        public Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
            AuthorArticlePinPermissionBatchRequest request,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Requests.Add(request);
            return Task.FromResult(new AuthorArticlePinPermissionSnapshot(
                AuthorArticlePinPermissionSnapshotStatus.Unavailable, request.Owner,
                string.Empty, string.Empty, string.Empty, [], string.Empty, "fixture-denied"));
        }
    }
}
