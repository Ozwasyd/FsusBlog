using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Analytics;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Comments;
using FsusBlog.V2.Server.Communication;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Passkeys;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Server;

internal static class ServerEndpoints
{
    internal static async Task MapAsync(WebApplication app, ServerBootstrapContext bootstrap)
    {
        var capabilities = bootstrap.Capabilities;
        var publications = app.Services.GetRequiredService<Publications>();
        var lease = app.Services.GetRequiredService<InstanceLease>();
        var authorCookie = ServerHttp.AuthorCookie(capabilities);

        MapSiteAndCommunicationEndpoints(app, bootstrap, authorCookie);
        MapMediaEndpoints(app, bootstrap, publications, authorCookie);
        await MapPublicContentEndpointsAsync(app, bootstrap, publications, lease, authorCookie);
        MapAuthoringEndpoints(app, capabilities, publications, authorCookie);
        MapCommentsAndAdministrationEndpoints(app, capabilities, publications, lease);
        PageShellEndpoints.Map(app, publications, bootstrap.PublicMediaEnabled);
    }

    private static void MapSiteAndCommunicationEndpoints(WebApplication app, ServerBootstrapContext bootstrap, string authorCookie)
    {
        var capabilities = bootstrap.Capabilities;
        bootstrap.Appearance?.Map(app);
        PasskeyEndpoints.Map(app, ServerHttp.SessionCookie, ServerHttp.ReadFrame, capabilities);
        SiteSessionEndpoints.Map(app, ServerHttp.SessionCookie, capabilities.SitePersistentRefresh);
        SiteDisplayNameEndpoints.Map(app, ServerHttp.SessionCookie, ServerHttp.ReadFrame);
        InboxEndpoints.Map(app, ServerHttp.SessionCookie, ServerHttp.ReadFrame, capabilities);
        InboxStreamEndpoints.Map(app, ServerHttp.SessionCookie);
        IdentitySessionEndpoints.Map(app, ServerHttp.SessionCookie, authorCookie, capabilities.SitePersistentRefresh);
    }

    private static void MapMediaEndpoints(WebApplication app, ServerBootstrapContext bootstrap, Publications publications, string authorCookie)
    {
        var capabilities = bootstrap.Capabilities;
        if (app.Services.GetService<MediaStore>() is not null)
        {
            MediaEndpoints.Map(app, authorCookie, capabilities);
            MediaUploadEndpoints.Map(app, authorCookie, capabilities);
            ArticleMediaEndpoints.Map(app, authorCookie, bootstrap.PublicMediaEnabled);
        }
        if (app.Services.GetService<PublishedMediaStore>() is { } publishedMedia)
            PublishedMediaEndpoints.Map(app, authorCookie, publications, publishedMedia, ServerHttp.ReadFrame);
    }

    private static async Task MapPublicContentEndpointsAsync(WebApplication app, ServerBootstrapContext bootstrap,
        Publications publications, InstanceLease lease, string authorCookie)
    {
        var capabilities = bootstrap.Capabilities;
        TaxonomyEndpoints.Map(app,
            ctx => ServerHttp.Snapshot(ctx, publications),
            (ctx, snapshot) => ServerHttp.RequireCurrentSnapshot(ctx, publications, snapshot),
            ServerHttp.Query, ServerHttp.ReadListCursor, authorCookie, ServerHttp.ReadFrame);
        app.Services.GetRequiredService<SitePages>().Map(app);
        bootstrap.IntegrityKeys.Map(app);
        await LegacyReleaseResponsibility.MapAsync(app, publications, lease);
        app.Services.GetService<PublicationProofs>()?.Map(app, bootstrap.CheckpointArchive);
        bootstrap.CheckpointArchive?.Map(app);
        capabilities.PublicSite.Map(app);
        if (capabilities.Subscription is { } subscription)
            SubscriptionEndpoints.Map(app, subscription, capabilities.PublicSite.Origin!, ServerHttp.ReadFrame);
        if (capabilities.ArticleReadProof)
            ArticleReadEndpoints.Map(app, capabilities.PublicSite.Origin!, publications, ServerHttp.ReadFrame);
        DistributionEndpoints.Map(app, publications, app.Services.GetRequiredService<DistributionSettings>());
        PublicReadEndpoints.Map(app, capabilities, publications, bootstrap.PublicMediaEnabled);
    }

    private static void MapAuthoringEndpoints(WebApplication app, SiteCapabilities capabilities,
        Publications publications, string authorCookie)
    {
        CanvasEndpoints.Map(app, authorCookie, ServerHttp.ReadFrame);
        PropertyEndpoints.Map(app, authorCookie, ServerHttp.ReadFrame, ServerHttp.Query);
        AuthorTextSearchEndpoints.Map(app, authorCookie, ServerHttp.ReadFrame);
        ArticleSummaryEndpoints.Map(app, authorCookie, ServerHttp.ReadFrame);
        SavedViewEndpoints.Map(app, authorCookie, ServerHttp.ReadFrame, ServerHttp.Query);
        RecoveryScopeEndpoints.Map(app, authorCookie);
        AuthoringWorkspaceEndpoints.Map(app, authorCookie, ServerHttp.ReadFrame);
        AuthorRecentOpenEndpoints.Map(app, authorCookie, ServerHttp.ReadFrame, ServerHttp.Query);
        var draftMutations = new DraftMutationRoutes(app, authorCookie, ServerHttp.ReadFrame);
        RevisionHistoryEndpoints.Map(app, authorCookie, ServerHttp.Query, draftMutations);
        draftMutations.MapRights(ServerHttp.Query);
        ArticleInventoryEndpoints.Map(app, authorCookie, ServerHttp.Query);
        draftMutations.MapSchedule(ServerHttp.Query);
        MarkdownExportEndpoints.Map(app, authorCookie, ServerHttp.Query, capabilities.PdfExport);
        if (capabilities.DocumentExportTasks)
            DocumentExportEndpoints.Map(app, authorCookie, capabilities.PdfExport, ServerHttp.ReadFrame);
        capabilities.PluginPreview?.Map(app, authorCookie, ServerHttp.Query);
        AuthorArticleEndpoints.Map(app, authorCookie, publications);
    }

    private static void MapCommentsAndAdministrationEndpoints(WebApplication app, SiteCapabilities capabilities,
        Publications publications, InstanceLease lease)
    {
        var commentRoutes = CommentReadEndpoints.Map(app, publications, ServerHttp.SessionCookie, ServerHttp.ReadFrame,
            lease.RootCommentPowPolicyInstalled, capabilities);
        if (capabilities.AdminIdentity is not null)
            AdminIdentityEndpoints.Map(app, capabilities, ServerHttp.ReadFrame, commentRoutes, ServerHttp.Query);
        CommentAuthorDeleteEndpoints.Map(app, ServerHttp.SessionCookie, ServerHttp.ReadFrame);
    }
}
