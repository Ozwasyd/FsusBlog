using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Modules.Endpoints;

internal static class PrivateAssetEndpoints
{
    internal static void MapPrivateAssetEndpoints(this WebApplication app)
    {
        app.MapMethods(
            PrivateAssetRoutePrivacy.ExternalPrefix + "{ticket}",
            [HttpMethods.Get, HttpMethods.Head],
            HandleAsync)
            .AllowAnonymous()
            .RequireNoStoreResponse()
            .WithMetadata(new FsusRouteKindMetadata("private-asset"));
    }

    internal static async Task HandleAsync(
        HttpContext context,
        string ticket,
        IPrivateAssetAccessService accessService,
        IPrivateAssetResponseWriter responseWriter,
        CancellationToken cancellationToken)
    {
        context.Response.ContentLength = 0;
        if (context.Request.Headers.ContainsKey("Range"))
        {
            context.Response.StatusCode = StatusCodes.Status416RangeNotSatisfiable;
            return;
        }

        try
        {
            PrivateAssetAccessResult? result = await accessService.RedeemAsync(
                ticket,
                context.User,
                cancellationToken);
            if (result is null)
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }

            await using (result.Handle)
            {
                await responseWriter.WriteAsync(context, result.Handle, cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            if (!context.Response.HasStarted)
            {
                context.Response.Clear();
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                context.Response.ContentLength = 0;
            }
            else
            {
                throw;
            }
        }
    }
}
