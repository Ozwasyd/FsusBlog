using System.Globalization;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Modules.Endpoints;

public static class IntegrityVerificationEndpoints
{
    private const string JsonContentType = "application/json; charset=utf-8";

    public static IEndpointRouteBuilder MapIntegrityVerificationEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/integrity/keys.json", async (
            HttpContext ctx,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetKeysAsync(cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/article/{articleId:int}", async (
            HttpContext ctx,
            int articleId,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetCurrentArticleProofAsync(articleId, cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/article/{articleId:int}/revisions/{revisionNo:int}", async (
            HttpContext ctx,
            int articleId,
            int revisionNo,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetArticleRevisionProofAsync(articleId, revisionNo, cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/article/{articleId:int}/rights", async (
            HttpContext ctx,
            int articleId,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetCurrentArticleRightsProofAsync(articleId, cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/article/{articleId:int}/revisions/{revisionNo:int}/rights", async (
            HttpContext ctx,
            int articleId,
            int revisionNo,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetArticleRevisionRightsProofAsync(articleId, revisionNo, cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/article/{articleId:int}/responsibility", async (
            HttpContext ctx,
            int articleId,
            IArticleResponsibilityManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetCurrentAsync(articleId, cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/article/{articleId:int}/revisions/{revisionNo:int}/responsibility", async (
            HttpContext ctx,
            int articleId,
            int revisionNo,
            IArticleResponsibilityManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetRevisionAsync(articleId, revisionNo, cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/revisions/{articleRevisionId:long}", async (
            HttpContext ctx,
            long articleRevisionId,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetRevisionProofAsync(articleRevisionId, cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/checkpoints/latest", async (
            HttpContext ctx,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetLatestCheckpointAsync(cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/checkpoints/{date}", async (
            HttpContext ctx,
            string date,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
        {
            if (!DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateOnly checkpointDate))
            {
                return WriteManifest(ctx, new IntegrityManifestResult(
                    StatusCodes.Status400BadRequest,
                    IntegrityVerificationCacheHeaders.NoStore,
                    IntegrityPublicErrorResponse.InvalidDate()));
            }

            return WriteManifest(ctx, await service.GetCheckpointAsync(checkpointDate, cancellationToken).ConfigureAwait(false));
        })
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        app.MapGet("/integrity/log/head", async (
            HttpContext ctx,
            IIntegrityVerificationManifestService service,
            CancellationToken cancellationToken) =>
            WriteManifest(ctx, await service.GetLogHeadAsync(cancellationToken).ConfigureAwait(false)))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .WithMetadata(new FsusRouteKindMetadata("public"));

        return app;
    }

    private static IResult WriteManifest(HttpContext ctx, IntegrityManifestResult result)
    {
        ctx.Response.Headers.CacheControl = result.CacheControl;
        ctx.Response.Headers.Vary = IntegrityVerificationCacheHeaders.Vary;
        return Results.Json(result.Body, IntegrityVerificationJson.Options, JsonContentType, result.StatusCode);
    }
}
