using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;
using FsusBlog.Server.Services.DocumentExport.Sources;

using Microsoft.Extensions.Configuration;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportSourceCatalogTests
{
    private static readonly DocumentExportJobActor s_actor = new(7, "https://example.test", "catalog-session");

    [Fact]
    public async Task InvalidOriginalCoordinates_RefuseBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        DocumentExportSourceRequest[] invalid =
        [
            new(DocumentExportCoordinateKind.Draft, 0, "owned"),
            new(DocumentExportCoordinateKind.Draft, 1, " owned "),
            new(DocumentExportCoordinateKind.Draft, 1, "owned", RevisionId: 9),
            new(DocumentExportCoordinateKind.Revision, 1, RevisionId: 0),
            new(DocumentExportCoordinateKind.Publication, 1, RevisionId: 9),
            new((DocumentExportCoordinateKind)99, 1)
        ];
        foreach (DocumentExportSourceRequest request in invalid)
        {
            await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(s_actor, [request]));
        }
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task WrongSession_RefusesBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.CaptureAsync(s_actor with
            {
                SessionId = "other"
            }, [new(DocumentExportCoordinateKind.Draft, 1, "owned")]));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task WrongConfiguredSite_RefusesBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.CaptureAsync(s_actor with
            {
                SiteScope = "primary"
            }, [new(DocumentExportCoordinateKind.Revision, 1, RevisionId: 9)]));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task InvalidChoiceOrVersion_RefusesBeforeAnyBindingRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        var coordinate = new DocumentExportArticleCoordinate(DocumentExportCoordinateKind.Revision, 1, null, 9, null, 1);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.ReadBoundAsync(s_actor, "revision-9", coordinate));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.ReadBoundAsync(s_actor, new string('a', 64), coordinate with
            {
                SourceVersion = 0
            }));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task CancelledRequest_RefusesBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            catalog.CaptureAsync(s_actor, [new(DocumentExportCoordinateKind.Revision, 1, RevisionId: 9)], cancellation.Token));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task DuplicateOrOversizeChoiceLists_RefuseBeforeAnySourceRead()
    {
        var (catalog, db, authoring) = CreateCatalog();
        var request = new DocumentExportSourceRequest(DocumentExportCoordinateKind.Revision, 1, RevisionId: 9);
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() => catalog.CaptureAsync(s_actor, [request, request]));
        await Assert.ThrowsAsync<DocumentExportSourceDeniedException>(() =>
            catalog.CaptureAsync(s_actor, Enumerable.Range(1, 51)
                .Select(id => request with { RevisionId = id }).ToArray()));
        Assert.Empty(authoring.ReceivedCalls());
        Assert.Empty(db.ReceivedCalls());
    }

    private static (DocumentExportSourceCatalog Catalog, ISqlSugarClient Db, IAuthoringDraftLifecycle Authoring) CreateCatalog()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IAuthoringDraftLifecycle authoring = Substitute.For<IAuthoringDraftLifecycle>();
        var accessor = new HttpContextAccessor
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                [
                    new Claim("identity_kind", "admin_principal"),
                    new Claim("admin_id", "7"),
                    new Claim("admin_sid", s_actor.SessionId),
                    new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
                ], "test"))
            }
        };
        IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SITE_BASEURL"] = "https://example.test/"
        }).Build();
        var authority = new SqlAuthorRecentArticleHistoryPermissionAuthority(db, accessor, configuration, TimeProvider.System);
        return (new(db, authoring, authority, accessor, configuration, new(db)), db, authoring);
    }
}
