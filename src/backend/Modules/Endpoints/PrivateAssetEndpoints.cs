using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;

using Microsoft.AspNetCore.Mvc;

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
        [FromRoute] string ticket,
        [FromServices] IPrivateAssetTicketRedemptionService redemptionService,
        [FromServices] IPrivateAssetResponseWriter responseWriter,
        CancellationToken cancellationToken)
    {
        SetFailureResponse(context.Response, StatusCodes.Status404NotFound);
        if (context.Request.Headers.ContainsKey("Range"))
        {
            SetFailureResponse(context.Response, StatusCodes.Status416RangeNotSatisfiable);
            return;
        }

        try
        {
            PrivateAssetAccessResult? result = await redemptionService.RedeemAsync(
                ticket,
                context.User,
                cancellationToken);
            if (result is null)
            {
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
                SetFailureResponse(context.Response, StatusCodes.Status404NotFound);
            }
            else
            {
                throw;
            }
        }
    }

    private static void SetFailureResponse(HttpResponse response, int statusCode)
    {
        response.StatusCode = statusCode;
        response.ContentLength = 0;
        response.Headers.CacheControl = "private,no-store";
        response.Headers.Pragma = "no-cache";
        response.Headers.XContentTypeOptions = "nosniff";
    }
}
